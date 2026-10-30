import { Bot } from "grammy";
import { loadConfig } from "../../packages/config/mod.ts";
import { abortableDelay } from "../../packages/domain/time.ts";
import { createLogger } from "../../packages/observability/logger.ts";
import { MetricsRegistry } from "../../packages/observability/metrics.ts";
import { HttpBackend } from "../../packages/telegram/backend.ts";
import { TelegramBridge } from "../../packages/telegram/bridge.ts";
import { configureTelegramCommands, GrammyTelegramAdapter } from "./telegram.ts";

const config = loadConfig("telegram");
if (!config.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (config.TELEGRAM_MODE !== "polling") throw new Error("Only Telegram polling mode is enabled");

const logger = createLogger(
  "telegram",
  config.APP_LOG_LEVEL,
  {},
  console.log,
  config.LOKI_PUSH_URL,
);
const metrics = new MetricsRegistry();
const backend = new HttpBackend(config.API_BASE_URL, config.INTERNAL_API_TOKEN);
const bot = new Bot(config.TELEGRAM_BOT_TOKEN, {
  client: { apiRoot: config.TELEGRAM_BOT_API_ROOT },
});
const adapter = new GrammyTelegramAdapter(bot.api);
const workerId = `telegram-${crypto.randomUUID()}`;
const bridge = new TelegramBridge(
  config,
  backend,
  adapter,
  workerId,
  undefined,
  undefined,
  (event, fields) => logger.info(event, { ...fields }),
);
const controller = new AbortController();
let telegramReady = false;

bot.on("message:text", async (context) => {
  if (!context.from) return;
  metrics.increment("video_downloader_telegram_updates_total");
  await bridge.handleMessage({
    updateId: context.update.update_id,
    chatId: String(context.chat.id),
    userId: String(context.from.id),
    messageId: context.message.message_id,
    chatType: context.chat.type,
    text: context.message.text,
    replyToMessageId: context.message.reply_to_message?.message_id,
  });
});
bot.on("callback_query:data", async (context) => {
  const message = context.callbackQuery.message;
  if (!context.from || !message) {
    await context.answerCallbackQuery({ text: "This action is unavailable.", show_alert: true });
    return;
  }
  metrics.increment("video_downloader_telegram_callbacks_total");
  await bridge.handleCallback({
    updateId: context.update.update_id,
    callbackId: context.callbackQuery.id,
    chatId: String(message.chat.id),
    userId: String(context.from.id),
    messageId: message.message_id,
    chatType: message.chat.type,
    data: context.callbackQuery.data,
  });
});
bot.catch((error) => logger.error("telegram.update_failed", { error: error.error }));

await bot.init();
const commandRegistration = await configureTelegramCommands(bot.api, config.telegramAdminUserIds);
if (commandRegistration.failed > 0) {
  logger.warn("telegram.command_registration_incomplete", commandRegistration);
}
telegramReady = true;
logger.info("telegram.identity_verified", { verified: true });

const server = Deno.serve(
  { hostname: "0.0.0.0", port: 8082, signal: controller.signal },
  async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/health/live") return Response.json({ status: "ok" });
    if (path === config.METRICS_PATH && config.METRICS_ENABLED) {
      return new Response(metrics.render(), {
        headers: { "content-type": "text/plain; version=0.0.4" },
      });
    }
    if (path === "/health/ready") {
      const api = await backend.healthy();
      const ready = telegramReady && api;
      return Response.json(
        { status: ready ? "ready" : "not_ready", api, telegram: telegramReady },
        { status: ready ? 200 : 503 },
      );
    }
    return new Response("Not found", { status: 404 });
  },
);

logger.info("telegram.delivery_loop_started", {
  pollIntervalMilliseconds: config.TELEGRAM_DELIVERY_POLL_INTERVAL_MS,
});
const deliveryLoop = (async () => {
  while (!controller.signal.aborted) {
    try {
      const progress = await bridge.refreshProgressOnce();
      metrics.increment("video_downloader_telegram_progress_edits_total", progress);
      const deliveryStartedAt = performance.now();
      const worked = await bridge.deliverOnce(controller.signal);
      if (worked) {
        metrics.increment("video_downloader_telegram_delivery_attempts_total");
        metrics.increment(
          "video_downloader_telegram_delivery_duration_seconds_total",
          (performance.now() - deliveryStartedAt) / 1000,
        );
      }
      if (!worked) {
        await abortableDelay(config.TELEGRAM_DELIVERY_POLL_INTERVAL_MS, controller.signal);
      }
    } catch (error) {
      logger.warn("telegram.delivery_loop_failed", { error });
      await abortableDelay(config.TELEGRAM_DELIVERY_POLL_INTERVAL_MS, controller.signal).catch(() =>
        undefined
      );
    }
  }
})();
const accessNotificationLoop = (async () => {
  while (!controller.signal.aborted) {
    try {
      const requestWorked = await bridge.notifyAccessRequestOnce();
      const decisionWorked = await bridge.notifyAccessDecisionOnce();
      const worked = requestWorked || decisionWorked;
      if (requestWorked) metrics.increment("video_downloader_telegram_access_notifications_total");
      if (decisionWorked) {
        metrics.increment("video_downloader_telegram_access_decision_notifications_total");
      }
      if (!worked) {
        await abortableDelay(
          config.TELEGRAM_ACCESS_NOTIFICATION_POLL_INTERVAL_MS,
          controller.signal,
        );
      }
    } catch (error) {
      logger.warn("telegram.access_notification_loop_failed", { error });
      await abortableDelay(
        config.TELEGRAM_ACCESS_NOTIFICATION_POLL_INTERVAL_MS,
        controller.signal,
      ).catch(() => undefined);
    }
  }
})();
const polling = bot.start({
  onStart: () => logger.info("telegram.polling_started"),
  allowed_updates: ["message", "callback_query"],
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => {
    telegramReady = false;
    controller.abort();
    bot.stop();
  });
}

await Promise.race([polling, server.finished]);
controller.abort();
bot.stop();
await Promise.allSettled([polling, server.finished, deliveryLoop, accessNotificationLoop]);
await logger.close();
