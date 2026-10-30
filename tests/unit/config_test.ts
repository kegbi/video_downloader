import { assertEquals, assertThrows } from "@std/assert";
import { ConfigError, loadConfig } from "../../packages/config/mod.ts";

Deno.test("configuration supplies approved defaults", () => {
  const config = loadConfig("test", { APP_ENV: "test" });
  assertEquals(config.WORKER_CONCURRENCY, 2);
  assertEquals(config.OUTBOX_POLL_INTERVAL_MS, 250);
  assertEquals(config.POSTGRES_POOL_SIZE, 10);
  assertEquals(config.RETENTION_DEFAULT_MODE, "ttl");
  assertEquals(config.RETENTION_TTL_SECONDS, 604_800);
  assertEquals(config.JOB_HISTORY_TTL_SECONDS, 604_800);
  assertEquals(config.ACCESS_REQUEST_DENIED_COOLDOWN_SECONDS, 604_800);
  assertEquals(config.TELEGRAM_ADMIN_PROMPT_TTL_SECONDS, 300);
  assertEquals(config.TELEGRAM_MAX_UPLOAD_BYTES, 49_000_000);
  assertEquals(config.TELEGRAM_DELIVERY_LEASE_SECONDS, 300);
  assertEquals(config.TELEGRAM_DELIVERY_HEARTBEAT_SECONDS, 30);
  assertEquals(config.TELEGRAM_DELIVERY_POLL_INTERVAL_MS, 250);
  assertEquals(config.WORKER_SOURCE_TIMEOUT_RETRY_DELAY_SECONDS, 5);
  assertEquals(config.WORKER_RETRY_DELAY_SECONDS, 30);
  assertEquals(config.MAX_ARTIFACT_BYTES, 49_000_000);
  assertEquals(config.DOWNLOAD_MAX_TEMP_BYTES, 200_000_000);
  assertEquals([...config.sourceAllowedHosts], [
    "x.com",
    "www.x.com",
    "twitter.com",
    "www.twitter.com",
  ]);
});

Deno.test("configuration rejects production placeholders without leaking values", () => {
  const error = assertThrows(
    () =>
      loadConfig("api", { APP_ENV: "production", INTERNAL_API_TOKEN: "replace-me-super-secret" }),
    ConfigError,
  );
  assertEquals(error.message.includes("replace-me-super-secret"), false);
  assertEquals(error.variables.includes("INTERNAL_API_TOKEN"), true);
});

Deno.test("live bridge requires token and numeric administrators", () => {
  const base = {
    APP_ENV: "production",
    INTERNAL_API_TOKEN: "this-is-a-strong-internal-token-123",
    POSTGRES_PASSWORD: "this-is-a-strong-postgres-pass-123",
    RABBITMQ_PASSWORD: "this-is-a-strong-rabbit-pass-123",
    S3_ACCESS_KEY: "strong-access-key-value-1234",
    S3_SECRET_KEY: "strong-secret-key-value-1234",
  };
  const missing = assertThrows(() => loadConfig("telegram", base), ConfigError);
  assertEquals(missing.variables.includes("TELEGRAM_BOT_TOKEN"), true);
  assertEquals(missing.variables.includes("TELEGRAM_ADMIN_USER_IDS"), true);
  assertThrows(
    () =>
      loadConfig("telegram", {
        ...base,
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_ADMIN_USER_IDS: "123,bad",
      }),
    ConfigError,
  );
});

Deno.test("configuration rejects unsafe timing", () => {
  const error = assertThrows(
    () =>
      loadConfig("worker", {
        APP_ENV: "test",
        WORKER_JOB_LEASE_SECONDS: "30",
        WORKER_HEARTBEAT_SECONDS: "30",
      }),
    ConfigError,
  );
  assertEquals(error.variables, ["WORKER_HEARTBEAT_SECONDS", "WORKER_JOB_LEASE_SECONDS"]);

  for (const heartbeatSeconds of [300, 76]) {
    const deliveryError = assertThrows(
      () =>
        loadConfig("telegram", {
          APP_ENV: "production",
          INTERNAL_API_TOKEN: "this-is-a-strong-internal-token-123",
          TELEGRAM_BOT_TOKEN: "test-token",
          TELEGRAM_ADMIN_USER_IDS: "123",
          TELEGRAM_DELIVERY_LEASE_SECONDS: "300",
          TELEGRAM_DELIVERY_HEARTBEAT_SECONDS: String(heartbeatSeconds),
        }),
      ConfigError,
    );
    assertEquals(deliveryError.variables, [
      "TELEGRAM_DELIVERY_HEARTBEAT_SECONDS",
      "TELEGRAM_DELIVERY_LEASE_SECONDS",
    ]);
    assertEquals(deliveryError.message.includes(String(heartbeatSeconds)), false);
  }

  const exactDeliveryBound = loadConfig("test", {
    APP_ENV: "test",
    TELEGRAM_DELIVERY_LEASE_SECONDS: "300",
    TELEGRAM_DELIVERY_HEARTBEAT_SECONDS: "75",
  });
  assertEquals(exactDeliveryBound.TELEGRAM_DELIVERY_HEARTBEAT_SECONDS, 75);

  const retryDelayError = assertThrows(
    () =>
      loadConfig("worker", {
        APP_ENV: "test",
        WORKER_SOURCE_TIMEOUT_RETRY_DELAY_SECONDS: "30",
        WORKER_RETRY_DELAY_SECONDS: "30",
      }),
    ConfigError,
  );
  assertEquals(retryDelayError.variables, [
    "WORKER_SOURCE_TIMEOUT_RETRY_DELAY_SECONDS",
    "WORKER_RETRY_DELAY_SECONDS",
  ]);
});

Deno.test("database pool reserves capacity for raw and ORM queries", () => {
  const error = assertThrows(
    () => loadConfig("test", { APP_ENV: "test", POSTGRES_POOL_SIZE: "1" }),
    ConfigError,
  );
  assertEquals(error.variables, ["POSTGRES_POOL_SIZE"]);
});

Deno.test("temporary media budget accepts its exact bound and rejects inconsistent ceilings", () => {
  const exact = loadConfig("test", {
    APP_ENV: "test",
    TELEGRAM_MAX_UPLOAD_BYTES: "100",
    MAX_ARTIFACT_BYTES: "100",
    DOWNLOAD_FORMAT_SAFETY_BYTES: "10",
    DOWNLOAD_MAX_TEMP_BYTES: "210",
  });
  assertEquals(exact.DOWNLOAD_MAX_TEMP_BYTES, 210);

  const undersized = assertThrows(
    () =>
      loadConfig("test", {
        APP_ENV: "test",
        TELEGRAM_MAX_UPLOAD_BYTES: "100",
        MAX_ARTIFACT_BYTES: "100",
        DOWNLOAD_FORMAT_SAFETY_BYTES: "10",
        DOWNLOAD_MAX_TEMP_BYTES: "209",
      }),
    ConfigError,
  );
  assertEquals(undersized.variables, [
    "DOWNLOAD_MAX_TEMP_BYTES",
    "MAX_ARTIFACT_BYTES",
    "DOWNLOAD_FORMAT_SAFETY_BYTES",
  ]);

  const inconsistent = assertThrows(
    () =>
      loadConfig("test", {
        APP_ENV: "test",
        TELEGRAM_MAX_UPLOAD_BYTES: "99",
        MAX_ARTIFACT_BYTES: "100",
        DOWNLOAD_FORMAT_SAFETY_BYTES: "10",
        DOWNLOAD_MAX_TEMP_BYTES: "210",
      }),
    ConfigError,
  );
  assertEquals(inconsistent.variables.includes("MAX_ARTIFACT_BYTES"), true);
  assertEquals(inconsistent.variables.includes("TELEGRAM_MAX_UPLOAD_BYTES"), true);

  const ceiling = assertThrows(
    () => loadConfig("test", { APP_ENV: "test", MAX_ARTIFACT_BYTES: "2000000000" }),
    ConfigError,
  );
  assertEquals(ceiling.variables, ["MAX_ARTIFACT_BYTES"]);
});

Deno.test("reviewed local-server production limits preserve the documented safety margins", () => {
  const reviewed = loadConfig("test", {
    APP_ENV: "test",
    TELEGRAM_MAX_UPLOAD_BYTES: "1990000000",
    MAX_ARTIFACT_BYTES: "1990000000",
    DOWNLOAD_FORMAT_SAFETY_BYTES: "2000000",
    DOWNLOAD_MAX_TEMP_BYTES: "3982000000",
  });
  assertEquals(reviewed.TELEGRAM_MAX_UPLOAD_BYTES, 1_990_000_000);
  assertEquals(reviewed.MAX_ARTIFACT_BYTES, 1_990_000_000);
  assertEquals(reviewed.DOWNLOAD_MAX_TEMP_BYTES, 3_982_000_000);

  for (const value of [1_999_999_998, 1_999_999_999]) {
    const accepted = loadConfig("test", {
      APP_ENV: "test",
      TELEGRAM_MAX_UPLOAD_BYTES: String(value),
      MAX_ARTIFACT_BYTES: String(value),
      DOWNLOAD_FORMAT_SAFETY_BYTES: "2000000",
      DOWNLOAD_MAX_TEMP_BYTES: String(value * 2 + 2_000_000),
    });
    assertEquals(accepted.MAX_ARTIFACT_BYTES, value);
  }

  for (const variable of ["TELEGRAM_MAX_UPLOAD_BYTES", "MAX_ARTIFACT_BYTES"] as const) {
    const rejected = assertThrows(
      () => loadConfig("test", { APP_ENV: "test", [variable]: "2000000000" }),
      ConfigError,
    );
    assertEquals(rejected.variables, [variable]);
  }
});

Deno.test("production worker rejects RAM-tmpfs-style or broad temporary paths", () => {
  const error = assertThrows(
    () =>
      loadConfig("worker", {
        APP_ENV: "production",
        POSTGRES_PASSWORD: "this-is-a-strong-postgres-pass-123",
        RABBITMQ_PASSWORD: "this-is-a-strong-rabbit-pass-123",
        S3_ACCESS_KEY: "strong-access-key-value-1234",
        S3_SECRET_KEY: "strong-secret-key-value-1234",
        DOWNLOAD_TEMP_DIR: "/tmp/media",
      }),
    ConfigError,
  );
  assertEquals(error.variables.includes("DOWNLOAD_TEMP_DIR"), true);
  assertEquals(error.message.includes("/tmp/media"), false);
});

Deno.test("application configuration does not retain local Bot API credentials", () => {
  const config = loadConfig("test", {
    APP_ENV: "test",
    TELEGRAM_API_ID: "12345",
    TELEGRAM_API_HASH: "test-only-not-a-live-api-hash",
  });
  const record = config as Readonly<Record<string, unknown>>;
  assertEquals("TELEGRAM_API_ID" in record, false);
  assertEquals("TELEGRAM_API_HASH" in record, false);
});
