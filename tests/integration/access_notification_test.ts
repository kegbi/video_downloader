import { assertEquals, assertExists } from "@std/assert";
import { loadConfig } from "../../packages/config/mod.ts";
import { closeDatabase, createDatabase } from "../../packages/db/client.ts";
import { runMigrations } from "../../packages/db/migrations.ts";
import { Repository } from "../../packages/db/repository.ts";
import { MutableClock, RandomIdGenerator } from "../../packages/domain/time.ts";

const databaseEnvironment = {
  APP_ENV: "test",
  POSTGRES_HOST: Deno.env.get("TEST_POSTGRES_HOST") ?? "127.0.0.1",
  POSTGRES_PORT: Deno.env.get("TEST_POSTGRES_PORT") ?? "5432",
  POSTGRES_DB: Deno.env.get("TEST_POSTGRES_DB") ?? "video_downloader_test",
  POSTGRES_USER: Deno.env.get("TEST_POSTGRES_USER") ?? "video_downloader_test",
  POSTGRES_PASSWORD: Deno.env.get("TEST_POSTGRES_PASSWORD") ?? "local-postgres-password",
};

Deno.test({
  name: "access notification outbox handles concurrency, partial success, restart and stale work",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const database = createDatabase(loadConfig("test", databaseEnvironment));
    try {
      await runMigrations(database, [
        new URL("../../migrations/", import.meta.url),
        new URL("../../drizzle/", import.meta.url),
      ]);
      const clock = new MutableClock(new Date("2026-08-13T10:00:00Z"));
      const repository = new Repository(database, clock, new RandomIdGenerator());

      // The full suite intentionally reuses one ephemeral database. Resolve any pending requests
      // left by earlier scenarios so this test exercises only the notifications it creates.
      await database`
        UPDATE access_requests SET state = 'denied', notification_pending = false,
          resolved_at = COALESCE(resolved_at, ${clock.now()})
        WHERE state = 'pending'
      `;
      await database`
        UPDATE access_request_notifications SET state = 'skipped', lease_owner = NULL,
          lease_expires_at = NULL, last_error_code = 'test-isolation', updated_at = ${clock.now()}
        WHERE state IN ('pending', 'leased')
      `;

      const suffix = Math.floor(Math.random() * 1_000_000);
      const adminA = String(101_000_000_000 + suffix);
      const adminB = String(102_000_000_000 + suffix);
      const adminC = String(103_000_000_000 + suffix);
      const requester = String(104_000_000_000 + suffix);
      await repository.bootstrapTelegramAdmins([adminA, adminB]);

      const concurrent = await Promise.all(
        Array.from({ length: 8 }, () =>
          repository.requestTelegramAccess({
            externalUserId: requester,
            requestKey: "telegram:duplicate-update",
            correlationId: crypto.randomUUID(),
            deniedCooldownSeconds: 604_800,
          })),
      );
      assertEquals(new Set(concurrent.map((item) => item.request.id)).size, 1);
      const requestId = concurrent[0].request.id;
      const initial = await database<{ notifications: number; active_admins: number }[]>`
        SELECT
          (SELECT count(*)::int FROM access_request_notifications
            WHERE access_request_id = ${requestId}) AS notifications,
          (SELECT count(*)::int FROM principals WHERE role = 'admin' AND state = 'active'
            AND (expires_at IS NULL OR expires_at > ${clock.now()})) AS active_admins
      `;
      assertEquals(initial[0]?.notifications, initial[0]?.active_admins);

      const claims = await Promise.all(
        Array.from(
          { length: initial[0].notifications },
          (_, index) =>
            repository.claimAccessRequestNotification(`notifier-${index}-${suffix}`, 10),
        ),
      );
      const claimA = claims.find((claim) => claim?.adminExternalUserId === adminA);
      const claimB = claims.find((claim) => claim?.adminExternalUserId === adminB);
      assertExists(claimA);
      assertExists(claimB);
      for (let index = 0; index < claims.length; index++) {
        const claim = claims[index];
        if (claim && claim.id !== claimA.id && claim.id !== claimB.id) {
          await repository.completeAccessRequestNotification(
            claim.id,
            `notifier-${index}-${suffix}`,
          );
        }
      }
      const claimAIndex = claims.findIndex((claim) => claim?.id === claimA.id);
      const claimBIndex = claims.findIndex((claim) => claim?.id === claimB.id);
      assertEquals(
        await repository.completeAccessRequestNotification(
          claimA.id,
          `notifier-${claimAIndex}-${suffix}`,
        ),
        true,
      );
      assertEquals(
        await repository.failAccessRequestNotification({
          id: claimB.id,
          workerId: `notifier-${claimBIndex}-${suffix}`,
          retryable: true,
          retryAfterSeconds: 2,
          maxAttempts: 4,
          errorCode: "retryable",
        }),
        true,
      );
      assertEquals(await repository.claimAccessRequestNotification("too-early", 10), null);
      clock.advance(2_000);
      const retry = await repository.claimAccessRequestNotification("before-crash", 10);
      assertEquals(retry?.id, claimB.id);
      assertEquals(retry?.attempts, 2);
      clock.advance(11_000);
      const recovered = await repository.claimAccessRequestNotification("after-restart", 10);
      assertEquals(recovered?.id, claimB.id);
      assertEquals(recovered?.attempts, 3);
      await repository.failAccessRequestNotification({
        id: recovered!.id,
        workerId: "after-restart",
        retryable: false,
        retryAfterSeconds: 1,
        maxAttempts: 4,
        errorCode: "permanent",
      });
      const partial = await database<{ state: string; attempts: number }[]>`
        SELECT state, attempts FROM access_request_notifications
        WHERE access_request_id = ${requestId} ORDER BY state
      `;
      assertEquals([...partial].filter((row) => row.state === "failed"), [
        { state: "failed", attempts: 3 },
      ]);
      assertEquals(
        partial.filter((row) => row.state === "sent").length,
        initial[0].notifications - 1,
      );

      await repository.bootstrapTelegramAdmins([adminC]);
      const dynamic = await repository.claimAccessRequestNotification("dynamic-admin", 10);
      assertEquals(dynamic?.adminExternalUserId, adminC);
      await repository.completeAccessRequestNotification(dynamic!.id, "dynamic-admin");

      const staleRequester = String(105_000_000_000 + suffix);
      const stale = await repository.requestTelegramAccess({
        externalUserId: staleRequester,
        requestKey: "telegram:resolve-before-send",
        correlationId: crypto.randomUUID(),
        deniedCooldownSeconds: 604_800,
      });
      await repository.adminUpsertTelegramPrincipal({
        actorExternalUserId: adminA,
        targetExternalUserId: staleRequester,
        correlationId: crypto.randomUUID(),
      });
      const staleRows = await database<{ state: string }[]>`
        SELECT state FROM access_request_notifications
        WHERE access_request_id = ${stale.request.id}
      `;
      assertEquals(staleRows.every((row) => row.state === "skipped"), true);

      const audit = await database<{ count: number }[]>`
        SELECT count(*)::int AS count FROM audit_events
        WHERE target_type = 'access_request_notification'
          AND target_id IN (${claimA.id}, ${claimB.id})
      `;
      assertEquals(audit[0]?.count, 2);
    } finally {
      await closeDatabase(database, { timeout: 5 });
    }
  },
});
