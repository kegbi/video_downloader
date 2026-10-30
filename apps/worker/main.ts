import { loadConfig } from "../../packages/config/mod.ts";
import { closeDatabase, createDatabase, databaseReady } from "../../packages/db/client.ts";
import { Repository } from "../../packages/db/repository.ts";
import { abortableDelay, RandomIdGenerator, SystemClock } from "../../packages/domain/time.ts";
import {
  cleanupAbandonedTemporaryDirectories,
  YtDlpDownloader,
} from "../../packages/downloader/adapter.ts";
import { createLogger } from "../../packages/observability/logger.ts";
import { MetricsRegistry } from "../../packages/observability/metrics.ts";
import { RabbitJobConsumer } from "../../packages/queue/rabbitmq.ts";
import { S3ArtifactStorage } from "../../packages/storage/s3.ts";
import { WorkerOrchestrator } from "./orchestrator.ts";

const config = loadConfig("worker");
const logger = createLogger("worker", config.APP_LOG_LEVEL, {}, console.log, config.LOKI_PUSH_URL);
const metrics = new MetricsRegistry();
const database = createDatabase(config);
const ids = new RandomIdGenerator();
const repository = new Repository(database, new SystemClock(), ids);
const storage = new S3ArtifactStorage(config);
const workerId = crypto.randomUUID();
const controller = new AbortController();
const reclaimAbandonedDirectories = () =>
  cleanupAbandonedTemporaryDirectories(config.DOWNLOAD_TEMP_DIR, {
    staleAfterMs: config.WORKER_JOB_LEASE_SECONDS * 1000,
    isLeaseActive: async (marker) => {
      const job = await repository.getJob(marker.jobId);
      return Boolean(
        job && (job.state === "downloading" || job.state === "processing") &&
          job.leaseOwner === marker.ownerId && job.leaseExpiresAt &&
          job.leaseExpiresAt > new Date(),
      );
    },
  });
const abandonedDirectories = await reclaimAbandonedDirectories();
if (abandonedDirectories > 0) {
  logger.info("worker.temp_recovered", { directoryCount: abandonedDirectories });
}
const downloader = new YtDlpDownloader(
  {
    ytDlpPath: config.YTDLP_PATH,
    ffmpegPath: config.FFMPEG_PATH,
    ffprobePath: config.FFPROBE_PATH,
    temporaryRoot: config.DOWNLOAD_TEMP_DIR,
    timeoutSeconds: config.DOWNLOAD_TIMEOUT_SECONDS,
    maximumDurationSeconds: config.DOWNLOAD_MAX_DURATION_SECONDS,
    maximumHeight: config.DOWNLOAD_MAX_HEIGHT,
    maximumBytes: config.MAX_ARTIFACT_BYTES,
    safetyBytes: config.DOWNLOAD_FORMAT_SAFETY_BYTES,
    maximumTemporaryBytes: config.DOWNLOAD_MAX_TEMP_BYTES,
  },
  undefined,
  undefined,
  (observation) => logger.info("job.download_phase", { ...observation }),
);
const consumer = new RabbitJobConsumer(config);
const temporaryCleanupTask = (async () => {
  while (!controller.signal.aborted) {
    await abortableDelay(config.WORKER_JOB_LEASE_SECONDS * 1000, controller.signal).catch(() =>
      undefined
    );
    if (controller.signal.aborted) break;
    try {
      const removed = await reclaimAbandonedDirectories();
      if (removed > 0) logger.info("worker.temp_recovered", { directoryCount: removed });
    } catch {
      logger.warn("worker.temp_recovery_failed");
    }
  }
})();
const tools = {
  ytDlp: await commandReady(config.YTDLP_PATH, ["--version"]),
  ffmpeg: await commandReady(config.FFMPEG_PATH, ["-version"]),
  ffprobe: await commandReady(config.FFPROBE_PATH, ["-version"]),
};
const orchestrator = new WorkerOrchestrator(
  config,
  repository,
  downloader,
  storage,
  ids,
  workerId,
  Deno.stat,
  (event, fields) => logger.info(event, { ...fields }),
);
await consumer.start(async (jobId) => {
  const startedAt = performance.now();
  metrics.increment("video_downloader_worker_jobs_received_total");
  logger.info("job.received", { jobId });
  const disposition = await orchestrator.process(jobId);
  metrics.increment(`video_downloader_worker_jobs_${disposition}_total`);
  metrics.increment(
    "video_downloader_worker_job_duration_seconds_total",
    (performance.now() - startedAt) / 1000,
  );
  const completed = await repository.getJob(jobId);
  if (completed?.errorCode && /^[a-z0-9_]+$/.test(completed.errorCode)) {
    metrics.increment(`video_downloader_worker_error_${completed.errorCode}_total`);
  }
  logger.info("job.finished", {
    jobId,
    disposition,
    finalState: completed?.state ?? "missing",
    errorCode: completed?.errorCode ?? null,
    durationMilliseconds: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
  });
  return disposition;
});

const server = Deno.serve(
  { hostname: "0.0.0.0", port: 8081, signal: controller.signal },
  async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/health/live") return Response.json({ status: "ok" });
    if (path === config.METRICS_PATH && config.METRICS_ENABLED) {
      return new Response(metrics.render(), {
        headers: { "content-type": "text/plain; version=0.0.4" },
      });
    }
    if (path === "/health/ready") {
      const [databaseOk, storageOk] = await Promise.all([
        databaseReady(database),
        storage.healthy(),
      ]);
      const toolsOk = tools.ytDlp && tools.ffmpeg && tools.ffprobe;
      const ready = databaseOk && storageOk && consumer.healthy() && toolsOk;
      return Response.json({
        status: ready ? "ready" : "not_ready",
        database: databaseOk,
        storage: storageOk,
        queue: consumer.healthy(),
        tools,
      }, { status: ready ? 200 : 503 });
    }
    return new Response("Not found", { status: 404 });
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => controller.abort());
}
await server.finished;
await consumer.close();
await temporaryCleanupTask;
await closeDatabase(database, { timeout: 10 });
await logger.close();

async function commandReady(command: string, args: string[]): Promise<boolean> {
  try {
    return (await new Deno.Command(command, {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output()).success;
  } catch {
    return false;
  }
}
