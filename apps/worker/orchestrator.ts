import type { AppConfig } from "../../packages/config/mod.ts";
import type { Repository } from "../../packages/db/repository.ts";
import type { DownloadedArtifact, Downloader } from "../../packages/downloader/adapter.ts";
import { DomainError } from "../../packages/domain/errors.ts";
import { abortableDelay, type IdGenerator } from "../../packages/domain/time.ts";
import type { ArtifactStorage } from "../../packages/storage/s3.ts";

export type WorkDisposition = "ack" | "retry" | "retry_source_timeout" | "dead";

export interface ArtifactFileStat {
  readonly isFile: boolean;
  readonly size: number;
}

export type ArtifactFileStatReader = (path: string) => Promise<ArtifactFileStat>;
export type WorkerLifecycleObserver = (
  event: string,
  fields: Readonly<Record<string, unknown>>,
) => void;

export class WorkerOrchestrator {
  constructor(
    private readonly config: Readonly<AppConfig>,
    private readonly repository: Repository,
    private readonly downloader: Downloader,
    private readonly storage: ArtifactStorage,
    private readonly ids: IdGenerator,
    private readonly workerId: string,
    private readonly statArtifact: ArtifactFileStatReader = Deno.stat,
    private readonly observeLifecycle?: WorkerLifecycleObserver,
  ) {}

  async process(jobId: string): Promise<WorkDisposition> {
    const attemptId = crypto.randomUUID();
    const leaseOwner = `${this.workerId}:${attemptId}`;
    const claimStartedAt = performance.now();
    const job = await this.repository.claimJob(
      jobId,
      leaseOwner,
      this.config.WORKER_JOB_LEASE_SECONDS,
    );
    if (!job) {
      this.emit("job.claim_skipped", {
        jobId,
        attemptId,
        durationMilliseconds: elapsedMilliseconds(claimStartedAt),
      });
      return "ack";
    }
    this.emit("job.claimed", {
      jobId,
      attemptId,
      attempt: job.attempts,
      claimedFromState: job.claimedFromState,
      claimDurationMilliseconds: elapsedMilliseconds(claimStartedAt),
      ...(job.claimedFromState === "queued"
        ? {
          queueDurationMilliseconds: Math.max(
            0,
            job.claimedAt.getTime() - job.claimReferenceAt.getTime(),
          ),
        }
        : {
          recoveryReferenceAgeMilliseconds: Math.max(
            0,
            job.claimedAt.getTime() - job.claimReferenceAt.getTime(),
          ),
        }),
    });

    const controller = new AbortController();
    let downloaded: DownloadedArtifact | null = null;
    let heartbeatStopped = false;
    const heartbeat = async () => {
      while (!heartbeatStopped) {
        await abortableDelay(
          this.config.WORKER_HEARTBEAT_SECONDS * 1000,
          controller.signal,
        ).catch(() => undefined);
        if (heartbeatStopped) break;
        const current = await this.repository.getJob(jobId);
        if (!current || current.cancellationRequestedAt) {
          controller.abort();
          break;
        }
        if (
          !await this.repository.heartbeatJob(
            jobId,
            leaseOwner,
            this.config.WORKER_JOB_LEASE_SECONDS,
          )
        ) {
          controller.abort();
          break;
        }
        if (downloaded) {
          try {
            await this.downloader.heartbeat(downloaded);
          } catch {
            controller.abort();
            break;
          }
        }
      }
    };
    const heartbeatTask = heartbeat();
    let artifactId: string | null = null;
    let temporaryKey: string | null = null;
    let finalKey: string | null = null;
    try {
      const sourceReuse = await this.measure(
        jobId,
        attemptId,
        "source_deduplication",
        () => this.repository.reuseReadyArtifactBySource(jobId),
      );
      if (sourceReuse) {
        this.emit("job.ready", { jobId, attemptId, result: "source_reused" });
        return "ack";
      }
      downloaded = await this.measure(
        jobId,
        attemptId,
        "download_pipeline",
        () =>
          this.downloader.download(job.normalizedUrl, controller.signal, {
            jobId,
            ownerId: leaseOwner,
            attemptId,
          }),
      );
      const processing = await this.measure(
        jobId,
        attemptId,
        "processing_transition",
        () => this.repository.transitionJob(jobId, "downloading", "processing"),
      );
      if (!processing) throw new DomainError("conflict", "The job lease changed before processing");
      const contentReuse = await this.measure(
        jobId,
        attemptId,
        "content_deduplication",
        () =>
          this.repository.reuseReadyArtifactByContent({
            jobId,
            byteSize: downloaded!.byteSize,
            sha256: downloaded!.sha256,
            selectedFormat: { ...downloaded!.selection },
          }),
      );
      if (contentReuse) {
        this.emit("job.ready", {
          jobId,
          attemptId,
          result: "content_reused",
          artifactByteSize: downloaded.byteSize,
        });
        return "ack";
      }
      artifactId = this.ids.next();
      temporaryKey = `${this.config.S3_TEMP_PREFIX}${artifactId}`;
      finalKey = `${this.config.S3_ARTIFACT_PREFIX}${artifactId}`;
      await this.measure(
        jobId,
        attemptId,
        "artifact_create",
        () =>
          this.repository.createUploadingArtifact({
            artifactId: artifactId!,
            jobId,
            objectKey: finalKey!,
            temporaryObjectKey: temporaryKey!,
          }),
      );
      const localFile = await this.measure(
        jobId,
        attemptId,
        "local_file_check",
        () => this.statArtifact(downloaded!.path),
      );
      if (
        !localFile.isFile || localFile.size !== downloaded.byteSize ||
        localFile.size > this.config.MAX_ARTIFACT_BYTES
      ) {
        throw new DomainError(
          "no_format_within_limit",
          "The downloaded artifact exceeds the upload limit",
        );
      }
      await this.measure(
        jobId,
        attemptId,
        "object_upload",
        () =>
          this.storage.putTemporary(artifactId!, {
            path: downloaded!.path,
            byteSize: downloaded!.byteSize,
            sha256: downloaded!.sha256,
          }),
      );
      await this.measure(
        jobId,
        attemptId,
        "object_promote",
        () => this.storage.promote(artifactId!),
      );
      const completed = await this.measure(
        jobId,
        attemptId,
        "artifact_finalize",
        () =>
          this.repository.completeArtifact({
            artifactId: artifactId!,
            jobId,
            objectKey: finalKey!,
            byteSize: downloaded!.byteSize,
            sha256: downloaded!.sha256,
            container: downloaded!.container,
            videoCodec: downloaded!.videoCodec,
            audioCodec: downloaded!.audioCodec,
            durationSeconds: downloaded!.durationSeconds,
            width: downloaded!.width,
            height: downloaded!.height,
            title: downloaded!.title,
            selectedFormat: { ...downloaded!.selection },
            maxStorageBytes: this.config.STORAGE_MAX_BYTES,
          }),
      );
      if (completed.reused) {
        await this.storage.delete(temporaryKey).catch(() => undefined);
        await this.storage.delete(finalKey).catch(() => undefined);
        temporaryKey = null;
        finalKey = null;
      }
      this.emit("job.ready", {
        jobId,
        attemptId,
        result: completed.reused ? "completion_reused" : "stored",
        artifactByteSize: downloaded.byteSize,
      });
      return "ack";
    } catch (error) {
      const domain = normalizeWorkerError(error);
      if (artifactId) {
        await this.repository.markArtifactUploadFailed(artifactId, domain.code).catch(() =>
          undefined
        );
      }
      if (temporaryKey) await this.storage.delete(temporaryKey).catch(() => undefined);
      if (finalKey) await this.storage.delete(finalKey).catch(() => undefined);
      const current = await this.repository.getJob(jobId);
      if (current?.state === "downloading" || current?.state === "processing") {
        if (domain.code === "cancelled" || current.cancellationRequestedAt) {
          await this.repository.transitionJob(jobId, current.state, "cancelled", {
            errorCode: "cancelled",
            safeErrorMessage: "The download was cancelled",
          });
          return "ack";
        }
        if (domain.retryable && current.attempts < this.config.WORKER_MAX_ATTEMPTS) {
          const sourceTimedOut = domain.details?.retryKind === "source_timeout";
          await this.repository.transitionJob(jobId, current.state, "queued", {
            errorCode: domain.code,
            safeErrorMessage: domain.message,
            ...(sourceTimedOut ? { progressPhase: "retrying_source_timeout" } : {}),
          });
          return sourceTimedOut ? "retry_source_timeout" : "retry";
        }
        await this.repository.transitionJob(jobId, current.state, "failed", {
          errorCode: domain.code,
          safeErrorMessage: domain.message,
        });
      }
      return domain.retryable ? "dead" : "ack";
    } finally {
      heartbeatStopped = true;
      controller.abort();
      await heartbeatTask;
      if (downloaded) {
        await this.measure(
          jobId,
          attemptId,
          "temporary_cleanup",
          () => this.downloader.cleanup(downloaded!),
        ).catch(() => undefined);
      }
    }
  }

  private async measure<Value>(
    jobId: string,
    attemptId: string,
    phase: string,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const startedAt = performance.now();
    try {
      const value = await operation();
      this.emit("job.phase", {
        jobId,
        attemptId,
        phase,
        outcome: "success",
        durationMilliseconds: elapsedMilliseconds(startedAt),
      });
      return value;
    } catch (error) {
      const errorCode = error instanceof DomainError ? error.code : "internal_error";
      this.emit("job.phase", {
        jobId,
        attemptId,
        phase,
        outcome: "failure",
        errorCode,
        durationMilliseconds: elapsedMilliseconds(startedAt),
      });
      throw error;
    }
  }

  private emit(event: string, fields: Readonly<Record<string, unknown>>): void {
    try {
      this.observeLifecycle?.(event, fields);
    } catch {
      // Observability must never change job behavior.
    }
  }
}

function normalizeWorkerError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  return new DomainError("storage_failure", "Artifact storage is temporarily unavailable", true);
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1_000) / 1_000;
}
