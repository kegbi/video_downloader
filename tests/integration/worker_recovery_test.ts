import { assertEquals, assertExists } from "@std/assert";
import { AMQPClient } from "@cloudamqp/amqp-client";
import { dirname } from "@std/path";
import { WorkerOrchestrator } from "../../apps/worker/orchestrator.ts";
import { loadConfig } from "../../packages/config/mod.ts";
import { closeDatabase, createDatabase } from "../../packages/db/client.ts";
import { runMigrations } from "../../packages/db/migrations.ts";
import { Repository } from "../../packages/db/repository.ts";
import type { DownloadedArtifact, Downloader } from "../../packages/downloader/adapter.ts";
import { MutableClock, RandomIdGenerator } from "../../packages/domain/time.ts";
import { RabbitJobConsumer, RabbitJobQueue } from "../../packages/queue/rabbitmq.ts";
import type { ArtifactRead, ArtifactStorage } from "../../packages/storage/s3.ts";

Deno.test({
  name: "worker restart requeues an unacked broker message and reclaims only the expired PG lease",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const suffix = crypto.randomUUID();
    const config = loadConfig("test", {
      APP_ENV: "test",
      POSTGRES_HOST: Deno.env.get("TEST_POSTGRES_HOST") ?? "127.0.0.1",
      POSTGRES_PORT: Deno.env.get("TEST_POSTGRES_PORT") ?? "5432",
      POSTGRES_DB: Deno.env.get("TEST_POSTGRES_DB") ?? "video_downloader_test",
      POSTGRES_USER: Deno.env.get("TEST_POSTGRES_USER") ?? "video_downloader_test",
      POSTGRES_PASSWORD: Deno.env.get("TEST_POSTGRES_PASSWORD") ?? "local-postgres-password",
      RABBITMQ_HOST: Deno.env.get("TEST_RABBITMQ_HOST") ?? "127.0.0.1",
      RABBITMQ_USER: Deno.env.get("TEST_RABBITMQ_USER") ?? "video_downloader_test",
      RABBITMQ_PASSWORD: Deno.env.get("TEST_RABBITMQ_PASSWORD") ?? "local-rabbitmq-password",
      RABBITMQ_VHOST: Deno.env.get("TEST_RABBITMQ_VHOST") ?? "video_downloader_test",
      RABBITMQ_DOWNLOAD_QUEUE: `video.download.recovery.${suffix}`,
      RABBITMQ_DOWNLOAD_RETRY_QUEUE: `video.download.recovery.${suffix}.retry`,
      RABBITMQ_DOWNLOAD_DEAD_LETTER_QUEUE: `video.download.recovery.${suffix}.dead`,
      WORKER_JOB_LEASE_SECONDS: "5",
      WORKER_HEARTBEAT_SECONDS: "1",
      WORKER_MAX_ATTEMPTS: "3",
      TELEGRAM_MAX_UPLOAD_BYTES: "1000",
      DOWNLOAD_FORMAT_SAFETY_BYTES: "100",
      MAX_ARTIFACT_BYTES: "1000",
      DOWNLOAD_MAX_TEMP_BYTES: "2100",
    });
    const database = createDatabase(config);
    const publisher = new RabbitJobQueue(config);
    let recoveryConsumer: RabbitJobConsumer | undefined;
    let crashedConnection: Awaited<ReturnType<AMQPClient["connect"]>> | undefined;
    const root = await Deno.makeTempDir();
    try {
      await runMigrations(database, [
        new URL("../../migrations/", import.meta.url),
        new URL("../../drizzle/", import.meta.url),
      ]);
      const clock = new MutableClock(new Date("2026-08-13T12:00:00Z"));
      const ids = new RandomIdGenerator();
      const repository = new Repository(database, clock, ids);
      const userId = String(110_000_000_000 + Math.floor(Math.random() * 1_000_000));
      await repository.upsertTelegramPrincipal({ externalUserId: userId });
      const sourceId = String(200_000_000 + Math.floor(Math.random() * 700_000_000));
      const submission = await repository.submitJob({
        bridge: "telegram",
        idempotencyKey: crypto.randomUUID(),
        requesterExternalUserId: userId,
        submittedUrl: `https://x.com/i/status/${sourceId}`,
        normalizedUrl: `https://x.com/i/status/${sourceId}`,
        sourceId,
        destination: { chatId: userId, requestMessageId: 1 },
        policy: { mode: "ttl", ttlSeconds: 604_800, afterDeliveryGraceSeconds: 300 },
        maxQueuedJobs: 1000,
        maxActiveJobsPerUser: 1000,
      });
      await repository.setDeliveryProgressMessage(submission.job.id, userId, 2);
      await publisher.connect();
      await publisher.publishJob(submission.job.id);

      const client = new AMQPClient(config.rabbitmqUrl);
      crashedConnection = await client.connect();
      const crashedChannel = await crashedConnection.channel();
      let leased = false;
      await crashedChannel.basicConsume(
        config.RABBITMQ_DOWNLOAD_QUEUE,
        { noAck: false },
        async (message) => {
          const payload = JSON.parse(message.bodyToString() ?? "null") as { jobId: string };
          assertEquals(payload.jobId, submission.job.id);
          assertExists(await repository.claimJob(payload.jobId, "crashed-worker", 5));
          leased = true;
          // Deliberately no ack: the connection below represents abrupt consumer loss.
        },
      );
      await waitFor(() => leased, 5_000);
      await crashedConnection.close();
      crashedConnection = undefined;
      assertEquals((await repository.getJob(submission.job.id))?.state, "downloading");
      clock.advance(6_000);

      const downloader = new RecoveryDownloader(root, suffix);
      const storage = new RecoveryStorage();
      const recoveredWorker = new WorkerOrchestrator(
        config,
        repository,
        downloader,
        storage,
        ids,
        "recovered-worker",
      );
      recoveryConsumer = new RabbitJobConsumer(config);
      await recoveryConsumer.start((jobId) => recoveredWorker.process(jobId));
      await waitFor(
        async () => (await repository.getJob(submission.job.id))?.state === "ready",
        8_000,
      );
      const ready = await repository.getJob(submission.job.id);
      assertEquals(ready?.attempts, 2);
      assertExists(ready?.artifactId);
      assertEquals(downloader.calls, 1);
      assertEquals(storage.promotions, 1);
      const counts = await database<{ jobs: number; artifacts: number }[]>`
        SELECT
          (SELECT count(*)::int FROM jobs WHERE id = ${submission.job.id}) AS jobs,
          (SELECT count(*)::int FROM artifacts WHERE job_id = ${submission.job.id}
            AND state = 'ready') AS artifacts
      `;
      assertEquals(counts[0], { jobs: 1, artifacts: 1 });
      const delivery = await repository.claimDelivery("recovery-delivery", 30, submission.job.id);
      assertExists(delivery);
      assertEquals(
        await repository.completeDelivery(delivery.id, "recovery-delivery", {
          mode: "fixture",
          messageId: 3,
        }),
        true,
      );
      assertEquals((await repository.getJob(submission.job.id))?.state, "delivered");
    } finally {
      await crashedConnection?.close().catch(() => undefined);
      await recoveryConsumer?.close().catch(() => undefined);
      await publisher.close().catch(() => undefined);
      await deleteFixtureQueues(config.rabbitmqUrl, [
        config.RABBITMQ_DOWNLOAD_QUEUE,
        config.RABBITMQ_DOWNLOAD_RETRY_QUEUE,
        config.RABBITMQ_DOWNLOAD_DEAD_LETTER_QUEUE,
      ]).catch(() => undefined);
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
      await closeDatabase(database, { timeout: 5 });
    }
  },
});

class RecoveryDownloader implements Downloader {
  calls = 0;
  constructor(private readonly root: string, private readonly marker: string) {}
  async download(): Promise<DownloadedArtifact> {
    this.calls++;
    const directory = await Deno.makeTempDir({ dir: this.root });
    const path = `${directory}/fixture.mp4`;
    const bytes = new TextEncoder().encode(`worker-recovery-fixture-${this.marker}`);
    await Deno.writeFile(path, bytes);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return {
      path,
      temporaryAttemptId: crypto.randomUUID(),
      byteSize: bytes.length,
      sha256: [...digest].map((value) => value.toString(16).padStart(2, "0")).join(""),
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
      durationSeconds: 1,
      width: 16,
      height: 16,
      title: "fixture",
      selection: {
        selector: "fixture",
        videoFormatId: "fixture",
        audioFormatId: null,
        estimatedBytes: bytes.length,
        height: 16,
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        compatibilityScore: 10,
      },
    };
  }
  heartbeat(): Promise<void> {
    return Promise.resolve();
  }
  async cleanup(artifact: DownloadedArtifact): Promise<void> {
    await Deno.remove(dirname(artifact.path), { recursive: true });
  }
}

class RecoveryStorage implements ArtifactStorage {
  promotions = 0;
  putTemporary(): Promise<string> {
    return Promise.resolve("temporary/fixture");
  }
  promote(): Promise<string> {
    this.promotions++;
    return Promise.resolve("artifacts/fixture");
  }
  read(): Promise<ArtifactRead> {
    throw new Error("not used");
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  healthy(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

async function deleteFixtureQueues(url: string, names: readonly string[]): Promise<void> {
  const client = new AMQPClient(url);
  const connection = await client.connect();
  try {
    const channel = await connection.channel();
    for (const name of names) await channel.queueDelete(name);
  } finally {
    await connection.close();
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for worker recovery state");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
