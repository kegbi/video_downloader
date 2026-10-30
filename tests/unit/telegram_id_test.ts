import { assertEquals, assertThrows } from "@std/assert";
import { ConfigError, loadConfig } from "../../packages/config/mod.ts";
import { DomainError } from "../../packages/domain/errors.ts";
import {
  isCanonicalTelegramUserId,
  parseTelegramUserId,
} from "../../packages/domain/telegram_id.ts";

Deno.test("Telegram numeric IDs use one bounded canonical representation", () => {
  for (const invalid of ["0", "01", "-1", "+1", "9007199254740992", "9".repeat(1_000)]) {
    assertEquals(isCanonicalTelegramUserId(invalid), false);
    assertThrows(() => parseTelegramUserId(invalid), DomainError);
    assertThrows(
      () => loadConfig("test", { APP_ENV: "test", TELEGRAM_ADMIN_USER_IDS: invalid }),
      ConfigError,
    );
  }
  for (const valid of ["1", "99", "9007199254740991"]) {
    assertEquals(isCanonicalTelegramUserId(valid), true);
    assertEquals(parseTelegramUserId(valid), valid);
    assertEquals(
      loadConfig("test", {
        APP_ENV: "test",
        TELEGRAM_ADMIN_USER_IDS: valid,
      }).telegramAdminUserIds,
      [valid],
    );
  }
});
