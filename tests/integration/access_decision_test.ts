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
  name: "access decision prompts pause one admin, keep notes private and permit cooldown retry",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const database = createDatabase(loadConfig("test", databaseEnvironment));
    try {
      await runMigrations(database, [
        new URL("../../migrations/", import.meta.url),
        new URL("../../drizzle/", import.meta.url),
      ]);
      const clock = new MutableClock(new Date("2026-08-14T10:00:00Z"));
      const repository = new Repository(database, clock, new RandomIdGenerator());
      await database`
        UPDATE access_requests SET state = 'denied', notification_pending = false,
          resolved_at = COALESCE(resolved_at, ${clock.now()}) WHERE state = 'pending'
      `;
      await database`
        UPDATE access_request_notifications SET state = 'skipped', lease_owner = NULL,
          lease_expires_at = NULL, updated_at = ${clock.now()}
        WHERE state IN ('pending', 'leased')
      `;
      await database`
        UPDATE access_decision_notifications SET state = 'failed', lease_owner = NULL,
          lease_expires_at = NULL, updated_at = ${clock.now()}
        WHERE state IN ('pending', 'leased')
      `;
      await database`
        UPDATE access_decision_prompts SET state = 'cancelled', completed_at = ${clock.now()},
          updated_at = ${clock.now()} WHERE state = 'pending'
      `;

      const suffix = Math.floor(Math.random() * 1_000_000);
      const admin = String(201_000_000_000 + suffix);
      const peerAdmin = String(203_000_000_000 + suffix);
      const requester = String(202_000_000_000 + suffix);
      await repository.bootstrapTelegramAdmins([admin, peerAdmin]);
      const requested = await repository.requestTelegramAccess({
        externalUserId: requester,
        requestKey: "telegram:decision-request",
        correlationId: crypto.randomUUID(),
        deniedCooldownSeconds: 60,
      });

      const denyPrompt = await repository.beginAccessDecisionPrompt({
        actorExternalUserId: admin,
        accessRequestId: requested.request.id,
        action: "deny",
        ttlSeconds: 300,
      });
      await repository.attachAccessDecisionPromptMessage({
        actorExternalUserId: admin,
        promptId: denyPrompt.id,
        promptMessageId: 700,
      });
      const adminPrincipal = await repository.getTelegramPrincipal(admin);
      assertExists(adminPrincipal);
      const paused = await database<{ state: string }[]>`
        SELECT notification.state FROM access_request_notifications notification
        WHERE notification.access_request_id = ${requested.request.id}
          AND notification.admin_principal_id = ${adminPrincipal.id}
      `;
      assertEquals([...paused], [{ state: "pending" }]);
      const notificationCount = await database<{ count: number }[]>`
        SELECT count(*)::int AS count FROM access_request_notifications
        WHERE access_request_id = ${requested.request.id}
      `;
      let peerClaimed = false;
      for (let index = 0; index < (notificationCount[0]?.count ?? 0); index++) {
        const claim = await repository.claimAccessRequestNotification("paused", 30);
        if (!claim) break;
        assertEquals(claim.adminExternalUserId === admin, false);
        if (claim.adminExternalUserId === peerAdmin) peerClaimed = true;
      }
      assertEquals(peerClaimed, true);

      const denied = await repository.resolveAccessDecisionPrompt({
        actorExternalUserId: admin,
        promptId: denyPrompt.id,
        note: "internal-only reason",
        correlationId: crypto.randomUUID(),
      });
      assertEquals(denied.decision, "denied");
      assertEquals(await repository.getTelegramPrincipal(requester), null);
      const deniedState = await database<{
        state: string;
        decision_note: string | null;
        prompt_state: string;
      }[]>`
        SELECT request.state, request.decision_note, prompt.state AS prompt_state
        FROM access_requests request
        JOIN access_decision_prompts prompt ON prompt.access_request_id = request.id
        WHERE request.id = ${requested.request.id} AND prompt.id = ${denyPrompt.id}
      `;
      assertEquals([...deniedState], [{
        state: "denied",
        decision_note: "internal-only reason",
        prompt_state: "completed",
      }]);
      const deniedNotification = await repository.claimAccessDecisionNotification("decision", 30);
      assertEquals(deniedNotification?.requesterExternalUserId, requester);
      assertEquals(deniedNotification?.decision, "denied");
      await repository.completeAccessDecisionNotification(deniedNotification!.id, "decision");

      const coolingDown = await repository.requestTelegramAccess({
        externalUserId: requester,
        requestKey: "telegram:decision-too-soon",
        correlationId: crypto.randomUUID(),
        deniedCooldownSeconds: 60,
      });
      assertEquals(coolingDown.request.state, "denied");
      assertEquals(coolingDown.created, false);

      clock.advance(61_000);
      const reopened = await repository.requestTelegramAccess({
        externalUserId: requester,
        requestKey: "telegram:decision-reopen",
        correlationId: crypto.randomUUID(),
        deniedCooldownSeconds: 60,
      });
      assertEquals(reopened.request.state, "pending");
      assertEquals(reopened.created, true);
      const allowPrompt = await repository.beginAccessDecisionPrompt({
        actorExternalUserId: admin,
        accessRequestId: reopened.request.id,
        action: "allow",
        ttlSeconds: 300,
      });
      await repository.attachAccessDecisionPromptMessage({
        actorExternalUserId: admin,
        promptId: allowPrompt.id,
        promptMessageId: 701,
      });
      const approved = await repository.resolveAccessDecisionPrompt({
        actorExternalUserId: admin,
        promptId: allowPrompt.id,
        note: "trusted source",
        correlationId: crypto.randomUUID(),
      });
      assertEquals(approved.decision, "approved");
      const principal = await repository.getTelegramPrincipal(requester);
      assertEquals(principal?.state, "active");
      assertEquals(principal?.note, "trusted source");
      const approvedNotification = await repository.claimAccessDecisionNotification("approved", 30);
      assertEquals(approvedNotification?.decision, "approved");
    } finally {
      await closeDatabase(database, { timeout: 5 });
    }
  },
});
