import { DomainError } from "./errors.ts";

export const MAX_TELEGRAM_NUMERIC_ID = Number.MAX_SAFE_INTEGER;
export const MAX_TELEGRAM_NUMERIC_ID_TEXT = String(MAX_TELEGRAM_NUMERIC_ID);

export function isCanonicalTelegramUserId(value: string): boolean {
  if (!/^[1-9]\d{0,15}$/.test(value)) return false;
  return value.length < 16 || value <= MAX_TELEGRAM_NUMERIC_ID_TEXT;
}

export function parseTelegramUserId(value: string): string {
  if (!isCanonicalTelegramUserId(value)) {
    throw new DomainError(
      "invalid_url",
      "Telegram user ID must be a positive canonical integer within the supported range",
    );
  }
  return value;
}
