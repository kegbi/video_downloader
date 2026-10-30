const SENSITIVE_KEY = /authorization|token|password|secret|cookie|api[_-]?hash|dsn/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const URL_PATTERN = /https?:\/\/[^\s"']+/gi;

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = "[REDACTED]";
      parsed.password = "[REDACTED]";
    }
    if (parsed.search) parsed.search = "?[REDACTED]";
    return parsed.toString();
  } catch {
    return "[REDACTED_URL]";
  }
}

export function redactString(value: string): string {
  return value.replace(BEARER, "Bearer [REDACTED]").replace(URL_PATTERN, redactUrl);
}

export function redact(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (value instanceof Error) {
    return {
      name: redactString(value.name),
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
      cause: value.cause === undefined ? undefined : redact(value.cause, "cause"),
    };
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]),
    );
  }
  return value;
}
