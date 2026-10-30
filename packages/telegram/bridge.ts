import type { AppConfig } from "../config/mod.ts";
import { DomainError } from "../domain/errors.ts";
import { abortableDelay } from "../domain/time.ts";
import { parseTelegramUserId } from "../domain/telegram_id.ts";
import { parseXStatusUrl } from "../domain/x_url.ts";
import {
  type ArtifactStream,
  type Backend,
  BackendError,
  type DeliveryLease,
  type PrincipalAccessView,
  type TerminalProgressLease,
} from "./backend.ts";

export interface TelegramMessage {
  readonly updateId: number;
  readonly chatId: string;
  readonly userId: string;
  readonly messageId: number;
  readonly chatType: "private" | "group" | "supergroup" | "channel";
  readonly text: string;
  readonly replyToMessageId?: number;
}

export interface TelegramCallback {
  readonly updateId: number;
  readonly callbackId: string;
  readonly chatId: string;
  readonly userId: string;
  readonly messageId: number;
  readonly chatType: "private" | "group" | "supergroup" | "channel";
  readonly data: string;
}

export interface AccessRequestButton {
  readonly requestId: string;
  readonly externalUserId: string;
}

export interface TelegramMediaResult {
  readonly messageId: number;
  readonly fileId?: string;
  readonly transfer?: TelegramTransferTiming;
}

export interface TelegramTransferTiming {
  readonly bytes: number;
  readonly chunks: number;
  readonly streamCompleted: boolean;
  readonly timeToFirstByteMilliseconds: number | null;
  readonly streamDurationMilliseconds: number | null;
  readonly responseWaitMilliseconds: number | null;
  readonly totalDurationMilliseconds: number;
}

export type TelegramMediaKind = "video" | "animation" | "document";

export interface TelegramAdapter {
  replyText(chatId: string, replyToMessageId: number, text: string): Promise<number>;
  sendText(chatId: string, text: string): Promise<number>;
  replyTextWithAccessButtons(
    chatId: string,
    replyToMessageId: number,
    text: string,
    requests: readonly AccessRequestButton[],
  ): Promise<number>;
  sendTextWithAccessButtons(
    chatId: string,
    text: string,
    request: AccessRequestButton,
  ): Promise<number>;
  sendForceReply(chatId: string, text: string): Promise<number>;
  answerCallback(callbackId: string, text?: string, showAlert?: boolean): Promise<void>;
  editText(chatId: string, messageId: number, text: string): Promise<void>;
  editMedia(
    chatId: string,
    messageId: number,
    artifact: ArtifactStream,
    filename: string,
    mediaKind: TelegramMediaKind,
    signal?: AbortSignal,
  ): Promise<TelegramMediaResult>;
  sendMedia(
    chatId: string,
    replyToMessageId: number,
    artifact: ArtifactStream,
    filename: string,
    mediaKind: TelegramMediaKind,
    signal?: AbortSignal,
  ): Promise<TelegramMediaResult>;
  deleteMessage(chatId: string, messageId: number): Promise<void>;
}

export class TelegramFailure extends Error {
  constructor(
    public readonly kind: "retryable" | "ambiguous" | "permanent",
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TelegramFailure";
  }
}

export type DeliveryHeartbeatWait = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

export type TelegramLifecycleObserver = (
  event: string,
  fields: Readonly<Record<string, unknown>>,
) => void;

export class TelegramBridge {
  private readonly progress: ProgressCoalescer;

  constructor(
    private readonly config: Readonly<AppConfig>,
    private readonly backend: Backend,
    private readonly telegram: TelegramAdapter,
    private readonly workerId: string,
    private readonly heartbeatWait: DeliveryHeartbeatWait = abortableDelay,
    private readonly heartbeatTimeout: DeliveryHeartbeatWait = abortableDelay,
    private readonly observeLifecycle?: TelegramLifecycleObserver,
  ) {
    this.progress = new ProgressCoalescer(config.TELEGRAM_PROGRESS_MIN_INTERVAL_SECONDS * 1000);
  }

  async handleMessage(message: TelegramMessage): Promise<void> {
    const receivedAt = performance.now();
    const correlationId = crypto.randomUUID();
    this.emit("telegram.update_received", {
      correlationId,
      updateType: "message",
    });
    try {
      parseTelegramUserId(message.userId);
    } catch (error) {
      await this.telegram.replyText(
        message.chatId,
        message.messageId,
        safeMessage(error, correlationId),
      );
      return;
    }
    if (this.config.ALLOW_PRIVATE_CHATS_ONLY && message.chatType !== "private") {
      await this.telegram.replyText(
        message.chatId,
        message.messageId,
        "Please send requests in a private chat.",
      );
      return;
    }
    const text = message.text.trim();
    if (await this.handleAccessDecisionReply(message, text, correlationId)) return;
    if (text.startsWith("/")) {
      await this.handleCommand(message, text, correlationId);
      return;
    }
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length !== 1) {
      await this.telegram.replyText(
        message.chatId,
        message.messageId,
        "Send exactly one public X status URL.",
      );
      return;
    }
    try {
      parseXStatusUrl(parts[0], this.config.sourceAllowedHosts);
      this.emit("telegram.download_request_received", {
        correlationId,
        receiveValidationDurationMilliseconds: elapsedMilliseconds(receivedAt),
      });
      const submitStartedAt = performance.now();
      const submission = await this.backend.submit({
        idempotencyKey: `telegram:${message.updateId}`,
        requesterUserId: message.userId,
        sourceUrl: parts[0],
        chatId: message.chatId,
        requestMessageId: message.messageId,
      });
      this.emit("telegram.job_submitted", {
        correlationId,
        jobId: submission.job.id,
        created: submission.created,
        backendDurationMilliseconds: elapsedMilliseconds(submitStartedAt),
        receiveToSubmissionDurationMilliseconds: elapsedMilliseconds(receivedAt),
      });
      const queuedReplyStartedAt = performance.now();
      const progressMessageId = await this.telegram.replyText(
        message.chatId,
        message.messageId,
        `Queued ${submission.job.displayId}. Use /status ${submission.job.displayId} for details.`,
      );
      this.emit("telegram.queued_message_sent", {
        correlationId,
        jobId: submission.job.id,
        telegramDurationMilliseconds: elapsedMilliseconds(queuedReplyStartedAt),
        receiveToQueuedMessageDurationMilliseconds: elapsedMilliseconds(receivedAt),
      });
      const contextStartedAt = performance.now();
      await this.backend.setProgressMessage(
        submission.job.id,
        message.userId,
        progressMessageId,
      );
      this.emit("telegram.request_queued", {
        correlationId,
        jobId: submission.job.id,
        backendDurationMilliseconds: elapsedMilliseconds(contextStartedAt),
        totalDurationMilliseconds: elapsedMilliseconds(receivedAt),
      });
    } catch (error) {
      this.emit("telegram.download_request_failed", {
        correlationId,
        errorCode: lifecycleErrorCode(error),
        totalDurationMilliseconds: elapsedMilliseconds(receivedAt),
      });
      if (error instanceof BackendError && error.code === "unauthorized") {
        await this.handleAccessRequest(message, correlationId);
        return;
      }
      await this.telegram.replyText(
        message.chatId,
        message.messageId,
        safeMessage(error, correlationId),
      );
    }
  }

  async handleCallback(callback: TelegramCallback): Promise<void> {
    const correlationId = crypto.randomUUID();
    let promptId: string | null = null;
    try {
      parseTelegramUserId(callback.userId);
      if (this.config.ALLOW_PRIVATE_CHATS_ONLY && callback.chatType !== "private") {
        await this.telegram.answerCallback(
          callback.callbackId,
          "Use access controls in a private chat.",
          true,
        );
        return;
      }
      const match =
        /^access:(allow|deny):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
          .exec(callback.data);
      if (!match) {
        await this.telegram.answerCallback(
          callback.callbackId,
          "This action is unavailable.",
          true,
        );
        return;
      }
      const prompt = await this.backend.beginAccessDecisionPrompt(
        callback.userId,
        match[2],
        match[1].toLowerCase() as "allow" | "deny",
        this.config.TELEGRAM_ADMIN_PROMPT_TTL_SECONDS,
      );
      promptId = prompt.id;
      const subject = prompt.action === "allow" ? "internal note" : "internal rejection reason";
      const promptMessageId = await this.telegram.sendForceReply(
        callback.chatId,
        `Enter an optional ${subject} for Telegram user ${prompt.requesterExternalUserId}. ` +
          "Reply with text, /skip for no note, or /cancel_action to cancel. " +
          "The text is visible only to administrators.",
      );
      await this.backend.attachAccessDecisionPromptMessage(
        callback.userId,
        prompt.id,
        promptMessageId,
      );
      await this.telegram.answerCallback(callback.callbackId, "Reply to the new prompt.");
    } catch (error) {
      if (promptId) {
        await this.backend.cancelAccessDecisionPrompt(callback.userId, promptId).catch(() => false);
      }
      await this.telegram.answerCallback(
        callback.callbackId,
        safeMessage(error, correlationId).slice(0, 200),
        true,
      ).catch(() => undefined);
    }
  }

  async deliverOnce(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const claimStartedAt = performance.now();
    let delivery: DeliveryLease | null;
    try {
      delivery = await this.backend.claimDelivery(
        this.workerId,
        this.config.TELEGRAM_DELIVERY_LEASE_SECONDS,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) return false;
      throw error;
    }
    if (!delivery) return false;
    const deliveryStartedAt = performance.now();
    this.emit("telegram.delivery_claimed", {
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      deliveryAttempt: delivery.attempts,
      artifactByteSize: delivery.artifactByteSize,
      claimDurationMilliseconds: elapsedMilliseconds(claimStartedAt),
      ...(delivery.artifactReadyAt
        ? {
          readyQueueDurationMilliseconds: Math.max(
            0,
            Date.now() - new Date(delivery.artifactReadyAt).getTime(),
          ),
        }
        : {}),
    });
    const guard = new DeliveryLeaseGuard(
      this.backend,
      delivery.id,
      this.workerId,
      this.config.TELEGRAM_DELIVERY_LEASE_SECONDS,
      this.config.TELEGRAM_DELIVERY_HEARTBEAT_SECONDS * 1000,
      this.heartbeatWait,
      this.heartbeatTimeout,
      signal,
    );
    try {
      if (!await this.deliveryPhase(delivery, "lease_start", () => guard.start())) {
        this.deliveryAbandoned(delivery, deliveryStartedAt, "lease_start");
        return true;
      }
      const existingFallback = fallbackResult(delivery);
      if (existingFallback) {
        if (guard.canStartTelegramOperation()) {
          await this.deliveryPhase(
            delivery,
            "recovered_progress_cleanup",
            () =>
              this.telegram.deleteMessage(
                delivery.destination.chatId,
                delivery.destination.progressMessageId,
              ),
          ).catch(() => undefined);
        }
        await this.deliveryPhase(
          delivery,
          "backend_complete",
          () => this.backend.completeDelivery(delivery.id, this.workerId, existingFallback),
        );
        this.deliveryCompleted(delivery, deliveryStartedAt, "fallback_recovered");
        return true;
      }

      if (guard.canStartTelegramOperation()) {
        await this.deliveryPhase(
          delivery,
          "uploading_status",
          () =>
            this.telegram.editText(
              delivery.destination.chatId,
              delivery.destination.progressMessageId,
              `${delivery.displayId}: uploading`,
            ),
        ).catch(() => undefined);
      }

      const filename = `${delivery.jobId}.mp4`;
      const mediaKind: TelegramMediaKind = delivery.artifactContentType !== "video/mp4"
        ? "document"
        : delivery.artifactVideoCodec === "h264" && delivery.artifactAudioCodec === null
        ? "animation"
        : "video";
      try {
        const artifact = await this.deliveryPhase(
          delivery,
          "artifact_open",
          () => this.backend.openArtifact(delivery.artifactId, guard.signal),
        );
        if (!guard.canStartTelegramOperation()) {
          await artifact.body.cancel().catch(() => undefined);
          this.deliveryAbandoned(delivery, deliveryStartedAt, "artifact_open");
          return true;
        }
        const result = await this.deliveryPhase(
          delivery,
          "telegram_edit_upload",
          () =>
            this.telegram.editMedia(
              delivery.destination.chatId,
              delivery.destination.progressMessageId,
              artifact,
              filename,
              mediaKind,
              guard.signal,
            ),
        );
        this.mediaAccepted(delivery, "edit", result);
        await this.deliveryPhase(
          delivery,
          "backend_complete",
          () =>
            this.backend.completeDelivery(delivery.id, this.workerId, {
              mode: "edit",
              messageId: result.messageId,
              fileId: result.fileId ?? null,
            }),
        );
        this.deliveryCompleted(delivery, deliveryStartedAt, "edit");
        return true;
      } catch (error) {
        if (
          error instanceof TelegramFailure && error.kind === "permanent" &&
          guard.canStartTelegramOperation()
        ) {
          return await this.fallback(delivery, filename, mediaKind, guard, deliveryStartedAt);
        }
        if (!guard.ownsLease()) {
          this.deliveryAbandoned(delivery, deliveryStartedAt, "lease_lost");
          return true;
        }
        await this.deliveryPhase(delivery, "backend_fail", () =>
          this.backend.failDelivery({
            id: delivery.id,
            workerId: this.workerId,
            retryable: true,
            safeMessage: "Telegram delivery is temporarily unavailable",
            retryAfterSeconds: error instanceof TelegramFailure
              ? error.retryAfterSeconds
              : undefined,
          }));
        this.deliveryFailed(delivery, deliveryStartedAt, error, true);
        return true;
      }
    } finally {
      await guard.stop();
    }
  }

  async refreshProgressOnce(): Promise<number> {
    const updates = await this.backend.listDeliveryProgress();
    let edited = 0;
    for (const update of updates) {
      if (!this.progress.shouldPublish(update.jobId, update.phase, update.percent)) continue;
      const percentage = update.percent === null ? "" : ` ${Math.round(update.percent)}%`;
      const phase = update.phase === "retrying_source_timeout"
        ? "retrying after source timeout"
        : update.phase;
      const startedAt = performance.now();
      try {
        await this.telegram.editText(
          update.destination.chatId,
          update.destination.progressMessageId,
          `${update.displayId}: ${phase}${percentage}`,
        );
        edited++;
        this.emit("telegram.progress_updated", {
          jobId: update.jobId,
          phase: update.phase,
          percent: update.percent,
          durationMilliseconds: elapsedMilliseconds(startedAt),
        });
      } catch (error) {
        this.emit("telegram.progress_update_failed", {
          jobId: update.jobId,
          phase: update.phase,
          errorCode: lifecycleErrorCode(error),
          durationMilliseconds: elapsedMilliseconds(startedAt),
        });
        // A concurrent final media edit or a transient Bot API error will be retried/coalesced.
      }
    }
    const terminal = await this.backend.claimTerminalProgress(
      this.workerId,
      this.config.TELEGRAM_DELIVERY_LEASE_SECONDS,
    );
    if (!terminal) return edited;
    const startedAt = performance.now();
    try {
      await this.telegram.editText(
        terminal.destination.chatId,
        terminal.destination.progressMessageId,
        terminalProgressText(terminal),
      );
      const completed = await this.backend.completeTerminalProgress(
        terminal.deliveryId,
        this.workerId,
      );
      if (!completed) {
        throw new Error("Terminal progress lease changed before completion");
      }
      edited++;
      this.emit("telegram.terminal_progress_finalized", {
        jobId: terminal.jobId,
        state: terminal.state,
        attempt: terminal.attempts,
        durationMilliseconds: elapsedMilliseconds(startedAt),
      });
    } catch (error) {
      const retryable = !(error instanceof TelegramFailure && error.kind === "permanent");
      const retryAfterSeconds = error instanceof TelegramFailure
        ? error.retryAfterSeconds ?? this.config.TELEGRAM_DELIVERY_POLL_INTERVAL_MS / 1000
        : this.config.TELEGRAM_DELIVERY_POLL_INTERVAL_MS / 1000;
      let recorded = false;
      try {
        recorded = await this.backend.failTerminalProgress({
          deliveryId: terminal.deliveryId,
          workerId: this.workerId,
          retryable,
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
        });
      } catch {
        // The lease expires, so a failed acknowledgement remains recoverable.
      }
      this.emit("telegram.terminal_progress_failed", {
        jobId: terminal.jobId,
        state: terminal.state,
        attempt: terminal.attempts,
        errorCode: lifecycleErrorCode(error),
        retryable,
        recorded,
        durationMilliseconds: elapsedMilliseconds(startedAt),
      });
    }
    return edited;
  }

  private async fallback(
    delivery: DeliveryLease,
    filename: string,
    mediaKind: TelegramMediaKind,
    guard: DeliveryLeaseGuard,
    deliveryStartedAt: number,
  ): Promise<boolean> {
    try {
      const artifact = await this.deliveryPhase(
        delivery,
        "fallback_artifact_open",
        () => this.backend.openArtifact(delivery.artifactId, guard.signal),
      );
      if (!guard.canStartTelegramOperation()) {
        await artifact.body.cancel().catch(() => undefined);
        this.deliveryAbandoned(delivery, deliveryStartedAt, "fallback_artifact_open");
        return true;
      }
      const result = await this.deliveryPhase(
        delivery,
        "telegram_fallback_upload",
        () =>
          this.telegram.sendMedia(
            delivery.destination.chatId,
            delivery.destination.requestMessageId,
            artifact,
            filename,
            mediaKind,
            guard.signal,
          ),
      );
      this.mediaAccepted(delivery, "fallback", result);
      const operation = {
        mode: "fallback",
        messageId: result.messageId,
        fileId: result.fileId ?? null,
      };
      await this.deliveryPhase(
        delivery,
        "backend_record_acceptance",
        () => this.backend.recordDeliveryOperation(delivery.id, this.workerId, operation),
      );
      if (guard.canStartTelegramOperation()) {
        try {
          await this.deliveryPhase(delivery, "progress_cleanup", () =>
            this.telegram.deleteMessage(
              delivery.destination.chatId,
              delivery.destination.progressMessageId,
            ));
        } catch {
          if (guard.canStartTelegramOperation()) {
            await this.deliveryPhase(
              delivery,
              "progress_cleanup_fallback",
              () =>
                this.telegram.editText(
                  delivery.destination.chatId,
                  delivery.destination.progressMessageId,
                  "Delivered in a new reply.",
                ),
            ).catch(() => undefined);
          }
        }
      }
      await this.deliveryPhase(
        delivery,
        "backend_complete",
        () => this.backend.completeDelivery(delivery.id, this.workerId, operation),
      );
      this.deliveryCompleted(delivery, deliveryStartedAt, "fallback");
      return true;
    } catch (error) {
      if (!guard.ownsLease()) {
        this.deliveryAbandoned(delivery, deliveryStartedAt, "fallback_lease_lost");
        return true;
      }
      const retryable = !(error instanceof TelegramFailure && error.kind === "permanent");
      await this.deliveryPhase(delivery, "backend_fail", () =>
        this.backend.failDelivery({
          id: delivery.id,
          workerId: this.workerId,
          retryable,
          safeMessage: error instanceof TelegramFailure && error.kind === "permanent"
            ? "Telegram rejected this artifact"
            : "Telegram delivery is temporarily unavailable",
          retryAfterSeconds: error instanceof TelegramFailure ? error.retryAfterSeconds : undefined,
        }));
      this.deliveryFailed(delivery, deliveryStartedAt, error, retryable);
      return true;
    }
  }

  private async deliveryPhase<Value>(
    delivery: DeliveryLease,
    phase: string,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const startedAt = performance.now();
    try {
      const value = await operation();
      this.emit("telegram.delivery_phase", {
        deliveryId: delivery.id,
        jobId: delivery.jobId,
        deliveryAttempt: delivery.attempts,
        phase,
        outcome: "success",
        durationMilliseconds: elapsedMilliseconds(startedAt),
      });
      return value;
    } catch (error) {
      this.emit("telegram.delivery_phase", {
        deliveryId: delivery.id,
        jobId: delivery.jobId,
        deliveryAttempt: delivery.attempts,
        phase,
        outcome: "failure",
        errorCode: lifecycleErrorCode(error),
        durationMilliseconds: elapsedMilliseconds(startedAt),
      });
      throw error;
    }
  }

  private mediaAccepted(
    delivery: DeliveryLease,
    mode: "edit" | "fallback",
    result: TelegramMediaResult,
  ): void {
    this.emit("telegram.media_accepted", {
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      deliveryAttempt: delivery.attempts,
      mode,
      artifactByteSize: delivery.artifactByteSize,
      ...(result.transfer
        ? {
          transferBytes: result.transfer.bytes,
          transferChunks: result.transfer.chunks,
          streamCompleted: result.transfer.streamCompleted,
          timeToFirstByteMilliseconds: result.transfer.timeToFirstByteMilliseconds,
          streamDurationMilliseconds: result.transfer.streamDurationMilliseconds,
          telegramResponseWaitMilliseconds: result.transfer.responseWaitMilliseconds,
          telegramOperationDurationMilliseconds: result.transfer.totalDurationMilliseconds,
        }
        : {}),
    });
  }

  private deliveryCompleted(
    delivery: DeliveryLease,
    startedAt: number,
    mode: "edit" | "fallback" | "fallback_recovered",
  ): void {
    this.emit("telegram.delivery_completed", {
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      deliveryAttempt: delivery.attempts,
      mode,
      artifactByteSize: delivery.artifactByteSize,
      totalDurationMilliseconds: elapsedMilliseconds(startedAt),
    });
  }

  private deliveryFailed(
    delivery: DeliveryLease,
    startedAt: number,
    error: unknown,
    retryable: boolean,
  ): void {
    this.emit("telegram.delivery_failed", {
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      deliveryAttempt: delivery.attempts,
      retryable,
      errorCode: lifecycleErrorCode(error),
      totalDurationMilliseconds: elapsedMilliseconds(startedAt),
    });
  }

  private deliveryAbandoned(delivery: DeliveryLease, startedAt: number, reason: string): void {
    this.emit("telegram.delivery_abandoned", {
      deliveryId: delivery.id,
      jobId: delivery.jobId,
      deliveryAttempt: delivery.attempts,
      reason,
      totalDurationMilliseconds: elapsedMilliseconds(startedAt),
    });
  }

  private emit(event: string, fields: Readonly<Record<string, unknown>>): void {
    try {
      this.observeLifecycle?.(event, fields);
    } catch {
      // Observability must never change Telegram behavior.
    }
  }

  private async handleCommand(
    message: TelegramMessage,
    text: string,
    correlationId: string,
  ): Promise<void> {
    const [commandWithTarget, ...args] = text.split(/\s+/);
    const command = commandWithTarget.toLowerCase().split("@")[0];
    try {
      if (command === "/request" && args.length === 0) {
        await this.handleAccessRequest(message, correlationId);
        return;
      }
      const access = await this.backend.getPrincipalAccess(message.userId);
      if (command === "/start" || command === "/help") {
        await this.telegram.replyText(
          message.chatId,
          message.messageId,
          helpText(access),
        );
        return;
      }
      if (access.state !== "active") {
        await this.telegram.replyText(
          message.chatId,
          message.messageId,
          access.state === "disabled"
            ? "Access is disabled. Contact an administrator if this is unexpected."
            : "Access is required. Use /request to request it.",
        );
        return;
      }
      if (ADMIN_COMMANDS.has(command) && access.role !== "admin") {
        await this.telegram.replyText(
          message.chatId,
          message.messageId,
          "Unknown or unavailable command.",
        );
        return;
      }
      if (command === "/status" && args.length === 1) {
        const job = await this.backend.getJob(args[0], message.userId);
        await this.telegram.replyText(
          message.chatId,
          message.messageId,
          `${job.displayId}: ${job.state}${job.error ? ` — ${job.error.message}` : ""}`,
        );
        return;
      }
      if (command === "/cancel" && args.length === 1) {
        const job = await this.backend.cancelJob(args[0], message.userId);
        await this.telegram.replyText(
          message.chatId,
          message.messageId,
          `${job.displayId}: cancelled`,
        );
        return;
      }
      if (command === "/retry" && args.length === 1) {
        const job = await this.backend.retryJob(args[0], message.userId);
        await this.telegram.replyText(
          message.chatId,
          message.messageId,
          `${job.displayId}: requeued`,
        );
        return;
      }
      if (command === "/allow" && args.length >= 1) {
        const targetUserId = parseTelegramUserId(args[0]);
        const principal = await this.backend.allowPrincipal(
          message.userId,
          targetUserId,
          args.slice(1).join(" ") || null,
          null,
        );
        await this.telegram.replyText(
          message.chatId,
          message.messageId,
          `Allowed Telegram user ${principal.externalUserId}.`,
        );
        return;
      }
      if (command === "/allow") {
        throw new DomainError("invalid_url", "Usage: /allow USER_ID [note]");
      }
      if (command === "/deny" && args.length >= 2) {
        const targetUserId = parseTelegramUserId(args[0]);
        const principal = await this.backend.denyPrincipal(
          message.userId,
          targetUserId,
          args.slice(1).join(" "),
        );
        await this.telegram.replyText(
          message.chatId,
          message.messageId,
          `Disabled Telegram user ${principal.externalUserId}.`,
        );
        return;
      }
      if (command === "/deny") {
        throw new DomainError("invalid_url", "Usage: /deny USER_ID reason");
      }
      if (command === "/users" && args.length === 0) {
        await this.sendPrincipalPage(message, 1);
        return;
      }
      if (command === "/users" && args.length === 1) {
        await this.sendPrincipalPage(message, parsePage(args[0]));
        return;
      }
      if (command === "/jobs") {
        const { filter, page } = parseJobsArguments(args);
        await this.sendJobPage(message, filter, page, access.role === "admin");
        return;
      }
      if (command === "/requests" && args.length <= 1) {
        await this.sendAccessRequestPage(message, args[0] ? parsePage(args[0]) : 1);
        return;
      }
      if (command === "/audit" && args.length <= 1) {
        await this.sendAuditPage(message, args[0] ? parsePage(args[0]) : 1);
        return;
      }
      await this.telegram.replyText(
        message.chatId,
        message.messageId,
        "Unknown or incomplete command.",
      );
    } catch (error) {
      await this.telegram.replyText(
        message.chatId,
        message.messageId,
        safeMessage(error, correlationId),
      );
    }
  }

  private async handleAccessRequest(
    message: TelegramMessage,
    correlationId: string,
  ): Promise<void> {
    try {
      const result = await this.backend.requestAccess(
        message.userId,
        `telegram:${message.updateId}`,
      );
      if (result.request.state === "approved") {
        await this.telegram.replyText(
          message.chatId,
          message.messageId,
          "Access is already active. Send one public X status URL.",
        );
        return;
      }
      if (result.request.state === "denied") {
        await this.telegram.replyText(
          message.chatId,
          message.messageId,
          "Access is disabled or a recent request was denied.",
        );
        return;
      }
      await this.telegram.replyText(
        message.chatId,
        message.messageId,
        result.created
          ? "Access request submitted. Downloads remain unavailable until an administrator approves it."
          : "An access request is already pending. Downloads remain unavailable until approval.",
      );
    } catch (error) {
      await this.telegram.replyText(
        message.chatId,
        message.messageId,
        safeMessage(error, correlationId),
      );
    }
  }

  private async handleAccessDecisionReply(
    message: TelegramMessage,
    text: string,
    correlationId: string,
  ): Promise<boolean> {
    const special = text === "/skip" || text === "/cancel_action";
    if (!special && (!message.replyToMessageId || text.startsWith("/"))) return false;
    let prompt;
    try {
      prompt = await this.backend.getActiveAccessDecisionPrompt(message.userId);
    } catch (error) {
      if (error instanceof BackendError && error.code === "unauthorized") return false;
      await this.telegram.replyText(
        message.chatId,
        message.messageId,
        safeMessage(error, correlationId),
      );
      return true;
    }
    if (!prompt) {
      if (!special) return false;
      await this.telegram.replyText(
        message.chatId,
        message.messageId,
        "No access decision is waiting for input.",
      );
      return true;
    }
    if (!special && prompt.promptMessageId !== message.replyToMessageId) return false;
    try {
      if (text === "/cancel_action") {
        await this.backend.cancelAccessDecisionPrompt(message.userId, prompt.id);
        await this.telegram.replyText(
          message.chatId,
          message.messageId,
          "Access decision cancelled.",
        );
        return true;
      }
      const note = text === "/skip" ? null : text;
      const result = await this.backend.resolveAccessDecisionPrompt(
        message.userId,
        prompt.id,
        note,
      );
      await this.telegram.replyText(
        message.chatId,
        message.messageId,
        result.decision === "approved"
          ? `Allowed Telegram user ${result.requesterExternalUserId}.`
          : `Rejected the current access request from Telegram user ${result.requesterExternalUserId}.`,
      );
    } catch (error) {
      await this.telegram.replyText(
        message.chatId,
        message.messageId,
        safeMessage(error, correlationId),
      );
    }
    return true;
  }

  async notifyAccessRequestOnce(): Promise<boolean> {
    const notification = await this.backend.claimAccessRequestNotification(
      this.workerId,
      this.config.TELEGRAM_ACCESS_NOTIFICATION_LEASE_SECONDS,
    );
    if (!notification) return false;
    const text =
      `Pending access request from Telegram user ${notification.requesterExternalUserId}.\n` +
      "Use the buttons below, or the /allow and /deny commands.";
    try {
      await this.telegram.sendTextWithAccessButtons(notification.adminExternalUserId, text, {
        requestId: notification.accessRequestId,
        externalUserId: notification.requesterExternalUserId,
      });
      await this.backend.completeAccessRequestNotification(notification.id, this.workerId);
    } catch (error) {
      const failure = error instanceof TelegramFailure
        ? error
        : new TelegramFailure("ambiguous", "Telegram request outcome is unknown");
      const retryable = failure.kind !== "permanent";
      const retryAfterSeconds = failure.retryAfterSeconds ?? Math.min(
        300,
        2 ** Math.min(notification.attempts, 8),
      );
      await this.backend.failAccessRequestNotification({
        id: notification.id,
        workerId: this.workerId,
        retryable,
        retryAfterSeconds,
        errorCode: failure.kind,
      });
    }
    return true;
  }

  async notifyAccessDecisionOnce(): Promise<boolean> {
    const notification = await this.backend.claimAccessDecisionNotification(
      this.workerId,
      this.config.TELEGRAM_ACCESS_NOTIFICATION_LEASE_SECONDS,
    );
    if (!notification) return false;
    const text = notification.decision === "approved"
      ? "Your access request was approved. You can now send one public X status URL."
      : `Your access request was declined. You may request access again after the configured cooldown.`;
    try {
      await this.telegram.sendText(notification.requesterExternalUserId, text);
      await this.backend.completeAccessDecisionNotification(notification.id, this.workerId);
    } catch (error) {
      const failure = error instanceof TelegramFailure
        ? error
        : new TelegramFailure("ambiguous", "Telegram request outcome is unknown");
      await this.backend.failAccessDecisionNotification({
        id: notification.id,
        workerId: this.workerId,
        retryable: failure.kind !== "permanent",
        retryAfterSeconds: failure.retryAfterSeconds ?? Math.min(
          300,
          2 ** Math.min(notification.attempts, 8),
        ),
        errorCode: failure.kind,
      });
    }
    return true;
  }

  private async sendPrincipalPage(message: TelegramMessage, pageNumber: number): Promise<void> {
    const limit = 8;
    const result = await this.backend.listPrincipals(
      message.userId,
      limit,
      (pageNumber - 1) * limit,
    );
    const lines = result.principals.map((principal) => {
      const note = principal.note ? `; note=${oneLine(principal.note, 120)}` : "";
      const expiry = principal.expiresAt ? `; expiry=${formatDate(principal.expiresAt)}` : "";
      return `${principal.externalUserId}: role=${principal.role}; state=${principal.state}${expiry}${note}`;
    });
    await this.telegram.replyText(
      message.chatId,
      message.messageId,
      paginatedText("Users", lines, pageNumber, result.page.hasMore, "/users"),
    );
  }

  private async sendJobPage(
    message: TelegramMessage,
    filter: "active" | "failed" | "recent",
    pageNumber: number,
    isAdmin: boolean,
  ): Promise<void> {
    const limit = 10;
    const result = await this.backend.listJobs(
      message.userId,
      filter,
      limit,
      (pageNumber - 1) * limit,
    );
    const lines = result.jobs.map((job) => {
      const requester = isAdmin && job.requesterExternalUserId
        ? `; user=${job.requesterExternalUserId}`
        : "";
      const error = job.error ? `; error=${oneLine(job.error.message, 100)}` : "";
      return `${job.displayId}: ${job.state}; attempts=${job.attempts}${requester}; ${
        formatDate(job.createdAt)
      }${error}`;
    });
    await this.telegram.replyText(
      message.chatId,
      message.messageId,
      paginatedText(
        `Jobs (${filter})`,
        lines,
        pageNumber,
        result.page.hasMore,
        `/jobs ${filter}`,
      ),
    );
  }

  private async sendAccessRequestPage(
    message: TelegramMessage,
    pageNumber: number,
  ): Promise<void> {
    const limit = 10;
    const result = await this.backend.listAccessRequests(
      message.userId,
      limit,
      (pageNumber - 1) * limit,
    );
    const lines = result.requests.map((request) =>
      `${
        telegramUserLink(request.externalUserId)
      }: pending; requests=${request.requestCount}; last=${formatDate(request.lastRequestedAt)}`
    );
    await this.telegram.replyTextWithAccessButtons(
      message.chatId,
      message.messageId,
      paginatedText("Pending access requests", lines, pageNumber, result.page.hasMore, "/requests"),
      result.requests.map((request) => ({
        requestId: request.id,
        externalUserId: request.externalUserId,
      })),
    );
  }

  private async sendAuditPage(message: TelegramMessage, pageNumber: number): Promise<void> {
    const limit = 8;
    const result = await this.backend.listAuditEvents(
      message.userId,
      limit,
      (pageNumber - 1) * limit,
    );
    const lines = result.events.map((event) => {
      const actor = event.actorExternalId ? ` actor=${event.actorExternalId}` : "";
      const target = event.targetId
        ? ` ${oneLine(event.targetType, 30)}=${oneLine(event.targetId, 50)}`
        : ` ${oneLine(event.targetType, 30)}`;
      return `${formatDate(event.createdAt)} ${
        oneLine(event.action, 60)
      } ${event.result}${actor}${target}`;
    });
    await this.telegram.replyText(
      message.chatId,
      message.messageId,
      paginatedText("Audit", lines, pageNumber, result.page.hasMore, "/audit"),
    );
  }
}

type DeliveryLeaseGuardState = "new" | "active" | "lost" | "cancelled" | "stopped";

class DeliveryLeaseGuard {
  private readonly controller = new AbortController();
  private state: DeliveryLeaseGuardState = "new";
  private task: Promise<void> | null = null;
  private readonly cancelFromParent = () => {
    if (this.state === "stopped") return;
    this.state = "cancelled";
    this.abort(this.parentSignal?.reason);
  };

  constructor(
    private readonly backend: Backend,
    private readonly deliveryId: string,
    private readonly workerId: string,
    private readonly leaseSeconds: number,
    private readonly intervalMilliseconds: number,
    private readonly wait: DeliveryHeartbeatWait,
    private readonly timeout: DeliveryHeartbeatWait,
    private readonly parentSignal?: AbortSignal,
  ) {
    if (parentSignal?.aborted) {
      this.cancelFromParent();
    } else {
      parentSignal?.addEventListener("abort", this.cancelFromParent, { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async start(): Promise<boolean> {
    if (this.state !== "new") return false;
    this.state = "active";
    try {
      const extended = await this.renew();
      if (!extended) {
        this.loseLease();
        return false;
      }
    } catch (error) {
      if (this.state === "active") this.loseLease(error);
      return false;
    }
    if (this.state !== "active") return false;
    this.task = this.run();
    return true;
  }

  ownsLease(): boolean {
    return this.state === "active";
  }

  canStartTelegramOperation(): boolean {
    return this.ownsLease() && !this.controller.signal.aborted;
  }

  async stop(): Promise<void> {
    if (this.state !== "lost" && this.state !== "cancelled") this.state = "stopped";
    this.abort();
    this.parentSignal?.removeEventListener("abort", this.cancelFromParent);
    await this.task;
  }

  private async run(): Promise<void> {
    while (this.state === "active") {
      try {
        await this.wait(this.intervalMilliseconds, this.controller.signal);
      } catch (error) {
        if (this.state === "active") this.loseLease(error);
        return;
      }
      if (this.state !== "active") return;
      try {
        const extended = await this.renew();
        if (!extended) {
          this.loseLease();
          return;
        }
      } catch (error) {
        if (this.state === "active") this.loseLease(error);
        return;
      }
    }
  }

  private async renew(): Promise<boolean> {
    const rpcController = new AbortController();
    const abortRpc = () => rpcController.abort(this.controller.signal.reason);
    if (this.controller.signal.aborted) abortRpc();
    else this.controller.signal.addEventListener("abort", abortRpc, { once: true });
    const deadline = this.timeout(this.intervalMilliseconds, rpcController.signal).then(() => {
      rpcController.abort(new Error("Delivery heartbeat timed out"));
      throw new Error("Delivery heartbeat timed out");
    });
    try {
      return await Promise.race([
        this.backend.heartbeatDelivery(
          this.deliveryId,
          this.workerId,
          this.leaseSeconds,
          rpcController.signal,
        ),
        deadline,
      ]);
    } finally {
      this.controller.signal.removeEventListener("abort", abortRpc);
      if (!rpcController.signal.aborted) rpcController.abort();
    }
  }

  private loseLease(reason?: unknown): void {
    this.state = "lost";
    this.abort(reason);
  }

  private abort(reason?: unknown): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort(reason);
  }
}

export class ProgressCoalescer {
  private readonly last = new Map<string, { phase: string; percent: number | null; at: number }>();

  constructor(private readonly minimumIntervalMs: number) {}

  shouldPublish(key: string, phase: string, percent: number | null, now = Date.now()): boolean {
    const previous = this.last.get(key);
    if (
      previous && previous.phase === phase && now - previous.at < this.minimumIntervalMs &&
      (percent === null || previous.percent === null || Math.abs(percent - previous.percent) < 5)
    ) return false;
    this.last.set(key, { phase, percent, at: now });
    return true;
  }
}

const ADMIN_COMMANDS = new Set(["/retry", "/allow", "/deny", "/users", "/requests", "/audit"]);

function helpText(access: PrincipalAccessView): string {
  if (access.state !== "active") {
    return access.state === "disabled"
      ? "Access is disabled. Contact an administrator if this is unexpected."
      : "Access is required. Use /request to request it.";
  }
  const userHelp = "Send one public X status URL.\n" +
    "User commands: /help, /jobs [active|failed|recent] [page], /status ID, /cancel ID.";
  if (access.role !== "admin") return userHelp;
  return `${userHelp}\nAdmin commands: /retry ID, /allow USER_ID [note], ` +
    "/deny USER_ID reason, /users [page], /requests [page], /audit [page].";
}

function parsePage(value: string): number {
  if (!/^\d{1,6}$/.test(value)) {
    throw new DomainError("invalid_url", "Page must be a positive integer");
  }
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new DomainError("invalid_url", "Page must be a positive integer");
  }
  return page;
}

function parseJobsArguments(args: readonly string[]): {
  filter: "active" | "failed" | "recent";
  page: number;
} {
  if (args.length === 0) return { filter: "recent", page: 1 };
  if (args.length === 1 && /^(active|failed|recent)$/i.test(args[0])) {
    return { filter: args[0].toLowerCase() as "active" | "failed" | "recent", page: 1 };
  }
  if (args.length === 1) return { filter: "recent", page: parsePage(args[0]) };
  if (args.length === 2 && /^(active|failed|recent)$/i.test(args[0])) {
    return {
      filter: args[0].toLowerCase() as "active" | "failed" | "recent",
      page: parsePage(args[1]),
    };
  }
  throw new DomainError(
    "invalid_url",
    "Usage: /jobs [active|failed|recent] [page]",
  );
}

function paginatedText(
  title: string,
  lines: readonly string[],
  page: number,
  hasMore: boolean,
  nextCommand: string,
): string {
  const body = lines.length === 0 ? ["No entries on this page."] : [...lines];
  const footer = hasMore ? `Next: ${nextCommand} ${page + 1}` : "End of results.";
  return boundedMessage([`${title} — page ${page}`, ...body, footer]);
}

function boundedMessage(lines: readonly string[], maximumLength = 3800): string {
  const output: string[] = [];
  let length = 0;
  for (const rawLine of lines) {
    const line = oneLine(rawLine, 500);
    const added = line.length + (output.length === 0 ? 0 : 1);
    if (length + added > maximumLength) {
      output.push("… output truncated; use the next page.");
      break;
    }
    output.push(line);
    length += added;
  }
  return output.join("\n").slice(0, maximumLength);
}

function oneLine(value: string, maximumLength: number): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return normalized.length <= maximumLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function telegramUserLink(externalUserId: string): string {
  const userId = parseTelegramUserId(externalUserId);
  return `<a href="tg://user?id=${userId}">${userId}</a>`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown-time" : date.toISOString().slice(0, 16) + "Z";
}

function fallbackResult(delivery: DeliveryLease): Record<string, unknown> | null {
  const context = delivery.operationContext;
  if (
    context?.mode === "fallback" && typeof context.messageId === "number" &&
    (context.fileId === null || typeof context.fileId === "string")
  ) return { ...context };
  return null;
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1_000) / 1_000;
}

function terminalProgressText(progress: TerminalProgressLease): string {
  if (progress.state === "failed") {
    const message = oneLine(progress.safeErrorMessage ?? "The download failed", 500);
    return `${progress.displayId}: failed — ${message}`;
  }
  return `${progress.displayId}: ${progress.state}`;
}

function lifecycleErrorCode(error: unknown): string {
  if (error instanceof BackendError || error instanceof DomainError) return error.code;
  if (error instanceof TelegramFailure) return `telegram_${error.kind}`;
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  return "unexpected";
}

function safeMessage(error: unknown, fallbackCorrelationId: string): string {
  if (error instanceof BackendError) {
    return `${error.message} Reference: ${error.correlationId ?? fallbackCorrelationId}`;
  }
  if (error instanceof DomainError) {
    return `${error.message} Reference: ${fallbackCorrelationId}`;
  }
  return `The request could not be completed. Please try again later. Reference: ${fallbackCorrelationId}`;
}
