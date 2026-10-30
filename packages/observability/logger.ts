import { redact } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
  close(): Promise<void>;
}

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

interface LogTransport {
  readonly sink: (line: string) => void;
  readonly lokiPushUrl: string;
  readonly pending: Set<Promise<void>>;
}

let latestTimestampNs = 0n;

export function createLogger(
  service: string,
  minimum: LogLevel = "info",
  base: Record<string, unknown> = {},
  sink: (line: string) => void = console.log,
  lokiPushUrl = "",
): Logger {
  return createChildLogger(service, minimum, base, { sink, lokiPushUrl, pending: new Set() });
}

function createChildLogger(
  service: string,
  minimum: LogLevel,
  base: Record<string, unknown>,
  transport: LogTransport,
): Logger {
  const emit = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    if (order[level] < order[minimum]) return;
    const line = JSON.stringify(
      redact({ timestamp: new Date().toISOString(), level, service, event, ...base, ...fields }),
    );
    transport.sink(line);
    if (transport.lokiPushUrl) pushToLoki(transport, service, level, line);
  };
  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (fields) => createChildLogger(service, minimum, { ...base, ...fields }, transport),
    close: async () => await Promise.allSettled([...transport.pending]).then(() => undefined),
  };
}

function pushToLoki(
  transport: LogTransport,
  service: string,
  level: LogLevel,
  line: string,
): void {
  const now = BigInt(Date.now()) * 1_000_000n;
  latestTimestampNs = now > latestTimestampNs ? now : latestTimestampNs + 1n;
  const task: Promise<void> = fetch(transport.lokiPushUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      streams: [{ stream: { service, level }, values: [[String(latestTimestampNs), line]] }],
    }),
    signal: AbortSignal.timeout(2_000),
  }).then((response) => {
    if (!response.ok) throw new Error(`Loki rejected a log entry with HTTP ${response.status}`);
  }).catch(() => undefined).finally(() => transport.pending.delete(task));
  transport.pending.add(task);
}
