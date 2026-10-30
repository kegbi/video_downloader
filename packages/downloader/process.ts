import { DomainError } from "../domain/errors.ts";

export interface ProcessResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

export async function runProcess(
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string;
    timeoutMs: number;
    signal?: AbortSignal;
    stdin?: Uint8Array;
    maxStderrBytes?: number;
    env?: Record<string, string>;
    monitor?: {
      intervalMs?: number;
      check: () => void | Promise<void>;
    };
  },
): Promise<ProcessResult> {
  const command = new Deno.Command(executable, {
    args: [...args],
    cwd: options.cwd,
    env: options.env,
    clearEnv: false,
    stdin: options.stdin ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  let inputError: unknown;
  const input = options.stdin;
  const inputTask = input
    ? (async () => {
      const writer = child.stdin.getWriter();
      try {
        await writer.write(input);
      } finally {
        await writer.close();
      }
    })().catch((error) => inputError = error)
    : Promise.resolve();
  let terminatedBy: "timeout" | "cancelled" | "monitor" | null = null;
  let monitorError: unknown;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const terminate = (reason: "timeout" | "cancelled" | "monitor") => {
    if (terminatedBy) return;
    terminatedBy = reason;
    try {
      child.kill("SIGTERM");
      forceKill = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process exited during the grace period.
        }
      }, 1000);
    } catch {
      // Process already exited.
    }
  };
  const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
  const onAbort = () => terminate("cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) terminate("cancelled");
  let monitorTimer: ReturnType<typeof setTimeout> | undefined;
  let monitorStopped = false;
  let finishMonitor = () => {};
  const monitorTask = new Promise<void>((resolve) => {
    finishMonitor = resolve;
    const monitor = options.monitor;
    if (!monitor) return resolve();
    const check = async () => {
      if (monitorStopped) return resolve();
      try {
        await monitor.check();
      } catch (error) {
        monitorError = error;
        terminate("monitor");
        return resolve();
      }
      if (monitorStopped) return resolve();
      monitorTimer = setTimeout(check, monitor.intervalMs ?? 100);
    };
    monitorTimer = setTimeout(check, monitor.intervalMs ?? 100);
  });
  try {
    const output = await child.output();
    await inputTask;
    if (terminatedBy === "timeout") {
      throw new DomainError("timeout", "The downloader exceeded its time limit", true);
    }
    if (terminatedBy === "cancelled") {
      throw new DomainError("cancelled", "The download was cancelled");
    }
    if (terminatedBy === "monitor") throw monitorError;
    if (inputError) throw inputError;
    const maximum = options.maxStderrBytes ?? 16_384;
    const stderrBytes = output.stderr.length > maximum
      ? output.stderr.slice(output.stderr.length - maximum)
      : output.stderr;
    return {
      code: output.code,
      stdout: output.stdout,
      stderr: new TextDecoder().decode(stderrBytes),
    };
  } finally {
    await inputTask;
    monitorStopped = true;
    if (monitorTimer !== undefined) clearTimeout(monitorTimer);
    finishMonitor();
    await monitorTask;
    clearTimeout(timeout);
    if (forceKill !== undefined) clearTimeout(forceKill);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
