import { assertEquals, assertExists } from "@std/assert";
import { loadConfig } from "../../packages/config/mod.ts";
import { closeDatabase, createDatabase } from "../../packages/db/client.ts";
import { runMigrations } from "../../packages/db/migrations.ts";
import { Repository } from "../../packages/db/repository.ts";
import { MutableClock, RandomIdGenerator } from "../../packages/domain/time.ts";

Deno.test({
  name: "source and SHA-256 deduplication reuse one artifact with conservative retention",
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
      const clock = new MutableClock(new Date("2026-08-13T10:00:00Z"));
      const repository = new Repository(database, clock, new RandomIdGenerator());
      const userId = String(95_000_000_000 + Math.floor(Math.random() * 1_000_000));
      await repository.upsertTelegramPrincipal({ externalUserId: userId });

      const sourceId = randomSourceId();
      const original = await submit(repository, userId, sourceId, "ttl");
      assertExists(await repository.claimJob(original.id, "worker-a", 30));
      assertExists(await repository.transitionJob(original.id, "downloading", "processing"));
      const canonicalId = crypto.randomUUID();
      const sha256 = canonicalId.replaceAll("-", "").repeat(2);
      await repository.createUploadingArtifact({
        artifactId: canonicalId,
        jobId: original.id,
        objectKey: `artifacts/${canonicalId}`,
        temporaryObjectKey: `temporary/${canonicalId}`,
      });
      const completed = await complete(repository, original.id, canonicalId, sha256);
      assertEquals(completed.reused, false);
      assertEquals(completed.artifact.expiresAt?.toISOString(), "2026-08-13T10:00:10.000Z");

      const sourceDuplicate = await submit(repository, userId, sourceId, "forever");
      assertEquals(sourceDuplicate.state, "ready");
      assertEquals(sourceDuplicate.artifactId, canonicalId);
      assertEquals((await repository.getReadyArtifact(canonicalId))?.expiresAt, null);
      const duplicateOutbox = await database<{ count: number }[]>`
        SELECT count(*)::int AS count FROM outbox WHERE aggregate_id = ${sourceDuplicate.id}
      `;
      assertEquals(duplicateOutbox[0]?.count, 0);

      const contentDuplicate = await submit(repository, userId, randomSourceId(), "ttl");
      assertExists(await repository.claimJob(contentDuplicate.id, "worker-b", 30));
      assertExists(
        await repository.transitionJob(contentDuplicate.id, "downloading", "processing"),
      );
      const reusedByHash = await repository.reuseReadyArtifactByContent({
        jobId: contentDuplicate.id,
        byteSize: 100,
        sha256,
        selectedFormat: { selector: "fixture" },
      });
      assertEquals(reusedByHash?.id, canonicalId);
      assertEquals((await repository.getJob(contentDuplicate.id))?.artifactId, canonicalId);

      const raced = await submit(repository, userId, randomSourceId(), "ttl");
      assertExists(await repository.claimJob(raced.id, "worker-c", 30));
      assertExists(await repository.transitionJob(raced.id, "downloading", "processing"));
      const duplicateId = crypto.randomUUID();
      await repository.createUploadingArtifact({
        artifactId: duplicateId,
        jobId: raced.id,
        objectKey: `artifacts/${duplicateId}`,
        temporaryObjectKey: `temporary/${duplicateId}`,
      });
      const raceResult = await complete(repository, raced.id, duplicateId, sha256);
      assertEquals(raceResult.reused, true);
      assertEquals(raceResult.artifact.id, canonicalId);
      assertEquals((await repository.getJob(raced.id))?.artifactId, canonicalId);

      const contents = await database<{ ready_count: number; duplicate_state: string }[]>`
        SELECT
          (SELECT count(*)::int FROM artifacts
            WHERE state = 'ready' AND sha256 = ${sha256} AND byte_size = 100) AS ready_count,
          (SELECT state FROM artifacts WHERE id = ${duplicateId}) AS duplicate_state
      `;
      assertEquals(contents[0], { ready_count: 1, duplicate_state: "delete_failed" });
    } finally {
      await closeDatabase(database, { timeout: 5 });
    }
  },
});

async function submit(
  repository: Repository,
  userId: string,
  sourceId: string,
  mode: "ttl" | "forever",
) {
  return (await repository.submitJob({
    bridge: "telegram",
    idempotencyKey: crypto.randomUUID(),
    requesterExternalUserId: userId,
    submittedUrl: `https://x.com/i/status/${sourceId}`,
    normalizedUrl: `https://x.com/i/status/${sourceId}`,
    sourceId,
    destination: { chatId: userId, requestMessageId: 1 },
    policy: { mode, ttlSeconds: 10, afterDeliveryGraceSeconds: 0 },
    maxQueuedJobs: 1000,
    maxActiveJobsPerUser: 1000,
  })).job;
}

function complete(repository: Repository, jobId: string, artifactId: string, sha256: string) {
  return repository.completeArtifact({
    artifactId,
    jobId,
    objectKey: `artifacts/${artifactId}`,
    byteSize: 100,
    sha256,
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    durationSeconds: 1,
    width: 16,
    height: 16,
    title: null,
    selectedFormat: { selector: "fixture" },
  });
}

function randomSourceId(): string {
  return String(100_000_000 + Math.floor(Math.random() * 900_000_000));
}
