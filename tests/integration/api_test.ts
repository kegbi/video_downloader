import { assertEquals, assertExists } from "@std/assert";
import { createApi } from "../../apps/api/app.ts";
import { loadConfig } from "../../packages/config/mod.ts";
import { closeDatabase, createDatabase } from "../../packages/db/client.ts";
import { runMigrations } from "../../packages/db/migrations.ts";
import { Repository } from "../../packages/db/repository.ts";
import { MutableClock, RandomIdGenerator } from "../../packages/domain/time.ts";
import { MetricsRegistry } from "../../packages/observability/metrics.ts";

const environment = {
  APP_ENV: "test",
  INTERNAL_API_TOKEN: "integration-api-token",
  POSTGRES_HOST: Deno.env.get("TEST_POSTGRES_HOST") ?? "127.0.0.1",
  POSTGRES_PORT: Deno.env.get("TEST_POSTGRES_PORT") ?? "5432",
  POSTGRES_DB: Deno.env.get("TEST_POSTGRES_DB") ?? "video_downloader_test",
  POSTGRES_USER: Deno.env.get("TEST_POSTGRES_USER") ?? "video_downloader_test",
  POSTGRES_PASSWORD: Deno.env.get("TEST_POSTGRES_PASSWORD") ?? "local-postgres-password",
};

Deno.test({
  name:
    "API enforces bearer and principal authorization, validates contracts, and creates durable submissions",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const config = loadConfig("test", environment);
    const database = createDatabase(config);
    try {
      await runMigrations(database, [
        new URL("../../migrations/", import.meta.url),
        new URL("../../drizzle/", import.meta.url),
      ]);
      const ids = new RandomIdGenerator();
      const repository = new Repository(
        database,
        new MutableClock(new Date()),
        ids,
      );
      const adminId = randomTelegramId(30_000_000_000);
      const userId = randomTelegramId(40_000_000_000);
      const secondUserId = randomTelegramId(41_000_000_000);
      const disabledUserId = randomTelegramId(42_000_000_000);
      const expiredUserId = randomTelegramId(43_000_000_000);
      const deniedId = randomTelegramId(50_000_000_000);
      const rejectedId = randomTelegramId(55_000_000_000);
      await repository.bootstrapTelegramAdmins([adminId]);
      await repository.adminUpsertTelegramPrincipal({
        actorExternalUserId: adminId,
        targetExternalUserId: userId,
        note: "integration user",
        correlationId: crypto.randomUUID(),
      });
      await repository.adminUpsertTelegramPrincipal({
        actorExternalUserId: adminId,
        targetExternalUserId: secondUserId,
        correlationId: crypto.randomUUID(),
      });
      await repository.upsertTelegramPrincipal({
        externalUserId: disabledUserId,
        state: "disabled",
      });
      await repository.upsertTelegramPrincipal({
        externalUserId: expiredUserId,
        expiresAt: new Date(0),
      });
      const app = createApi({
        config,
        repository,
        database,
        metrics: new MetricsRegistry(),
        id: () => ids.next(),
      });
      const headers = {
        authorization: `Bearer ${config.INTERNAL_API_TOKEN}`,
        "content-type": "application/json",
      };

      const unauthorized = await app.request("/v1/jobs", { method: "POST" });
      assertEquals(unauthorized.status, 401);

      const malformedBody = await app.request("/v1/jobs", {
        method: "POST",
        headers: { ...headers, "x-correlation-id": "validation-body" },
        body: "{}",
      });
      assertEquals(malformedBody.status, 400);
      assertEquals(await malformedBody.json(), {
        error: {
          code: "invalid_url",
          message: "Invalid request",
          correlationId: "validation-body",
          retryable: false,
        },
      });
      const malformedPath = await app.request("/v1/principals/telegram/01/access", {
        headers: { ...headers, "x-correlation-id": "validation-path" },
      });
      assertEquals(malformedPath.status, 400);
      assertEquals((await malformedPath.json()).error, {
        code: "invalid_url",
        message: "Invalid request",
        correlationId: "validation-path",
        retryable: false,
      });
      const malformedQuery = await app.request("/v1/jobs?actorUserId=0&limit=invalid", {
        headers,
      });
      assertEquals(malformedQuery.status, 400);
      const malformedQueryBody = await malformedQuery.json();
      assertEquals(malformedQueryBody.error.code, "invalid_url");
      assertEquals(malformedQueryBody.error.message, "Invalid request");
      assertEquals(malformedQueryBody.error.retryable, false);
      assertEquals(/^[0-9a-f-]{36}$/.test(malformedQueryBody.error.correlationId), true);
      assertEquals(Object.keys(malformedQueryBody.error).sort(), [
        "code",
        "correlationId",
        "message",
        "retryable",
      ]);

      const malformedJsonWithCorrelation = await app.request("/v1/jobs", {
        method: "POST",
        headers: { ...headers, "x-correlation-id": "malformed-json" },
        body: "{",
      });
      assertEquals(malformedJsonWithCorrelation.status, 400);
      assertEquals(await malformedJsonWithCorrelation.json(), {
        error: {
          code: "invalid_url",
          message: "Invalid request",
          correlationId: "malformed-json",
          retryable: false,
        },
      });
      const malformedJsonWithGeneratedCorrelation = await app.request("/v1/jobs", {
        method: "POST",
        headers: { ...headers, "content-type": "application/problem+json" },
        body: "{",
      });
      assertEquals(malformedJsonWithGeneratedCorrelation.status, 400);
      const generatedMalformedJsonBody = await malformedJsonWithGeneratedCorrelation.json();
      assertEquals(generatedMalformedJsonBody.error.code, "invalid_url");
      assertEquals(generatedMalformedJsonBody.error.message, "Invalid request");
      assertEquals(generatedMalformedJsonBody.error.retryable, false);
      assertEquals(/^[0-9a-f-]{36}$/.test(generatedMalformedJsonBody.error.correlationId), true);

      const internalSyntaxApp = createApi({
        config,
        repository: new class extends Repository {
          override listJobs(
            ..._args: Parameters<Repository["listJobs"]>
          ): ReturnType<Repository["listJobs"]> {
            return Promise.reject(new SyntaxError("internal parser detail"));
          }
        }(database, new MutableClock(new Date()), ids),
        database,
        metrics: new MetricsRegistry(),
        id: () => ids.next(),
      });
      const internalSyntax = await internalSyntaxApp.request(
        `/v1/jobs?actorUserId=${userId}`,
        { headers: { ...headers, "x-correlation-id": "internal-syntax" } },
      );
      assertEquals(internalSyntax.status, 500);
      assertEquals(await internalSyntax.json(), {
        error: {
          code: "internal_error",
          message: "An internal error occurred",
          correlationId: "internal-syntax",
          retryable: false,
        },
      });

      const invalid = await app.request("/v1/jobs", {
        method: "POST",
        headers,
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          requester: { bridge: "telegram", externalUserId: userId },
          sourceUrl: "https://example.com/video",
          destination: { chatId: userId, requestMessageId: 1 },
        }),
      });
      assertEquals(invalid.status, 400);

      const denied = await app.request("/v1/jobs", {
        method: "POST",
        headers,
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          requester: { bridge: "telegram", externalUserId: deniedId },
          sourceUrl: "https://x.com/i/status/123456789",
          destination: { chatId: deniedId, requestMessageId: 1 },
        }),
      });
      assertEquals(denied.status, 401);

      for (const malformedUserId of ["0", "01", "9007199254740992", "9".repeat(1_000)]) {
        const malformed = await app.request("/v1/jobs", {
          method: "POST",
          headers,
          body: JSON.stringify({
            idempotencyKey: crypto.randomUUID(),
            requester: { bridge: "telegram", externalUserId: malformedUserId },
            sourceUrl: "https://x.com/i/status/123456789",
            destination: { chatId: "1", requestMessageId: 1 },
          }),
        });
        assertEquals(malformed.status, 400);
      }

      const requestPath = `/v1/access-requests/telegram/${deniedId}`;
      const firstAccessRequest = await app.request(requestPath, {
        method: "POST",
        headers,
        body: JSON.stringify({ requestKey: "telegram:access-one" }),
      });
      assertEquals(firstAccessRequest.status, 200);
      const firstAccessBody = await firstAccessRequest.json();
      assertEquals(firstAccessBody.created, true);
      const repeatedAccessRequest = await app.request(requestPath, {
        method: "POST",
        headers,
        body: JSON.stringify({ requestKey: "telegram:access-two" }),
      });
      const repeatedAccessBody = await repeatedAccessRequest.json();
      assertEquals(repeatedAccessBody.created, false);
      assertEquals(repeatedAccessBody.request.requestCount, 2);
      assertEquals(repeatedAccessBody.request.state, "pending");
      const pendingForUser = await app.request(
        `/v1/access-requests?actorUserId=${userId}&limit=1&offset=0`,
        { headers },
      );
      assertEquals(pendingForUser.status, 401);
      const pendingForAdmin = await app.request(
        `/v1/access-requests?actorUserId=${adminId}&limit=100&offset=0`,
        { headers },
      );
      const pendingBody = await pendingForAdmin.json();
      assertEquals(
        pendingBody.requests.some((request: { externalUserId: string }) =>
          request.externalUserId === deniedId
        ),
        true,
      );
      assertEquals(pendingBody.page.limit, 100);

      const forbiddenPrompt = await app.request(
        `/v1/access-requests/${firstAccessBody.request.id}/decision-prompts`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ actorUserId: userId, action: "deny", ttlSeconds: 300 }),
        },
      );
      assertEquals(forbiddenPrompt.status, 401);
      const promptResponse = await app.request(
        `/v1/access-requests/${firstAccessBody.request.id}/decision-prompts`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ actorUserId: adminId, action: "deny", ttlSeconds: 300 }),
        },
      );
      assertEquals(promptResponse.status, 200);
      const promptBody = await promptResponse.json();
      const attachedPrompt = await app.request(
        `/v1/access-decision-prompts/${promptBody.id}/message`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ actorUserId: adminId, promptMessageId: 900 }),
        },
      );
      assertEquals((await attachedPrompt.json()).promptMessageId, 900);
      const activePrompt = await app.request(
        `/v1/access-decision-prompts/active?actorUserId=${adminId}`,
        { headers },
      );
      assertEquals((await activePrompt.json()).prompt.id, promptBody.id);
      const resolvedPrompt = await app.request(
        `/v1/access-decision-prompts/${promptBody.id}/resolve`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ actorUserId: adminId, note: null }),
        },
      );
      assertEquals((await resolvedPrompt.json()).decision, "denied");
      await database`
        UPDATE access_decision_notifications SET available_at = ${new Date(0)}
        WHERE access_request_id = ${firstAccessBody.request.id} AND state = 'pending'
      `;
      const decisionClaim = await app.request("/v1/access-decision-notifications/claim", {
        method: "POST",
        headers,
        body: JSON.stringify({ workerId: "api-decision", leaseSeconds: 30 }),
      });
      const decisionClaimBody = await decisionClaim.json();
      assertEquals(decisionClaimBody.notification.requesterExternalUserId, deniedId);
      assertEquals(decisionClaimBody.notification.decision, "denied");

      const idempotencyKey = crypto.randomUUID();
      const acceptedSourceId = randomSourceId();
      const body = JSON.stringify({
        idempotencyKey,
        requester: { bridge: "telegram", externalUserId: userId },
        sourceUrl: `https://twitter.com/someone/status/${acceptedSourceId}?s=20`,
        destination: { chatId: userId, requestMessageId: 42 },
      });
      const accepted = await app.request("/v1/jobs", { method: "POST", headers, body });
      assertEquals(accepted.status, 200);
      const acceptedBody = await accepted.json();
      assertEquals(acceptedBody.created, true);
      assertEquals(acceptedBody.job.state, "queued");
      const duplicate = await app.request("/v1/jobs", { method: "POST", headers, body });
      assertEquals((await duplicate.json()).created, false);
      for (
        const [requesterId, expectedStatus] of [
          [secondUserId, 409],
          [deniedId, 401],
          [disabledUserId, 401],
          [expiredUserId, 401],
        ] as const
      ) {
        const crossActor = await app.request("/v1/jobs", {
          method: "POST",
          headers,
          body: body.replace(userId, requesterId).replace(userId, requesterId),
        });
        assertEquals(crossActor.status, expectedStatus);
      }
      const changedUrl = await app.request("/v1/jobs", {
        method: "POST",
        headers,
        body: body.replace(acceptedSourceId, randomSourceId()),
      });
      assertEquals(changedUrl.status, 409);
      const changedSubmittedUrl = await app.request("/v1/jobs", {
        method: "POST",
        headers,
        body: body.replace("?s=20", "?s=21"),
      });
      assertEquals(changedSubmittedUrl.status, 409);
      const changedDestination = await app.request("/v1/jobs", {
        method: "POST",
        headers,
        body: body.replace('"requestMessageId":42', '"requestMessageId":43'),
      });
      assertEquals(changedDestination.status, 409);

      const status = await app.request(
        `/v1/jobs/${acceptedBody.job.id}?requesterUserId=${userId}`,
        { headers },
      );
      assertEquals(status.status, 200);
      const hidden = await app.request(
        `/v1/jobs/${acceptedBody.job.id}?requesterUserId=${deniedId}`,
        { headers },
      );
      assertEquals(hidden.status, 404);

      const userJobs = await app.request(
        `/v1/jobs?actorUserId=${userId}&filter=recent&limit=1&offset=0`,
        { headers },
      );
      const userJobsBody = await userJobs.json();
      assertEquals(userJobs.status, 200);
      assertEquals(userJobsBody.jobs[0].id, acceptedBody.job.id);
      assertEquals(userJobsBody.jobs[0].requesterExternalUserId, null);
      const adminJobs = await app.request(
        `/v1/jobs?actorUserId=${adminId}&filter=active&limit=1&offset=0`,
        { headers },
      );
      const adminJobsBody = await adminJobs.json();
      assertEquals(adminJobs.status, 200);
      assertEquals(adminJobsBody.jobs[0].requesterExternalUserId, userId);

      const deliveryContext = await app.request(
        `/v1/jobs/${acceptedBody.job.id}/delivery-context`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ requesterUserId: userId, progressMessageId: 44 }),
        },
      );
      assertEquals(deliveryContext.status, 200);

      const cancelled = await app.request(`/v1/jobs/${acceptedBody.job.id}/cancel`, {
        method: "POST",
        headers,
        body: JSON.stringify({ requesterUserId: userId }),
      });
      assertEquals(cancelled.status, 200);
      assertEquals((await cancelled.json()).state, "cancelled");
      const terminalClaim = await app.request("/v1/deliveries/progress/claim", {
        method: "POST",
        headers,
        body: JSON.stringify({ workerId: "api-terminal-bridge", leaseSeconds: 30 }),
      });
      assertEquals(terminalClaim.status, 200);
      const terminalProgress = (await terminalClaim.json()).progress;
      assertEquals(terminalProgress.jobId, acceptedBody.job.id);
      assertEquals(terminalProgress.state, "cancelled");
      assertEquals(terminalProgress.safeErrorMessage, null);
      const terminalComplete = await app.request(
        `/v1/deliveries/progress/${terminalProgress.deliveryId}/complete`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ workerId: "api-terminal-bridge" }),
        },
      );
      assertEquals(terminalComplete.status, 200);
      assertEquals(await terminalComplete.json(), { completed: true });

      const retrySubmission = await app.request("/v1/jobs", {
        method: "POST",
        headers,
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          requester: { bridge: "telegram", externalUserId: userId },
          sourceUrl: `https://x.com/i/status/${randomSourceId()}`,
          destination: { chatId: userId, requestMessageId: 43 },
        }),
      });
      const retryJob = (await retrySubmission.json()).job;
      assertExists(await repository.claimJob(retryJob.id, "api-integration-worker", 30));
      assertExists(
        await repository.transitionJob(retryJob.id, "downloading", "failed", {
          errorCode: "source_unavailable",
          safeErrorMessage: "The X post has no downloadable video",
        }),
      );
      const unauthorizedRetry = await app.request(`/v1/jobs/${retryJob.id}/retry`, {
        method: "POST",
        headers,
        body: JSON.stringify({ actorUserId: userId }),
      });
      assertEquals(unauthorizedRetry.status, 401);
      const retried = await app.request(`/v1/jobs/${retryJob.id}/retry`, {
        method: "POST",
        headers: { ...headers, "x-correlation-id": "api-retry-test" },
        body: JSON.stringify({ actorUserId: adminId }),
      });
      assertEquals(retried.status, 200);
      assertEquals((await retried.json()).state, "queued");
      const retryEvidence = await database<{
        outbox_count: number;
        retry_audit_count: number;
        cancel_audit_count: number;
      }[]>`
        SELECT
          (SELECT count(*)::int FROM outbox WHERE aggregate_id = ${retryJob.id}) AS outbox_count,
          (SELECT count(*)::int FROM audit_events WHERE target_type = 'job'
            AND target_id = ${retryJob.id} AND action = 'job.retry'
            AND correlation_id = 'api-retry-test') AS retry_audit_count,
          (SELECT count(*)::int FROM audit_events WHERE target_type = 'job'
            AND target_id = ${acceptedBody.job.id} AND action = 'job.cancel') AS cancel_audit_count
      `;
      assertEquals(retryEvidence[0], {
        outbox_count: 2,
        retry_audit_count: 1,
        cancel_audit_count: 1,
      });

      const principals = await app.request(`/v1/principals?actorUserId=${adminId}`, { headers });
      assertEquals(principals.status, 200);
      assertExists(
        (await principals.json()).principals.find((principal: { externalUserId: string }) =>
          principal.externalUserId === userId
        ),
      );
      const principalPage = await app.request(
        `/v1/principals?actorUserId=${adminId}&limit=1&offset=0`,
        { headers },
      );
      assertEquals((await principalPage.json()).page.hasMore, true);

      const allowedFromRequest = await app.request(
        `/v1/principals/telegram/${deniedId}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({ actorUserId: adminId, note: "approved request" }),
        },
      );
      assertEquals(allowedFromRequest.status, 200);
      const access = await app.request(`/v1/principals/telegram/${deniedId}/access`, { headers });
      assertEquals(await access.json(), { state: "active", role: "user", expiresAt: null });
      const resolvedRequest = await database<{ state: string }[]>`
        SELECT state FROM access_requests WHERE external_user_id = ${deniedId}
      `;
      assertEquals(resolvedRequest[0]?.state, "approved");

      await app.request(`/v1/access-requests/telegram/${rejectedId}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ requestKey: "telegram:reject-one" }),
      });
      const deniedRequest = await app.request(`/v1/principals/telegram/${rejectedId}`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ actorUserId: adminId, reason: "request denied" }),
      });
      assertEquals(deniedRequest.status, 200);
      assertEquals((await deniedRequest.json()).state, "disabled");
      const rejectedRequest = await database<{ state: string }[]>`
        SELECT state FROM access_requests WHERE external_user_id = ${rejectedId}
      `;
      assertEquals(rejectedRequest[0]?.state, "denied");

      const userAudit = await app.request(
        `/v1/audit-events?actorUserId=${userId}&limit=5&offset=0`,
        { headers },
      );
      assertEquals(userAudit.status, 401);
      const adminAudit = await app.request(
        `/v1/audit-events?actorUserId=${adminId}&limit=5&offset=0`,
        { headers },
      );
      const auditBody = await adminAudit.json();
      assertEquals(adminAudit.status, 200);
      assertEquals(auditBody.events.length > 0, true);
      assertEquals("changes" in auditBody.events[0], false);

      const changedDefaultConfig = loadConfig("test", {
        ...environment,
        RETENTION_TTL_SECONDS: "60",
      });
      const changedDefaultApp = createApi({
        config: changedDefaultConfig,
        repository,
        database,
        metrics: new MetricsRegistry(),
        id: () => ids.next(),
      });
      const omittedRetryAfterDefaultChange = await changedDefaultApp.request("/v1/jobs", {
        method: "POST",
        headers,
        body,
      });
      assertEquals(omittedRetryAfterDefaultChange.status, 200);
      assertEquals((await omittedRetryAfterDefaultChange.json()).created, false);

      const originalRequest = JSON.parse(body);
      const explicitRetry = await app.request("/v1/jobs", {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...originalRequest,
          retention: {
            mode: "ttl",
            ttlSeconds: 604_800,
            afterDeliveryGraceSeconds: 300,
          },
        }),
      });
      assertEquals(explicitRetry.status, 409);

      const explicitSourceId = randomSourceId();
      const explicitRequest = {
        idempotencyKey: crypto.randomUUID(),
        requester: { bridge: "telegram", externalUserId: userId },
        sourceUrl: `https://x.com/i/status/${explicitSourceId}`,
        destination: { chatId: userId, requestMessageId: 91 },
        retention: {
          mode: "ttl",
          ttlSeconds: 604_800,
          afterDeliveryGraceSeconds: 300,
        },
      };
      const explicitFirst = await app.request("/v1/jobs", {
        method: "POST",
        headers,
        body: JSON.stringify(explicitRequest),
      });
      assertEquals(explicitFirst.status, 200);
      const explicitFirstBody = await explicitFirst.json();
      assertEquals(explicitFirstBody.created, true);
      const explicitDuplicate = await app.request("/v1/jobs", {
        method: "POST",
        headers,
        body: JSON.stringify(explicitRequest),
      });
      assertEquals((await explicitDuplicate.json()).created, false);
      const { retention: _omitted, ...withoutExplicitRetention } = explicitRequest;
      const omittedAfterExplicit = await app.request("/v1/jobs", {
        method: "POST",
        headers,
        body: JSON.stringify(withoutExplicitRetention),
      });
      assertEquals(omittedAfterExplicit.status, 409);
      const changedExplicit = await app.request("/v1/jobs", {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...explicitRequest,
          retention: { ...explicitRequest.retention, ttlSeconds: 60 },
        }),
      });
      assertEquals(changedExplicit.status, 409);

      await database`
        UPDATE jobs SET policy = policy - '_submission' WHERE id = ${explicitFirstBody.job.id}
      `;
      const legacyCompatibleRetry = await app.request("/v1/jobs", {
        method: "POST",
        headers,
        body: JSON.stringify(explicitRequest),
      });
      assertEquals(legacyCompatibleRetry.status, 200);
      assertEquals((await legacyCompatibleRetry.json()).created, false);

      const openapi = await app.request("/openapi.json");
      assertEquals(openapi.status, 200);
      const openapiBody = await openapi.json();
      assertExists(openapiBody.paths["/v1/jobs"]);
      assertExists(openapiBody.paths["/v1/access-requests"]);
    } finally {
      await closeDatabase(database, { timeout: 5 });
    }
  },
});

function randomSourceId(): string {
  return String(100_000_000 + Math.floor(Math.random() * 900_000_000));
}

function randomTelegramId(base: number): string {
  return String(base + Math.floor(Math.random() * 1_000_000));
}
