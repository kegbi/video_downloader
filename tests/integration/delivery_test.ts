import { assertEquals, assertExists } from "@std/assert";
import { loadConfig } from "../../packages/config/mod.ts";
import { closeDatabase, createDatabase } from "../../packages/db/client.ts";
import { runMigrations } from "../../packages/db/migrations.ts";
import { Repository } from "../../packages/db/repository.ts";
import { MutableClock, RandomIdGenerator } from "../../packages/domain/time.ts";

Deno.test({
  name: "delivery leases recover, persist results, and schedule after-delivery expiry",
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
      // Keep this fixture ahead of unrelated durable rows in a developer database.
      const clock = new MutableClock(new Date("1999-01-01T00:00:00Z"));
      const repository = new Repository(database, clock, new RandomIdGenerator());
      const userId = String(80_000_000_000 + Math.floor(Math.random() * 1_000_000));
      const sourceId = String(100_000_000 + Math.floor(Math.random() * 900_000_000));
      await repository.upsertTelegramPrincipal({ externalUserId: userId });
      const submitted = await repository.submitJob({
        bridge: "telegram",
        idempotencyKey: crypto.randomUUID(),
        requesterExternalUserId: userId,
        submittedUrl: `https://x.com/i/status/${sourceId}`,
        normalizedUrl: `https://x.com/i/status/${sourceId}`,
        sourceId,
        destination: { chatId: userId, requestMessageId: 1 },
        policy: { mode: "after_delivery", ttlSeconds: 100, afterDeliveryGraceSeconds: 30 },
        maxQueuedJobs: 1000,
        maxActiveJobsPerUser: 1000,
      });
      assertExists(await repository.claimJob(submitted.job.id, "worker", 10));
      assertExists(await repository.transitionJob(submitted.job.id, "downloading", "processing"));
      const artifactId = crypto.randomUUID();
      await repository.createUploadingArtifact({
        artifactId,
        jobId: submitted.job.id,
        objectKey: `artifacts/${artifactId}`,
        temporaryObjectKey: `temporary/${artifactId}`,
      });
      await repository.completeArtifact({
        artifactId,
        jobId: submitted.job.id,
        objectKey: `artifacts/${artifactId}`,
        byteSize: 4,
        sha256: artifactId.replaceAll("-", "").repeat(2),
        container: "mp4",
        videoCodec: "h264",
        audioCodec: null,
        durationSeconds: 1,
        width: 16,
        height: 16,
        title: null,
        selectedFormat: {},
      });

      assertEquals(
        await repository.claimDelivery("bridge-before-acknowledgement", 10, submitted.job.id),
        null,
      );
      assertEquals(
        await repository.setDeliveryProgressMessage(submitted.job.id, userId, 2),
        true,
      );

      const first = await repository.claimDelivery("bridge-a", 10, submitted.job.id);
      assertExists(first);
      assertEquals(first.displayId, submitted.job.displayId);
      assertEquals(first.artifactVideoCodec, "h264");
      assertEquals(first.artifactAudioCodec, null);
      assertEquals(first.destination.progressMessageId, 2);
      const held = await database<{ lease_owner: string }[]>`
        SELECT lease_owner FROM deliveries WHERE id = ${first.id}
      `;
      assertEquals(held[0]?.lease_owner, "bridge-a");
      assertEquals(await repository.claimDelivery("bridge-b", 10, submitted.job.id), null);
      clock.advance(4_000);
      assertEquals(await repository.heartbeatDelivery(first.id, "bridge-a", 10), true);
      clock.advance(7_000);
      assertEquals(await repository.claimDelivery("bridge-b", 10, submitted.job.id), null);
      assertEquals(await repository.heartbeatDelivery(first.id, "bridge-a", 10), true);
      clock.advance(11_000);
      const recovered = await repository.claimDelivery("bridge-b", 10, submitted.job.id);
      assertExists(recovered);
      assertEquals(recovered.id, first.id);
      assertEquals(await repository.heartbeatDelivery(recovered.id, "bridge-a", 10), false);
      assertEquals(
        await repository.recordDeliveryOperation(recovered.id, "bridge-b", {
          mode: "fallback",
          messageId: 99,
        }),
        true,
      );
      assertEquals(
        await repository.completeDelivery(recovered.id, "bridge-b", {
          mode: "fallback",
          messageId: 99,
        }),
        true,
      );
      assertEquals((await repository.getJob(submitted.job.id))?.state, "delivered");
      assertEquals(
        (await repository.getReadyArtifact(artifactId))?.expiresAt?.toISOString(),
        new Date(clock.now().getTime() + 30_000).toISOString(),
      );
      assertEquals(await repository.completeDelivery(recovered.id, "bridge-b", {}), true);

      await repository.bootstrapTelegramAdmins([userId]);
      const failedSourceId = String(Number(sourceId) + 1);
      const failed = await repository.submitJob({
        bridge: "telegram",
        idempotencyKey: crypto.randomUUID(),
        requesterExternalUserId: userId,
        submittedUrl: `https://x.com/i/status/${failedSourceId}`,
        normalizedUrl: `https://x.com/i/status/${failedSourceId}`,
        sourceId: failedSourceId,
        destination: { chatId: userId, requestMessageId: 3 },
        policy: { mode: "ttl", ttlSeconds: 100, afterDeliveryGraceSeconds: 0 },
        maxQueuedJobs: 1000,
        maxActiveJobsPerUser: 1000,
      });
      assertEquals(await repository.setDeliveryProgressMessage(failed.job.id, userId, 4), true);
      assertExists(await repository.claimJob(failed.job.id, "worker-terminal", 10));
      assertExists(
        await repository.transitionJob(failed.job.id, "downloading", "failed", {
          errorCode: "extractor_failure",
          safeErrorMessage: "The X extractor could not read this post",
        }),
      );

      const terminal = await repository.claimTerminalProgress("bridge-terminal-a", 10);
      assertExists(terminal);
      assertEquals(terminal.jobId, failed.job.id);
      assertEquals(terminal.state, "failed");
      assertEquals(terminal.safeErrorMessage, "The X extractor could not read this post");
      assertEquals(await repository.claimTerminalProgress("bridge-terminal-b", 10), null);
      assertEquals(
        await repository.completeTerminalProgress(terminal.deliveryId, "bridge-terminal-a"),
        true,
      );
      assertEquals(await repository.claimTerminalProgress("bridge-terminal-b", 10), null);

      assertExists(await repository.retryFailedJob(failed.job.id, userId, crypto.randomUUID()));
      assertExists(await repository.claimJob(failed.job.id, "worker-terminal-retry", 10));
      assertExists(
        await repository.transitionJob(failed.job.id, "downloading", "failed", {
          errorCode: "extractor_failure",
          safeErrorMessage: "The X extractor could not read this post",
        }),
      );
      const retriedTerminal = await repository.claimTerminalProgress("bridge-terminal-b", 10);
      assertExists(retriedTerminal);
      assertEquals(retriedTerminal.jobId, failed.job.id);
      assertEquals(retriedTerminal.attempts, 2);
      assertEquals(
        await repository.failTerminalProgress({
          deliveryId: retriedTerminal.deliveryId,
          workerId: "bridge-terminal-b",
          retryable: true,
          retryAfterSeconds: 5,
        }),
        true,
      );
      assertEquals(await repository.claimTerminalProgress("bridge-terminal-c", 10), null);
      clock.advance(5_000);
      assertExists(await repository.claimTerminalProgress("bridge-terminal-c", 10));
    } finally {
      await closeDatabase(database, { timeout: 5 });
    }
  },
});
