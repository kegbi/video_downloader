import { assertEquals, assertThrows } from "@std/assert";
import { DomainError } from "../../packages/domain/errors.ts";
import { parseXStatusUrl } from "../../packages/domain/x_url.ts";

const hosts = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);

Deno.test("X URL parser normalizes approved status shapes without changing identity", () => {
  for (
    const input of [
      "https://x.com/user/status/123456789",
      "https://www.x.com/i/status/123456789/",
      "https://twitter.com/user_name/status/123456789?s=20",
      "https://www.twitter.com/i/status/123456789?t=123",
      "https://x.com/someone/status/123456789?a=AbCdEf123_xyz&s=19",
      "https://x.com/user/status/123456789?redirect=https://127.0.0.1",
    ]
  ) {
    const parsed = parseXStatusUrl(input, hosts);
    assertEquals(parsed.statusId, "123456789");
    assertEquals(parsed.normalizedUrl, "https://x.com/i/status/123456789");
    assertEquals(parsed.submittedUrl, input);
  }
});

Deno.test("X URL parser rejects schemes, credentials, ports, fragments and generic paths", () => {
  for (
    const input of [
      "http://x.com/i/status/123",
      "https://user:pass@x.com/i/status/123",
      "https://x.com:443/i/status/123",
      "https://x.com/i/status/123#fragment",
      "https://x.com/home",
      "https://example.com/i/status/123",
      "file:///etc/passwd",
      "https://x.com/home?ref=https://x.com/i/status/123",
      "https://x.com/i/status/0",
      "https://x.com/user/status/123/extra",
    ]
  ) assertThrows(() => parseXStatusUrl(input, hosts), DomainError);
});
