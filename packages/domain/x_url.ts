import { DomainError } from "./errors.ts";

export interface ParsedXUrl {
  readonly submittedUrl: string;
  readonly normalizedUrl: string;
  readonly statusId: string;
}

// The optional `/video/N` or `/photo/N` suffix is the media-viewer form X produces when a post is
// shared from its media view. It names the same status, so it is accepted and dropped during
// normalization; the job still follows the deterministic first-video selection policy.
const STATUS_PATH =
  /^\/(?:i|[A-Za-z0-9_]{1,15})\/status\/(\d{1,20})(?:\/(?:video|photo)\/[1-4])?\/?$/;

export function parseXStatusUrl(input: string, allowedHosts: ReadonlySet<string>): ParsedXUrl {
  const submittedUrl = input.trim();
  if (!submittedUrl || submittedUrl.length > 2048) {
    throw new DomainError("invalid_url", "Enter one valid X status URL");
  }

  let url: URL;
  try {
    url = new URL(submittedUrl);
  } catch {
    throw new DomainError("invalid_url", "Enter one valid X status URL");
  }

  const host = url.hostname.toLowerCase();
  const authority = /^https:\/\/([^/]+)/i.exec(submittedUrl)?.[1] ?? "";
  if (url.protocol !== "https:" || !allowedHosts.has(host)) {
    throw new DomainError("unsupported_url", "Only public HTTPS X status URLs are supported");
  }
  if (url.username || url.password || url.port || /:\d+$/.test(authority) || url.hash) {
    throw new DomainError("invalid_url", "The X URL contains unsupported components");
  }
  // Share links carry tracking parameters (s, t, a, ...). They never reach the downloader because
  // the normalized URL is rebuilt from the status ID alone, so they are ignored rather than rejected.
  const match = STATUS_PATH.exec(url.pathname);
  if (!match) {
    throw new DomainError("unsupported_url", "Only individual X status URLs are supported");
  }
  const statusId = match[1];
  if (BigInt(statusId) === 0n) throw new DomainError("invalid_url", "The X status ID is invalid");

  return {
    submittedUrl,
    normalizedUrl: `https://x.com/i/status/${statusId}`,
    statusId,
  };
}
