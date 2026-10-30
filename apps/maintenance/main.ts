import { loadConfig } from "../../packages/config/mod.ts";
import { closeDatabase, createDatabase, databaseReady } from "../../packages/db/client.ts";
import { Repository } from "../../packages/db/repository.ts";
import { abortableDelay, RandomIdGenerator, SystemClock } from "../../packages/domain/time.ts";
import { createLogger } from "../../packages/observability/logger.ts";
import { MetricsRegistry } from "../../packages/observability/metrics.ts";
import { OutboxPublisher } from "../../packages/queue/outbox.ts";
import { RabbitJobQueue } from "../../packages/queue/rabbitmq.ts";
import { S3ArtifactStorage } from "../../packages/storage/s3.ts";
import { MaintenanceService } from "./service.ts";

const config = loadConfig("maintenance");
const logger = createLogger(
  "maintenance",
  config.APP_LOG_LEVEL,
  {},
  console.log,
  config.LOKI_PUSH_URL,
);
const metrics = new MetricsRegistry();
const database = createDatabase(config);
const repository = new Repository(database, new SystemClock(), new RandomIdGenerator());
const storage = new S3ArtifactStorage(config);
const queue = new RabbitJobQueue(config);
await queue.connect();
const workerId = `maintenance-${crypto.randomUUID()}`;
const service = new MaintenanceService(
  config,
  repository,
  storage,
  new OutboxPublisher(
    repository,
    queue,
    workerId,
    (event, fields) => logger.info(event, { ...fields }),
  ),
  logger,
);
const controller = new AbortController();
const server = Deno.serve(
  { hostname: "0.0.0.0", port: 8083, signal: controller.signal },
  async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/health/live") return Response.json({ status: "ok" });
    if (path === config.METRICS_PATH && config.METRICS_ENABLED) {
      return new Response(metrics.render(), {
        headers: { "content-type": "text/plain; version=0.0.4" },
      });
    }
    if (path === "/health/ready") {
      const [postgres, objectStorage] = await Promise.all([
        databaseReady(database),
        storage.healthy(),
      ]);
      const ready = postgres && objectStorage && queue.healthy();
      return Response.json(
        { status: ready ? "ready" : "not_ready", postgres, objectStorage, queue: queue.healthy() },
        { status: ready ? 200 : 503 },
      );
    }
    return new Response("Not found", { status: 404 });
  },
);

const outboxLoop = (async () => {
  while (!controller.signal.aborted) {
    try {
      const result = await service.publishOnce();
      metrics.increment("video_downloader_outbox_published_total", result.published);
      metrics.increment("video_downloader_outbox_publish_failures_total", result.publishFailed);
      if (result.published || result.publishFailed) logger.info("outbox.batch", result);
    } catch (error) {
      logger.error("outbox.batch_failed", { error });
    }
    await abortableDelay(config.OUTBOX_POLL_INTERVAL_MS, controller.signal).catch(() => undefined);
  }
})();

const cleanupLoop = (async () => {
  while (!controller.signal.aborted) {
    try {
      const result = await service.cleanupOnce();
      metrics.increment("video_downloader_artifacts_cleaned_total", result.cleaned);
      metrics.increment("video_downloader_artifact_cleanup_failures_total", result.cleanupFailed);
      metrics.increment("video_downloader_history_jobs_purged_total", result.purgedJobs);
      metrics.increment(
        "video_downloader_history_audit_events_purged_total",
        result.purgedAuditEvents,
      );
      metrics.increment(
        "video_downloader_history_outbox_events_purged_total",
        result.purgedOutboxEvents,
      );
      metrics.increment(
        "video_downloader_history_access_requests_purged_total",
        result.purgedAccessRequests,
      );
      const snapshot = await repository.getOperationalSnapshot();
      metrics.set("video_downloader_jobs_queued", snapshot.queuedJobs);
      metrics.set(
        "video_downloader_jobs_oldest_queued_age_seconds",
        snapshot.oldestQueuedAgeSeconds,
      );
      metrics.set("video_downloader_worker_leases_active", snapshot.activeWorkerLeases);
      metrics.set("video_downloader_delivery_leases_active", snapshot.activeDeliveryLeases);
      metrics.set("video_downloader_outbox_unpublished", snapshot.unpublishedOutbox);
      metrics.set("video_downloader_outbox_oldest_age_seconds", snapshot.oldestOutboxAgeSeconds);
      metrics.set("video_downloader_artifact_ready_bytes", snapshot.readyArtifactBytes);
      metrics.set("video_downloader_artifact_cleanup_failed", snapshot.cleanupFailures);
      metrics.set(
        "video_downloader_artifact_expired_lag_seconds",
        snapshot.expiredArtifactLagSeconds,
      );
      if (
        result.cleaned || result.cleanupFailed || result.purgedJobs || result.purgedAuditEvents ||
        result.purgedOutboxEvents || result.purgedAccessRequests
      ) {
        logger.info("cleanup.batch", result);
      }
    } catch (error) {
      logger.error("cleanup.batch_failed", { error });
    }
    await abortableDelay(config.CLEANUP_INTERVAL_SECONDS * 1000, controller.signal).catch(() =>
      undefined
    );
  }
})();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => controller.abort());
}
await server.finished;
controller.abort();
await Promise.all([outboxLoop, cleanupLoop]);
await queue.close();
await closeDatabase(database, { timeout: 10 });
await logger.close();
