import { z } from "zod";
import { isCanonicalTelegramUserId } from "../domain/telegram_id.ts";

export type ServiceName =
  | "api"
  | "worker"
  | "telegram"
  | "maintenance"
  | "migrate"
  | "storage"
  | "test";

const booleanString = z.enum(["true", "false"]).transform((value) => value === "true");
const positiveInteger = z.coerce.number().int().positive();
const databasePoolSize = z.coerce.number().int().min(2);
const nonNegativeInteger = z.coerce.number().int().nonnegative();
const byteCount = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const optionalUrl = z.string().transform((value) => value.trim()).pipe(
  z.union([z.literal(""), z.url()]),
);

const environmentSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  INTERNAL_API_TOKEN: z.string().default("development-internal-token"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  API_BASE_URL: z.url().default("http://api:8080"),

  POSTGRES_HOST: z.string().default("postgres"),
  POSTGRES_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  POSTGRES_DB: z.string().min(1).default("video_downloader"),
  POSTGRES_USER: z.string().min(1).default("video_downloader"),
  POSTGRES_PASSWORD: z.string().default("development-postgres-password"),
  POSTGRES_POOL_SIZE: databasePoolSize.default(10),
  POSTGRES_SSL_MODE: z.enum(["disable", "prefer", "require"]).default("disable"),

  RABBITMQ_HOST: z.string().default("rabbitmq"),
  RABBITMQ_PORT: z.coerce.number().int().min(1).max(65535).default(5672),
  RABBITMQ_USER: z.string().default("video_downloader"),
  RABBITMQ_PASSWORD: z.string().default("development-rabbitmq-password"),
  RABBITMQ_VHOST: z.string().default("video_downloader"),
  RABBITMQ_TLS: booleanString.default(false),
  RABBITMQ_DOWNLOAD_QUEUE: z.string().default("video.download"),
  RABBITMQ_DOWNLOAD_RETRY_QUEUE: z.string().default("video.download.retry"),
  RABBITMQ_DOWNLOAD_DEAD_LETTER_QUEUE: z.string().default("video.download.dead"),

  S3_ENDPOINT: z.url().default("http://rustfs:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).default("video-artifacts"),
  S3_ACCESS_KEY: z.string().default("development-rustfs-key"),
  S3_SECRET_KEY: z.string().default("development-rustfs-secret"),
  S3_FORCE_PATH_STYLE: booleanString.default(true),
  S3_TEMP_PREFIX: z.string().default("temporary/"),
  S3_ARTIFACT_PREFIX: z.string().default("artifacts/"),
  STORAGE_MAX_BYTES: nonNegativeInteger.default(0),

  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_ADMIN_USER_IDS: z.string().default(""),
  TELEGRAM_MODE: z.enum(["polling", "webhook"]).default("polling"),
  TELEGRAM_BOT_API_ROOT: z.url().default("https://api.telegram.org"),
  TELEGRAM_MAX_UPLOAD_BYTES: byteCount.max(1_999_999_999).default(49_000_000),
  TELEGRAM_PROGRESS_MIN_INTERVAL_SECONDS: nonNegativeInteger.default(2),
  TELEGRAM_DELIVERY_LEASE_SECONDS: positiveInteger.default(300),
  TELEGRAM_DELIVERY_HEARTBEAT_SECONDS: positiveInteger.default(30),
  TELEGRAM_DELIVERY_POLL_INTERVAL_MS: positiveInteger.default(250),
  TELEGRAM_ACCESS_NOTIFICATION_LEASE_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  TELEGRAM_ACCESS_NOTIFICATION_POLL_INTERVAL_MS: positiveInteger.default(1000),
  TELEGRAM_ACCESS_NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  TELEGRAM_ADMIN_PROMPT_TTL_SECONDS: z.coerce.number().int().min(30).max(1800).default(300),
  ALLOW_PRIVATE_CHATS_ONLY: booleanString.default(true),
  MAX_ACTIVE_JOBS_PER_USER: positiveInteger.default(2),
  MAX_QUEUED_JOBS: positiveInteger.default(100),
  SOURCE_ALLOWED_HOSTS: z.string().default("x.com,www.x.com,twitter.com,www.twitter.com"),

  WORKER_CONCURRENCY: positiveInteger.default(2),
  WORKER_JOB_LEASE_SECONDS: positiveInteger.default(120),
  WORKER_HEARTBEAT_SECONDS: positiveInteger.default(30),
  WORKER_MAX_ATTEMPTS: positiveInteger.default(3),
  WORKER_SOURCE_TIMEOUT_RETRY_DELAY_SECONDS: positiveInteger.default(5),
  WORKER_RETRY_DELAY_SECONDS: positiveInteger.default(30),
  YTDLP_PATH: z.string().default("yt-dlp"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  DOWNLOAD_TEMP_DIR: z.string().trim().min(1).default("/var/tmp/video-downloader"),
  DOWNLOAD_TIMEOUT_SECONDS: positiveInteger.default(900),
  DOWNLOAD_MAX_DURATION_SECONDS: positiveInteger.default(1800),
  DOWNLOAD_MAX_HEIGHT: positiveInteger.default(1080),
  DOWNLOAD_FORMAT_SAFETY_BYTES: nonNegativeInteger.default(2_000_000),
  MAX_ARTIFACT_BYTES: byteCount.max(1_999_999_999).default(49_000_000),
  DOWNLOAD_MAX_TEMP_BYTES: byteCount.default(200_000_000),
  DOWNLOADER_MODE: z.enum(["live", "fixture"]).default("live"),

  RETENTION_DEFAULT_MODE: z.enum(["forever", "ttl", "after_delivery"]).default("ttl"),
  RETENTION_TTL_SECONDS: positiveInteger.default(604_800),
  RETENTION_AFTER_DELIVERY_GRACE_SECONDS: nonNegativeInteger.default(300),
  OUTBOX_POLL_INTERVAL_MS: positiveInteger.default(250),
  CLEANUP_INTERVAL_SECONDS: positiveInteger.default(60),
  TEMP_OBJECT_MAX_AGE_SECONDS: positiveInteger.default(86_400),
  JOB_HISTORY_TTL_SECONDS: nonNegativeInteger.default(604_800),
  ACCESS_REQUEST_TTL_SECONDS: positiveInteger.default(604_800),
  ACCESS_REQUEST_DENIED_COOLDOWN_SECONDS: nonNegativeInteger.default(604_800),

  METRICS_ENABLED: booleanString.default(true),
  METRICS_PATH: z.string().startsWith("/").default("/metrics"),
  LOKI_PUSH_URL: optionalUrl.default(""),
});

const PLACEHOLDER_PATTERN = /(^|[-_])(replace[-_]?me|changeme|example|development)([-_]|$)/i;

export interface AppConfig extends z.infer<typeof environmentSchema> {
  readonly service: ServiceName;
  readonly telegramAdminUserIds: readonly string[];
  readonly sourceAllowedHosts: ReadonlySet<string>;
  readonly postgresUrl: string;
  readonly rabbitmqUrl: string;
}

export class ConfigError extends Error {
  constructor(public readonly variables: readonly string[]) {
    super(`Invalid configuration: ${variables.join(", ")}`);
    this.name = "ConfigError";
  }
}

function secretLooksLikePlaceholder(value: string): boolean {
  return value.length < 24 || PLACEHOLDER_PATTERN.test(value);
}

function parseAdminIds(value: string): readonly string[] {
  const ids = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const invalid = ids.filter((entry) => !isCanonicalTelegramUserId(entry));
  if (invalid.length > 0 || new Set(ids).size !== ids.length) {
    throw new ConfigError(["TELEGRAM_ADMIN_USER_IDS"]);
  }
  return Object.freeze(ids);
}

export function loadConfig(
  service: ServiceName,
  environment: Record<string, string | undefined> = Deno.env.toObject(),
): Readonly<AppConfig> {
  const isolatedTestDefaults = environment.APP_ENV === "test"
    ? {
      POSTGRES_DB: "video_downloader_test",
      POSTGRES_USER: "video_downloader_test",
      RABBITMQ_VHOST: "video_downloader_test",
      RABBITMQ_USER: "video_downloader_test",
      S3_BUCKET: "video-artifacts-test",
    }
    : {};
  const result = environmentSchema.safeParse({ ...isolatedTestDefaults, ...environment });
  if (!result.success) {
    const names = [
      ...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "environment"))),
    ];
    throw new ConfigError(names);
  }

  const raw = result.data;
  const invalid: string[] = [];
  const telegramAdminUserIds = parseAdminIds(raw.TELEGRAM_ADMIN_USER_IDS);

  if (service === "test" && raw.APP_ENV === "test") {
    if (!raw.POSTGRES_DB.endsWith("_test")) invalid.push("POSTGRES_DB");
    if (!raw.RABBITMQ_VHOST.endsWith("_test")) invalid.push("RABBITMQ_VHOST");
    if (!raw.S3_BUCKET.endsWith("-test")) invalid.push("S3_BUCKET");
  }

  if (raw.WORKER_HEARTBEAT_SECONDS >= raw.WORKER_JOB_LEASE_SECONDS) {
    invalid.push("WORKER_HEARTBEAT_SECONDS", "WORKER_JOB_LEASE_SECONDS");
  }
  if (raw.WORKER_SOURCE_TIMEOUT_RETRY_DELAY_SECONDS >= raw.WORKER_RETRY_DELAY_SECONDS) {
    invalid.push(
      "WORKER_SOURCE_TIMEOUT_RETRY_DELAY_SECONDS",
      "WORKER_RETRY_DELAY_SECONDS",
    );
  }
  if (
    raw.TELEGRAM_DELIVERY_HEARTBEAT_SECONDS >= raw.TELEGRAM_DELIVERY_LEASE_SECONDS ||
    raw.TELEGRAM_DELIVERY_HEARTBEAT_SECONDS * 4 > raw.TELEGRAM_DELIVERY_LEASE_SECONDS
  ) {
    invalid.push(
      "TELEGRAM_DELIVERY_HEARTBEAT_SECONDS",
      "TELEGRAM_DELIVERY_LEASE_SECONDS",
    );
  }
  if (raw.MAX_ARTIFACT_BYTES > raw.TELEGRAM_MAX_UPLOAD_BYTES) {
    invalid.push("MAX_ARTIFACT_BYTES", "TELEGRAM_MAX_UPLOAD_BYTES");
  }
  if (raw.MAX_ARTIFACT_BYTES <= raw.DOWNLOAD_FORMAT_SAFETY_BYTES) {
    invalid.push("MAX_ARTIFACT_BYTES", "DOWNLOAD_FORMAT_SAFETY_BYTES");
  }
  const minimumTemporaryBytes = raw.MAX_ARTIFACT_BYTES * 2 + raw.DOWNLOAD_FORMAT_SAFETY_BYTES;
  if (raw.DOWNLOAD_MAX_TEMP_BYTES < minimumTemporaryBytes) {
    invalid.push(
      "DOWNLOAD_MAX_TEMP_BYTES",
      "MAX_ARTIFACT_BYTES",
      "DOWNLOAD_FORMAT_SAFETY_BYTES",
    );
  }
  if (!isAbsoluteConfiguredPath(raw.DOWNLOAD_TEMP_DIR)) {
    invalid.push("DOWNLOAD_TEMP_DIR");
  }
  if (raw.APP_ENV === "production") {
    const requiredSecrets: Array<[string, string]> = [];
    if (service === "api" || service === "telegram") {
      requiredSecrets.push(["INTERNAL_API_TOKEN", raw.INTERNAL_API_TOKEN]);
    }
    if (["api", "worker", "maintenance", "migrate"].includes(service)) {
      requiredSecrets.push(["POSTGRES_PASSWORD", raw.POSTGRES_PASSWORD]);
    }
    if (service === "worker" || service === "maintenance") {
      requiredSecrets.push(["RABBITMQ_PASSWORD", raw.RABBITMQ_PASSWORD]);
    }
    if (["api", "worker", "maintenance", "storage"].includes(service)) {
      requiredSecrets.push(["S3_ACCESS_KEY", raw.S3_ACCESS_KEY]);
      requiredSecrets.push(["S3_SECRET_KEY", raw.S3_SECRET_KEY]);
    }
    invalid.push(
      ...requiredSecrets.filter(([, value]) => secretLooksLikePlaceholder(value)).map(([name]) =>
        name
      ),
    );
    if (raw.DOWNLOADER_MODE === "fixture") invalid.push("DOWNLOADER_MODE");
    if (
      service === "worker" &&
      !isDedicatedProductionTemporaryDirectory(raw.DOWNLOAD_TEMP_DIR)
    ) {
      invalid.push("DOWNLOAD_TEMP_DIR");
    }
    if (service === "telegram" && !raw.TELEGRAM_BOT_TOKEN) invalid.push("TELEGRAM_BOT_TOKEN");
    if ((service === "api" || service === "telegram") && telegramAdminUserIds.length === 0) {
      invalid.push("TELEGRAM_ADMIN_USER_IDS");
    }
    if (["api", "worker", "maintenance", "storage"].includes(service) && !raw.S3_FORCE_PATH_STYLE) {
      invalid.push("S3_FORCE_PATH_STYLE");
    }
  }
  if (invalid.length > 0) throw new ConfigError([...new Set(invalid)]);

  const postgresUrl = new URL(
    `postgres://${raw.POSTGRES_HOST}:${raw.POSTGRES_PORT}/${raw.POSTGRES_DB}`,
  );
  postgresUrl.username = raw.POSTGRES_USER;
  postgresUrl.password = raw.POSTGRES_PASSWORD;
  postgresUrl.searchParams.set("sslmode", raw.POSTGRES_SSL_MODE);

  const rabbitmqUrl = new URL(
    `${raw.RABBITMQ_TLS ? "amqps" : "amqp"}://${raw.RABBITMQ_HOST}:${raw.RABBITMQ_PORT}`,
  );
  rabbitmqUrl.username = raw.RABBITMQ_USER;
  rabbitmqUrl.password = raw.RABBITMQ_PASSWORD;
  rabbitmqUrl.pathname = `/${encodeURIComponent(raw.RABBITMQ_VHOST)}`;

  return Object.freeze({
    ...raw,
    service,
    telegramAdminUserIds,
    sourceAllowedHosts: new Set(
      raw.SOURCE_ALLOWED_HOSTS.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
    ),
    postgresUrl: postgresUrl.toString(),
    rabbitmqUrl: rabbitmqUrl.toString(),
  });
}

function isAbsoluteConfiguredPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function isDedicatedProductionTemporaryDirectory(value: string): boolean {
  if (!value.startsWith("/")) return false;
  const normalized = value.replace(/\/+$/, "") || "/";
  return !["/", "/tmp", "/var", "/var/tmp"].includes(normalized) &&
    !normalized.startsWith("/tmp/");
}
