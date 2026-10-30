import { createApi } from "./app.ts";
import { loadConfig } from "../../packages/config/mod.ts";
import { closeDatabase, createDatabase } from "../../packages/db/client.ts";
import { Repository } from "../../packages/db/repository.ts";
import { RandomIdGenerator, SystemClock } from "../../packages/domain/time.ts";
import { MetricsRegistry } from "../../packages/observability/metrics.ts";
import { createLogger } from "../../packages/observability/logger.ts";
import { S3ArtifactStorage } from "../../packages/storage/s3.ts";

const config = loadConfig("api");
const logger = createLogger("api", config.APP_LOG_LEVEL, {}, console.log, config.LOKI_PUSH_URL);
const database = createDatabase(config);
const ids = new RandomIdGenerator();
const repository = new Repository(database, new SystemClock(), ids);
await repository.bootstrapTelegramAdmins(config.telegramAdminUserIds);
const app = createApi({
  config,
  repository,
  database,
  metrics: new MetricsRegistry(),
  id: () => ids.next(),
  storage: new S3ArtifactStorage(config),
  observeLifecycle: (event, fields) => logger.info(event, { ...fields }),
});

const abortController = new AbortController();
const server = Deno.serve({
  hostname: config.API_HOST,
  port: config.API_PORT,
  signal: abortController.signal,
  onListen: ({ hostname, port }) => logger.info("server.started", { hostname, port }),
}, app.fetch);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => abortController.abort());
}
await server.finished;
await closeDatabase(database, { timeout: 10 });
logger.info("server.stopped");
await logger.close();
