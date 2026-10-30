const SCRATCH_ROOT = "/var/tmp/video-downloader/large-file-acceptance";
const ACCEPTANCE_CASES = ["above-hosted", "boundary"] as const;
const REVIEWED_LIMITS = {
  TELEGRAM_MAX_UPLOAD_BYTES: "1990000000",
  MAX_ARTIFACT_BYTES: "1990000000",
  DOWNLOAD_FORMAT_SAFETY_BYTES: "2000000",
  DOWNLOAD_MAX_TEMP_BYTES: "3982000000",
} as const;

type AcceptanceCase = (typeof ACCEPTANCE_CASES)[number];

interface AcceptedEvidence {
  acceptanceCase: AcceptanceCase;
  artifactBytes: number;
  uploadOperations: number;
  uploadedBytes: number;
  uploadChunks: number;
  maximumChunkBytes: number;
  deliveryHeartbeats: number;
  durationMilliseconds: number;
  telegramCleanup: true;
  accepted: true;
}

let activeChild: Deno.ChildProcess | undefined;
let stopping = false;

async function main(): Promise<void> {
  if (Deno.env.get("RUN_LARGE_FILE_ACCEPTANCE") !== "1") {
    throw new Error("Large-file acceptance requires an explicit opt-in");
  }
  const chatId = requiredEnvironment("LARGE_FILE_ACCEPTANCE_CHAT_ID");
  const apiRoot = requiredEnvironment("TELEGRAM_BOT_API_ROOT");
  const token = requiredEnvironment("TELEGRAM_BOT_TOKEN");
  const ffmpegPath = requiredEnvironment("FFMPEG_PATH");
  const ffprobePath = requiredEnvironment("FFPROBE_PATH");
  const reviewedLimits = requiredReviewedLimits();

  Deno.addSignalListener("SIGTERM", requestStop);
  try {
    for (const acceptanceCase of ACCEPTANCE_CASES) {
      if (stopping) throw new Error("Large-file acceptance was stopped");
      const artifactPath = `${SCRATCH_ROOT}/${acceptanceCase}.mp4`;
      let evidence: AcceptedEvidence | undefined;
      let telegramCleanup: true | "unconfirmed" = "unconfirmed";
      let artifactCleanup = false;
      let failed = false;
      try {
        if (!(await removeScratch())) throw new Error("Acceptance scratch cleanup failed");
        await Deno.mkdir(SCRATCH_ROOT, { recursive: true, mode: 0o700 });
        const generated = await runDeno([
          "run",
          "--no-prompt",
          "--cached-only",
          `--allow-env=FFMPEG_PATH,FFPROBE_PATH`,
          `--allow-read=${SCRATCH_ROOT}`,
          `--allow-write=${SCRATCH_ROOT}`,
          `--allow-run=${ffmpegPath},${ffprobePath}`,
          "tools/generate_large_fixture.ts",
          acceptanceCase,
          artifactPath,
        ], {
          DENO_DIR: "/deno-dir",
          FFMPEG_PATH: ffmpegPath,
          FFPROBE_PATH: ffprobePath,
        });
        if (!generated.success) throw new Error("Controlled fixture generation failed");

        const accepted = await runDeno([
          "run",
          "--no-prompt",
          "--cached-only",
          `--allow-env=RUN_LARGE_FILE_ACCEPTANCE,LARGE_FILE_ACCEPTANCE_CHAT_ID,TELEGRAM_BOT_API_ROOT,TELEGRAM_BOT_TOKEN,TELEGRAM_MAX_UPLOAD_BYTES,MAX_ARTIFACT_BYTES,DOWNLOAD_FORMAT_SAFETY_BYTES,DOWNLOAD_MAX_TEMP_BYTES`,
          "--allow-net=telegram-bot-api:8081",
          `--allow-read=${artifactPath}`,
          "tools/large_file_acceptance.ts",
          acceptanceCase,
          artifactPath,
        ], {
          DENO_DIR: "/deno-dir",
          RUN_LARGE_FILE_ACCEPTANCE: "1",
          LARGE_FILE_ACCEPTANCE_CHAT_ID: chatId,
          TELEGRAM_BOT_API_ROOT: apiRoot,
          TELEGRAM_BOT_TOKEN: token,
          ...reviewedLimits,
        });
        if (!accepted.success) throw new Error("Controlled Telegram acceptance failed");
        evidence = parseAcceptedEvidence(accepted.stdout, acceptanceCase);
        telegramCleanup = evidence.telegramCleanup;
      } catch {
        failed = true;
      } finally {
        artifactCleanup = await removeScratch();
      }

      if (failed || !evidence || telegramCleanup !== true || !artifactCleanup) {
        console.error(JSON.stringify({
          acceptanceCase,
          telegramCleanup,
          artifactCleanup,
          accepted: false,
        }));
        Deno.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ ...evidence, artifactCleanup: true }));
    }
  } finally {
    try {
      activeChild?.kill("SIGTERM");
    } catch {
      // The child may already have exited.
    }
    await removeScratch();
    Deno.removeSignalListener("SIGTERM", requestStop);
  }
}

function requestStop(): void {
  stopping = true;
  try {
    activeChild?.kill("SIGTERM");
  } catch {
    // The child may have exited between the signal and cleanup.
  }
}

async function runDeno(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<{ success: boolean; stdout: string }> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [...args],
    clearEnv: true,
    env: environment,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  activeChild = child;
  try {
    const output = await child.output();
    return {
      success: output.success,
      stdout: new TextDecoder().decode(output.stdout).trim(),
    };
  } finally {
    activeChild = undefined;
  }
}

function parseAcceptedEvidence(stdout: string, acceptanceCase: AcceptanceCase): AcceptedEvidence {
  const line = stdout.split(/\r?\n/).filter(Boolean).at(-1);
  const value = line ? JSON.parse(line) as Record<string, unknown> : undefined;
  if (
    value?.acceptanceCase !== acceptanceCase || value.accepted !== true ||
    value.telegramCleanup !== true
  ) {
    throw new Error("Controlled acceptance evidence was invalid");
  }
  for (
    const field of [
      "artifactBytes",
      "uploadOperations",
      "uploadedBytes",
      "uploadChunks",
      "maximumChunkBytes",
      "deliveryHeartbeats",
      "durationMilliseconds",
    ]
  ) {
    if (typeof value[field] !== "number" || !Number.isFinite(value[field])) {
      throw new Error("Controlled acceptance evidence was invalid");
    }
  }
  return {
    acceptanceCase,
    artifactBytes: value.artifactBytes as number,
    uploadOperations: value.uploadOperations as number,
    uploadedBytes: value.uploadedBytes as number,
    uploadChunks: value.uploadChunks as number,
    maximumChunkBytes: value.maximumChunkBytes as number,
    deliveryHeartbeats: value.deliveryHeartbeats as number,
    durationMilliseconds: value.durationMilliseconds as number,
    telegramCleanup: true,
    accepted: true,
  };
}

async function removeScratch(): Promise<boolean> {
  try {
    await Deno.remove(SCRATCH_ROOT, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) return false;
  }
  try {
    await Deno.lstat(SCRATCH_ROOT);
    return false;
  } catch (error) {
    return error instanceof Deno.errors.NotFound;
  }
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function requiredReviewedLimits(): Record<keyof typeof REVIEWED_LIMITS, string> {
  const values = {} as Record<keyof typeof REVIEWED_LIMITS, string>;
  for (const [name, expected] of Object.entries(REVIEWED_LIMITS)) {
    const value = requiredEnvironment(name);
    if (value !== expected) throw new Error("Large-file acceptance limits are not reviewed");
    values[name as keyof typeof REVIEWED_LIMITS] = value;
  }
  return values;
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    console.error(JSON.stringify({
      acceptanceCase: stopping ? "stopped" : "unknown",
      telegramCleanup: "unconfirmed",
      artifactCleanup: await removeScratch(),
      accepted: false,
    }));
    Deno.exitCode = 1;
  }
}
