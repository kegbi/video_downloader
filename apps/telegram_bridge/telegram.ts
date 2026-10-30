import { type Api, GrammyError, HttpError, InlineKeyboard, InputFile } from "grammy";
import type { ArtifactStream } from "../../packages/telegram/backend.ts";
import {
  type AccessRequestButton,
  type TelegramAdapter,
  TelegramFailure,
  type TelegramMediaKind,
  type TelegramMediaResult,
} from "../../packages/telegram/bridge.ts";

export type TelegramUploadObservation =
  | { readonly type: "chunk"; readonly byteLength: number }
  | { readonly type: "closed"; readonly completed: boolean };

export const TELEGRAM_UPLOAD_CHUNK_BYTES = 64 * 1024;

export class GrammyTelegramAdapter implements TelegramAdapter {
  constructor(
    private readonly api: Api,
    private readonly observeUpload?: (observation: TelegramUploadObservation) => void,
  ) {}

  async replyText(chatId: string, replyToMessageId: number, text: string): Promise<number> {
    try {
      const message = await this.api.sendMessage(chatId, text, {
        reply_parameters: { message_id: replyToMessageId },
      });
      return message.message_id;
    } catch (error) {
      throw classifyTelegramError(error);
    }
  }

  async sendText(chatId: string, text: string): Promise<number> {
    try {
      const message = await this.api.sendMessage(chatId, text);
      return message.message_id;
    } catch (error) {
      throw classifyTelegramError(error);
    }
  }

  async replyTextWithAccessButtons(
    chatId: string,
    replyToMessageId: number,
    text: string,
    requests: readonly AccessRequestButton[],
  ): Promise<number> {
    try {
      const message = await this.api.sendMessage(chatId, text, {
        reply_parameters: { message_id: replyToMessageId },
        reply_markup: accessRequestKeyboard(requests),
        parse_mode: "HTML",
      });
      return message.message_id;
    } catch (error) {
      throw classifyTelegramError(error);
    }
  }

  async sendTextWithAccessButtons(
    chatId: string,
    text: string,
    request: AccessRequestButton,
  ): Promise<number> {
    try {
      const message = await this.api.sendMessage(chatId, text, {
        reply_markup: accessRequestKeyboard([request]),
      });
      return message.message_id;
    } catch (error) {
      throw classifyTelegramError(error);
    }
  }

  async sendForceReply(chatId: string, text: string): Promise<number> {
    try {
      const message = await this.api.sendMessage(chatId, text, {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "Optional internal note",
        },
      });
      return message.message_id;
    } catch (error) {
      throw classifyTelegramError(error);
    }
  }

  async answerCallback(callbackId: string, text?: string, showAlert = false): Promise<void> {
    try {
      await this.api.answerCallbackQuery(callbackId, { text, show_alert: showAlert });
    } catch (error) {
      throw classifyTelegramError(error);
    }
  }

  async editText(chatId: string, messageId: number, text: string): Promise<void> {
    try {
      await this.api.editMessageText(chatId, messageId, text);
    } catch (error) {
      if (isNotModified(error)) return;
      throw classifyTelegramError(error);
    }
  }

  async editMedia(
    chatId: string,
    messageId: number,
    artifact: ArtifactStream,
    filename: string,
    mediaKind: TelegramMediaKind,
    signal?: AbortSignal,
  ): Promise<TelegramMediaResult> {
    const transfer = new TransferMeasurement(this.observeUpload);
    try {
      const media = new InputFile(
        toAsyncIterable(artifact.body, signal, transfer.observe),
        filename,
      );
      const message = await this.api.editMessageMedia(
        chatId,
        messageId,
        mediaKind === "video"
          ? { type: "video", media, supports_streaming: true }
          : { type: mediaKind, media },
      );
      if (message === true) return { messageId, transfer: transfer.finish() };
      return {
        messageId: message.message_id,
        fileId: mediaFileId(message),
        transfer: transfer.finish(),
      };
    } catch (error) {
      if (isNotModified(error)) return { messageId, transfer: transfer.finish() };
      throw classifyTelegramError(error);
    }
  }

  async sendMedia(
    chatId: string,
    replyToMessageId: number,
    artifact: ArtifactStream,
    filename: string,
    mediaKind: TelegramMediaKind,
    signal?: AbortSignal,
  ): Promise<TelegramMediaResult> {
    const transfer = new TransferMeasurement(this.observeUpload);
    try {
      const media = new InputFile(
        toAsyncIterable(artifact.body, signal, transfer.observe),
        filename,
      );
      const options = { reply_parameters: { message_id: replyToMessageId } };
      const message = mediaKind === "animation"
        ? await this.api.sendAnimation(chatId, media, options)
        : mediaKind === "video"
        ? await this.api.sendVideo(chatId, media, { ...options, supports_streaming: true })
        : await this.api.sendDocument(chatId, media, options);
      return {
        messageId: message.message_id,
        fileId: mediaFileId(message),
        transfer: transfer.finish(),
      };
    } catch (error) {
      throw classifyTelegramError(error);
    }
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    try {
      await this.api.deleteMessage(chatId, messageId);
    } catch (error) {
      throw classifyTelegramError(error);
    }
  }
}

class TransferMeasurement {
  private readonly startedAt = performance.now();
  private firstChunkAt: number | null = null;
  private closedAt: number | null = null;
  private bytes = 0;
  private chunks = 0;
  private completed = false;

  constructor(
    private readonly externalObserver?: (observation: TelegramUploadObservation) => void,
  ) {}

  readonly observe = (observation: TelegramUploadObservation): void => {
    const now = performance.now();
    if (observation.type === "chunk") {
      this.firstChunkAt ??= now;
      this.bytes += observation.byteLength;
      this.chunks++;
    } else {
      this.closedAt = now;
      this.completed = observation.completed;
    }
    try {
      this.externalObserver?.(observation);
    } catch {
      // Observability must never change the upload stream.
    }
  };

  finish(): NonNullable<TelegramMediaResult["transfer"]> {
    const finishedAt = performance.now();
    return {
      bytes: this.bytes,
      chunks: this.chunks,
      streamCompleted: this.completed,
      timeToFirstByteMilliseconds: this.firstChunkAt === null
        ? null
        : roundedMilliseconds(this.firstChunkAt - this.startedAt),
      streamDurationMilliseconds: this.firstChunkAt === null || this.closedAt === null
        ? null
        : roundedMilliseconds(this.closedAt - this.firstChunkAt),
      responseWaitMilliseconds: this.closedAt === null
        ? null
        : roundedMilliseconds(finishedAt - this.closedAt),
      totalDurationMilliseconds: roundedMilliseconds(finishedAt - this.startedAt),
    };
  }
}

function roundedMilliseconds(milliseconds: number): number {
  return Math.round(milliseconds * 1_000) / 1_000;
}

function accessRequestKeyboard(requests: readonly AccessRequestButton[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, request] of requests.entries()) {
    keyboard.url(
      `👤 ${request.externalUserId}`,
      `tg://user?id=${request.externalUserId}`,
    ).row();
    keyboard
      .text("✅ Allow", `access:allow:${request.requestId}`)
      .text("❌ Deny", `access:deny:${request.requestId}`);
    if (index < requests.length - 1) keyboard.row();
  }
  return keyboard;
}

export const USER_BOT_COMMANDS = [
  { command: "start", description: "Show access and usage guidance" },
  { command: "help", description: "Show commands available to you" },
  { command: "request", description: "Request download access" },
  { command: "jobs", description: "List your jobs" },
  { command: "status", description: "Show one job status" },
  { command: "cancel", description: "Cancel your job" },
] as const;

export const ADMIN_BOT_COMMANDS = [
  ...USER_BOT_COMMANDS,
  { command: "retry", description: "Retry a failed job" },
  { command: "allow", description: "Allow a Telegram user" },
  { command: "deny", description: "Disable a Telegram user" },
  { command: "users", description: "List access principals" },
  { command: "requests", description: "List pending access requests" },
  { command: "audit", description: "List sanitized audit events" },
] as const;

export async function configureTelegramCommands(
  api: Pick<Api, "setMyCommands">,
  adminUserIds: readonly string[],
  timeoutMs = 5_000,
): Promise<{ attempted: number; failed: number }> {
  const registrations = [
    () => api.setMyCommands([...USER_BOT_COMMANDS], { scope: { type: "all_private_chats" } }),
    ...adminUserIds.map((adminUserId) => () =>
      api.setMyCommands([...ADMIN_BOT_COMMANDS], {
        scope: { type: "chat", chat_id: Number(adminUserId) },
      })
    ),
  ];
  const results = await Promise.allSettled(
    registrations.map((registration) => withTimeout(registration(), timeoutMs)),
  );
  return {
    attempted: registrations.length,
    failed: results.filter((result) => result.status === "rejected").length,
  };
}

async function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number): Promise<Value> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Telegram command registration timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function classifyTelegramError(error: unknown): TelegramFailure {
  if (error instanceof TelegramFailure) return error;
  if (error instanceof HttpError) {
    return new TelegramFailure("ambiguous", "Telegram request outcome is unknown");
  }
  if (error instanceof GrammyError) {
    const retryAfter = error.parameters.retry_after;
    if (error.error_code === 429 || error.error_code >= 500) {
      return new TelegramFailure("retryable", "Telegram is temporarily unavailable", retryAfter);
    }
    return new TelegramFailure("permanent", "Telegram rejected the media operation");
  }
  return new TelegramFailure("ambiguous", "Telegram request outcome is unknown");
}

function isNotModified(error: unknown): boolean {
  return error instanceof GrammyError && /message is not modified/i.test(error.description);
}

function mediaFileId(message: {
  animation?: { file_id: string };
  video?: { file_id: string };
  document?: { file_id: string };
}): string | undefined {
  return message.animation?.file_id ?? message.video?.file_id ?? message.document?.file_id;
}

async function* toAsyncIterable(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  observe?: (observation: TelegramUploadObservation) => void,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  let completed = false;
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw abortReason(signal);
      const result = await reader.read();
      if (signal?.aborted) throw abortReason(signal);
      if (result.done) {
        completed = true;
        break;
      }
      for (
        let offset = 0;
        offset < result.value.byteLength;
        offset += TELEGRAM_UPLOAD_CHUNK_BYTES
      ) {
        const chunk = result.value.subarray(offset, offset + TELEGRAM_UPLOAD_CHUNK_BYTES);
        observe?.({ type: "chunk", byteLength: chunk.byteLength });
        yield chunk;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!completed) await reader.cancel(signal?.reason).catch(() => undefined);
    reader.releaseLock();
    observe?.({ type: "closed", completed });
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
