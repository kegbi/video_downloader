import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { loadConfig } from "../../packages/config/mod.ts";
import { closeDatabase, createDatabase } from "../../packages/db/client.ts";
import { runMigrations } from "../../packages/db/migrations.ts";
import { Repository } from "../../packages/db/repository.ts";
import { MutableClock, RandomIdGenerator } from "../../packages/domain/time.ts";
import { DomainError } from "../../packages/domain/errors.ts";

const databaseEnvironment = {
  APP_ENV: "test",
  POSTGRES_HOST: Deno.env.get("TEST_POSTGRES_HOST") ?? "127.0.0.1",
  POSTGRES_PORT: Deno.env.get("TEST_POSTGRES_PORT") ?? "5432",
  POSTGRES_DB: Deno.env.get("TEST_POSTGRES_DB") ?? "video_downloader_test",
  POSTGRES_USER: Deno.env.get("TEST_POSTGRES_USER") ?? "video_downloader_test",
  POSTGRES_PASSWORD: Deno.env.get("TEST_POSTGRES_PASSWORD") ?? "local-postgres-password",
};

Deno.test({
  name: "migrations, concurrent idempotency and expired worker leases",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const config = loadConfig("test", databaseEnvironment);
    const sql = createDatabase(config);
    try {
      await runMigrations(sql, [
        new URL("../../migrations/", import.meta.url),
        new URL("../../drizzle/", import.meta.url),
      ]);
      const clock = new MutableClock(new Date("2026-08-12T12:00:00Z"));
      const repository = new Repository(sql, clock, new RandomIdGenerator());
      const adminExternalId = String(Math.floor(Math.random() * 9_000_000_000) + 10_000_000_000);
      assertEquals(await repository.bootstrapTelegramAdmins([adminExternalId]), 1);
      assertEquals(await repository.bootstrapTelegramAdmins([adminExternalId]), 0);
      const admin = await repository.findAuthorizedTelegramPrincipal(adminExternalId);
      assertExists(admin);
      assertEquals(admin.role, "admin");
      const bootstrapAudit = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM audit_events
        WHERE action = 'principal.bootstrap_admin' AND actor_external_id = ${adminExternalId}
      `;
      assertEquals(bootstrapAudit[0]?.count, 1);

      const externalUserId = String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
      await repository.upsertTelegramPrincipal({ externalUserId });
      const secondExternalUserId = String(
        Math.floor(Math.random() * 9_000_000_000) + 30_000_000_000,
      );
      await repository.upsertTelegramPrincipal({ externalUserId: secondExternalUserId });
      const disabledExternalId = String(
        Math.floor(Math.random() * 9_000_000_000) + 40_000_000_000,
      );
      await repository.upsertTelegramPrincipal({
        externalUserId: disabledExternalId,
        state: "disabled",
      });
      const expiredExternalId = String(Math.floor(Math.random() * 9_000_000_000) + 20_000_000_000);
      await repository.upsertTelegramPrincipal({
        externalUserId: expiredExternalId,
        expiresAt: new Date("2026-08-12T11:59:59Z"),
      });
      assertEquals(await repository.findAuthorizedTelegramPrincipal(expiredExternalId), null);

      const idempotencyKey = crypto.randomUUID();
      const sourceId = String(100_000_000 + Math.floor(Math.random() * 900_000_000));
      const request = {
        bridge: "telegram" as const,
        idempotencyKey,
        requesterExternalUserId: externalUserId,
        submittedUrl: `https://x.com/example/status/${sourceId}`,
        normalizedUrl: `https://x.com/i/status/${sourceId}`,
        sourceId,
        destination: { chatId: externalUserId, requestMessageId: 42 },
        policy: { mode: "ttl" as const, ttlSeconds: 604_800, afterDeliveryGraceSeconds: 300 },
        maxQueuedJobs: 1000,
        maxActiveJobsPerUser: 1000,
      };
      const results = await Promise.all(
        Array.from({ length: 12 }, () => repository.submitJob(request)),
      );
      assertEquals(new Set(results.map((result) => result.job.id)).size, 1);
      assertEquals(results.filter((result) => result.created).length, 1);
      const job = results[0].job;

      for (
        const requesterExternalUserId of [
          secondExternalUserId,
          String(50_000_000_000 + Math.floor(Math.random() * 1_000_000)),
          disabledExternalId,
          expiredExternalId,
        ]
      ) {
        const expectedCode = requesterExternalUserId === secondExternalUserId
          ? "conflict"
          : "unauthorized";
        const error = await assertRejects(
          () => repository.submitJob({ ...request, requesterExternalUserId }),
          DomainError,
        );
        assertEquals(error.code, expectedCode);
      }
      for (
        const semanticChange of [
          {
            submittedUrl: `https://twitter.com/example/status/${sourceId}`,
          },
          {
            submittedUrl: `https://x.com/i/status/${Number(sourceId) + 1}`,
            normalizedUrl: `https://x.com/i/status/${Number(sourceId) + 1}`,
            sourceId: String(Number(sourceId) + 1),
          },
          { destination: { chatId: externalUserId, requestMessageId: 43 } },
          {
            policy: { mode: "ttl" as const, ttlSeconds: 60, afterDeliveryGraceSeconds: 300 },
          },
        ]
      ) {
        const error = await assertRejects(
          () => repository.submitJob({ ...request, ...semanticChange }),
          DomainError,
        );
        assertEquals(error.code, "conflict");
      }

      const related = await sql<{ deliveries: number; events: number }[]>`
        SELECT
          (SELECT count(*)::int FROM deliveries WHERE job_id = ${job.id}) AS deliveries,
          (SELECT count(*)::int FROM outbox WHERE aggregate_id = ${job.id}) AS events
      `;
      assertEquals(related[0], { deliveries: 1, events: 1 });

      const firstAttemptOwner = `worker-one:${crypto.randomUUID()}`;
      const secondAttemptOwner = `worker-one:${crypto.randomUUID()}`;
      const firstClaim = await repository.claimJob(job.id, firstAttemptOwner, 120);
      assertExists(firstClaim);
      assertEquals(firstClaim.attempts, 1);
      assertEquals(await repository.claimJob(job.id, secondAttemptOwner, 120), null);
      assertEquals(await repository.heartbeatJob(job.id, "wrong-worker", 120), false);
      assertEquals(await repository.heartbeatJob(job.id, firstAttemptOwner, 120), true);

      clock.advance(121_000);
      const recoveryClaim = await repository.claimJob(job.id, secondAttemptOwner, 120);
      assertExists(recoveryClaim);
      assertEquals(recoveryClaim.attempts, 2);
      assertEquals(recoveryClaim.leaseOwner, secondAttemptOwner);
      assertEquals(await repository.heartbeatJob(job.id, firstAttemptOwner, 120), false);
      assertEquals(await repository.heartbeatJob(job.id, secondAttemptOwner, 120), true);

      assertEquals(
        await repository.transitionJob(job.id, "downloading", "processing") !== null,
        true,
      );
      assertEquals(await repository.transitionJob(job.id, "queued", "failed"), null);
    } finally {
      await closeDatabase(sql, { timeout: 5 });
    }
  },
});
