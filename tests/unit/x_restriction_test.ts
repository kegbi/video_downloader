import { assertEquals, assertMatch } from "@std/assert";
import { isXRegionWithheld } from "../../packages/downloader/x_restriction.ts";

const post = "https://x.com/example/status/123456789";
const withheld = {
  __typename: "TweetTombstone",
  tombstone: {
    text: {
      text:
        "This Post from @example has been withheld in Germany based on local law(s). Learn more",
    },
  },
};

Deno.test("X restriction diagnostic recognizes a regional tombstone through a fixed public endpoint", async () => {
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    assertEquals(url.origin + url.pathname, "https://cdn.syndication.twimg.com/tweet-result");
    assertEquals(url.searchParams.get("id"), "123456789");
    assertMatch(url.searchParams.get("token") ?? "", /^[a-z1-9]+$/);
    assertEquals([...url.searchParams.keys()].sort(), ["id", "token"]);
    assertEquals(init?.redirect, "error");
    assertEquals(new Headers(init?.headers).get("Accept-Language"), "en");
    assertEquals(init?.signal?.aborted, false);
    return Promise.resolve(Response.json(withheld));
  };
  assertEquals(await isXRegionWithheld(post + "?s=20", undefined, fetcher), true);
});

Deno.test("X restriction diagnostic does not mistake missing media, text, or failures for a region block", async () => {
  const responses = [
    Response.json({ tweetResult: {} }),
    Response.json({ ...withheld, __typename: "Tweet" }),
    Response.json({
      __typename: "TweetTombstone",
      tombstone: { text: { text: "This Post was deleted." } },
    }),
    Response.json({ __typename: "TweetTombstone", tombstone: { text: { text: 42 } } }),
    Response.json(withheld, { status: 403 }),
    new Response("not JSON"),
    new Response(null, { status: 204 }),
  ];
  for (const response of responses) {
    assertEquals(await isXRegionWithheld(post, undefined, () => Promise.resolve(response)), false);
  }
  assertEquals(
    await isXRegionWithheld(
      post,
      undefined,
      () => Promise.reject(new Error("network unavailable")),
    ),
    false,
  );
  let calls = 0;
  assertEquals(
    await isXRegionWithheld("https://localhost/status/123", undefined, () => {
      calls++;
      return Promise.resolve(Response.json(withheld));
    }),
    false,
  );
  assertEquals(calls, 0);
});

Deno.test("X restriction diagnostic caps response bytes and cancels an oversized body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(65_537));
    },
    cancel() {
      cancelled = true;
    },
  });
  assertEquals(
    await isXRegionWithheld(post, undefined, () => Promise.resolve(new Response(body))),
    false,
  );
  assertEquals(cancelled, true);
});

Deno.test("X restriction diagnostic propagates caller cancellation to its request", async () => {
  const controller = new AbortController();
  const fetcher: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      controller.abort();
    });
  assertEquals(await isXRegionWithheld(post, controller.signal, fetcher), false);
});

Deno.test("X restriction diagnostic aborts a stalled request within five seconds", async () => {
  const fetcher: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  assertEquals(await isXRegionWithheld(post, undefined, fetcher), false);
});
