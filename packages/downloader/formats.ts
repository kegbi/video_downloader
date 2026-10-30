import type { DownloaderMetadata } from "./metadata.ts";
import { DomainError } from "../domain/errors.ts";

type Format = DownloaderMetadata["formats"][number];

export interface FormatSelection {
  readonly selector: string;
  readonly videoFormatId: string;
  readonly audioFormatId: string | null;
  readonly estimatedBytes: number | null;
  readonly height: number | null;
  readonly container: string;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly compatibilityScore: number;
}

export function estimateFormatBytes(
  format: Format,
  durationSeconds: number | null | undefined,
): number | null {
  if (format.filesize && format.filesize > 0) return Math.ceil(format.filesize);
  if (format.filesize_approx && format.filesize_approx > 0) {
    return Math.ceil(format.filesize_approx);
  }
  if (durationSeconds == null) return null;
  const bitrate = format.tbr ?? ((format.vbr ?? 0) + (format.abr ?? 0));
  return bitrate && bitrate > 0 ? Math.ceil(durationSeconds * bitrate * 1000 / 8) : null;
}

export function rankFormats(
  metadata: DownloaderMetadata,
  maxHeight: number,
  maximumBytes: number,
  safetyBytes: number,
): readonly FormatSelection[] {
  const byteLimit = maximumBytes - safetyBytes;
  if (byteLimit <= 0) {
    throw new DomainError(
      "no_format_within_limit",
      "The configured size safety margin is too large",
    );
  }
  const formats = metadata.formats.filter((format) => !format.height || format.height <= maxHeight);
  const audioOnly = formats.filter((format) => hasAudio(format) && !hasVideo(format));
  const candidates: FormatSelection[] = [];

  for (const video of formats.filter(hasVideo)) {
    if (hasAudio(video) || audioOnly.length === 0) {
      candidates.push(selection(video, null, metadata.duration));
    } else {
      for (const audio of audioOnly) candidates.push(selection(video, audio, metadata.duration));
    }
  }

  const fitting = candidates.filter((candidate) =>
    candidate.estimatedBytes === null || candidate.estimatedBytes <= byteLimit
  );
  fitting.sort((a, b) => {
    const knownA = a.estimatedBytes !== null ? 1 : 0;
    const knownB = b.estimatedBytes !== null ? 1 : 0;
    return b.compatibilityScore - a.compatibilityScore ||
      (b.height ?? 0) - (a.height ?? 0) ||
      knownB - knownA ||
      (b.estimatedBytes ?? 0) - (a.estimatedBytes ?? 0) ||
      a.selector.localeCompare(b.selector);
  });
  if (fitting.length === 0) {
    throw new DomainError(
      "no_format_within_limit",
      "No source format fits the configured upload limit",
    );
  }
  return fitting;
}

function selection(
  video: Format,
  audio: Format | null,
  duration: number | null | undefined,
): FormatSelection {
  const videoBytes = estimateFormatBytes(video, duration);
  const audioBytes = audio ? estimateFormatBytes(audio, duration) : 0;
  const estimatedBytes = videoBytes === null || audioBytes === null
    ? null
    : videoBytes + audioBytes;
  const videoCodec = valueCodec(video.vcodec);
  const audioCodec = valueCodec(audio?.acodec ?? video.acodec);
  const container = video.ext ?? "unknown";
  let compatibilityScore = 0;
  if (container === "mp4" || container === "m4v") compatibilityScore += 4;
  if (videoCodec?.startsWith("avc1") || videoCodec?.startsWith("h264")) compatibilityScore += 3;
  if (audioCodec?.startsWith("mp4a") || audioCodec?.startsWith("aac")) compatibilityScore += 2;
  if (!audio) compatibilityScore += 1;
  return {
    selector: audio ? `${video.format_id}+${audio.format_id}` : video.format_id,
    videoFormatId: video.format_id,
    audioFormatId: audio?.format_id ?? null,
    estimatedBytes,
    height: video.height ?? null,
    container,
    videoCodec,
    audioCodec,
    compatibilityScore,
  };
}

function valueCodec(value?: string | null): string | null {
  return value && value !== "none" ? value : null;
}
function hasVideo(format: Format): boolean {
  return valueCodec(format.vcodec) !== null ||
    valueExtension(format.video_ext) !== null;
}
function hasAudio(format: Format): boolean {
  return valueCodec(format.acodec) !== null || valueExtension(format.audio_ext) !== null;
}

function valueExtension(value?: string | null): string | null {
  return value && value !== "none" ? value : null;
}
