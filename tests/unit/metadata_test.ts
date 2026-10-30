import { assertEquals, assertThrows } from "@std/assert";
import {
  metadataSchema,
  parseDownloaderMetadata,
  parseProgressLine,
} from "../../packages/downloader/metadata.ts";
import animation from "../fixtures/x_animation.json" with { type: "json" };

Deno.test("X animation metadata may omit duration but cannot provide an invalid duration", () => {
  for (const duration of [undefined, null, 1]) {
    assertEquals(metadataSchema.parse({ ...animation, duration }).duration, duration);
  }
  for (const duration of [0, -1, "1", Infinity]) {
    assertThrows(() => metadataSchema.parse({ ...animation, duration }));
  }
});

Deno.test("captured yt-dlp metadata and fixed progress templates are validated", () => {
  const metadata = metadataSchema.parse({
    id: "123456789",
    extractor_key: "Twitter",
    webpage_url: "https://x.com/i/status/123456789",
    duration: 12.5,
    formats: [{ format_id: "http-1", ext: "mp4", vcodec: "h264", acodec: "aac" }],
  });
  assertEquals(metadata.id, "123456789");
  assertEquals(
    parseProgressLine(
      'VD_PROGRESS {"status":"downloading","downloaded_bytes":25,"total_bytes":100}',
    ),
    { phase: "downloading", downloadedBytes: 25, totalBytes: 100, percent: 25 },
  );
  assertEquals(
    parseProgressLine(
      'VD_PROGRESS {"status":"finished","downloaded_bytes":100,"total_bytes_estimate":100}',
    )?.phase,
    "processing",
  );
  assertEquals(parseProgressLine("[download] 25%"), null);
  assertEquals(parseProgressLine("VD_PROGRESS not-json"), null);
});

Deno.test("playlist-shaped metadata for one multi-video X status selects its first video", () => {
  const parsed = parseDownloaderMetadata({
    _type: "playlist",
    id: "1000000000000000003",
    extractor_key: "Twitter",
    webpage_url: "https://x.com/i/status/1000000000000000003",
    playlist_count: 2,
    entries: [
      {
        id: "1000000000000000004",
        extractor_key: "Twitter",
        webpage_url: "https://x.com/i/status/1000000000000000003",
        duration: 67.986,
        formats: [{ format_id: "first", ext: "mp4", vcodec: "h264", acodec: "aac" }],
      },
    ],
  });

  assertEquals(parsed.value.id, "1000000000000000004");
  assertEquals(parsed.value.formats[0].format_id, "first");
  assertEquals(parsed.sourceMediaCount, 2);
  assertEquals(parsed.selectedMediaIndex, 1);
});
