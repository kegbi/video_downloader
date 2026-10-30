import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { loadConfig } from "../../packages/config/mod.ts";
import { closeDatabase, createDatabase } from "../../packages/db/client.ts";
import { runMigrations } from "../../packages/db/migrations.ts";
import { Repository } from "../../packages/db/repository.ts";
import { DomainError } from "../../packages/domain/errors.ts";
import type { RetentionPolicy } from "../../packages/domain/retention.ts";
import { MutableClock, RandomIdGenerator } from "../../packages/domain/time.ts";

Deno.test({
  name: "forever, TTL, active-delivery protection, cleanup retry and abandoned uploads are durable",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const config = loadConfig("test", {
      APP_ENV: "test",
      POSTGRES_HOST: Deno.env.get("TEST_POSTGRES_HOST") ?? "127.0.0.1",
      POSTGRES_PORT: Deno.env.get("TEST_POSTGRES_PORT") ?? "5432",
      POSTGRES_DB: Deno.env.get("TEST_POSTGRES_DB") ?? "video_downloader_test",
      POSTGRES_USER: Deno.env.get("TEST_POSTGRES_USER") ?? "video_downloader_test",
      POSTGRES_PASSWORD: Deno.env.get("TEST_POSTGRES_PASSWORD") ?? "local-postgres-password",
    });
    const database = createDatabase(config);
    try {
      await runMigrations(database, [
        new URL("../../migrations/", import.meta.url),
        new URL("../../drizzle/", import.meta.url),
      ]);
      const clock = new MutableClock(new Date("1980-01-01T00:00:00Z"));
      const repository = new Repository(database, clock, new RandomIdGenerator());
      const userId = String(90_000_000_000 + Math.floor(Math.random() * 1_000_000));
      await repository.upsertTelegramPrincipal({ externalUserId: userId });
      assertEquals(await repository.bootstrapTelegramAdmins([userId]), 1);

      const forever = await readyArtifact(repository, userId, {
        mode: "forever",
        ttlSeconds: 10,
        afterDeliveryGraceSeconds: 0,
      });
      assertEquals((await repository.getReadyArtifact(forever.artifactId))?.expiresAt, null);
      const ceiling = await uploadingArtifact(repository, userId, {
        mode: "ttl",
        ttlSeconds: 10,
        afterDeliveryGraceSeconds: 0,
      });
      await assertRejects(
        () =>
          repository.completeArtifact({
            artifactId: ceiling.artifactId,
            jobId: ceiling.jobId,
            objectKey: `artifacts/${ceiling.artifactId}`,
            byteSize: 1,
            sha256: ceiling.artifactId.replaceAll("-", "").repeat(2),
            container: "mp4",
            videoCodec: "h264",
            audioCodec: "aac",
            durationSeconds: 1,
            width: 16,
            height: 16,
            title: null,
            selectedFormat: {},
            maxStorageBytes: 4,
          }),
        DomainError,
        "configured limit",
      );
      clock.advance(20_000);
      assertEquals(await repository.claimArtifactCleanup(10, forever.artifactId), null);

      const ttl = await readyArtifact(repository, userId, {
        mode: "ttl",
        ttlSeconds: 10,
        afterDeliveryGraceSeconds: 0,
      });
      assertExists(await repository.setDeliveryProgressMessage(ttl.jobId, userId, 2));
      const lease = await repository.claimDelivery("bridge", 30, ttl.jobId);
      assertExists(lease);
      clock.advance(11_000);
      assertEquals(await repository.claimArtifactCleanup(10, ttl.artifactId), null);
      clock.advance(20_000);
      const cleanup = await repository.claimArtifactCleanup(10, ttl.artifactId);
      assertExists(cleanup);
      assertEquals(await repository.failArtifactCleanup(ttl.artifactId, "Unavailable", 5), true);
      assertEquals(await repository.claimArtifactCleanup(10, ttl.artifactId), null);
      clock.advance(5_000);
      assertExists(await repository.claimArtifactCleanup(10, ttl.artifactId));
      assertEquals(await repository.completeArtifactCleanup(ttl.artifactId), true);
      assertEquals((await repository.getJob(ttl.jobId))?.state, "expired");

      const partial = await submittedJob(repository, userId, {
        mode: "ttl",
        ttlSeconds: 10,
        afterDeliveryGraceSeconds: 0,
      });
      assertExists(await repository.claimJob(partial, "worker", 10));
      assertExists(await repository.transitionJob(partial, "downloading", "processing"));
      const partialArtifact = crypto.randomUUID();
      await repository.createUploadingArtifact({
        artifactId: partialArtifact,
        jobId: partial,
        objectKey: `artifacts/${partialArtifact}`,
        temporaryObjectKey: `temporary/${partialArtifact}`,
      });
      clock.advance(11_000);
      assertExists(await repository.claimArtifactCleanup(10, partialArtifact));
      assertEquals(await repository.completeArtifactCleanup(partialArtifact), true);
      assertEquals((await repository.getJob(partial))?.errorCode, "cleanup_failure");
      const snapshot = await repository.getOperationalSnapshot();
      assertEquals(snapshot.readyArtifactBytes >= 4, true);
      assertEquals(snapshot.oldestQueuedAgeSeconds >= 0, true);
      assertEquals(snapshot.oldestOutboxAgeSeconds >= 0, true);
      assertEquals(snapshot.cleanupFailures >= 0, true);
      assertEquals(snapshot.expiredArtifactLagSeconds >= 0, true);

      const historyOutbox = await repository.claimOutbox("history-purge", 100, 60);
      assertEquals(historyOutbox.length, 4);
      for (const event of historyOutbox) {
        assertEquals(await repository.markOutboxPublished(event.id, "history-purge"), true);
      }
      const accessExternalId = String(90_000_000_000 + Math.floor(Math.random() * 1_000_000));
      const accessRequest = await repository.requestTelegramAccess({
        externalUserId: accessExternalId,
        requestKey: "telegram:history-purge",
        correlationId: "history-purge",
        deniedCooldownSeconds: 604_800,
      });
      const accessAdminId = String(91_000_000_000 + Math.floor(Math.random() * 1_000_000));
      await repository.bootstrapTelegramAdmins([accessAdminId]);
      const decisionPrompt = await repository.beginAccessDecisionPrompt({
        actorExternalUserId: accessAdminId,
        accessRequestId: accessRequest.request.id,
        action: "deny",
        ttlSeconds: 300,
      });
      await repository.resolveAccessDecisionPrompt({
        actorExternalUserId: accessAdminId,
        promptId: decisionPrompt.id,
        note: "retention fixture",
        correlationId: "history-purge-decision",
      });
      clock.advance(2_000);
      const purged = await repository.purgeOldJobHistory(1, 1000);
      assertEquals(purged.jobs, 2);
      assertEquals(purged.auditEvents > 0, true);
      assertEquals(purged.outboxEvents >= historyOutbox.length, true);
      assertEquals(purged.accessRequests >= 1, true);
      const retainedRequest = await database<{
        requests: number;
        notifications: number;
        prompts: number;
        decision_notifications: number;
      }[]>`
        SELECT
          (SELECT count(*)::int FROM access_requests
            WHERE external_user_id = ${accessExternalId}) AS requests,
          (SELECT count(*)::int FROM access_request_notifications
            WHERE access_request_id = ${accessRequest.request.id}) AS notifications,
          (SELECT count(*)::int FROM access_decision_prompts
            WHERE access_request_id = ${accessRequest.request.id}) AS prompts,
          (SELECT count(*)::int FROM access_decision_notifications
            WHERE access_request_id = ${accessRequest.request.id}) AS decision_notifications
      `;
      assertEquals(retainedRequest[0], {
        requests: 0,
        notifications: 0,
        prompts: 0,
        decision_notifications: 0,
      });
      assertEquals(await repository.getJob(ttl.jobId), null);
      assertEquals(await repository.getJob(partial), null);
      assertExists(await repository.getJob(forever.jobId));
      const expiredHistory = await database<{ audit_count: number; outbox_count: number }[]>`
        SELECT
          (SELECT count(*)::int FROM audit_events WHERE created_at <= ${clock.now()}) AS audit_count,
          (SELECT count(*)::int FROM outbox WHERE published_at IS NOT NULL
            AND created_at <= ${clock.now()}) AS outbox_count
      `;
      assertEquals(expiredHistory[0], { audit_count: 0, outbox_count: 0 });
    } finally {
      await closeDatabase(database, { timeout: 5 });
    }
  },
});

async function readyArtifact(
  repository: Repository,
  userId: string,
  policy: RetentionPolicy,
): Promise<{ jobId: string; artifactId: string }> {
  const jobId = await submittedJob(repository, userId, policy);
  assertExists(await repository.claimJob(jobId, "worker", 10));
  assertExists(await repository.transitionJob(jobId, "downloading", "processing"));
  const artifactId = crypto.randomUUID();
  await repository.createUploadingArtifact({
    artifactId,
    jobId,
    objectKey: `artifacts/${artifactId}`,
    temporaryObjectKey: `temporary/${artifactId}`,
  });
  await repository.completeArtifact({
    artifactId,
    jobId,
    objectKey: `artifacts/${artifactId}`,
    byteSize: 4,
    sha256: artifactId.replaceAll("-", "").repeat(2),
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    durationSeconds: 1,
    width: 16,
    height: 16,
    title: null,
    selectedFormat: {},
  });
  return { jobId, artifactId };
}

async function uploadingArtifact(
  repository: Repository,
  userId: string,
  policy: RetentionPolicy,
): Promise<{ jobId: string; artifactId: string }> {
  const jobId = await submittedJob(repository, userId, policy);
  assertExists(await repository.claimJob(jobId, "worker", 10));
  assertExists(await repository.transitionJob(jobId, "downloading", "processing"));
  const artifactId = crypto.randomUUID();
  await repository.createUploadingArtifact({
    artifactId,
    jobId,
    objectKey: `artifacts/${artifactId}`,
    temporaryObjectKey: `temporary/${artifactId}`,
  });
  return { jobId, artifactId };
}

async function submittedJob(
  repository: Repository,
  userId: string,
  policy: RetentionPolicy,
): Promise<string> {
  const sourceId = String(100_000_000 + Math.floor(Math.random() * 900_000_000));
  const result = await repository.submitJob({
    bridge: "telegram",
    idempotencyKey: crypto.randomUUID(),
    requesterExternalUserId: userId,
    submittedUrl: `https://x.com/i/status/${sourceId}`,
    normalizedUrl: `https://x.com/i/status/${sourceId}`,
    sourceId,
    destination: { chatId: userId, requestMessageId: 1 },
    policy,
    maxQueuedJobs: 1000,
    maxActiveJobsPerUser: 1000,
  });
  return result.job.id;
}
