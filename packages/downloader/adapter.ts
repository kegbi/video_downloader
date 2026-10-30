import { dirname, join, resolve } from "@std/path";
import { createHash } from "node:crypto";
import {
  describeMetadataValidationError,
  type DownloaderMetadata,
  parseDownloaderMetadata,
} from "./metadata.ts";
import { type FormatSelection, rankFormats } from "./formats.ts";
import { runProcess } from "./process.ts";
import { DomainError, type ErrorCode } from "../domain/errors.ts";
import { boundedDiagnosticExcerpt } from "./diagnostics.ts";
import { isXRegionWithheld } from "./x_restriction.ts";

export interface DownloadedArtifact {
  readonly path: string;
  readonly temporaryAttemptId: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly container: string;
  readonly videoCodec: string;
  readonly audioCodec: string | null;
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
  readonly title: string | null;
  readonly selection: FormatSelection;
}

export interface Downloader {
  download(
    url: string,
    signal?: AbortSignal,
    attempt?: DownloadAttempt,
  ): Promise<DownloadedArtifact>;
  heartbeat(artifact: DownloadedArtifact): Promise<void>;
  cleanup(artifact: DownloadedArtifact): Promise<void>;
}

export interface DownloadAttempt {
  readonly jobId: string;
  readonly ownerId: string;
  readonly attemptId: string;
}

export type DownloadPhase =
  | "metadata"
  | "media_download"
  | "video_download"
  | "audio_download"
  | "mux"
  | "validation";

export interface DownloadPhaseObservation {
  readonly jobId: string;
  readonly attemptId: string;
  readonly phase: DownloadPhase;
  readonly candidate?: number;
  readonly outcome: "success" | "unavailable" | "failure";
  readonly durationMilliseconds: number;
  readonly errorCode?: ErrorCode;
  readonly failureKind?: "process_exit" | "invalid_output";
  readonly processExitCode?: number;
  readonly stderrExcerpt?: string;
  readonly metadataValidationIssue?: string;
  readonly sourceMediaCount?: number;
  readonly selectedMediaIndex?: number;
  readonly retryKind?: "source_timeout";
  readonly sourceRestriction?: "region_withheld";
}

export type DownloadPhaseObserver = (observation: DownloadPhaseObservation) => void;

export interface DownloaderOptions {
  readonly ytDlpPath: string;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly temporaryRoot: string;
  readonly timeoutSeconds: number;
  readonly maximumDurationSeconds: number;
  readonly maximumHeight: number;
  readonly maximumBytes: number;
  readonly safetyBytes: number;
  readonly maximumTemporaryBytes: number;
}

const JOB_MARKER = ".video-downloader-job.json";
const JOB_MARKER_VERSION = 1;

interface JobMarker extends DownloadAttempt {
  readonly version: typeof JOB_MARKER_VERSION;
}

interface ExtractedMetadata {
  readonly value: DownloaderMetadata;
  readonly infoJson: Uint8Array;
  readonly sourceMediaCount: number;
  readonly selectedMediaIndex: number;
}

export class YtDlpDownloader implements Downloader {
  constructor(
    private readonly options: DownloaderOptions,
    private readonly processRunner: typeof runProcess = runProcess,
    private readonly markerWriter: typeof Deno.writeTextFile = Deno.writeTextFile,
    private readonly observePhase?: DownloadPhaseObserver,
    private readonly regionWithheldProbe: typeof isXRegionWithheld = isXRegionWithheld,
  ) {}

  async download(
    url: string,
    signal?: AbortSignal,
    attempt: DownloadAttempt = {
      jobId: crypto.randomUUID(),
      ownerId: "direct-adapter-call",
      attemptId: crypto.randomUUID(),
    },
  ): Promise<DownloadedArtifact> {
    const extracted = await this.measurePhase(
      attempt,
      "metadata",
      undefined,
      () => this.metadata(url, signal),
      () => false,
      (value) => ({
        sourceMediaCount: value.sourceMediaCount,
        selectedMediaIndex: value.selectedMediaIndex,
      }),
    );
    const metadata = extracted.value;
    if (metadata.duration != null && metadata.duration > this.options.maximumDurationSeconds) {
      throw new DomainError(
        "source_unavailable",
        "The source video exceeds the configured duration limit",
      );
    }
    const candidates = rankFormats(
      metadata,
      this.options.maximumHeight,
      this.options.maximumBytes,
      this.options.safetyBytes,
    ).filter((candidate) => {
      if (candidate.estimatedBytes === null) return true;
      const expectedTemporaryBytes = candidate.audioFormatId
        ? candidate.estimatedBytes * 2
        : candidate.estimatedBytes;
      return expectedTemporaryBytes <= this.options.maximumTemporaryBytes;
    });
    if (candidates.length === 0) throw temporaryLimitError();

    await prepareTemporaryRoot(this.options.temporaryRoot);
    const directory = await Deno.makeTempDir({ dir: this.options.temporaryRoot, prefix: "job-" });
    try {
      await this.markerWriter(
        join(directory, JOB_MARKER),
        JSON.stringify({ version: JOB_MARKER_VERSION, ...attempt }),
        { createNew: true },
      );
    } catch (error) {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
      throw error;
    }
    try {
      for (const [candidateIndex, candidate] of candidates.entries()) {
        await clearDirectory(directory);
        const path = candidate.audioFormatId
          ? await this.downloadSplitFormat(
            extracted.infoJson,
            candidate.videoFormatId,
            candidate.audioFormatId,
            directory,
            attempt,
            candidateIndex + 1,
            signal,
          )
          : await this.measurePhase(
            attempt,
            "media_download",
            candidateIndex + 1,
            () =>
              this.downloadFormat(
                extracted.infoJson,
                candidate.videoFormatId,
                "media",
                directory,
                signal,
              ),
            (result) => result === null,
          );
        if (!path) continue;
        const artifact = await this.measurePhase(
          attempt,
          "validation",
          candidateIndex + 1,
          () =>
            this.validate(
              path,
              metadata,
              candidate,
              attempt.attemptId,
              signal,
            ),
        );
        if (artifact.byteSize <= this.options.maximumBytes) return artifact;
        await Deno.remove(path).catch(() => undefined);
      }
      throw new DomainError(
        "no_format_within_limit",
        "No downloaded source format fits the upload limit",
      );
    } catch (error) {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
      throw error;
    }
  }

  async heartbeat(artifact: DownloadedArtifact): Promise<void> {
    const directory = await this.managedArtifactDirectory(artifact);
    await Deno.utime(join(directory, JOB_MARKER), new Date(), new Date());
  }

  async cleanup(artifact: DownloadedArtifact): Promise<void> {
    const directory = await this.managedArtifactDirectory(artifact);
    await Deno.remove(directory, { recursive: true });
  }

  private async managedArtifactDirectory(artifact: DownloadedArtifact): Promise<string> {
    const root = resolve(this.options.temporaryRoot);
    const directory = resolve(dirname(artifact.path));
    if (dirname(directory) !== root) {
      throw new DomainError(
        "cleanup_failure",
        "Temporary media cleanup refused an unmanaged path",
      );
    }
    const directoryStat = await Deno.lstat(directory).catch(() => null);
    const marker = await readJobMarker(directory);
    if (
      !directoryStat?.isDirectory || directoryStat.isSymlink || !marker ||
      marker.attemptId !== artifact.temporaryAttemptId
    ) {
      throw new DomainError(
        "cleanup_failure",
        "Temporary media cleanup refused an unmanaged path",
      );
    }
    return directory;
  }

  private async downloadSplitFormat(
    infoJson: Uint8Array,
    videoFormatId: string,
    audioFormatId: string,
    directory: string,
    attempt: DownloadAttempt,
    candidate: number,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const controller = new AbortController();
    const candidateSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    let unavailable = false;
    let primaryError: unknown;
    let hasPrimaryError = false;
    const downloadTrack = async (
      phase: "video_download" | "audio_download",
      formatId: string,
      outputPrefix: string,
    ): Promise<string | null> => {
      try {
        const path = await this.measurePhase(
          attempt,
          phase,
          candidate,
          () => this.downloadFormat(infoJson, formatId, outputPrefix, directory, candidateSignal),
          (result) => result === null,
        );
        if (!path) {
          unavailable = true;
          controller.abort();
        }
        return path;
      } catch (error) {
        if (!controller.signal.aborted) {
          primaryError = error;
          hasPrimaryError = true;
        }
        controller.abort();
        throw error;
      }
    };
    const [video, audio] = await Promise.allSettled([
      downloadTrack("video_download", videoFormatId, "video"),
      downloadTrack("audio_download", audioFormatId, "audio"),
    ]);
    if (hasPrimaryError) throw primaryError;
    if (signal?.aborted) {
      const rejection = [video, audio].find((result) => result.status === "rejected");
      if (rejection?.status === "rejected") throw rejection.reason;
    }
    if (unavailable) return null;
    if (video.status === "rejected") throw video.reason;
    if (audio.status === "rejected") throw audio.reason;
    const videoPath = video.value;
    const audioPath = audio.value;
    if (!videoPath || !audioPath) return null;

    const outputPath = join(directory, "media.mp4");
    return await this.measurePhase(
      attempt,
      "mux",
      candidate,
      async () => {
        const existingBytes = await assertTemporaryBudget(
          directory,
          this.options.maximumTemporaryBytes,
        );
        const outputLimit = this.options.maximumTemporaryBytes - existingBytes;
        if (outputLimit <= 0) throw temporaryLimitError();
        const merged = await this.processRunner(this.options.ffmpegPath, [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          videoPath,
          "-i",
          audioPath,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          "-fs",
          String(outputLimit),
          outputPath,
        ], {
          timeoutMs: 30_000,
          signal,
          cwd: directory,
          monitor: temporaryBudgetMonitor(directory, this.options.maximumTemporaryBytes),
        });
        await assertTemporaryBudget(directory, this.options.maximumTemporaryBytes);
        return merged.code === 0 ? outputPath : null;
      },
      (result) => result === null,
    );
  }

  private async measurePhase<Value>(
    attempt: DownloadAttempt,
    phase: DownloadPhase,
    candidate: number | undefined,
    operation: () => Promise<Value>,
    unavailable: (value: Value) => boolean = () => false,
    successFields: (
      value: Value,
    ) => Partial<Pick<DownloadPhaseObservation, "sourceMediaCount" | "selectedMediaIndex">> =
      () => ({}),
  ): Promise<Value> {
    const startedAt = performance.now();
    try {
      const value = await operation();
      this.emitPhase({
        jobId: attempt.jobId,
        attemptId: attempt.attemptId,
        phase,
        ...(candidate === undefined ? {} : { candidate }),
        ...successFields(value),
        outcome: unavailable(value) ? "unavailable" : "success",
        durationMilliseconds: elapsedMilliseconds(startedAt),
      });
      return value;
    } catch (error) {
      this.emitPhase({
        jobId: attempt.jobId,
        attemptId: attempt.attemptId,
        phase,
        ...(candidate === undefined ? {} : { candidate }),
        outcome: "failure",
        durationMilliseconds: elapsedMilliseconds(startedAt),
        ...downloadFailureFields(error),
      });
      throw error;
    }
  }

  private emitPhase(observation: DownloadPhaseObservation): void {
    try {
      this.observePhase?.(observation);
    } catch {
      // Observability must never change download behavior.
    }
  }

  private async downloadFormat(
    infoJson: Uint8Array,
    formatId: string,
    outputPrefix: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const existingBytes = await assertTemporaryBudget(
      directory,
      this.options.maximumTemporaryBytes,
    );
    const remainingBytes = this.options.maximumTemporaryBytes - existingBytes;
    if (remainingBytes <= 0) throw temporaryLimitError();
    const result = await this.processRunner(this.options.ytDlpPath, [
      "--no-playlist",
      "--no-warnings",
      "--no-simulate",
      "--newline",
      "--progress-template",
      'download:VD_PROGRESS {"status":%(progress.status)j,"downloaded_bytes":%(progress.downloaded_bytes)j,"total_bytes":%(progress.total_bytes)j,"total_bytes_estimate":%(progress.total_bytes_estimate)j}',
      "--ies",
      "Twitter",
      "--load-info-json",
      "-",
      "--format",
      formatId,
      "--max-filesize",
      String(remainingBytes),
      "--ffmpeg-location",
      this.options.ffmpegPath,
      "--output",
      join(directory, `${outputPrefix}.%(ext)s`),
    ], {
      timeoutMs: this.options.timeoutSeconds * 1000,
      signal,
      stdin: infoJson,
      cwd: directory,
      monitor: temporaryBudgetMonitor(directory, this.options.maximumTemporaryBytes),
    });
    await assertTemporaryBudget(directory, this.options.maximumTemporaryBytes);
    if (result.code !== 0) return null;
    return await findOutputFile(directory, outputPrefix);
  }

  private async metadata(url: string, signal?: AbortSignal): Promise<ExtractedMetadata> {
    const result = await this.processRunner(this.options.ytDlpPath, [
      "--simulate",
      "--dump-single-json",
      "--no-playlist",
      "--playlist-items",
      "1",
      "--no-warnings",
      "--ies",
      "Twitter",
      "--",
      url,
    ], { timeoutMs: this.options.timeoutSeconds * 1000, signal });
    if (result.code !== 0) {
      if (
        /^ERROR: \[twitter\] \d+: No video could be found in this tweet\s*$/m.test(result.stderr)
      ) {
        const regionWithheld = await this.regionWithheldProbe(url, signal);
        if (signal?.aborted) throw new DomainError("cancelled", "The download was cancelled");
        if (regionWithheld) {
          throw new DomainError(
            "source_unavailable",
            "X has withheld this post in the download server's region due to local law",
            false,
            {
              failureKind: "process_exit",
              processExitCode: result.code,
              sourceRestriction: "region_withheld",
            },
          );
        }
      }
      const sourceTimedOut = isSourceMetadataTimeout(result.stderr);
      throw new DomainError(
        "extractor_failure",
        "The X extractor could not read this post",
        true,
        {
          failureKind: "process_exit",
          processExitCode: result.code,
          stderrExcerpt: boundedDiagnosticExcerpt(result.stderr),
          ...(sourceTimedOut ? { retryKind: "source_timeout" } : {}),
        },
      );
    }
    try {
      const parsed = parseDownloaderMetadata(
        JSON.parse(new TextDecoder().decode(result.stdout)),
      );
      return {
        value: parsed.value,
        infoJson: new TextEncoder().encode(JSON.stringify(parsed.value)),
        sourceMediaCount: parsed.sourceMediaCount,
        selectedMediaIndex: parsed.selectedMediaIndex,
      };
    } catch (error) {
      throw new DomainError(
        "extractor_failure",
        "The extractor returned invalid media metadata",
        true,
        {
          failureKind: "invalid_output",
          processExitCode: result.code,
          stderrExcerpt: boundedDiagnosticExcerpt(result.stderr),
          metadataValidationIssue: describeMetadataValidationError(error),
        },
      );
    }
  }

  private async validate(
    path: string,
    metadata: DownloaderMetadata,
    selection: FormatSelection,
    expectedAttemptId: string,
    signal?: AbortSignal,
  ): Promise<DownloadedArtifact> {
    await assertTemporaryBudget(dirname(path), this.options.maximumTemporaryBytes);
    const stat = await Deno.stat(path);
    if (!stat.isFile) {
      throw new DomainError("processing_failure", "The downloader did not produce a file");
    }
    const result = await this.processRunner(this.options.ffprobePath, [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      "--",
      path,
    ], { timeoutMs: 30_000, signal });
    if (result.code !== 0) {
      throw new DomainError("processing_failure", "The downloaded media failed validation");
    }
    const probe = parseProbe(JSON.parse(new TextDecoder().decode(result.stdout)));
    if (probe.duration > this.options.maximumDurationSeconds) {
      throw new DomainError(
        "source_unavailable",
        "The source video exceeds the configured duration limit",
      );
    }
    const sha256 = await hashFile(path);
    const marker = await readJobMarker(dirname(path));
    if (!marker || marker.attemptId !== expectedAttemptId) {
      throw new DomainError("processing_failure", "Temporary media ownership was invalid");
    }
    return {
      path,
      temporaryAttemptId: expectedAttemptId,
      byteSize: stat.size,
      sha256,
      container: probe.container,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      durationSeconds: probe.duration,
      width: probe.width,
      height: probe.height,
      title: metadata.title ?? null,
      selection,
    };
  }
}

function downloadFailureFields(error: unknown): Partial<DownloadPhaseObservation> {
  if (!(error instanceof DomainError)) return {};
  const fields: {
    errorCode: ErrorCode;
    failureKind?: "process_exit" | "invalid_output";
    processExitCode?: number;
    stderrExcerpt?: string;
    metadataValidationIssue?: string;
    retryKind?: "source_timeout";
    sourceRestriction?: "region_withheld";
  } = { errorCode: error.code };
  const details = error.details;
  if (
    details?.failureKind === "process_exit" || details?.failureKind === "invalid_output"
  ) {
    fields.failureKind = details.failureKind;
  }
  if (typeof details?.processExitCode === "number" && Number.isInteger(details.processExitCode)) {
    fields.processExitCode = details.processExitCode;
  }
  if (typeof details?.stderrExcerpt === "string") fields.stderrExcerpt = details.stderrExcerpt;
  if (typeof details?.metadataValidationIssue === "string") {
    fields.metadataValidationIssue = details.metadataValidationIssue;
  }
  if (details?.retryKind === "source_timeout") fields.retryKind = details.retryKind;
  if (details?.sourceRestriction === "region_withheld") {
    fields.sourceRestriction = details.sourceRestriction;
  }
  return fields;
}

function isSourceMetadataTimeout(stderr: string): boolean {
  return /\b(?:timed out|timeout(?:error)?)\b/i.test(stderr);
}

async function findOutputFile(directory: string, prefix: string): Promise<string | null> {
  const matches: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && entry.name.startsWith(`${prefix}.`) && !entry.name.endsWith(".part")) {
      matches.push(join(directory, entry.name));
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

async function clearDirectory(directory: string): Promise<void> {
  for await (const entry of Deno.readDir(directory)) {
    if (entry.name === JOB_MARKER) continue;
    await Deno.remove(join(directory, entry.name), { recursive: entry.isDirectory });
  }
}

export async function prepareTemporaryRoot(root: string): Promise<void> {
  await Deno.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await Deno.lstat(root);
  if (!stat.isDirectory || stat.isSymlink) {
    throw new DomainError("cleanup_failure", "The configured temporary path is not a directory");
  }
  const probe = join(root, `.write-probe-${crypto.randomUUID()}`);
  try {
    await Deno.writeFile(probe, new Uint8Array(), { createNew: true, mode: 0o600 });
  } finally {
    await Deno.remove(probe).catch(() => undefined);
  }
}

export async function cleanupAbandonedTemporaryDirectories(
  root: string,
  options: {
    readonly isLeaseActive: (marker: DownloadAttempt) => boolean | Promise<boolean>;
    readonly staleAfterMs: number;
    readonly now?: Date;
  },
): Promise<number> {
  await prepareTemporaryRoot(root);
  let removed = 0;
  const now = options.now ?? new Date();
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory) continue;
    const directory = join(root, entry.name);
    const marker = await readJobMarker(directory);
    if (!marker || await options.isLeaseActive(marker)) continue;
    let markerStat: Deno.FileInfo;
    try {
      markerStat = await Deno.stat(join(directory, JOB_MARKER));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    if (
      !markerStat.mtime ||
      now.getTime() - markerStat.mtime.getTime() < options.staleAfterMs
    ) continue;
    await Deno.remove(directory, { recursive: true });
    removed++;
  }
  return removed;
}

async function readJobMarker(directory: string): Promise<JobMarker | null> {
  try {
    const value = JSON.parse(await Deno.readTextFile(join(directory, JOB_MARKER))) as {
      version?: unknown;
      jobId?: unknown;
      ownerId?: unknown;
      attemptId?: unknown;
    };
    return value.version === JOB_MARKER_VERSION && isUuid(value.jobId) &&
        typeof value.ownerId === "string" && value.ownerId.length > 0 &&
        value.ownerId.length <= 200 && isUuid(value.attemptId)
      ? {
        version: JOB_MARKER_VERSION,
        jobId: value.jobId,
        ownerId: value.ownerId,
        attemptId: value.attemptId,
      }
      : null;
  } catch {
    return null;
  }
}

function temporaryBudgetMonitor(directory: string, maximumBytes: number) {
  let lastHeartbeat = 0;
  return {
    intervalMs: 50,
    check: async () => {
      await assertTemporaryBudget(directory, maximumBytes);
      if (Date.now() - lastHeartbeat >= 1_000) {
        await Deno.utime(join(directory, JOB_MARKER), new Date(), new Date());
        lastHeartbeat = Date.now();
      }
    },
  };
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function assertTemporaryBudget(directory: string, maximumBytes: number): Promise<number> {
  const usedBytes = await temporaryMediaBytes(directory);
  if (usedBytes > maximumBytes) throw temporaryLimitError();
  return usedBytes;
}

async function temporaryMediaBytes(directory: string): Promise<number> {
  let total = 0;
  for await (const entry of Deno.readDir(directory)) {
    if (entry.name === JOB_MARKER) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory) {
      total += await temporaryMediaBytes(path);
    } else if (entry.isFile) {
      try {
        total += (await Deno.stat(path)).size;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    } else if (entry.isSymlink) {
      throw new DomainError("processing_failure", "Temporary media contained an unsafe link");
    }
  }
  return total;
}

function temporaryLimitError(): DomainError {
  return new DomainError(
    "temp_storage_limit",
    "Temporary media exceeded the configured byte budget",
  );
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1_000) / 1_000;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await Deno.open(path, { read: true });
  for await (const chunk of file.readable) hash.update(chunk);
  return hash.digest("hex");
}

function parseProbe(value: unknown) {
  const object = value as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const streams = object.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(object.format?.duration ?? video?.duration);
  const width = Number(video?.width);
  const height = Number(video?.height);
  const videoCodec = String(video?.codec_name ?? "");
  if (
    !video || !Number.isFinite(duration) || duration <= 0 || width <= 0 || height <= 0 ||
    !videoCodec
  ) {
    throw new DomainError("processing_failure", "The downloaded file has invalid video metadata");
  }
  return {
    duration,
    width,
    height,
    videoCodec,
    audioCodec: audio?.codec_name ? String(audio.codec_name) : null,
    container: String(object.format?.format_name ?? "mp4").split(",").includes("mp4")
      ? "mp4"
      : String(object.format?.format_name).split(",")[0],
  };
}
