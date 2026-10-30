import { z } from "zod";

export const formatSchema = z.object({
  format_id: z.string(),
  ext: z.string().optional(),
  video_ext: z.string().optional(),
  audio_ext: z.string().optional(),
  protocol: z.string().optional(),
  vcodec: z.string().optional(),
  acodec: z.string().optional(),
  width: z.number().nullish(),
  height: z.number().nullish(),
  fps: z.number().nullish(),
  tbr: z.number().nullish(),
  vbr: z.number().nullish(),
  abr: z.number().nullish(),
  filesize: z.number().nullish(),
  filesize_approx: z.number().nullish(),
  url: z.string().optional(),
}).passthrough();

export const metadataSchema = z.object({
  id: z.string().regex(/^\d+$/),
  extractor_key: z.string(),
  webpage_url: z.string().url(),
  title: z.string().optional(),
  duration: z.number().positive().nullish(),
  live_status: z.string().optional(),
  formats: z.array(formatSchema).min(1),
}).passthrough().superRefine((value, context) => {
  if (!/^twitter$/i.test(value.extractor_key)) {
    context.addIssue({
      code: "custom",
      path: ["extractor_key"],
      message: "Only the Twitter extractor is allowed",
    });
  }
  if (value.live_status === "is_live") {
    context.addIssue({
      code: "custom",
      path: ["live_status"],
      message: "Live streams are not supported",
    });
  }
});

export type DownloaderMetadata = z.infer<typeof metadataSchema>;

const xPostMediaContainerSchema = z.object({
  _type: z.literal("playlist"),
  id: z.string().regex(/^\d+$/),
  extractor_key: z.string().refine((value) => /^twitter$/i.test(value), {
    message: "Only the Twitter extractor is allowed",
  }),
  webpage_url: z.string().url(),
  playlist_count: z.number().int().positive().optional(),
  entries: z.array(z.unknown()).min(1),
}).passthrough();

export interface ParsedDownloaderMetadata {
  readonly value: DownloaderMetadata;
  readonly sourceMediaCount: number;
  readonly selectedMediaIndex: number;
}

/**
 * yt-dlp represents a single X status containing multiple videos as a playlist-shaped media
 * container. The public input remains one validated status URL; select its first video
 * deterministically rather than exposing generic playlist behavior.
 */
export function parseDownloaderMetadata(value: unknown): ParsedDownloaderMetadata {
  if (isRecord(value) && value._type === "playlist") {
    const container = xPostMediaContainerSchema.parse(value);
    return {
      value: metadataSchema.parse(container.entries[0]),
      sourceMediaCount: Math.max(container.playlist_count ?? 0, container.entries.length),
      selectedMediaIndex: 1,
    };
  }
  return {
    value: metadataSchema.parse(value),
    sourceMediaCount: 1,
    selectedMediaIndex: 1,
  };
}

export function describeMetadataValidationError(error: unknown): string | undefined {
  if (!(error instanceof z.ZodError)) return undefined;
  const description = error.issues.slice(0, 4).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "metadata";
    return `${path}: ${issue.message}`;
  }).join("; ");
  return description.length <= 512 ? description : `${description.slice(0, 511)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const progressSchema = z.object({
  phase: z.enum(["downloading", "processing"]),
  downloadedBytes: z.number().nonnegative().nullable(),
  totalBytes: z.number().positive().nullable(),
  percent: z.number().min(0).max(100).nullable(),
});

export type DownloaderProgress = z.infer<typeof progressSchema>;

/** Parses only the JSON emitted by the fixed yt-dlp progress template. */
export function parseProgressLine(line: string): DownloaderProgress | null {
  const prefix = "VD_PROGRESS ";
  if (!line.startsWith(prefix)) return null;
  try {
    const raw = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
    const downloadedBytes = finiteNumber(raw.downloaded_bytes);
    const totalBytes = finiteNumber(raw.total_bytes ?? raw.total_bytes_estimate);
    const percent = downloadedBytes !== null && totalBytes !== null && totalBytes > 0
      ? Math.min(100, downloadedBytes / totalBytes * 100)
      : null;
    return progressSchema.parse({
      phase: raw.status === "finished" ? "processing" : "downloading",
      downloadedBytes,
      totalBytes,
      percent,
    });
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
