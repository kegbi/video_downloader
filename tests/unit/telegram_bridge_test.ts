import { assertEquals, assertNotMatch } from "@std/assert";
import { loadConfig } from "../../packages/config/mod.ts";
import type {
  ArtifactStream,
  Backend,
  BridgeJob,
  DeliveryLease,
  DeliveryProgress,
  PrincipalView,
  TerminalProgressLease,
} from "../../packages/telegram/backend.ts";
import {
  ProgressCoalescer,
  type TelegramAdapter,
  TelegramBridge,
  TelegramFailure,
  type TelegramMediaKind,
  type TelegramMediaResult,
  type TelegramMessage,
} from "../../packages/telegram/bridge.ts";

const config = loadConfig("test", {
  APP_ENV: "test",
  TELEGRAM_DELIVERY_LEASE_SECONDS: "30",
  TELEGRAM_DELIVERY_HEARTBEAT_SECONDS: "5",
});

Deno.test("Telegram intake enforces private single-URL requests and persists one acknowledgement", async () => {
  const backend = new FakeBackend();
  const telegram = new FakeTelegram();
  const bridge = new TelegramBridge(config, backend, telegram, "bridge-1");
  await bridge.handleMessage(message({ chatType: "group", text: "https://x.com/a/status/123" }));
  await bridge.handleMessage(message({ updateId: 2, text: "two values" }));
  await bridge.handleMessage(message({ updateId: 3, text: "https://x.com/a/status/123456789" }));
  assertEquals(backend.submissions, 1);
  assertEquals(backend.progressUpdates, [{ jobId: backend.job.id, userId: "10", messageId: 103 }]);
  assertEquals(telegram.replies.length, 3);

  await bridge.handleMessage(message({ updateId: 3, text: "/status abc123" }));
  await bridge.handleMessage(message({ updateId: 4, text: "/cancel abc123" }));
  await bridge.handleMessage(message({ updateId: 5, text: "/retry abc123" }));
  await bridge.handleMessage(message({ updateId: 6, text: "/allow 20 trusted" }));
  await bridge.handleMessage(message({ updateId: 7, text: "/deny 20 revoked" }));
  await bridge.handleMessage(message({ updateId: 8, text: "/users" }));
  await bridge.handleMessage(message({ updateId: 9, text: "/jobs active 2" }));
  await bridge.handleMessage(message({ updateId: 10, text: "/requests" }));
  await bridge.handleMessage(message({ updateId: 11, text: "/audit" }));
  assertEquals(backend.commandCalls, [
    "status",
    "cancel",
    "retry",
    "allow",
    "deny",
    "users",
    "jobs",
    "requests",
    "audit",
  ]);
  assertEquals(telegram.replies.some((reply) => reply.includes("Jobs (active) — page 2")), true);
  assertEquals(
    telegram.buttonMessages.at(-1)?.text.includes(
      '<a href="tg://user?id=20">20</a>: pending',
    ),
    true,
  );

  backend.progress.push({
    jobId: backend.job.id,
    displayId: backend.job.displayId,
    state: "downloading",
    phase: "downloading",
    percent: 20,
    destination: { chatId: "10", requestMessageId: 5, progressMessageId: 103 },
  });
  assertEquals(await bridge.refreshProgressOnce(), 1);
  assertEquals(telegram.edits.at(-1), "abc123: downloading 20%");

  backend.progress.push({
    jobId: backend.job.id,
    displayId: backend.job.displayId,
    state: "queued",
    phase: "retrying_source_timeout",
    percent: null,
    destination: { chatId: "10", requestMessageId: 5, progressMessageId: 103 },
  });
  assertEquals(await bridge.refreshProgressOnce(), 1);
  assertEquals(telegram.edits.at(-1), "abc123: retrying after source timeout");
});

Deno.test("terminal progress finalizes failed, cancelled, and expired messages once", async () => {
  for (
    const testCase of [
      {
        state: "failed" as const,
        safeErrorMessage: "The X extractor could not read this post",
        expected: "abc123: failed — The X extractor could not read this post",
      },
      {
        state: "failed" as const,
        safeErrorMessage:
          "X has withheld this post in the download server's region due to local law",
        expected:
          "abc123: failed — X has withheld this post in the download server's region due to local law",
      },
      { state: "cancelled" as const, safeErrorMessage: null, expected: "abc123: cancelled" },
      { state: "expired" as const, safeErrorMessage: null, expected: "abc123: expired" },
    ]
  ) {
    const backend = new FakeBackend();
    const telegram = new FakeTelegram();
    const bridge = new TelegramBridge(config, backend, telegram, "bridge-terminal");
    backend.terminalProgressClaims.push(terminalProgress(testCase));

    assertEquals(await bridge.refreshProgressOnce(), 1);
    assertEquals(await bridge.refreshProgressOnce(), 0);
    assertEquals(telegram.edits, [testCase.expected]);
    assertEquals(backend.terminalProgressCompletions, [terminalProgress().deliveryId]);
    assertEquals(backend.terminalProgressFailures, []);
  }
});

Deno.test("terminal progress records transient Telegram failures for retry", async () => {
  const backend = new FakeBackend();
  const telegram = new FakeTelegram();
  const bridge = new TelegramBridge(config, backend, telegram, "bridge-terminal-retry");
  backend.terminalProgressClaims.push(terminalProgress());
  telegram.editTextFailures.push(new TelegramFailure("ambiguous", "network timeout"));

  assertEquals(await bridge.refreshProgressOnce(), 0);
  assertEquals(backend.terminalProgressCompletions, []);
  assertEquals(backend.terminalProgressFailures, [{
    deliveryId: terminalProgress().deliveryId,
    retryable: true,
  }]);
});

Deno.test("download lifecycle timings correlate intake, queue progress, and Telegram acceptance", async () => {
  const backend = new FakeBackend();
  const telegram = new FakeTelegram();
  const events: Array<{ event: string; fields: Readonly<Record<string, unknown>> }> = [];
  const bridge = new TelegramBridge(
    config,
    backend,
    telegram,
    "bridge-observed",
    undefined,
    undefined,
    (event, fields) => events.push({ event, fields }),
  );

  await bridge.handleMessage(message({ text: "https://x.com/a/status/123456789" }));
  backend.claims.push(delivery({ artifactReadyAt: new Date(Date.now() - 50).toISOString() }));
  assertEquals(await bridge.deliverOnce(), true);
  assertEquals(telegram.edits.at(-1), "abc123: uploading");
  assertEquals(
    events.filter(({ event }) => event === "telegram.delivery_phase").map(({ fields }) =>
      fields.phase
    ),
    [
      "lease_start",
      "uploading_status",
      "artifact_open",
      "telegram_edit_upload",
      "backend_complete",
    ],
  );

  assertEquals(
    events.map(({ event }) => event).filter((event) => event !== "telegram.delivery_phase"),
    [
      "telegram.update_received",
      "telegram.download_request_received",
      "telegram.job_submitted",
      "telegram.queued_message_sent",
      "telegram.request_queued",
      "telegram.delivery_claimed",
      "telegram.media_accepted",
      "telegram.delivery_completed",
    ],
  );
  const accepted = events.find(({ event }) => event === "telegram.media_accepted")?.fields;
  assertEquals(accepted?.transferBytes, 4);
  assertEquals(accepted?.telegramOperationDurationMilliseconds, 4);
  assertEquals(
    events.every(({ fields }) =>
      typeof fields.durationMilliseconds !== "number" || fields.durationMilliseconds >= 0
    ),
    true,
  );
  assertNotMatch(JSON.stringify(events), /chatId|userId|sourceUrl|x\.com/);
});

Deno.test("help and admin commands are role-aware and access requests notify configured admins", async () => {
  const backend = new FakeBackend();
  const telegram = new FakeTelegram();
  const bridge = new TelegramBridge(
    loadConfig("test", {
      APP_ENV: "test",
      TELEGRAM_ADMIN_USER_IDS: "99",
      TELEGRAM_DELIVERY_LEASE_SECONDS: "30",
      TELEGRAM_DELIVERY_HEARTBEAT_SECONDS: "5",
    }),
    backend,
    telegram,
    "bridge-1",
  );

  backend.access = { state: "active", role: "user", expiresAt: null };
  await bridge.handleMessage(message({ text: "/help" }));
  assertEquals(telegram.replies.at(-1)?.includes("Admin commands"), false);
  await bridge.handleMessage(message({ updateId: 2, text: "/users" }));
  assertEquals(telegram.replies.at(-1), "Unknown or unavailable command.");
  assertEquals(backend.commandCalls.includes("users"), false);

  backend.access = { state: "unauthorized", role: null, expiresAt: null };
  await bridge.handleMessage(message({ updateId: 3, text: "/help" }));
  assertEquals(telegram.replies.at(-1), "Access is required. Use /request to request it.");
  await bridge.handleMessage(message({ updateId: 4, text: "/request" }));
  assertEquals(backend.accessRequests, 1);
  backend.notificationClaims.push({
    id: "00000000-0000-4000-8000-000000000061",
    accessRequestId: "00000000-0000-4000-8000-000000000060",
    adminExternalUserId: "99",
    requesterExternalUserId: "10",
    attempts: 1,
  });
  assertEquals(await bridge.notifyAccessRequestOnce(), true);
  assertEquals(backend.notificationsCompleted, 1);
  assertEquals(telegram.buttonMessages[0]?.chatId, "99");
  assertEquals(telegram.buttonMessages[0]?.requests, [{
    requestId: "00000000-0000-4000-8000-000000000060",
    externalUserId: "10",
  }]);
  assertEquals(telegram.replies.at(-1)?.startsWith("Access request submitted."), true);
});

Deno.test("access request buttons prompt for an optional private reason and resolve a reply", async () => {
  const backend = new FakeBackend();
  const telegram = new FakeTelegram();
  const bridge = new TelegramBridge(config, backend, telegram, "bridge-buttons");
  const requestId = "00000000-0000-4000-8000-000000000060";

  await bridge.handleCallback({
    updateId: 50,
    callbackId: "callback-1",
    chatId: "10",
    userId: "10",
    messageId: 500,
    chatType: "private",
    data: `access:deny:${requestId}`,
  });
  assertEquals(backend.activePrompt?.action, "deny");
  assertEquals(telegram.replies.at(-1)?.includes("optional internal rejection reason"), true);
  assertEquals(telegram.callbackAnswers.at(-1)?.text, "Reply to the new prompt.");

  const promptMessageId = backend.activePrompt?.promptMessageId;
  await bridge.handleMessage(message({
    updateId: 51,
    messageId: 501,
    replyToMessageId: promptMessageId ?? undefined,
    text: "/skip",
  }));
  assertEquals(backend.activePrompt, null);
  assertEquals(
    telegram.replies.at(-1),
    "Rejected the current access request from Telegram user 20.",
  );

  backend.decisionNotificationClaims.push({
    id: "00000000-0000-4000-8000-000000000082",
    accessRequestId: requestId,
    requesterExternalUserId: "20",
    decision: "denied",
    attempts: 1,
  });
  assertEquals(await bridge.notifyAccessDecisionOnce(), true);
  assertEquals(telegram.notifications.at(-1)?.text.includes("declined"), true);

  await bridge.handleCallback({
    updateId: 52,
    callbackId: "callback-2",
    chatId: "10",
    userId: "10",
    messageId: 502,
    chatType: "private",
    data: `access:allow:${requestId}`,
  });
  assertEquals(backend.activePrompt?.action, "allow");
  await bridge.handleMessage(message({ updateId: 53, messageId: 503, text: "/cancel_action" }));
  assertEquals(backend.activePrompt, null);
  assertEquals(telegram.replies.at(-1), "Access decision cancelled.");
});

Deno.test("access notification leases retry safely and command errors include correlation", async () => {
  const backend = new FakeBackend();
  const telegram = new FakeTelegram();
  const bridge = new TelegramBridge(config, backend, telegram, "bridge-restarted");
  backend.notificationClaims.push(
    {
      id: "00000000-0000-4000-8000-000000000071",
      accessRequestId: "00000000-0000-4000-8000-000000000072",
      adminExternalUserId: "99",
      requesterExternalUserId: "10",
      attempts: 1,
    },
    {
      id: "00000000-0000-4000-8000-000000000073",
      accessRequestId: "00000000-0000-4000-8000-000000000074",
      adminExternalUserId: "100",
      requesterExternalUserId: "11",
      attempts: 2,
    },
  );
  telegram.sendTextFailures.push(new TelegramFailure("retryable", "rate", 7));
  assertEquals(await bridge.notifyAccessRequestOnce(), true);
  assertEquals(backend.notificationFailures[0], {
    id: "00000000-0000-4000-8000-000000000071",
    retryable: true,
    retryAfterSeconds: 7,
    errorCode: "retryable",
  });
  assertEquals(await bridge.notifyAccessRequestOnce(), true);
  assertEquals(backend.notificationsCompleted, 1);

  backend.accessError = new (await import("../../packages/telegram/backend.ts")).BackendError(
    "internal_error",
    "The backend request failed",
    true,
    "safe-reference-1",
  );
  await bridge.handleMessage(message({ text: "/help" }));
  assertEquals(telegram.replies.at(-1), "The backend request failed Reference: safe-reference-1");

  backend.accessError = undefined;
  for (
    const [index, command] of [
      "/allow 0",
      "/allow 01",
      "/allow 9007199254740992",
      `/allow ${"9".repeat(1_000)}`,
      "/deny 01 reason",
      "/deny 20",
    ].entries()
  ) {
    await bridge.handleMessage(message({ updateId: 100 + index, text: command }));
    assertEquals(
      / Reference: [0-9a-f-]{36}$/.test(telegram.replies.at(-1) ?? ""),
      true,
    );
  }
  assertEquals(backend.commandCalls.includes("allow"), false);
  assertEquals(backend.commandCalls.includes("deny"), false);
});

Deno.test("delivery edits in place, retries ambiguous outcomes and safely records fallback", async () => {
  const backend = new FakeBackend();
  const telegram = new FakeTelegram();
  const bridge = new TelegramBridge(config, backend, telegram, "bridge-1");

  backend.claims.push(delivery());
  assertEquals(await bridge.deliverOnce(), true);
  assertEquals(backend.completions[0]?.result.mode, "edit");
  assertEquals(backend.artifactOpens, 1);

  telegram.editFailure = new TelegramFailure("ambiguous", "timeout");
  backend.claims.push(delivery({ id: "00000000-0000-4000-8000-000000000022" }));
  await bridge.deliverOnce();
  assertEquals(backend.failures.at(-1)?.retryable, true);
  assertEquals(telegram.sent, 0);

  telegram.editFailure = new TelegramFailure("permanent", "cannot edit text to media");
  backend.claims.push(delivery({ id: "00000000-0000-4000-8000-000000000023" }));
  await bridge.deliverOnce();
  assertEquals(telegram.sent, 1);
  assertEquals(backend.operations.at(-1)?.context.mode, "fallback");
  assertEquals(backend.completions.at(-1)?.result.mode, "fallback");
  assertEquals(telegram.deleted, 1);

  telegram.editFailure = undefined;
  backend.claims.push(delivery({
    id: "00000000-0000-4000-8000-000000000024",
    operationContext: { mode: "fallback", messageId: 900, fileId: "file-900" },
  }));
  const opensBefore = backend.artifactOpens;
  await bridge.deliverOnce();
  assertEquals(backend.artifactOpens, opensBefore);
  assertEquals(backend.completions.at(-1)?.result.messageId, 900);
  assertEquals(telegram.sent, 1);
});

Deno.test("delivery heartbeat renews through an upload spanning multiple lease windows", async () => {
  const backend = new FakeBackend();
  const telegram = new FakeTelegram();
  const timing = new ManualHeartbeatWait();
  const upload = deferred<void>();
  telegram.editGate = upload;
  backend.claims.push(delivery());
  const bridge = new TelegramBridge(
    loadConfig("test", {
      APP_ENV: "test",
      TELEGRAM_DELIVERY_LEASE_SECONDS: "8",
      TELEGRAM_DELIVERY_HEARTBEAT_SECONDS: "2",
    }),
    backend,
    telegram,
    "bridge-long-upload",
    timing.wait,
  );

  const attempt = bridge.deliverOnce();
  await waitUntil(() => telegram.editStarted === 1 && timing.pending === 1);
  // Nine virtual heartbeat intervals represent eighteen seconds: more than two original leases.
  for (let interval = 0; interval < 9; interval++) {
    timing.tick();
    await waitUntil(() => backend.heartbeats === interval + 2 && timing.pending === 1);
  }
  upload.resolve();

  assertEquals(await attempt, true);
  assertEquals(backend.heartbeats, 10);
  assertEquals(backend.completedWhileOwned, true);
  assertEquals(backend.completions.length, 1);
  assertEquals(timing.pending, 0);
});

Deno.test("heartbeat lease loss aborts streaming and starts no later Telegram operation", async () => {
  const backend = new FakeBackend();
  const telegram = new FakeTelegram();
  const timing = new ManualHeartbeatWait();
  telegram.editGate = deferred<void>();
  backend.heartbeatResults.push(true, false);
  backend.claims.push(delivery());
  const bridge = new TelegramBridge(
    loadConfig("test", {
      APP_ENV: "test",
      TELEGRAM_DELIVERY_LEASE_SECONDS: "8",
      TELEGRAM_DELIVERY_HEARTBEAT_SECONDS: "2",
    }),
    backend,
    telegram,
    "bridge-lost-lease",
    timing.wait,
  );

  const attempt = bridge.deliverOnce();
  await waitUntil(() => telegram.editStarted === 1 && timing.pending === 1);
  timing.tick();

  assertEquals(await attempt, true);
  assertEquals(telegram.editAborted, 1);
  assertEquals(telegram.sent, 0);
  assertEquals(backend.completions.length, 0);
  assertEquals(backend.failures.length, 0);
  assertEquals(backend.artifactStreamCancellations, 1);
  assertEquals(timing.pending, 0);
});

Deno.test("a never-resolving heartbeat times out, aborts upload, and stops cleanly", async () => {
  const backend = new FakeBackend();
  const telegram = new FakeTelegram();
  const timing = new ManualHeartbeatWait();
  const heartbeatDeadline = new ManualHeartbeatWait();
  telegram.editGate = deferred<void>();
  backend.heartbeatResults.push(true, new Promise<boolean>(() => undefined));
  backend.claims.push(delivery());
  const bridge = new TelegramBridge(
    config,
    backend,
    telegram,
    "bridge-hung-heartbeat",
    timing.wait,
    heartbeatDeadline.wait,
  );

  const attempt = bridge.deliverOnce();
  await waitUntil(() => telegram.editStarted === 1 && timing.pending === 1);
  timing.tick();
  await waitUntil(() => backend.heartbeats === 2 && heartbeatDeadline.pending === 1);
  heartbeatDeadline.tick();

  assertEquals(await attempt, true);
  assertEquals(telegram.editAborted, 1);
  assertEquals(backend.artifactStreamCancellations, 1);
  assertEquals(backend.completions.length, 0);
  assertEquals(backend.failures.length, 0);
  assertEquals(timing.pending, 0);
  assertEquals(heartbeatDeadline.pending, 0);
});

Deno.test("known Telegram acceptance is persisted when shutdown races the result", async () => {
  const backend = new FakeBackend();
  const telegram = new FakeTelegram();
  const shutdown = new AbortController();
  telegram.afterEditAccepted = () => shutdown.abort();
  backend.claims.push(delivery());
  const bridge = new TelegramBridge(config, backend, telegram, "bridge-result-race");

  assertEquals(await bridge.deliverOnce(shutdown.signal), true);
  assertEquals(backend.completions.length, 1);
  assertEquals(backend.completions[0]?.result.mode, "edit");
  assertEquals(backend.failures.length, 0);
});

Deno.test("bridge shutdown stops heartbeat and an expired lease can be recovered", async () => {
  const backend = new FakeBackend();
  const firstTelegram = new FakeTelegram();
  const firstTiming = new ManualHeartbeatWait();
  const firstHeartbeatDeadline = new ManualHeartbeatWait();
  const shutdown = new AbortController();
  firstTelegram.editGate = deferred<void>();
  backend.heartbeatResults.push(true, new Promise<boolean>(() => undefined));
  backend.claims.push(delivery());
  const firstBridge = new TelegramBridge(
    config,
    backend,
    firstTelegram,
    "bridge-before-restart",
    firstTiming.wait,
    firstHeartbeatDeadline.wait,
  );

  const interrupted = firstBridge.deliverOnce(shutdown.signal);
  await waitUntil(() => firstTelegram.editStarted === 1 && firstTiming.pending === 1);
  firstTiming.tick();
  await waitUntil(() => backend.heartbeats === 2 && firstHeartbeatDeadline.pending === 1);
  shutdown.abort();
  assertEquals(await interrupted, true);
  assertEquals(firstTelegram.editAborted, 1);
  assertEquals(firstTiming.pending, 0);
  assertEquals(firstHeartbeatDeadline.pending, 0);
  assertEquals(backend.completions.length, 0);
  assertEquals(backend.failures.length, 0);

  backend.claims.push(delivery({ attempts: 2 }));
  const restartedTelegram = new FakeTelegram();
  const restartedBridge = new TelegramBridge(
    config,
    backend,
    restartedTelegram,
    "bridge-after-restart",
    new ManualHeartbeatWait().wait,
  );
  assertEquals(await restartedBridge.deliverOnce(), true);
  assertEquals(backend.completions.length, 1);
  assertEquals(restartedTelegram.sent, 0);
});

Deno.test("progress coalescer favors phase changes and bounded percentage edits", () => {
  const progress = new ProgressCoalescer(2_000);
  assertEquals(progress.shouldPublish("job", "download", 1, 1_000), true);
  assertEquals(progress.shouldPublish("job", "download", 3, 1_500), false);
  assertEquals(progress.shouldPublish("job", "download", 8, 1_600), true);
  assertEquals(progress.shouldPublish("job", "processing", null, 1_700), true);
  assertEquals(progress.shouldPublish("job", "processing", null, 4_000), true);
});

function message(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    updateId: 1,
    chatId: "10",
    userId: "10",
    messageId: 5,
    chatType: "private",
    text: "/help",
    ...overrides,
  };
}

function delivery(overrides: Partial<DeliveryLease> = {}): DeliveryLease {
  return {
    id: "00000000-0000-4000-8000-000000000021",
    jobId: "00000000-0000-4000-8000-000000000031",
    displayId: "abc123",
    artifactId: "00000000-0000-4000-8000-000000000041",
    attempts: 1,
    destination: { chatId: "10", requestMessageId: 5, progressMessageId: 101 },
    operationContext: null,
    artifactByteSize: 4,
    artifactContentType: "video/mp4",
    ...overrides,
  };
}

function terminalProgress(
  overrides: Partial<TerminalProgressLease> = {},
): TerminalProgressLease {
  return {
    deliveryId: "00000000-0000-4000-8000-000000000071",
    jobId: "00000000-0000-4000-8000-000000000031",
    displayId: "abc123",
    state: "failed",
    safeErrorMessage: "The X extractor could not read this post",
    attempts: 1,
    destination: { chatId: "10", requestMessageId: 5, progressMessageId: 101 },
    ...overrides,
  };
}

class FakeBackend implements Backend {
  readonly job: BridgeJob = {
    id: "00000000-0000-4000-8000-000000000001",
    displayId: "abc123",
    state: "queued",
    artifactId: null,
    error: null,
  };
  readonly claims: DeliveryLease[] = [];
  readonly progressUpdates: Array<{ jobId: string; userId: string; messageId: number }> = [];
  readonly completions: Array<{ id: string; result: Record<string, unknown> }> = [];
  readonly failures: Array<{ id: string; retryable: boolean }> = [];
  readonly operations: Array<{ id: string; context: Record<string, unknown> }> = [];
  readonly progress: DeliveryProgress[] = [];
  readonly terminalProgressClaims: TerminalProgressLease[] = [];
  readonly terminalProgressCompletions: string[] = [];
  readonly terminalProgressFailures: Array<{ deliveryId: string; retryable: boolean }> = [];
  readonly commandCalls: string[] = [];
  access: Awaited<ReturnType<Backend["getPrincipalAccess"]>> = {
    state: "active",
    role: "admin",
    expiresAt: null,
  };
  submissions = 0;
  artifactOpens = 0;
  accessRequests = 0;
  notificationsCompleted = 0;
  readonly notificationClaims: NonNullable<
    Awaited<ReturnType<Backend["claimAccessRequestNotification"]>>
  >[] = [];
  readonly notificationFailures: Array<{
    id: string;
    retryable: boolean;
    retryAfterSeconds: number;
    errorCode: string;
  }> = [];
  activePrompt: Awaited<ReturnType<Backend["getActiveAccessDecisionPrompt"]>> = null;
  readonly decisionNotificationClaims: NonNullable<
    Awaited<ReturnType<Backend["claimAccessDecisionNotification"]>>
  >[] = [];
  accessError?: Error;
  readonly heartbeatResults: Array<boolean | Promise<boolean>> = [];
  heartbeats = 0;
  leaseOwned = false;
  completedWhileOwned = false;
  artifactStreamCancellations = 0;

  submit(): Promise<{ job: BridgeJob; created: boolean }> {
    this.submissions++;
    return Promise.resolve({ job: this.job, created: true });
  }
  setProgressMessage(jobId: string, userId: string, messageId: number): Promise<void> {
    this.progressUpdates.push({ jobId, userId, messageId });
    return Promise.resolve();
  }
  getJob(): Promise<BridgeJob> {
    this.commandCalls.push("status");
    return Promise.resolve(this.job);
  }
  cancelJob(): Promise<BridgeJob> {
    this.commandCalls.push("cancel");
    return Promise.resolve({ ...this.job, state: "cancelled" });
  }
  retryJob(): Promise<BridgeJob> {
    this.commandCalls.push("retry");
    return Promise.resolve({ ...this.job, state: "queued" });
  }
  allowPrincipal(): Promise<PrincipalView> {
    this.commandCalls.push("allow");
    return Promise.resolve(principal());
  }
  denyPrincipal(): Promise<PrincipalView> {
    this.commandCalls.push("deny");
    return Promise.resolve({ ...principal(), state: "disabled" });
  }
  getPrincipalAccess(): Promise<Awaited<ReturnType<Backend["getPrincipalAccess"]>>> {
    if (this.accessError) return Promise.reject(this.accessError);
    return Promise.resolve(this.access);
  }
  listPrincipals(): ReturnType<Backend["listPrincipals"]> {
    this.commandCalls.push("users");
    return Promise.resolve({ principals: [principal()], page: page(false) });
  }
  listJobs(): ReturnType<Backend["listJobs"]> {
    this.commandCalls.push("jobs");
    return Promise.resolve({
      jobs: [{
        id: this.job.id,
        displayId: this.job.displayId,
        state: this.job.state,
        attempts: 0,
        requesterExternalUserId: "20",
        error: null,
        createdAt: "2026-08-13T12:00:00.000Z",
        updatedAt: "2026-08-13T12:00:00.000Z",
      }],
      page: page(false),
    });
  }
  listAuditEvents(): ReturnType<Backend["listAuditEvents"]> {
    this.commandCalls.push("audit");
    return Promise.resolve({
      events: [{
        id: "00000000-0000-4000-8000-000000000050",
        actorExternalId: "10",
        action: "principal.allow",
        targetType: "principal",
        targetId: "00000000-0000-4000-8000-000000000051",
        result: "success",
        createdAt: "2026-08-13T12:00:00.000Z",
      }],
      page: page(false),
    });
  }
  requestAccess(userId: string): ReturnType<Backend["requestAccess"]> {
    this.accessRequests++;
    return Promise.resolve({
      request: {
        id: "00000000-0000-4000-8000-000000000060",
        externalUserId: userId,
        state: "pending",
        requestCount: 1,
        notificationPending: true,
        firstRequestedAt: "2026-08-13T12:00:00.000Z",
        lastRequestedAt: "2026-08-13T12:00:00.000Z",
        resolvedAt: null,
      },
      created: true,
    });
  }
  listAccessRequests(): ReturnType<Backend["listAccessRequests"]> {
    this.commandCalls.push("requests");
    return Promise.resolve({
      requests: [{
        id: "00000000-0000-4000-8000-000000000060",
        externalUserId: "20",
        state: "pending",
        requestCount: 2,
        notificationPending: true,
        firstRequestedAt: "2026-08-13T12:00:00.000Z",
        lastRequestedAt: "2026-08-13T12:00:00.000Z",
        resolvedAt: null,
      }],
      page: page(false),
    });
  }
  claimAccessRequestNotification(): ReturnType<Backend["claimAccessRequestNotification"]> {
    return Promise.resolve(this.notificationClaims.shift() ?? null);
  }
  completeAccessRequestNotification(): Promise<boolean> {
    this.notificationsCompleted++;
    return Promise.resolve(true);
  }
  failAccessRequestNotification(
    input: Parameters<Backend["failAccessRequestNotification"]>[0],
  ): Promise<boolean> {
    this.notificationFailures.push({
      id: input.id,
      retryable: input.retryable,
      retryAfterSeconds: input.retryAfterSeconds,
      errorCode: input.errorCode,
    });
    return Promise.resolve(true);
  }
  beginAccessDecisionPrompt(
    _actorUserId: string,
    accessRequestId: string,
    action: "allow" | "deny",
  ): ReturnType<Backend["beginAccessDecisionPrompt"]> {
    this.activePrompt = {
      id: "00000000-0000-4000-8000-000000000081",
      accessRequestId,
      requesterExternalUserId: "20",
      action,
      promptMessageId: null,
      expiresAt: "2026-08-14T12:00:00.000Z",
    };
    return Promise.resolve(this.activePrompt);
  }
  attachAccessDecisionPromptMessage(
    _actorUserId: string,
    _promptId: string,
    promptMessageId: number,
  ): ReturnType<Backend["attachAccessDecisionPromptMessage"]> {
    if (!this.activePrompt) return Promise.reject(new Error("No active prompt"));
    this.activePrompt = { ...this.activePrompt, promptMessageId };
    return Promise.resolve(this.activePrompt);
  }
  getActiveAccessDecisionPrompt(): ReturnType<Backend["getActiveAccessDecisionPrompt"]> {
    return Promise.resolve(this.activePrompt);
  }
  resolveAccessDecisionPrompt(): ReturnType<Backend["resolveAccessDecisionPrompt"]> {
    if (!this.activePrompt) return Promise.reject(new Error("No active prompt"));
    const result = {
      accessRequestId: this.activePrompt.accessRequestId,
      requesterExternalUserId: this.activePrompt.requesterExternalUserId,
      decision: this.activePrompt.action === "allow" ? "approved" as const : "denied" as const,
    };
    this.activePrompt = null;
    return Promise.resolve(result);
  }
  cancelAccessDecisionPrompt(): Promise<boolean> {
    this.activePrompt = null;
    return Promise.resolve(true);
  }
  claimAccessDecisionNotification(): ReturnType<Backend["claimAccessDecisionNotification"]> {
    return Promise.resolve(this.decisionNotificationClaims.shift() ?? null);
  }
  completeAccessDecisionNotification(): Promise<boolean> {
    return Promise.resolve(true);
  }
  failAccessDecisionNotification(): Promise<boolean> {
    return Promise.resolve(true);
  }
  listDeliveryProgress(): Promise<readonly DeliveryProgress[]> {
    return Promise.resolve(this.progress);
  }
  claimTerminalProgress(): Promise<TerminalProgressLease | null> {
    return Promise.resolve(this.terminalProgressClaims.shift() ?? null);
  }
  completeTerminalProgress(deliveryId: string): Promise<boolean> {
    this.terminalProgressCompletions.push(deliveryId);
    return Promise.resolve(true);
  }
  failTerminalProgress(
    input: Parameters<Backend["failTerminalProgress"]>[0],
  ): Promise<boolean> {
    this.terminalProgressFailures.push({
      deliveryId: input.deliveryId,
      retryable: input.retryable,
    });
    return Promise.resolve(true);
  }
  claimDelivery(): Promise<DeliveryLease | null> {
    const claim = this.claims.shift() ?? null;
    if (claim) this.leaseOwned = true;
    return Promise.resolve(claim);
  }
  async heartbeatDelivery(): Promise<boolean> {
    this.heartbeats++;
    const extended = await (this.heartbeatResults.shift() ?? true);
    if (!extended) this.leaseOwned = false;
    return extended;
  }
  openArtifact(): Promise<ArtifactStream> {
    this.artifactOpens++;
    const bytes = new Uint8Array([1, 2, 3, 4]);
    return Promise.resolve({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
        },
        cancel: () => {
          this.artifactStreamCancellations++;
        },
      }),
      contentLength: bytes.length,
      contentType: "video/mp4",
    });
  }
  recordDeliveryOperation(
    id: string,
    _workerId: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    this.operations.push({ id, context });
    return Promise.resolve();
  }
  completeDelivery(id: string, _workerId: string, result: Record<string, unknown>): Promise<void> {
    this.completedWhileOwned = this.leaseOwned;
    this.completions.push({ id, result });
    this.leaseOwned = false;
    return Promise.resolve();
  }
  failDelivery(input: { id: string; retryable: boolean }): Promise<void> {
    this.failures.push({ id: input.id, retryable: input.retryable });
    this.leaseOwned = false;
    return Promise.resolve();
  }
  healthy(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class FakeTelegram implements TelegramAdapter {
  readonly replies: string[] = [];
  readonly edits: string[] = [];
  readonly notifications: Array<{ chatId: string; text: string }> = [];
  readonly sendTextFailures: Error[] = [];
  readonly editTextFailures: Error[] = [];
  readonly buttonMessages: Array<{ chatId: string; text: string; requests: readonly unknown[] }> =
    [];
  readonly callbackAnswers: Array<{ id: string; text?: string; showAlert?: boolean }> = [];
  editFailure?: TelegramFailure;
  editGate?: Deferred<void>;
  editStarted = 0;
  editAborted = 0;
  afterEditAccepted?: () => void;
  sent = 0;
  deleted = 0;
  replyText(_chatId: string, _replyToMessageId: number, text: string): Promise<number> {
    this.replies.push(text);
    return Promise.resolve(100 + this.replies.length);
  }
  sendText(chatId: string, text: string): Promise<number> {
    this.notifications.push({ chatId, text });
    const error = this.sendTextFailures.shift();
    if (error) return Promise.reject(error);
    return Promise.resolve(500 + this.notifications.length);
  }
  replyTextWithAccessButtons(
    chatId: string,
    _replyToMessageId: number,
    text: string,
    requests: readonly unknown[],
  ): Promise<number> {
    this.buttonMessages.push({ chatId, text, requests });
    return Promise.resolve(700 + this.buttonMessages.length);
  }
  sendTextWithAccessButtons(
    chatId: string,
    text: string,
    request: unknown,
  ): Promise<number> {
    this.buttonMessages.push({ chatId, text, requests: [request] });
    const error = this.sendTextFailures.shift();
    if (error) return Promise.reject(error);
    return Promise.resolve(700 + this.buttonMessages.length);
  }
  sendForceReply(_chatId: string, text: string): Promise<number> {
    this.replies.push(text);
    return Promise.resolve(800 + this.replies.length);
  }
  answerCallback(id: string, text?: string, showAlert?: boolean): Promise<void> {
    this.callbackAnswers.push({ id, text, showAlert });
    return Promise.resolve();
  }
  editText(_chatId: string, _messageId: number, text: string): Promise<void> {
    this.edits.push(text);
    const error = this.editTextFailures.shift();
    if (error) return Promise.reject(error);
    return Promise.resolve();
  }
  async editMedia(
    _chatId: string,
    _messageId: number,
    artifact: ArtifactStream,
    _filename: string,
    _mediaKind: TelegramMediaKind,
    signal?: AbortSignal,
  ): Promise<TelegramMediaResult> {
    if (this.editFailure) throw this.editFailure;
    this.editStarted++;
    if (this.editGate) {
      try {
        await waitWithSignal(this.editGate.promise, signal);
      } catch (error) {
        this.editAborted++;
        await artifact.body.cancel(error).catch(() => undefined);
        throw error;
      }
    }
    this.afterEditAccepted?.();
    return {
      messageId: 101,
      fileId: "edited-file",
      transfer: {
        bytes: 4,
        chunks: 1,
        streamCompleted: true,
        timeToFirstByteMilliseconds: 1,
        streamDurationMilliseconds: 2,
        responseWaitMilliseconds: 1,
        totalDurationMilliseconds: 4,
      },
    };
  }
  sendMedia(): Promise<TelegramMediaResult> {
    this.sent++;
    return Promise.resolve({ messageId: 900, fileId: "sent-file" });
  }
  deleteMessage(): Promise<void> {
    this.deleted++;
    return Promise.resolve();
  }
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ManualHeartbeatWait {
  private readonly pendingWaits = new Set<() => void>();
  readonly wait = (_milliseconds: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", abort);
        this.pendingWaits.delete(finish);
        resolve();
      };
      const abort = () => {
        this.pendingWaits.delete(finish);
        reject(signal.reason);
      };
      if (signal.aborted) return abort();
      this.pendingWaits.add(finish);
      signal.addEventListener("abort", abort, { once: true });
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

async function waitWithSignal<Value>(
  promise: Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> {
  if (!signal) return await promise;
  if (signal.aborted) throw signal.reason;
  let abort!: () => void;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not reached");
}

function page(hasMore: boolean) {
  return { limit: 10, offset: 0, hasMore, nextOffset: hasMore ? 10 : null };
}

function principal(): PrincipalView {
  return {
    externalUserId: "20",
    role: "user",
    state: "active",
    expiresAt: null,
    note: null,
  };
}
