import { assertEquals, assertThrows } from "@std/assert";
import { estimateFormatBytes, rankFormats } from "../../packages/downloader/formats.ts";
import { metadataSchema } from "../../packages/downloader/metadata.ts";
import { DomainError } from "../../packages/domain/errors.ts";
import animation from "../fixtures/x_animation.json" with { type: "json" };

Deno.test("silent X animations select a standalone stream with an unknown size", () => {
  const ranked = rankFormats(metadataSchema.parse(animation), 1080, 49_000_000, 2_000_000);
  assertEquals(ranked[0].selector, "http-0");
  assertEquals(ranked[0].audioFormatId, null);
  assertEquals(ranked[0].estimatedBytes, null);
  assertEquals(estimateFormatBytes({ format_id: "known", filesize: 100 }, undefined), 100);
});

const metadata = metadataSchema.parse({
  id: "123",
  extractor_key: "Twitter",
  webpage_url: "https://x.com/i/status/123",
  duration: 100,
  formats: [
    {
      format_id: "large",
      ext: "mp4",
      vcodec: "avc1.640028",
      acodec: "mp4a.40.2",
      height: 1080,
      filesize: 60_000_000,
    },
    {
      format_id: "medium",
      ext: "mp4",
      vcodec: "avc1.4d401f",
      acodec: "mp4a.40.2",
      height: 720,
      filesize_approx: 30_000_000,
    },
    {
      format_id: "small-video",
      ext: "mp4",
      vcodec: "avc1.4d401e",
      acodec: "none",
      height: 480,
      tbr: 800,
    },
    { format_id: "audio", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 128 },
    {
      format_id: "webm",
      ext: "webm",
      vcodec: "vp9",
      acodec: "opus",
      height: 720,
      filesize: 20_000_000,
    },
  ],
});

Deno.test("format ranking prefers compatible fitting MP4 and combines source streams", () => {
  const ranked = rankFormats(metadata, 1080, 49_000_000, 2_000_000);
  assertEquals(ranked[0].selector, "medium");
  assertEquals(ranked.some((candidate) => candidate.selector === "large"), false);
  const split = ranked.find((candidate) => candidate.selector === "small-video+audio");
  assertEquals(split?.estimatedBytes, 11_600_000);
  assertEquals(estimateFormatBytes({ format_id: "unknown" }, 100), null);
});

Deno.test("format ranking enforces height and hard size policies", () => {
  assertThrows(() => rankFormats(metadata, 360, 1_000_000, 0), DomainError);
  assertThrows(() => rankFormats(metadata, 1080, 1_000, 2_000), DomainError);
});

Deno.test("format ranking recognizes X streams when yt-dlp omits codec names", () => {
  const currentXMetadata = metadataSchema.parse({
    id: "1000000000000000002",
    extractor_key: "Twitter",
    webpage_url: "https://x.com/i/status/1000000000000000001",
    duration: 172.375,
    formats: [
      {
        format_id: "hls-audio-64000-Audio",
        ext: "mp4",
        video_ext: "none",
        audio_ext: "mp4",
        tbr: 64,
      },
      {
        format_id: "http-950",
        ext: "mp4",
        video_ext: "mp4",
        audio_ext: "none",
        width: 360,
        height: 640,
        filesize_approx: 20_469_531,
        tbr: 950,
      },
    ],
  });

  const ranked = rankFormats(currentXMetadata, 1080, 49_000_000, 2_000_000);
  assertEquals(ranked[0].selector, "http-950+hls-audio-64000-Audio");
  assertEquals(ranked[0].estimatedBytes, 21_848_531);
});

Deno.test("format ranking applies the reviewed local-server ceiling without media allocation", () => {
  const maximumBytes = 1_990_000_000;
  const safetyBytes = 2_000_000;
  const selectionLimit = maximumBytes - safetyBytes;
  const boundaryMetadata = metadataSchema.parse({
    id: "123456789",
    extractor_key: "Twitter",
    webpage_url: "https://x.com/i/status/123456789",
    duration: 1,
    formats: [
      directFormat("below", selectionLimit - 1),
      directFormat("exact", selectionLimit),
      directFormat("above", selectionLimit + 1),
    ],
  });

  const ranked = rankFormats(boundaryMetadata, 1080, maximumBytes, safetyBytes);
  assertEquals(ranked.map((candidate) => candidate.selector), ["exact", "below"]);
  assertEquals(ranked.map((candidate) => candidate.estimatedBytes), [
    selectionLimit,
    selectionLimit - 1,
  ]);
});

function directFormat(formatId: string, filesize: number) {
  return {
    format_id: formatId,
    ext: "mp4",
    vcodec: "h264",
    acodec: "aac",
    height: 1080,
    filesize,
  };
}
