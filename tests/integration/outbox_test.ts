import { assertEquals } from "@std/assert";
import { loadConfig } from "../../packages/config/mod.ts";
import { closeDatabase, createDatabase } from "../../packages/db/client.ts";
import { runMigrations } from "../../packages/db/migrations.ts";
import { Repository } from "../../packages/db/repository.ts";
import { MutableClock, RandomIdGenerator } from "../../packages/domain/time.ts";
import { OutboxPublisher } from "../../packages/queue/outbox.ts";
import type { JobPublisher } from "../../packages/queue/rabbitmq.ts";

Deno.test({
  name: "outbox confirmation boundary permits duplicate publish but never loses committed work",
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
      await database`UPDATE outbox SET published_at = now(), locked_by = NULL, locked_at = NULL WHERE published_at IS NULL`;
      const clock = new MutableClock(new Date("2026-08-12T12:00:00Z"));
      const repository = new Repository(database, clock, new RandomIdGenerator());
      const userId = String(60_000_000_000 + Math.floor(Math.random() * 1_000_000));
      const sourceId = String(100_000_000 + Math.floor(Math.random() * 900_000_000));
      await repository.upsertTelegramPrincipal({ externalUserId: userId });
      const submission = await repository.submitJob({
        bridge: "telegram",
        idempotencyKey: crypto.randomUUID(),
        requesterExternalUserId: userId,
        submittedUrl: `https://x.com/i/status/${sourceId}`,
        normalizedUrl: `https://x.com/i/status/${sourceId}`,
        sourceId,
        destination: { chatId: userId, requestMessageId: 1 },
        policy: { mode: "ttl", ttlSeconds: 604800, afterDeliveryGraceSeconds: 300 },
        maxQueuedJobs: 1000,
        maxActiveJobsPerUser: 1000,
      });
      const fake = new FakePublisher();
      const claimed = await repository.claimOutbox("dead-publisher", 1, 60);
      assertEquals(claimed[0]?.aggregateId, submission.job.id);
      await fake.publishJob(submission.job.id); // Simulate broker confirmation followed by process death.
      clock.advance(61_000);
      const lifecycle: Array<{ event: string; fields: Readonly<Record<string, unknown>> }> = [];
      const publisher = new OutboxPublisher(
        repository,
        fake,
        "recovered-publisher",
        (event, fields) => lifecycle.push({ event, fields }),
      );
      assertEquals(await publisher.publishBatch(), { published: 1, failed: 0 });
      assertEquals(fake.jobIds, [submission.job.id, submission.job.id]);
      assertEquals(lifecycle[0]?.event, "outbox.job_published");
      assertEquals(lifecycle[0]?.fields.jobId, submission.job.id);
      assertEquals((lifecycle[0]?.fields.durationMilliseconds as number) >= 0, true);
      assertEquals(await publisher.publishBatch(), { published: 0, failed: 0 });
    } finally {
      await closeDatabase(database, { timeout: 5 });
    }
  },
});

class FakePublisher implements JobPublisher {
  readonly jobIds: string[] = [];
  publishJob(jobId: string): Promise<void> {
    this.jobIds.push(jobId);
    return Promise.resolve();
  }
  healthy(): boolean {
    return true;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}
