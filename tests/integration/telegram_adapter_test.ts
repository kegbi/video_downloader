import { assertEquals, assertRejects } from "@std/assert";
import { Bot } from "grammy";
import {
  configureTelegramCommands,
  GrammyTelegramAdapter,
  TELEGRAM_UPLOAD_CHUNK_BYTES,
  type TelegramUploadObservation,
} from "../../apps/telegram_bridge/telegram.ts";
import { loadConfig } from "../../packages/config/mod.ts";
import type { ArtifactStream, Backend, DeliveryLease } from "../../packages/telegram/backend.ts";
import { TelegramBridge, TelegramFailure } from "../../packages/telegram/bridge.ts";

Deno.test({
  name:
    "fake Telegram Bot API covers streaming upload, 429, permanent rejection and transport failure",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let mode: "success" | "rate" | "permanent" = "success";
    let uploaded = "";
    const commandBodies: Array<Record<string, unknown>> = [];
    const actionBodies: Array<{ path: string; body: Record<string, unknown> }> = [];
    const controller = new AbortController();
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, signal: controller.signal },
      async (request) => {
        if (new URL(request.url).pathname.endsWith("/setMyCommands")) {
          commandBodies.push(await request.json());
          return Response.json({ ok: true, result: true });
        }
        const path = new URL(request.url).pathname;
        if (path.endsWith("/sendMessage") || path.endsWith("/answerCallbackQuery")) {
          actionBodies.push({ path, body: await request.json() });
          return Response.json({
            ok: true,
            result: path.endsWith("/answerCallbackQuery")
              ? true
              : { message_id: 202, date: 0, chat: { id: 10, type: "private" } },
          });
        }
        uploaded = new TextDecoder().decode(await request.arrayBuffer());
        if (mode === "rate") {
          return Response.json({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 2 },
          });
        }
        if (mode === "permanent") {
          return Response.json({
            ok: false,
            error_code: 400,
            description: "Bad Request: message can't be edited",
          });
        }
        return Response.json({
          ok: true,
          result: {
            message_id: 101,
            date: 0,
            chat: { id: 10, type: "private" },
            video: {
              file_id: "fake-file",
              file_unique_id: "unique",
              width: 16,
              height: 16,
              duration: 1,
            },
          },
        });
      },
    );
    const port = (server.addr as Deno.NetAddr).port;
    const bot = new Bot("test", {
      client: { apiRoot: `http://127.0.0.1:${port}`, timeoutSeconds: 1 },
    });
    const adapter = new GrammyTelegramAdapter(bot.api);

    assertEquals(await configureTelegramCommands(bot.api, ["99", "100"]), {
      attempted: 3,
      failed: 0,
    });
    assertEquals(commandBodies.length, 3);
    assertEquals(commandBodies[0]?.scope, { type: "all_private_chats" });
    assertEquals(commandBodies[1]?.scope, { type: "chat", chat_id: 99 });
    assertEquals(
      (commandBodies[0]?.commands as Array<{ command: string }>).some((item) =>
        item.command === "audit"
      ),
      false,
    );
    assertEquals(
      (commandBodies[1]?.commands as Array<{ command: string }>).some((item) =>
        item.command === "audit"
      ),
      true,
    );

    await adapter.sendTextWithAccessButtons("10", "Pending", {
      requestId: "00000000-0000-4000-8000-000000000060",
      externalUserId: "20",
    });
    await adapter.replyTextWithAccessButtons("10", 5, "Requests", [{
      requestId: "00000000-0000-4000-8000-000000000061",
      externalUserId: "21",
    }]);
    await adapter.sendForceReply("10", "Optional reason");
    await adapter.answerCallback("callback-1", "Reply to the prompt");
    const notificationMarkup = actionBodies[0]?.body.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data?: string; text: string; url?: string }>>;
    };
    assertEquals(notificationMarkup.inline_keyboard[0], [{
      text: "👤 20",
      url: "tg://user?id=20",
    }]);
    assertEquals(notificationMarkup.inline_keyboard[1]?.map((button) => button.callback_data), [
      "access:allow:00000000-0000-4000-8000-000000000060",
      "access:deny:00000000-0000-4000-8000-000000000060",
    ]);
    const pageMarkup = actionBodies[1]?.body.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data?: string; text: string; url?: string }>>;
    };
    assertEquals(pageMarkup.inline_keyboard[0], [{
      text: "👤 21",
      url: "tg://user?id=21",
    }]);
    assertEquals(pageMarkup.inline_keyboard.length, 2);
    assertEquals(actionBodies[1]?.body.parse_mode, "HTML");
    assertEquals(actionBodies[2]?.body.reply_markup, {
      force_reply: true,
      input_field_placeholder: "Optional internal note",
    });
    assertEquals(actionBodies[3]?.body, {
      callback_query_id: "callback-1",
      text: "Reply to the prompt",
      show_alert: false,
    });

    const result = await adapter.editMedia("10", 101, artifact(), "fixture.mp4", "video");
    assertEquals(result.messageId, 101);
    assertEquals(result.fileId, "fake-file");
    assertEquals(result.transfer?.bytes, new TextEncoder().encode("fixture-video").byteLength);
    assertEquals(result.transfer?.chunks, 1);
    assertEquals(result.transfer?.streamCompleted, true);
    assertEquals((result.transfer?.totalDurationMilliseconds ?? -1) >= 0, true);
    assertEquals(uploaded.includes("fixture-video"), true);

    mode = "rate";
    const rate = await assertRejects(
      () => adapter.editMedia("10", 101, artifact(), "fixture.mp4", "video"),
      TelegramFailure,
    );
    assertEquals(rate.kind, "retryable");
    assertEquals(rate.retryAfterSeconds, 2);

    mode = "permanent";
    const permanent = await assertRejects(
      () => adapter.editMedia("10", 101, artifact(), "fixture.mp4", "video"),
      TelegramFailure,
    );
    assertEquals(permanent.kind, "permanent");

    const failedCommands = await configureTelegramCommands(
      {
        setMyCommands: () => Promise.reject(new Error("permanent fake failure")),
      } as unknown as Parameters<typeof configureTelegramCommands>[0],
      ["99"],
      50,
    );
    assertEquals(failedCommands, { attempted: 2, failed: 2 });

    const timedOutCommands = await configureTelegramCommands(
      {
        setMyCommands: () => new Promise(() => undefined),
      } as unknown as Parameters<typeof configureTelegramCommands>[0],
      ["99"],
      10,
    );
    assertEquals(timedOutCommands, { attempted: 2, failed: 2 });

    controller.abort();
    await server.finished;
    const transport = await assertRejects(
      () => adapter.editMedia("10", 101, artifact(), "fixture.mp4", "video"),
      TelegramFailure,
    );
    assertEquals(transport.kind, "ambiguous");
  },
});

Deno.test({
  name:
    "fake Bot API and backend cover slow backpressure, cancellation, ambiguity, retry, and fallback",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    type Mode = "success" | "slow" | "ambiguous" | "retryable" | "fallback" | "permanent";
    let mode: Mode = "success";
    let slowStarted = signal();
    let releaseSlow = signal();
    let uploadFinished = signal();
    let releaseResponse = signal();
    const methods: string[] = [];
    const requestBytes: number[] = [];
    const controller = new AbortController();
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, signal: controller.signal },
      async (request) => {
        const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
        methods.push(method);
        if (method === "deleteMessage") {
          await request.arrayBuffer();
          return Response.json({ ok: true, result: true });
        }
        if (method === "editMessageText") {
          requestBytes.push(await consumeRequest(request));
          return mediaResponse(101);
        }
        if (mode === "slow") {
          slowStarted.resolve();
          await releaseSlow.promise;
        }
        requestBytes.push(await consumeRequest(request));
        if (mode === "ambiguous") {
          uploadFinished.resolve();
          await releaseResponse.promise;
        }
        if (mode === "retryable") {
          return Response.json({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 2 },
          });
        }
        if (
          (mode === "fallback" && method === "editMessageMedia") ||
          mode === "permanent"
        ) {
          return Response.json({
            ok: false,
            error_code: 400,
            description: "Bad Request: media operation rejected",
          });
        }
        return mediaResponse(method === "editMessageMedia" ? 101 : 202);
      },
    );
    const port = (server.addr as Deno.NetAddr).port;
    const apiRoot = `http://127.0.0.1:${port}`;
    const observations: TelegramUploadObservation[] = [];
    const adapter = new GrammyTelegramAdapter(
      new Bot("test", { client: { apiRoot, timeoutSeconds: 30 } }).api,
      (observation) => observations.push(observation),
    );
    const backend = new DeliveryBackendHarness();
    const timing = new ManualHeartbeatWait();
    const bridge = new TelegramBridge(
      loadConfig("test", {
        APP_ENV: "test",
        TELEGRAM_DELIVERY_LEASE_SECONDS: "8",
        TELEGRAM_DELIVERY_HEARTBEAT_SECONDS: "2",
      }),
      backend as unknown as Backend,
      adapter,
      "integration-bridge",
      timing.wait,
    );

    try {
      mode = "slow";
      const slowBytes = 64 * 1024 * 1024;
      backend.artifactBytes = slowBytes;
      backend.claims.push(deliveryLease("00000000-0000-4000-8000-000000000101", slowBytes));
      const slowAttempt = bridge.deliverOnce();
      await slowStarted.promise;
      await waitUntil(() => chunkBytes(observations) > 0 && timing.pending === 1);
      assertEquals(chunkBytes(observations) < slowBytes, true);
      for (let interval = 0; interval < 5; interval++) {
        timing.tick();
        await waitUntil(() => backend.heartbeats === interval + 2 && timing.pending === 1);
      }
      releaseSlow.resolve();
      assertEquals(await slowAttempt, true);
      assertEquals(backend.completions.length, 1);
      assertEquals(backend.failures.length, 0);
      assertEquals(chunkBytes(observations), slowBytes);
      assertEquals(maxChunkBytes(observations) <= TELEGRAM_UPLOAD_CHUNK_BYTES, true);
      assertEquals(
        observations.filter((item) => item.type === "chunk").length,
        slowBytes / TELEGRAM_UPLOAD_CHUNK_BYTES,
      );
      assertEquals(
        observations.some((item) => item.type === "closed" && item.completed),
        true,
      );
      assertEquals(requestBytes.at(-1)! > slowBytes, true);

      observations.length = 0;
      methods.length = 0;
      mode = "ambiguous";
      uploadFinished = signal();
      releaseResponse = signal();
      backend.artifactBytes = 512 * 1024;
      backend.claims.push(deliveryLease("00000000-0000-4000-8000-000000000102", 512 * 1024));
      const ambiguityAdapter = new GrammyTelegramAdapter(
        new Bot("test", { client: { apiRoot, timeoutSeconds: 0.05 } }).api,
        (observation) => observations.push(observation),
      );
      const ambiguityBridge = new TelegramBridge(
        loadConfig("test", { APP_ENV: "test" }),
        backend as unknown as Backend,
        ambiguityAdapter,
        "ambiguity-bridge",
      );
      const ambiguousAttempt = ambiguityBridge.deliverOnce();
      await uploadFinished.promise;
      assertEquals(await ambiguousAttempt, true);
      releaseResponse.resolve();
      assertEquals(backend.failures.at(-1)?.retryable, true);
      assertEquals(methods.includes("sendVideo"), false);
      assertEquals(chunkBytes(observations), 512 * 1024);

      mode = "retryable";
      methods.length = 0;
      backend.claims.push(deliveryLease("00000000-0000-4000-8000-000000000103", 512 * 1024));
      assertEquals(await bridge.deliverOnce(), true);
      assertEquals(backend.failures.at(-1), { retryable: true, retryAfterSeconds: 2 });
      assertEquals(methods.includes("sendVideo"), false);

      mode = "fallback";
      methods.length = 0;
      backend.claims.push(deliveryLease("00000000-0000-4000-8000-000000000104", 512 * 1024));
      assertEquals(await bridge.deliverOnce(), true);
      assertEquals(methods.filter((method) => method === "editMessageMedia").length, 1);
      assertEquals(methods.filter((method) => method === "sendVideo").length, 1);
      assertEquals(backend.operations.at(-1)?.mode, "fallback");
      assertEquals(backend.completions.at(-1), {
        mode: "fallback",
        messageId: 202,
        fileId: "fake-file",
      });

      const opensAfterFallback = backend.artifactOpens;
      const mediaCallsAfterFallback = methods.filter(isMediaMethod).length;
      backend.claims.push(deliveryLease(
        "00000000-0000-4000-8000-000000000105",
        512 * 1024,
        { mode: "fallback", messageId: 202, fileId: "fake-file" },
      ));
      assertEquals(await bridge.deliverOnce(), true);
      assertEquals(backend.artifactOpens, opensAfterFallback);
      assertEquals(methods.filter(isMediaMethod).length, mediaCallsAfterFallback);
      assertEquals(backend.completions.at(-1)?.mode, "fallback");

      mode = "permanent";
      methods.length = 0;
      backend.claims.push(deliveryLease("00000000-0000-4000-8000-000000000106", 512 * 1024));
      assertEquals(await bridge.deliverOnce(), true);
      assertEquals(methods.filter(isMediaMethod), ["editMessageMedia", "sendVideo"]);
      assertEquals(backend.failures.at(-1)?.retryable, false);

      mode = "slow";
      methods.length = 0;
      observations.length = 0;
      slowStarted = signal();
      releaseSlow = signal();
      const boundaryBytes = 1_990_000_000;
      backend.artifactBytes = boundaryBytes;
      backend.claims.push(deliveryLease("00000000-0000-4000-8000-000000000107", boundaryBytes));
      const completionsBeforeCancellation = backend.completions.length;
      const failuresBeforeCancellation = backend.failures.length;
      const shutdown = new AbortController();
      const cancelledAttempt = bridge.deliverOnce(shutdown.signal);
      await slowStarted.promise;
      await waitUntil(() => chunkBytes(observations) > 0);
      assertEquals(chunkBytes(observations) < boundaryBytes, true);
      shutdown.abort(new Error("controlled disconnect"));
      releaseSlow.resolve();
      assertEquals(await cancelledAttempt, true);
      assertEquals(backend.artifactCancellations > 0, true);
      assertEquals(backend.completions.length, completionsBeforeCancellation);
      assertEquals(backend.failures.length, failuresBeforeCancellation);
      assertEquals(methods.includes("sendVideo"), false);
      assertEquals(
        observations.some((item) => item.type === "closed" && !item.completed),
        true,
      );
    } finally {
      releaseSlow.resolve();
      releaseResponse.resolve();
      controller.abort();
      await server.finished;
    }
  },
});

Deno.test("silent MP4 delivery uses Telegram animation for edits and send fallback", async () => {
  const controller = new AbortController();
  let rejectEdit = false;
  const uploads: Array<{ method: string; kind: string }> = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, signal: controller.signal },
    async (request) => {
      const method = new URL(request.url).pathname.split("/").at(-1)!;
      if (method === "editMessageText" || method === "deleteMessage") {
        await request.text();
        return Response.json({ ok: true, result: true });
      }
      const form = await request.formData();
      const kind = method === "editMessageMedia"
        ? JSON.parse(String(form.get("media"))).type
        : form.has("animation")
        ? "animation"
        : "unexpected";
      uploads.push({ method, kind });
      if (method === "editMessageMedia" && rejectEdit) {
        return Response.json({
          ok: false,
          error_code: 400,
          description: "Bad Request: message can't be edited",
        });
      }
      return Response.json({
        ok: true,
        result: {
          message_id: 101,
          date: 0,
          chat: { id: 10, type: "private" },
          animation: {
            file_id: "animation-file",
            file_unique_id: "unique",
            width: 16,
            height: 16,
            duration: 1,
          },
        },
      });
    },
  );
  try {
    const bot = new Bot("test", {
      client: { apiRoot: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}` },
    });
    const backend = new DeliveryBackendHarness();
    backend.artifactBytes = 4;
    const config = loadConfig("test", { APP_ENV: "test" });
    const bridge = new TelegramBridge(
      config,
      backend as unknown as Backend,
      new GrammyTelegramAdapter(bot.api),
      "animation-test",
    );
    for (const fallback of [false, true]) {
      rejectEdit = fallback;
      backend.claims.push({
        ...deliveryLease(crypto.randomUUID(), 4),
        artifactVideoCodec: "h264",
        artifactAudioCodec: null,
      });
      assertEquals(await bridge.deliverOnce(), true);
      assertEquals(backend.completions.at(-1)?.fileId, "animation-file");
      assertEquals(backend.completions.at(-1)?.mode, fallback ? "fallback" : "edit");
    }
    assertEquals(uploads, [
      { method: "editMessageMedia", kind: "animation" },
      { method: "editMessageMedia", kind: "animation" },
      { method: "sendAnimation", kind: "animation" },
    ]);
    assertEquals(backend.failures, []);
  } finally {
    controller.abort();
    await server.finished;
  }
});

function artifact(): ArtifactStream {
  const bytes = new TextEncoder().encode("fixture-video");
  return {
    body: new Response(bytes).body!,
    contentLength: bytes.length,
    contentType: "video/mp4",
  };
}

function mediaResponse(messageId: number): Response {
  return Response.json({
    ok: true,
    result: {
      message_id: messageId,
      date: 0,
      chat: { id: 10, type: "private" },
      video: {
        file_id: "fake-file",
        file_unique_id: "unique",
        width: 16,
        height: 16,
        duration: 1,
      },
    },
  });
}

async function consumeRequest(request: Request): Promise<number> {
  if (!request.body) return 0;
  let total = 0;
  const reader = request.body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return total;
      total += result.value.byteLength;
      await Promise.resolve();
    }
  } catch {
    return total;
  } finally {
    reader.releaseLock();
  }
}

function boundedArtifact(
  totalBytes: number,
  chunkSize: number,
  cancelled: () => void,
): ArtifactStream {
  let remaining = totalBytes;
  return {
    contentLength: totalBytes,
    contentType: "video/mp4",
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining === 0) {
          controller.close();
          return;
        }
        const byteLength = Math.min(chunkSize, remaining);
        remaining -= byteLength;
        controller.enqueue(new Uint8Array(byteLength));
      },
      cancel: cancelled,
    }),
  };
}

class DeliveryBackendHarness {
  readonly claims: DeliveryLease[] = [];
  readonly completions: Array<Record<string, unknown>> = [];
  readonly operations: Array<Record<string, unknown>> = [];
  readonly failures: Array<{ retryable: boolean; retryAfterSeconds?: number }> = [];
  artifactBytes = 512 * 1024;
  upstreamChunkBytes = 512 * 1024;
  artifactOpens = 0;
  artifactCancellations = 0;
  heartbeats = 0;

  claimDelivery(): Promise<DeliveryLease | null> {
    return Promise.resolve(this.claims.shift() ?? null);
  }

  heartbeatDelivery(): Promise<boolean> {
    this.heartbeats++;
    return Promise.resolve(true);
  }

  openArtifact(): Promise<ArtifactStream> {
    this.artifactOpens++;
    return Promise.resolve(boundedArtifact(this.artifactBytes, this.upstreamChunkBytes, () => {
      this.artifactCancellations++;
    }));
  }

  recordDeliveryOperation(
    _id: string,
    _workerId: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    this.operations.push(context);
    return Promise.resolve();
  }

  completeDelivery(
    _id: string,
    _workerId: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    this.completions.push(result);
    return Promise.resolve();
  }

  failDelivery(input: { retryable: boolean; retryAfterSeconds?: number }): Promise<void> {
    this.failures.push({
      retryable: input.retryable,
      retryAfterSeconds: input.retryAfterSeconds,
    });
    return Promise.resolve();
  }
}

function deliveryLease(
  id: string,
  artifactByteSize: number,
  operationContext: Record<string, unknown> | null = null,
): DeliveryLease {
  return {
    id,
    jobId: "00000000-0000-4000-8000-000000000201",
    displayId: "abc123",
    artifactId: "00000000-0000-4000-8000-000000000301",
    attempts: 1,
    destination: { chatId: "10", requestMessageId: 5, progressMessageId: 101 },
    operationContext,
    artifactByteSize,
    artifactContentType: "video/mp4",
  };
}

function signal(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}

class ManualHeartbeatWait {
  private readonly pendingWaits = new Set<() => void>();
  readonly wait = (_milliseconds: number, abortSignal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const finish = () => {
        abortSignal.removeEventListener("abort", abort);
        this.pendingWaits.delete(finish);
        resolve();
      };
      const abort = () => {
        this.pendingWaits.delete(finish);
        reject(abortSignal.reason);
      };
      if (abortSignal.aborted) return abort();
      this.pendingWaits.add(finish);
      abortSignal.addEventListener("abort", abort, { once: true });
    });

  get pending(): number {
    return this.pendingWaits.size;
  }

  tick(): void {
    const next = this.pendingWaits.values().next().value;
    if (!next) throw new Error("No heartbeat wait is pending");
    next();
  }
}

function chunkBytes(observations: readonly TelegramUploadObservation[]): number {
  return observations.reduce(
    (total, observation) => total + (observation.type === "chunk" ? observation.byteLength : 0),
    0,
  );
}

function maxChunkBytes(observations: readonly TelegramUploadObservation[]): number {
  return Math.max(
    ...observations.map((observation) => observation.type === "chunk" ? observation.byteLength : 0),
  );
}

function isMediaMethod(method: string): boolean {
  return method === "editMessageMedia" || method === "sendVideo" || method === "sendDocument";
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached");
}
