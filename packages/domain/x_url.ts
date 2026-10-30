import { DomainError } from "./errors.ts";

export interface ParsedXUrl {
  readonly submittedUrl: string;
  readonly normalizedUrl: string;
  readonly statusId: string;
}

const STATUS_PATH = /^\/(?:i|[A-Za-z0-9_]{1,15})\/status\/(\d{1,20})\/?$/;

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
