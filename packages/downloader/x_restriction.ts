import { z } from "zod";
import { parseXStatusUrl } from "../domain/x_url.ts";

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
const MAX_RESPONSE_BYTES = 65_536;
const tombstoneSchema = z.object({
  __typename: z.literal("TweetTombstone"),
  tombstone: z.object({ text: z.object({ text: z.string().max(4_096) }) }),
});

/** Diagnose an ambiguous extractor error, without trusting or following any returned URLs. */
export async function isXRegionWithheld(
  input: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  let response: Response | undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const { statusId } = parseXStatusUrl(input, X_HOSTS);
    const url = new URL("https://cdn.syndication.twimg.com/tweet-result");
    url.searchParams.set("id", statusId);
    // The public syndication token uses the same JS-number formula as yt-dlp's Twitter extractor.
    url.searchParams.set(
      "token",
      ((Number(statusId) / 1e15) * Math.PI).toString(36).replace(/[0.]/g, ""),
    );
    response = await fetcher(url, {
      headers: { "User-Agent": "Googlebot", "Accept-Language": "en" },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    if (!response.ok || !response.body) return false;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) return false;
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed = tombstoneSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success &&
      /\bhas been withheld in .+ based on local law\(s\)\./i.test(parsed.data.tombstone.text.text);
  } catch {
    // A failed diagnostic is not proof of a restriction. Preserve the original retryable error.
    return false;
  } finally {
    clearTimeout(timeout);
    await response?.body?.cancel().catch(() => undefined);
  }
}
