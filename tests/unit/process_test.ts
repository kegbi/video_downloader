import { assertEquals, assertRejects } from "@std/assert";
import { runProcess } from "../../packages/downloader/process.ts";
import { DomainError } from "../../packages/domain/errors.ts";

Deno.test("process runner captures output and bounds stderr", async () => {
  const result = await runProcess(Deno.execPath(), [
    "eval",
    "console.log('ok'); console.error('1234567890')",
  ], {
    timeoutMs: 5000,
    maxStderrBytes: 5,
  });
  assertEquals(result.code, 0);
  assertEquals(new TextDecoder().decode(result.stdout).trim(), "ok");
  assertEquals(result.stderr.trim(), "7890");
});

Deno.test("process runner can stream fixed input to a child", async () => {
  const result = await runProcess(Deno.execPath(), [
    "eval",
    "const value=await new Response(Deno.stdin.readable).text();console.log(value.toUpperCase())",
  ], {
    timeoutMs: 5000,
    stdin: new TextEncoder().encode("metadata input"),
  });
  assertEquals(result.code, 0);
  assertEquals(new TextDecoder().decode(result.stdout).trim(), "METADATA INPUT");
});

Deno.test("process runner terminates on timeout and cancellation", async () => {
  const timeout = await assertRejects(
    () => runProcess(Deno.execPath(), ["eval", "setInterval(() => {}, 1000)"], { timeoutMs: 50 }),
    DomainError,
  );
  assertEquals(timeout.code, "timeout");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const cancelled = await assertRejects(
    () =>
      runProcess(Deno.execPath(), ["eval", "setInterval(() => {}, 1000)"], {
        timeoutMs: 5000,
        signal: controller.signal,
      }),
    DomainError,
  );
  assertEquals(cancelled.code, "cancelled");

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const cancelledBeforeSpawn = await assertRejects(
    () =>
      runProcess(Deno.execPath(), ["eval", "setInterval(() => {}, 1000)"], {
        timeoutMs: 5000,
        signal: alreadyAborted.signal,
      }),
    DomainError,
  );
  assertEquals(cancelledBeforeSpawn.code, "cancelled");
});

Deno.test("process runner stops a child when its monitored byte budget is exceeded", async () => {
  const root = await Deno.makeTempDir();
  const path = `${root}/growing.bin`;
  try {
    const error = await assertRejects(
      () =>
        runProcess(Deno.execPath(), [
          "eval",
          "const f=await Deno.open(Deno.args[0],{create:true,write:true});" +
          "for(let i=0;i<100;i++){await f.write(new Uint8Array(8));" +
          "await new Promise(r=>setTimeout(r,10))}",
          path,
        ], {
          timeoutMs: 5_000,
          monitor: {
            intervalMs: 5,
            check: async () => {
              let size = 0;
              try {
                size = (await Deno.stat(path)).size;
              } catch (error) {
                if (!(error instanceof Deno.errors.NotFound)) throw error;
              }
              if (size > 16) {
                throw new DomainError(
                  "temp_storage_limit",
                  "Temporary media exceeded the configured byte budget",
                );
              }
            },
          },
        }),
      DomainError,
    );
    assertEquals(error.code, "temp_storage_limit");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});
