import { assertEquals, assertStringIncludes } from "@std/assert";
import { createLogger } from "../../packages/observability/logger.ts";
import { redact, redactString } from "../../packages/observability/redact.ts";

Deno.test("redactor removes secret fields, bearer values, credentials and query strings", () => {
  const value = redact({
    authorization: "Bearer abc.def",
    nested: {
      password: "nope",
      source: "https://user:pass@cdn.example/video.mp4?signature=secret",
    },
  }) as Record<string, unknown>;
  assertEquals(value.authorization, "[REDACTED]");
  assertEquals((value.nested as Record<string, unknown>).password, "[REDACTED]");
  assertEquals(
    (value.nested as Record<string, unknown>).source,
    "https://%5BREDACTED%5D:%5BREDACTED%5D@cdn.example/video.mp4?[REDACTED]",
  );
  assertEquals(redactString("Bearer token-value"), "Bearer [REDACTED]");
});

Deno.test("structured logger emits redacted JSON", () => {
  const lines: string[] = [];
  const logger = createLogger("test", "info", {}, (line) => lines.push(line));
  logger.info("request", { apiToken: "secret", url: "https://x.com/i/status/123?x=y" });
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], '"apiToken":"[REDACTED]"');
  assertEquals(lines[0].includes("secret"), false);
  assertEquals(lines[0].includes("x=y"), false);
});

Deno.test("structured logger serializes Error details instead of an empty object", () => {
  const lines: string[] = [];
  const logger = createLogger("test", "info", {}, (line) => lines.push(line));
  logger.error("failure", {
    error: new TypeError("request to https://example.test/video?token=secret failed"),
  });
  const entry = JSON.parse(lines[0]) as { error: Record<string, unknown> };
  assertEquals(entry.error.name, "TypeError");
  assertStringIncludes(String(entry.error.message), "?[REDACTED]");
  assertEquals(String(entry.error.message).includes("secret"), false);
  assertStringIncludes(String(entry.error.stack), "TypeError");
});
