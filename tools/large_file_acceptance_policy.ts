import { parseTelegramUserId } from "../packages/domain/telegram_id.ts";

const LOCAL_BOT_API_HOSTS = new Set([
  "telegram-bot-api",
  "localhost",
  "127.0.0.1",
  "[::1]",
]);
const LOCAL_BOT_API_PORT = "8081";

export function validateLargeFileAcceptanceDestination(apiRoot: string, chatId: string): void {
  let apiUrl: URL;
  try {
    apiUrl = new URL(apiRoot);
  } catch {
    throw new Error("Large-file acceptance requires a valid local Bot API root");
  }
  if (
    apiUrl.protocol !== "http:" ||
    !LOCAL_BOT_API_HOSTS.has(apiUrl.hostname) ||
    apiUrl.port !== LOCAL_BOT_API_PORT ||
    apiUrl.username !== "" ||
    apiUrl.password !== "" ||
    apiUrl.pathname !== "/" ||
    apiUrl.search !== "" ||
    apiUrl.hash !== ""
  ) {
    throw new Error("Large-file acceptance requires the documented local Bot API endpoint");
  }
  parseTelegramUserId(chatId);
}
