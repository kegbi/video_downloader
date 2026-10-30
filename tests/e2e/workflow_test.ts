import { assertEquals, assertExists, assertMatch } from "@std/assert";
import { dirname } from "@std/path";
import { createApi } from "../../apps/api/app.ts";
import { WorkerOrchestrator } from "../../apps/worker/orchestrator.ts";
import { loadConfig } from "../../packages/config/mod.ts";
import { closeDatabase, createDatabase } from "../../packages/db/client.ts";
import { runMigrations } from "../../packages/db/migrations.ts";
import { Repository } from "../../packages/db/repository.ts";
import type { DownloadedArtifact, Downloader } from "../../packages/downloader/adapter.ts";
import { MutableClock, RandomIdGenerator } from "../../packages/domain/time.ts";
import { MetricsRegistry } from "../../packages/observability/metrics.ts";
import type { ArtifactRead, ArtifactStorage } from "../../packages/storage/s3.ts";
import { HttpBackend } from "../../packages/telegram/backend.ts";
import {
  type TelegramAdapter,
  TelegramBridge,
  TelegramFailure,
  type TelegramMediaResult,
} from "../../packages/telegram/bridge.ts";

Deno.test({
  name: "fake Telegram workflow survives a bridge restart after timeout without redownloading",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const adminUserId = String(61_000_000_000 + Math.floor(Math.random() * 1_000_000));
    const config = loadConfig("test", {
      APP_ENV: "test",
      POSTGRES_HOST: Deno.env.get("TEST_POSTGRES_HOST") ?? "127.0.0.1",
      POSTGRES_PORT: Deno.env.get("TEST_POSTGRES_PORT") ?? "5432",
      POSTGRES_DB: Deno.env.get("TEST_POSTGRES_DB") ?? "video_downloader_test",
      POSTGRES_USER: Deno.env.get("TEST_POSTGRES_USER") ?? "video_downloader_test",
      POSTGRES_PASSWORD: Deno.env.get("TEST_POSTGRES_PASSWORD") ?? "local-postgres-password",
      INTERNAL_API_TOKEN: "e2e-internal-token",
      MAX_ACTIVE_JOBS_PER_USER: "10",
      TELEGRAM_MAX_UPLOAD_BYTES: "1000",
      MAX_ARTIFACT_BYTES: "1000",
      DOWNLOAD_MAX_TEMP_BYTES: "2100",
      DOWNLOAD_FORMAT_SAFETY_BYTES: "100",
      WORKER_HEARTBEAT_SECONDS: "1",
      WORKER_JOB_LEASE_SECONDS: "10",
      TELEGRAM_DELIVERY_LEASE_SECONDS: "30",
      TELEGRAM_DELIVERY_HEARTBEAT_SECONDS: "5",
      TELEGRAM_ADMIN_USER_IDS: adminUserId,
    });
    const database = createDatabase(config);
    const root = await Deno.makeTempDir();
    try {
      await runMigrations(database, [
        new URL("../../migrations/", import.meta.url),
        new URL("../../drizzle/", import.meta.url),
      ]);
      const clock = new MutableClock(new Date("1970-01-01T00:00:00Z"));
      const ids = new RandomIdGenerator();
      const repository = new Repository(database, clock, ids);
      await repository.bootstrapTelegramAdmins([adminUserId]);
      const userId = String(60_000_000_000 + Math.floor(Math.random() * 1_000_000));
      await repository.upsertTelegramPrincipal({ externalUserId: userId });
      const storage = new MemoryStorage();
      const app = createApi({
        config,
        repository,
        database,
        metrics: new MetricsRegistry(),
        id: () => ids.next(),
        storage,
      });
      const backend = new HttpBackend(
        "http://internal/",
        config.INTERNAL_API_TOKEN,
        async (input, init) => await app.fetch(new Request(input, init)),
      );
      const telegram = new FakeTelegram();
      const bridge = new TelegramBridge(config, backend, telegram, "e2e-bridge");
      const updateId = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
      const sourceId = String(100_000_000 + Math.floor(Math.random() * 900_000_000));
      const fixtureContent = `fixture-video-${crypto.randomUUID()}`;

      await bridge.handleMessage({
        updateId,
        chatId: userId,
        userId,
        messageId: 44,
        chatType: "private",
        text: `https://x.com/example/status/${sourceId}`,
      });
      assertMatch(telegram.replies[0], /^Queued /);
      const rows = await database<{ id: string }[]>`
        SELECT id FROM jobs WHERE idempotency_key = ${`telegram:${updateId}`}
      `;
      const jobId = rows[0]?.id;
      assertExists(jobId);

      const downloader = new FixtureDownloader(root, fixtureContent);
      const worker = new WorkerOrchestrator(
        config,
        repository,
        downloader,
        storage,
        ids,
        "e2e-worker",
      );
      assertEquals(await worker.process(jobId), "ack");
      const readyJob = await repository.getJob(jobId);
      assertEquals(readyJob?.state, "ready");
      assertExists(readyJob?.artifactId);
      const range = await app.request(`/v1/artifacts/${readyJob.artifactId}/content`, {
        headers: { authorization: `Bearer ${config.INTERNAL_API_TOKEN}`, range: "bytes=0-6" },
      });
      assertEquals(range.status, 206);
      assertEquals(await range.text(), "fixture");

      telegram.editFailure = new TelegramFailure("ambiguous", "network timeout");
      assertEquals(await bridge.deliverOnce(), true);
      assertEquals((await repository.getJob(jobId))?.state, "ready");
      assertEquals(telegram.sendCalls, 0);
      clock.advance(6_000);
      telegram.editFailure = undefined;
      const restartedBridge = new TelegramBridge(
        config,
        backend,
        telegram,
        "e2e-bridge-restarted",
      );
      assertEquals(await restartedBridge.deliverOnce(), true);
      assertEquals((await repository.getJob(jobId))?.state, "delivered");
      assertEquals(downloader.calls, 1);
      assertEquals(telegram.deliveredBytes, fixtureContent);

      const unauthorizedUserId = String(
        999_000_000_000 + Math.floor(Math.random() * 1_000_000),
      );
      await bridge.handleMessage({
        updateId: 701,
        chatId: unauthorizedUserId,
        userId: unauthorizedUserId,
        messageId: 45,
        chatType: "private",
        text: "https://x.com/example/status/123456780",
      });
      assertEquals(
        telegram.replies.at(-1),
        "Access request submitted. Downloads remain unavailable until an administrator approves it.",
      );
      const accessRequests = await database<{ state: string; request_count: number }[]>`
        SELECT state, request_count FROM access_requests
        WHERE external_user_id = ${unauthorizedUserId}
      `;
      assertEquals(accessRequests[0], { state: "pending", request_count: 1 });
      const notificationRecoveryBridge = new TelegramBridge(
        config,
        backend,
        telegram,
        "e2e-notification-restarted",
      );
      for (let index = 0; index < 100; index++) {
        if (!await notificationRecoveryBridge.notifyAccessRequestOnce()) break;
      }
      assertEquals(telegram.notifications > 0, true);
      const notification = await database<{ state: string; attempts: number }[]>`
        SELECT n.state, n.attempts FROM access_request_notifications n
        JOIN access_requests r ON r.id = n.access_request_id
        JOIN principals admin ON admin.id = n.admin_principal_id
        WHERE r.external_user_id = ${unauthorizedUserId}
          AND admin.external_user_id = ${adminUserId}
      `;
      assertEquals([...notification], [{ state: "sent", attempts: 1 }]);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
      await closeDatabase(database, { timeout: 5 });
    }
  },
});

class FixtureDownloader implements Downloader {
  calls = 0;
  constructor(private readonly root: string, private readonly content: string) {}
  async download(): Promise<DownloadedArtifact> {
    this.calls++;
    const directory = await Deno.makeTempDir({ dir: this.root });
    const path = `${directory}/fixture.mp4`;
    const bytes = new TextEncoder().encode(this.content);
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

class MemoryStorage implements ArtifactStorage {
  private readonly temporary = new Map<string, Uint8Array>();
  private readonly final = new Map<string, Uint8Array>();
  async putTemporary(
    id: string,
    source: { path: string; byteSize: number; sha256: string },
  ): Promise<string> {
    const bytes = await Deno.readFile(source.path);
    this.temporary.set(`temporary/${id}`, bytes.slice());
    return `temporary/${id}`;
  }
  promote(id: string): Promise<string> {
    this.final.set(`artifacts/${id}`, this.temporary.get(`temporary/${id}`)!);
    this.temporary.delete(`temporary/${id}`);
    return Promise.resolve(`artifacts/${id}`);
  }
  read(key: string, range?: string): Promise<ArtifactRead> {
    const bytes = this.final.get(key)!;
    const match = range?.match(/^bytes=(\d+)-(\d+)$/);
    const start = match ? Number(match[1]) : 0;
    const end = match ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    const selected = bytes.slice(start, end + 1);
    return Promise.resolve({
      body: new Response(selected).body!,
      contentLength: selected.length,
      contentRange: range ? `bytes ${start}-${end}/${bytes.length}` : null,
      contentType: "video/mp4",
    });
  }
  delete(key: string): Promise<void> {
    this.temporary.delete(key);
    this.final.delete(key);
    return Promise.resolve();
  }
  healthy(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class FakeTelegram implements TelegramAdapter {
  readonly replies: string[] = [];
  editFailure?: TelegramFailure;
  sendCalls = 0;
  notifications = 0;
  deliveredBytes = "";
  replyText(_chat: string, _replyTo: number, text: string): Promise<number> {
    this.replies.push(text);
    return Promise.resolve(100 + this.replies.length);
  }
  sendText(): Promise<number> {
    this.notifications++;
    return Promise.resolve(500);
  }
  replyTextWithAccessButtons(_chat: string, _replyTo: number, text: string): Promise<number> {
    this.replies.push(text);
    return Promise.resolve(600 + this.replies.length);
  }
  sendTextWithAccessButtons(): Promise<number> {
    this.notifications++;
    return Promise.resolve(601);
  }
  sendForceReply(_chat: string, text: string): Promise<number> {
    this.replies.push(text);
    return Promise.resolve(602);
  }
  answerCallback(): Promise<void> {
    return Promise.resolve();
  }
  editText(): Promise<void> {
    return Promise.resolve();
  }
  async editMedia(
    _chat: string,
    messageId: number,
    artifact: { body: ReadableStream<Uint8Array> },
  ): Promise<TelegramMediaResult> {
    if (this.editFailure) throw this.editFailure;
    this.deliveredBytes = await new Response(artifact.body).text();
    return { messageId, fileId: "fake-file" };
  }
  sendMedia(): Promise<TelegramMediaResult> {
    this.sendCalls++;
    return Promise.resolve({ messageId: 999 });
  }
  deleteMessage(): Promise<void> {
    return Promise.resolve();
  }
}
