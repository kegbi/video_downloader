import { dirname, resolve } from "@std/path";

const TARGET_BYTES = {
  "above-hosted": 52_000_000,
  boundary: 1_990_000_000,
} as const;

type AcceptanceCase = keyof typeof TARGET_BYTES;

async function main(): Promise<void> {
  const acceptanceCase = Deno.args[0] as AcceptanceCase | undefined;
  const outputArgument = Deno.args[1];
  if (!acceptanceCase || !(acceptanceCase in TARGET_BYTES) || !outputArgument) {
    throw new Error("Usage: generate_large_fixture.ts <above-hosted|boundary> <output.mp4>");
  }
  const output = resolve(outputArgument);
  try {
    await Deno.lstat(output);
    throw new Error("The controlled fixture output already exists");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.mkdir(dirname(output), { recursive: true });

  try {
    await runMediaTool(Deno.env.get("FFMPEG_PATH") ?? "ffmpeg", [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      output,
    ]);
    await appendSparseFreeBox(output, TARGET_BYTES[acceptanceCase]);
    await runMediaTool(Deno.env.get("FFPROBE_PATH") ?? "ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height",
      "-of",
      "json",
      "--",
      output,
    ]);
    const size = (await Deno.stat(output)).size;
    if (size !== TARGET_BYTES[acceptanceCase]) {
      throw new Error("The controlled fixture has an unexpected logical size");
    }
    console.log(JSON.stringify({
      acceptanceCase,
      artifactBytes: size,
      fixtureValidated: true,
    }));
  } catch (error) {
    await Deno.remove(output).catch(() => undefined);
    throw error;
  }
}

async function appendSparseFreeBox(path: string, targetBytes: number): Promise<void> {
  const initialBytes = (await Deno.stat(path)).size;
  const freeBoxBytes = targetBytes - initialBytes;
  if (freeBoxBytes < 8 || freeBoxBytes > 0xffff_ffff) {
    throw new Error("The generated MP4 cannot be padded to the requested controlled size");
  }
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, freeBoxBytes);
  header.set(new TextEncoder().encode("free"), 4);
  const file = await Deno.open(path, { read: true, write: true });
  try {
    await file.seek(0, Deno.SeekMode.End);
    await file.write(header);
    await file.truncate(targetBytes);
  } finally {
    file.close();
  }
}

async function runMediaTool(command: string, args: readonly string[]): Promise<void> {
  const result = await new Deno.Command(command, {
    args: [...args],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  if (!result.success) throw new Error("Controlled fixture media validation failed");
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    console.error(JSON.stringify({ fixtureValidated: false }));
    Deno.exitCode = 1;
  }
}
