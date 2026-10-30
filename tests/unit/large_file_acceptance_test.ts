import { assertThrows } from "@std/assert";
import { validateLargeFileAcceptanceDestination } from "../../tools/large_file_acceptance_policy.ts";

Deno.test("large-file acceptance permits only the local Bot API and a private chat", () => {
  for (
    const apiRoot of [
      "http://telegram-bot-api:8081",
      "http://localhost:8081",
      "http://127.0.0.1:8081",
      "http://[::1]:8081",
    ]
  ) {
    validateLargeFileAcceptanceDestination(apiRoot, "123456789");
  }
});

Deno.test("large-file acceptance rejects remote or malformed Bot API roots", () => {
  for (
    const apiRoot of [
      "https://api.telegram.org",
      "http://api.telegram.org:8081",
      "https://telegram-bot-api:8081",
      "http://telegram-bot-api:8080",
      "http://telegram-bot-api:8081/bot",
      "http://user:password@telegram-bot-api:8081",
      "not-a-url",
    ]
  ) {
    assertThrows(() => validateLargeFileAcceptanceDestination(apiRoot, "123456789"));
  }
});

Deno.test("large-file acceptance rejects non-private or non-canonical chat IDs", () => {
  for (const chatId of ["-100123456789", "0", "0123456789", "9007199254740992", "chat-name"]) {
    assertThrows(() =>
      validateLargeFileAcceptanceDestination("http://telegram-bot-api:8081", chatId)
    );
  }
});
