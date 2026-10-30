import { Bot } from "grammy";
import {
  GrammyTelegramAdapter,
  TELEGRAM_UPLOAD_CHUNK_BYTES,
  type TelegramUploadObservation,
} from "../apps/telegram_bridge/telegram.ts";
import { loadConfig } from "../packages/config/mod.ts";
import type { ArtifactStream, Backend, DeliveryLease } from "../packages/telegram/backend.ts";
import { TelegramBridge } from "../packages/telegram/bridge.ts";
import { validateLargeFileAcceptanceDestination } from "./large_file_acceptance_policy.ts";

const TARGET_BYTES = {
  "above-hosted": 52_000_000,
  boundary: 1_990_000_000,
} as const;

type AcceptanceCase = keyof typeof TARGET_BYTES;

async function main(): Promise<void> {
  if (Deno.env.get("RUN_LARGE_FILE_ACCEPTANCE") !== "1") {
    throw new Error("Large-file acceptance requires an explicit opt-in");
  }
  const acceptanceCase = Deno.args[0] as AcceptanceCase | undefined;
  const artifactPath = Deno.args[1];
  const chatId = requiredEnvironment("LARGE_FILE_ACCEPTANCE_CHAT_ID");
  const apiRoot = requiredEnvironment("TELEGRAM_BOT_API_ROOT");
  if (!acceptanceCase || !(acceptanceCase in TARGET_BYTES) || !artifactPath) {
    throw new Error("Large-file acceptance arguments are invalid");
  }
  validateLargeFileAcceptanceDestination(apiRoot, chatId);
  const token = requiredEnvironment("TELEGRAM_BOT_TOKEN");
  const artifactBytes = (await Deno.stat(artifactPath)).size;
  if (artifactBytes !== TARGET_BYTES[acceptanceCase]) {
    throw new Error("The controlled artifact does not match the selected acceptance case");
  }

  const config = loadConfig("test", {
    APP_ENV: "test",
    TELEGRAM_BOT_API_ROOT: apiRoot,
    TELEGRAM_MAX_UPLOAD_BYTES: requiredEnvironment("TELEGRAM_MAX_UPLOAD_BYTES"),
    MAX_ARTIFACT_BYTES: requiredEnvironment("MAX_ARTIFACT_BYTES"),
    DOWNLOAD_FORMAT_SAFETY_BYTES: requiredEnvironment("DOWNLOAD_FORMAT_SAFETY_BYTES"),
    DOWNLOAD_MAX_TEMP_BYTES: requiredEnvironment("DOWNLOAD_MAX_TEMP_BYTES"),
    TELEGRAM_DELIVERY_LEASE_SECONDS: "300",
    TELEGRAM_DELIVERY_HEARTBEAT_SECONDS: "30",
  });

  const observations: TelegramUploadObservation[] = [];
  const adapter = new GrammyTelegramAdapter(
    new Bot(token, { client: { apiRoot, timeoutSeconds: 3_600 } }).api,
    (observation) => observations.push(observation),
  );
  const progressMessageId = await adapter.sendText(
    chatId,
    `Controlled ${acceptanceCase} large-file acceptance in progress.`,
  );
  const backend = new AcceptanceBackend(artifactPath, artifactBytes, chatId, progressMessageId);
  const startedAt = performance.now();
  let telegramCleanup = true;
  try {
    const bridge = new TelegramBridge(
      config,
      backend as unknown as Backend,
      adapter,
      "controlled-live-acceptance",
    );
    await bridge.deliverOnce();
    if (!backend.completed || backend.failed) {
      throw new Error("The controlled Telegram delivery was not confirmed");
    }
  } finally {
    for (const messageId of backend.messageIds(progressMessageId)) {
      try {
        await adapter.deleteMessage(chatId, messageId);
      } catch {
        telegramCleanup = false;
      }
    }
  }

  const streams = summarizeUploads(observations);
  const uploadChunks = streams.reduce((total, stream) => total + stream.chunks, 0);
  const uploadedBytes = streams.reduce((total, stream) => total + stream.bytes, 0);
  const maximumChunkBytes = Math.max(...streams.map((stream) => stream.maximumChunkBytes));
  if (
    !telegramCleanup || streams.length === 0 ||
    streams.some((stream) => !stream.completed || stream.bytes !== artifactBytes) ||
    maximumChunkBytes > TELEGRAM_UPLOAD_CHUNK_BYTES
  ) {
    throw new Error("The controlled acceptance evidence or cleanup was incomplete");
  }
  console.log(JSON.stringify({
    acceptanceCase,
    artifactBytes,
    uploadOperations: streams.length,
    uploadedBytes,
    uploadChunks,
    maximumChunkBytes,
    deliveryHeartbeats: backend.heartbeats,
    durationMilliseconds: Math.round(performance.now() - startedAt),
    telegramCleanup,
    accepted: true,
  }));
}

class AcceptanceBackend {
  private claimAvailable = true;
  completed: Record<string, unknown> | null = null;
  operation: Record<string, unknown> | null = null;
  failed = false;
  heartbeats = 0;

  constructor(
    private readonly artifactPath: string,
    private readonly artifactBytes: number,
    private readonly chatId: string,
    private readonly progressMessageId: number,
  ) {}

  claimDelivery(): Promise<DeliveryLease | null> {
    if (!this.claimAvailable) return Promise.resolve(null);
    this.claimAvailable = false;
    return Promise.resolve({
      id: "00000000-0000-4000-8000-000000000401",
      jobId: "00000000-0000-4000-8000-000000000402",
      displayId: "acceptance",
      artifactId: "00000000-0000-4000-8000-000000000403",
      attempts: 1,
      destination: {
        chatId: this.chatId,
        requestMessageId: this.progressMessageId,
        progressMessageId: this.progressMessageId,
      },
      operationContext: null,
      artifactByteSize: this.artifactBytes,
      artifactContentType: "video/mp4",
    });
  }

  heartbeatDelivery(): Promise<boolean> {
    this.heartbeats++;
    return Promise.resolve(true);
  }

  async openArtifact(): Promise<ArtifactStream> {
    const file = await Deno.open(this.artifactPath, { read: true });
    return {
      body: file.readable,
      contentLength: this.artifactBytes,
      contentType: "video/mp4",
    };
  }

  recordDeliveryOperation(
    _id: string,
    _workerId: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    this.operation = context;
    return Promise.resolve();
  }

  completeDelivery(
    _id: string,
    _workerId: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    this.completed = result;
    return Promise.resolve();
  }

  failDelivery(): Promise<void> {
    this.failed = true;
    return Promise.resolve();
  }

  messageIds(progressMessageId: number): readonly number[] {
    const ids = new Set([progressMessageId]);
    for (const result of [this.operation, this.completed]) {
      if (typeof result?.messageId === "number") ids.add(result.messageId);
    }
    return [...ids];
  }
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function summarizeUploads(observations: readonly TelegramUploadObservation[]): Array<{
  bytes: number;
  chunks: number;
  maximumChunkBytes: number;
  completed: boolean;
}> {
  const streams: Array<{
    bytes: number;
    chunks: number;
    maximumChunkBytes: number;
    completed: boolean;
  }> = [];
  let current = { bytes: 0, chunks: 0, maximumChunkBytes: 0, completed: false };
  for (const observation of observations) {
    if (observation.type === "chunk") {
      current.bytes += observation.byteLength;
      current.chunks++;
      current.maximumChunkBytes = Math.max(current.maximumChunkBytes, observation.byteLength);
    } else {
      current.completed = observation.completed;
      streams.push(current);
      current = { bytes: 0, chunks: 0, maximumChunkBytes: 0, completed: false };
    }
  }
  if (current.chunks > 0) streams.push(current);
  return streams;
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    console.error(JSON.stringify({ accepted: false }));
    Deno.exitCode = 1;
  }
}
