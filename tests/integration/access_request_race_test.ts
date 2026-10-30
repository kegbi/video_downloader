import { assertEquals } from "@std/assert";
import { loadConfig } from "../../packages/config/mod.ts";
import { closeDatabase, createDatabase } from "../../packages/db/client.ts";
import { runMigrations } from "../../packages/db/migrations.ts";
import { Repository, type RepositoryConcurrencyHooks } from "../../packages/db/repository.ts";
import { MutableClock, RandomIdGenerator } from "../../packages/domain/time.ts";

const environment = {
  APP_ENV: "test",
  POSTGRES_HOST: Deno.env.get("TEST_POSTGRES_HOST") ?? "127.0.0.1",
  POSTGRES_PORT: Deno.env.get("TEST_POSTGRES_PORT") ?? "5432",
  POSTGRES_DB: Deno.env.get("TEST_POSTGRES_DB") ?? "video_downloader_test",
  POSTGRES_USER: Deno.env.get("TEST_POSTGRES_USER") ?? "video_downloader_test",
  POSTGRES_PASSWORD: Deno.env.get("TEST_POSTGRES_PASSWORD") ?? "local-postgres-password",
};

Deno.test({
  name: "access request and admin decisions serialize on one target lock",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const database = createDatabase(loadConfig("test", environment));
    try {
      await runMigrations(database, [
        new URL("../../migrations/", import.meta.url),
        new URL("../../drizzle/", import.meta.url),
      ]);
      const clock = new MutableClock(new Date("2026-08-14T10:00:00Z"));
      const adminId = randomTelegramId(120_000_000_000);
      const repository = new Repository(database, clock, new RandomIdGenerator());
      await repository.bootstrapTelegramAdmins([adminId]);

      await exerciseRequestDecisionRace(database, clock, adminId, "allow");
      await exerciseRequestDecisionRace(database, clock, adminId, "deny");
      await exerciseAdminDecisionRace(database, clock, adminId);
    } finally {
      await closeDatabase(database, { timeout: 5 });
    }
  },
});

async function exerciseRequestDecisionRace(
  database: ReturnType<typeof createDatabase>,
  clock: MutableClock,
  adminId: string,
  decision: "allow" | "deny",
): Promise<void> {
  const targetId = randomTelegramId(decision === "allow" ? 121_000_000_000 : 122_000_000_000);
  const requestLocked = deferred<void>();
  const releaseRequest = deferred<void>();
  const decisionContended = deferred<void>();
  const requestRepository = hookedRepository(database, clock, {
    accessTargetLocked: async (operation, externalUserId) => {
      if (operation !== "request" || externalUserId !== targetId) return;
      requestLocked.resolve();
      await releaseRequest.promise;
    },
  });
  const decisionRepository = hookedRepository(database, clock, {
    accessTargetLockContended: (operation, externalUserId) => {
      if (operation === decision && externalUserId === targetId) decisionContended.resolve();
    },
  });

  const request = requestRepository.requestTelegramAccess({
    externalUserId: targetId,
    requestKey: `race:${decision}`,
    correlationId: `race-request-${decision}`,
    deniedCooldownSeconds: 604_800,
  });
  await withTimeout(requestLocked.promise);
  const adminDecision = decision === "allow"
    ? decisionRepository.adminUpsertTelegramPrincipal({
      actorExternalUserId: adminId,
      targetExternalUserId: targetId,
      correlationId: "race-allow",
    })
    : decisionRepository.adminDisableTelegramPrincipal({
      actorExternalUserId: adminId,
      targetExternalUserId: targetId,
      reason: "race denial",
      correlationId: "race-deny",
    });
  await withTimeout(decisionContended.promise);
  releaseRequest.resolve();
  await Promise.all([request, adminDecision]);

  await assertAccessState(
    database,
    targetId,
    decision === "allow" ? "active" : "disabled",
    decision === "allow" ? "approved" : "denied",
  );
}

async function exerciseAdminDecisionRace(
  database: ReturnType<typeof createDatabase>,
  clock: MutableClock,
  adminId: string,
): Promise<void> {
  const targetId = randomTelegramId(123_000_000_000);
  const base = new Repository(database, clock, new RandomIdGenerator());
  await base.requestTelegramAccess({
    externalUserId: targetId,
    requestKey: "race:admin-decisions",
    correlationId: "race-admin-request",
    deniedCooldownSeconds: 604_800,
  });
  const allowLocked = deferred<void>();
  const releaseAllow = deferred<void>();
  const denyContended = deferred<void>();
  const allowRepository = hookedRepository(database, clock, {
    accessTargetLocked: async (operation, externalUserId) => {
      if (operation !== "allow" || externalUserId !== targetId) return;
      allowLocked.resolve();
      await releaseAllow.promise;
    },
  });
  const denyRepository = hookedRepository(database, clock, {
    accessTargetLockContended: (operation, externalUserId) => {
      if (operation === "deny" && externalUserId === targetId) denyContended.resolve();
    },
  });
  const allow = allowRepository.adminUpsertTelegramPrincipal({
    actorExternalUserId: adminId,
    targetExternalUserId: targetId,
    correlationId: "race-admin-allow",
  });
  await withTimeout(allowLocked.promise);
  const deny = denyRepository.adminDisableTelegramPrincipal({
    actorExternalUserId: adminId,
    targetExternalUserId: targetId,
    reason: "serialized denial",
    correlationId: "race-admin-deny",
  });
  await withTimeout(denyContended.promise);
  releaseAllow.resolve();
  await Promise.all([allow, deny]);
  await assertAccessState(database, targetId, "disabled", "denied");
}

function hookedRepository(
  database: ReturnType<typeof createDatabase>,
  clock: MutableClock,
  hooks: RepositoryConcurrencyHooks,
): Repository {
  return new Repository(database, clock, new RandomIdGenerator(), undefined, hooks);
}

async function assertAccessState(
  database: ReturnType<typeof createDatabase>,
  externalUserId: string,
  principalState: "active" | "disabled",
  requestState: "approved" | "denied",
): Promise<void> {
  const rows = await database<{
    principal_state: string;
    request_state: string;
    notification_pending: boolean;
    deliverable_notifications: number;
  }[]>`
    SELECT p.state AS principal_state, r.state AS request_state, r.notification_pending,
      (SELECT count(*)::int FROM access_request_notifications n
        WHERE n.access_request_id = r.id AND n.state IN ('pending', 'leased'))
        AS deliverable_notifications
    FROM principals p JOIN access_requests r
      ON r.bridge = p.bridge AND r.external_user_id = p.external_user_id
    WHERE p.bridge = 'telegram' AND p.external_user_id = ${externalUserId}
  `;
  assertEquals(rows[0], {
    principal_state: principalState,
    request_state: requestState,
    notification_pending: false,
    deliverable_notifications: 0,
  });
}

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => resolve = done);
  return { promise, resolve };
}

async function withTimeout<Value>(promise: Promise<Value>): Promise<Value> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("deterministic access-lock barrier timed out")), 5_000)
    ),
  ]);
}

function randomTelegramId(base: number): string {
  return String(base + Math.floor(Math.random() * 1_000_000));
}
