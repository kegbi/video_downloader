const URL = /https?:\/\/[^\s"'<>]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const SENSITIVE_LINE =
  /\b(authorization|cookie|set-cookie|x-api-key|api[_-]?key|token|password|secret)\b(\s*[:=]\s*)[^\r\n]*/gi;

export const MAX_DIAGNOSTIC_EXCERPT_CHARACTERS = 2_048;

/** Produces a log-only excerpt. It must never be exposed as a user-facing error message. */
export function boundedDiagnosticExcerpt(
  value: string,
  maximumCharacters = MAX_DIAGNOSTIC_EXCERPT_CHARACTERS,
): string | undefined {
  const sanitized = stripAnsi(value)
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(SENSITIVE_LINE, (_match, key: string) => `${key}: [REDACTED]`)
    .replace(URL, "[REDACTED_URL]");
  const normalized = stripControlCharacters(sanitized).trim();
  if (!normalized) return undefined;
  if (normalized.length <= maximumCharacters) return normalized;
  return `…${normalized.slice(-(maximumCharacters - 1))}`;
}

function stripAnsi(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) !== 27) {
      output += value[index];
      continue;
    }
    if (value[index + 1] === "[") {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code >= 64 && code <= 126) break;
        index++;
      }
      continue;
    }
    if (value[index + 1] === "]") {
      index += 2;
      while (index < value.length) {
        if (value.charCodeAt(index) === 7) break;
        if (value.charCodeAt(index) === 27 && value[index + 1] === "\\") {
          index++;
          break;
        }
        index++;
      }
    }
  }
  return output;
}

function stripControlCharacters(value: string): string {
  return [...value].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return character === "\n" || character === "\r" || character === "\t" ||
      code >= 32 && code !== 127;
  }).join("");
}
