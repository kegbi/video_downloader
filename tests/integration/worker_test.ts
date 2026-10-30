import { assertEquals, assertExists } from "@std/assert";
import { dirname } from "@std/path";
import { WorkerOrchestrator } from "../../apps/worker/orchestrator.ts";
import { loadConfig } from "../../packages/config/mod.ts";
import { closeDatabase, createDatabase } from "../../packages/db/client.ts";
import { runMigrations } from "../../packages/db/migrations.ts";
import { Repository } from "../../packages/db/repository.ts";
import {
  type DownloadedArtifact,
  type Downloader,
  YtDlpDownloader,
} from "../../packages/downloader/adapter.ts";
import { DomainError } from "../../packages/domain/errors.ts";
import { MutableClock, RandomIdGenerator } from "../../packages/domain/time.ts";
import type { ArtifactRead, ArtifactStorage } from "../../packages/storage/s3.ts";

const fixtureSalt = new TextEncoder().encode(crypto.randomUUID());

Deno.test({
  name:
    "fixture worker handles success, duplicate, oversize, cancellation, timeout and storage retry",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const config = loadConfig("test", {
      APP_ENV: "test",
      POSTGRES_HOST: Deno.env.get("TEST_POSTGRES_HOST") ?? "127.0.0.1",
      POSTGRES_PORT: Deno.env.get("TEST_POSTGRES_PORT") ?? "5432",
      POSTGRES_DB: Deno.env.get("TEST_POSTGRES_DB") ?? "video_downloader_test",
      POSTGRES_USER: Deno.env.get("TEST_POSTGRES_USER") ?? "video_downloader_test",
      POSTGRES_PASSWORD: Deno.env.get("TEST_POSTGRES_PASSWORD") ?? "local-postgres-password",
      TELEGRAM_MAX_UPLOAD_BYTES: "1000",
      DOWNLOAD_FORMAT_SAFETY_BYTES: "100",
      MAX_ARTIFACT_BYTES: "1000",
      DOWNLOAD_MAX_TEMP_BYTES: "2100",
      WORKER_HEARTBEAT_SECONDS: "1",
      WORKER_JOB_LEASE_SECONDS: "5",
    });
    const database = createDatabase(config);
    const temporaryRoot = await Deno.makeTempDir();
    try {
      await runMigrations(database, [
        new URL("../../migrations/", import.meta.url),
        new URL("../../drizzle/", import.meta.url),
      ]);
      const repository = new Repository(
        database,
        new MutableClock(new Date("2026-08-12T12:00:00Z")),
        new RandomIdGenerator(),
      );
      const userId = String(70_000_000_000 + Math.floor(Math.random() * 1_000_000));
      await repository.upsertTelegramPrincipal({ externalUserId: userId });

      const success = await submit(repository, userId);
      const successStorage = new MemoryStorage();
      const lifecycle: Array<{ event: string; fields: Readonly<Record<string, unknown>> }> = [];
      const successWorker = new WorkerOrchestrator(
        config,
        repository,
        new FixtureDownloader(temporaryRoot, { mode: "success", byteSize: 100 }),
        successStorage,
        new RandomIdGenerator(),
        "fixture-worker",
        Deno.stat,
        (event, fields) => lifecycle.push({ event, fields }),
      );
      assertEquals(await successWorker.process(success), "ack");
      assertEquals((await repository.getJob(success))?.state, "ready");
      assertExists((await repository.getJob(success))?.artifactId);
      assertEquals(successStorage.temporary.size, 0);
      assertEquals(successStorage.final.size, 1);
      assertEquals(
        lifecycle.filter(({ event }) => event === "job.phase").map(({ fields }) => fields.phase),
        [
          "source_deduplication",
          "download_pipeline",
          "processing_transition",
          "content_deduplication",
          "artifact_create",
          "local_file_check",
          "object_upload",
          "object_promote",
          "artifact_finalize",
          "temporary_cleanup",
        ],
      );
      const claimed = lifecycle.find(({ event }) => event === "job.claimed")?.fields;
      assertEquals(claimed?.claimedFromState, "queued");
      assertEquals(claimed?.queueDurationMilliseconds, 0);
      assertEquals(lifecycle.some(({ event }) => event === "job.ready"), true);
      assertEquals(await successWorker.process(success), "ack");
      assertEquals(successStorage.final.size, 1);

      const oversize = await submit(repository, userId);
      const oversizeWorker = new WorkerOrchestrator(
        config,
        repository,
        new FixtureDownloader(temporaryRoot, { mode: "success", byteSize: 1001 }),
        new MemoryStorage(),
        new RandomIdGenerator(),
        "oversize-worker",
      );
      assertEquals(await oversizeWorker.process(oversize), "ack");
      assertEquals((await repository.getJob(oversize))?.errorCode, "no_format_within_limit");

      for (
        const [mode, code, expected] of [
          ["cancelled", "cancelled", "ack"],
          ["timeout", "timeout", "retry"],
          ["source_timeout", "extractor_failure", "retry_source_timeout"],
          ["source", "source_unavailable", "ack"],
          ["crash", "processing_failure", "ack"],
        ] as const
      ) {
        const id = await submit(repository, userId);
        const worker = new WorkerOrchestrator(
          config,
          repository,
          new FixtureDownloader(temporaryRoot, { mode, byteSize: 100 }),
          new MemoryStorage(),
          new RandomIdGenerator(),
          `${mode}-worker`,
        );
        assertEquals(await worker.process(id), expected);
        const job = await repository.getJob(id);
        assertEquals(job?.errorCode, code);
        assertEquals(
          job?.state,
          mode === "cancelled"
            ? "cancelled"
            : mode === "timeout" || mode === "source_timeout"
            ? "queued"
            : "failed",
        );
        if (mode === "source_timeout") {
          assertEquals(job?.progressPhase, "retrying_source_timeout");
        } else if (mode === "timeout") {
          assertEquals(job?.progressPhase, "queued");
        }
      }

      const restricted = await submit(repository, userId);
      let restrictedAttempts = 0;
      const restrictedStorage = new MemoryStorage();
      const restrictedWorker = new WorkerOrchestrator(
        config,
        repository,
        new YtDlpDownloader(
          {
            ytDlpPath: "yt-dlp",
            ffmpegPath: "ffmpeg",
            ffprobePath: "ffprobe",
            temporaryRoot,
            timeoutSeconds: 60,
            maximumDurationSeconds: 60,
            maximumHeight: 1080,
            maximumBytes: 1000,
            maximumTemporaryBytes: 2100,
            safetyBytes: 100,
          },
          () => {
            restrictedAttempts++;
            return Promise.resolve({
              code: 1,
              stdout: new Uint8Array(),
              stderr: "ERROR: [twitter] 123: No video could be found in this tweet",
            });
          },
          undefined,
          undefined,
          () => Promise.resolve(true),
        ),
        restrictedStorage,
        new RandomIdGenerator(),
        "region-restricted-worker",
      );
      assertEquals(await restrictedWorker.process(restricted), "ack");
      assertEquals(await restrictedWorker.process(restricted), "ack");
      const restrictedJob = await repository.getJob(restricted);
      assertEquals(restrictedJob?.state, "failed");
      assertEquals(restrictedJob?.errorCode, "source_unavailable");
      assertEquals(
        restrictedJob?.safeErrorMessage,
        "X has withheld this post in the download server's region due to local law",
      );
      assertEquals(restrictedJob?.attempts, 1);
      assertEquals(restrictedAttempts, 1);
      assertEquals(restrictedStorage.final.size, 0);

      const storageFailure = await submit(repository, userId);
      const failingStorage = new MemoryStorage();
      failingStorage.failPut = true;
      const storageWorker = new WorkerOrchestrator(
        config,
        repository,
        new FixtureDownloader(temporaryRoot, { mode: "success", byteSize: 101 }),
        failingStorage,
        new RandomIdGenerator(),
        "storage-worker",
      );
      assertEquals(await storageWorker.process(storageFailure), "retry");
      const storageRetryJob = await repository.getJob(storageFailure);
      assertEquals(storageRetryJob?.state, "queued");
      assertEquals(storageRetryJob?.progressPhase, "queued");
      assertEquals(failingStorage.temporary.size, 0);
    } finally {
      await Deno.remove(temporaryRoot, { recursive: true }).catch(() => undefined);
      await closeDatabase(database, { timeout: 5 });
    }
  },
});

Deno.test({
  name: "worker validates virtual artifact sizes below, at, and above the reviewed local ceiling",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const maximumBytes = 1_990_000_000;
    const config = loadConfig("test", {
      APP_ENV: "test",
      POSTGRES_HOST: Deno.env.get("TEST_POSTGRES_HOST") ?? "127.0.0.1",
      POSTGRES_PORT: Deno.env.get("TEST_POSTGRES_PORT") ?? "5432",
      POSTGRES_DB: Deno.env.get("TEST_POSTGRES_DB") ?? "video_downloader_test",
      POSTGRES_USER: Deno.env.get("TEST_POSTGRES_USER") ?? "video_downloader_test",
      POSTGRES_PASSWORD: Deno.env.get("TEST_POSTGRES_PASSWORD") ?? "local-postgres-password",
      TELEGRAM_MAX_UPLOAD_BYTES: String(maximumBytes),
      DOWNLOAD_FORMAT_SAFETY_BYTES: "2000000",
      MAX_ARTIFACT_BYTES: String(maximumBytes),
      DOWNLOAD_MAX_TEMP_BYTES: "3982000000",
      WORKER_HEARTBEAT_SECONDS: "1",
      WORKER_JOB_LEASE_SECONDS: "5",
    });
    const database = createDatabase(config);
    const temporaryRoot = await Deno.makeTempDir();
    try {
      await runMigrations(database, [
        new URL("../../migrations/", import.meta.url),
        new URL("../../drizzle/", import.meta.url),
      ]);
      const repository = new Repository(
        database,
        new MutableClock(new Date("2026-08-14T12:00:00Z")),
        new RandomIdGenerator(),
      );
      const userId = String(71_000_000_000 + Math.floor(Math.random() * 1_000_000));
      await repository.upsertTelegramPrincipal({ externalUserId: userId });

      for (
        const [label, byteSize, expectedState] of [
          ["below", maximumBytes - 1, "ready"],
          ["exact", maximumBytes, "ready"],
          ["above", maximumBytes + 1, "failed"],
        ] as const
      ) {
        const jobId = await submit(repository, userId);
        const storage = new MetadataOnlyStorage();
        const physicalSizes: number[] = [];
        const worker = new WorkerOrchestrator(
          config,
          repository,
          new VirtualLargeArtifactDownloader(temporaryRoot, byteSize),
          storage,
          new RandomIdGenerator(),
          `virtual-large-${label}-worker`,
          async (path) => {
            const physical = await Deno.stat(path);
            physicalSizes.push(physical.size);
            return { isFile: physical.isFile, size: byteSize };
          },
        );

        assertEquals(await worker.process(jobId), "ack", label);
        const job = await repository.getJob(jobId);
        assertEquals(job?.state, expectedState, label);
        assertEquals(job?.errorCode, expectedState === "failed" ? "no_format_within_limit" : null);
        assertEquals(storage.uploadedSizes, expectedState === "ready" ? [byteSize] : [], label);
        assertEquals(physicalSizes, [32], label);
        assertEquals(await directoryNames(temporaryRoot), [], label);
      }
    } finally {
      await Deno.remove(temporaryRoot, { recursive: true }).catch(() => undefined);
      await closeDatabase(database, { timeout: 5 });
    }
  },
});

async function submit(repository: Repository, userId: string): Promise<string> {
  const sourceId = String(100_000_000 + Math.floor(Math.random() * 900_000_000));
  const result = await repository.submitJob({
    bridge: "telegram",
    idempotencyKey: crypto.randomUUID(),
    requesterExternalUserId: userId,
    submittedUrl: `https://x.com/i/status/${sourceId}`,
    normalizedUrl: `https://x.com/i/status/${sourceId}`,
    sourceId,
    destination: { chatId: userId, requestMessageId: 1 },
    policy: { mode: "ttl", ttlSeconds: 604800, afterDeliveryGraceSeconds: 300 },
    maxQueuedJobs: 1000,
    maxActiveJobsPerUser: 1000,
  });
  return result.job.id;
}

class FixtureDownloader implements Downloader {
  constructor(
    private root: string,
    private behavior: {
      mode: "success" | "cancelled" | "timeout" | "source_timeout" | "source" | "crash";
      byteSize: number;
    },
  ) {}
  async download(): Promise<DownloadedArtifact> {
    if (this.behavior.mode === "cancelled") {
      throw new DomainError("cancelled", "The download was cancelled");
    }
    if (this.behavior.mode === "timeout") {
      throw new DomainError("timeout", "The downloader exceeded its time limit", true);
    }
    if (this.behavior.mode === "source_timeout") {
      throw new DomainError(
        "extractor_failure",
        "The X extractor could not read this post",
        true,
        { retryKind: "source_timeout" },
      );
    }
    if (this.behavior.mode === "source") {
      throw new DomainError("source_unavailable", "The X post has no downloadable video");
    }
    if (this.behavior.mode === "crash") {
      throw new DomainError("processing_failure", "The media process exited unexpectedly");
    }
    const directory = await Deno.makeTempDir({ dir: this.root });
    const path = `${directory}/fixture.mp4`;
    const bytes = new Uint8Array(this.behavior.byteSize).fill(7);
    bytes.set(fixtureSalt.slice(0, Math.min(bytes.length, fixtureSalt.length)));
    await Deno.writeFile(path, bytes);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return {
      path,
      temporaryAttemptId: crypto.randomUUID(),
      byteSize: bytes.length,
      sha256: [...digest].map((value) => value.toString(16).padStart(2, "0")).join(""),
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
      durationSeconds: 1,
      width: 16,
      height: 16,
      title: "fixture",
      selection: {
        selector: "fixture",
        videoFormatId: "fixture",
        audioFormatId: null,
        estimatedBytes: bytes.length,
        height: 16,
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        compatibilityScore: 10,
      },
    };
  }
  heartbeat(): Promise<void> {
    return Promise.resolve();
  }
  async cleanup(artifact: DownloadedArtifact): Promise<void> {
    await Deno.remove(dirname(artifact.path), { recursive: true });
  }
}

class MemoryStorage implements ArtifactStorage {
  readonly temporary = new Map<string, Uint8Array>();
  readonly final = new Map<string, Uint8Array>();
  failPut = false;
  async putTemporary(
    id: string,
    source: { path: string; byteSize: number; sha256: string },
  ): Promise<string> {
    if (this.failPut) return Promise.reject(new Error("storage unavailable"));
    const bytes = await Deno.readFile(source.path);
    this.temporary.set(`temporary/${id}`, bytes);
    return `temporary/${id}`;
  }
  promote(id: string): Promise<string> {
    const bytes = this.temporary.get(`temporary/${id}`)!;
    this.final.set(`artifacts/${id}`, bytes);
    this.temporary.delete(`temporary/${id}`);
    return Promise.resolve(`artifacts/${id}`);
  }
  read(key: string): Promise<ArtifactRead> {
    const bytes = this.final.get(key)!;
    return Promise.resolve({
      body: new Response(bytes.slice().buffer).body!,
      contentLength: bytes.length,
      contentRange: null,
      contentType: "video/mp4",
    });
  }
  delete(key: string): Promise<void> {
    this.temporary.delete(key);
    this.final.delete(key);
    return Promise.resolve();
  }
  healthy(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class VirtualLargeArtifactDownloader implements Downloader {
  private readonly sha256 = crypto.randomUUID().replaceAll("-", "").repeat(2);

  constructor(private readonly root: string, private readonly byteSize: number) {}

  async download(): Promise<DownloadedArtifact> {
    const directory = await Deno.makeTempDir({ dir: this.root });
    const path = `${directory}/virtual-large-fixture.mp4`;
    await Deno.writeFile(path, new Uint8Array(32));
    return {
      path,
      temporaryAttemptId: crypto.randomUUID(),
      byteSize: this.byteSize,
      sha256: this.sha256,
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
      durationSeconds: 1,
      width: 16,
      height: 16,
      title: "virtual large fixture",
      selection: {
        selector: "virtual-large-fixture",
        videoFormatId: "virtual-large-fixture",
        audioFormatId: null,
        estimatedBytes: this.byteSize,
        height: 16,
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        compatibilityScore: 10,
      },
    };
  }

  heartbeat(): Promise<void> {
    return Promise.resolve();
  }

  async cleanup(artifact: DownloadedArtifact): Promise<void> {
    await Deno.remove(dirname(artifact.path), { recursive: true });
  }
}

class MetadataOnlyStorage implements ArtifactStorage {
  readonly uploadedSizes: number[] = [];

  putTemporary(
    id: string,
    source: { path: string; byteSize: number; sha256: string },
  ): Promise<string> {
    this.uploadedSizes.push(source.byteSize);
    return Promise.resolve(`temporary/${id}`);
  }

  promote(id: string): Promise<string> {
    return Promise.resolve(`artifacts/${id}`);
  }

  read(): Promise<ArtifactRead> {
    throw new Error("Virtual boundary fixtures are never read into memory");
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }

  healthy(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

async function directoryNames(root: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(root)) names.push(entry.name);
  return names.sort();
}
