import { assertEquals, assertMatch, assertNotMatch, assertRejects } from "@std/assert";
import { dirname } from "@std/path";
import {
  cleanupAbandonedTemporaryDirectories,
  type DownloadPhaseObservation,
  YtDlpDownloader,
} from "../../packages/downloader/adapter.ts";
import { runProcess } from "../../packages/downloader/process.ts";
import { DomainError } from "../../packages/domain/errors.ts";
import animation from "../fixtures/x_animation.json" with { type: "json" };

Deno.test("X animations without duration download silently and enforce probed duration limits", async () => {
  for (const duration of [1, 61, 0]) {
    const root = await Deno.makeTempDir();
    const calls: string[] = [];
    const runner: typeof runProcess = async (executable, args) => {
      calls.push(executable);
      if (args.includes("--dump-single-json")) return result(JSON.stringify(animation));
      if (executable === "yt-dlp") {
        const output = args[args.indexOf("--output") + 1].replace("%(ext)s", "mp4");
        await Deno.writeFile(output, new Uint8Array([1]));
        return result("");
      }
      assertEquals(executable, "ffprobe");
      return result(JSON.stringify({
        streams: [{ codec_type: "video", codec_name: "h264", width: 320, height: 240 }],
        format: { duration: String(duration), format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
      }));
    };
    const downloader = new YtDlpDownloader(downloaderOptions(root, 100, 200), runner);
    try {
      if (duration === 1) {
        const artifact = await downloader.download(animation.webpage_url);
        assertEquals(artifact.durationSeconds, 1);
        assertEquals(artifact.audioCodec, null);
        assertEquals(artifact.container, "mp4");
        assertEquals(artifact.selection.selector, "http-0");
        assertEquals(calls, ["yt-dlp", "yt-dlp", "ffprobe"]);
        await downloader.cleanup(artifact);
      } else {
        const error = await assertRejects(
          () => downloader.download(animation.webpage_url),
          DomainError,
        );
        assertEquals(error.code, duration === 0 ? "processing_failure" : "source_unavailable");
      }
      assertEquals(await directoryNames(root), []);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

const encoder = new TextEncoder();

Deno.test("downloader explicitly muxes split X streams when audio codec metadata is absent", async () => {
  const temporaryRoot = await Deno.makeTempDir();
  const invocations: Array<{
    executable: string;
    args: readonly string[];
    stdin?: Uint8Array;
  }> = [];
  const phases: DownloadPhaseObservation[] = [];
  let activeDownloads = 0;
  let maximumActiveDownloads = 0;
  let reportBothStarted = () => {};
  const bothStarted = new Promise<void>((resolve) => reportBothStarted = resolve);
  const runner: typeof runProcess = async (executable, args, options) => {
    invocations.push({ executable, args, stdin: options.stdin });
    if (executable === "yt-dlp" && args.includes("--dump-single-json")) {
      return result(JSON.stringify({
        id: "1000000000000000002",
        extractor_key: "Twitter",
        webpage_url: "https://x.com/i/status/1000000000000000001",
        duration: 10,
        formats: [
          {
            format_id: "video",
            ext: "mp4",
            vcodec: "avc1.4D401E",
            acodec: "none",
            video_ext: "mp4",
            audio_ext: "none",
            height: 640,
            tbr: 254,
          },
          {
            format_id: "audio",
            ext: "mp4",
            vcodec: "none",
            video_ext: "none",
            audio_ext: "mp4",
            tbr: 64,
          },
        ],
      }));
    }
    if (executable === "yt-dlp") {
      activeDownloads++;
      maximumActiveDownloads = Math.max(maximumActiveDownloads, activeDownloads);
      if (activeDownloads === 2) reportBothStarted();
      try {
        await Promise.race([
          bothStarted,
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("Split downloads did not overlap")), 1_000)
          ),
        ]);
        const output = args[args.indexOf("--output") + 1].replace("%(ext)s", "mp4");
        await Deno.writeFile(output, encoder.encode(args[args.indexOf("--format") + 1]));
        return result("");
      } finally {
        activeDownloads--;
      }
    }
    if (executable === "ffmpeg") {
      await Deno.writeFile(args.at(-1)!, encoder.encode("merged"));
      return result("");
    }
    if (executable === "ffprobe") {
      return result(JSON.stringify({
        streams: [
          { codec_type: "video", codec_name: "h264", width: 360, height: 640 },
          { codec_type: "audio", codec_name: "aac" },
        ],
        format: { duration: "10", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
      }));
    }
    throw new Error(`Unexpected executable: ${executable}`);
  };
  const downloader = new YtDlpDownloader(
    {
      ytDlpPath: "yt-dlp",
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      temporaryRoot,
      timeoutSeconds: 60,
      maximumDurationSeconds: 60,
      maximumHeight: 1080,
      maximumBytes: 49_000_000,
      safetyBytes: 2_000_000,
      maximumTemporaryBytes: 100_000_000,
    },
    runner,
    undefined,
    (observation) => phases.push(observation),
  );

  try {
    const artifact = await downloader.download("https://x.com/i/status/1000000000000000001");
    assertEquals(artifact.selection.selector, "video+audio");
    assertEquals(artifact.videoCodec, "h264");
    assertEquals(artifact.audioCodec, "aac");
    assertEquals(maximumActiveDownloads, 2);
    assertEquals(
      invocations.filter((invocation) =>
        invocation.executable === "yt-dlp" &&
        invocation.args.includes("--format")
      )
        .map((invocation) => invocation.args[invocation.args.indexOf("--format") + 1]).sort(),
      ["audio", "video"],
    );
    const mediaInvocations = invocations.filter((invocation) =>
      invocation.executable === "yt-dlp" && invocation.args.includes("--format")
    );
    assertEquals(
      mediaInvocations.every((invocation) =>
        invocation.args.includes("--load-info-json") &&
        invocation.args[invocation.args.indexOf("--load-info-json") + 1] === "-" &&
        invocation.stdin !== undefined &&
        !invocation.args.some((argument) => argument.includes("x.com"))
      ),
      true,
    );
    const merge = invocations.find((invocation) => invocation.executable === "ffmpeg");
    assertEquals(merge?.args.includes("copy"), true);
    assertEquals(phases[0] && { phase: phases[0].phase, outcome: phases[0].outcome }, {
      phase: "metadata",
      outcome: "success",
    });
    assertEquals(
      phases.slice(1, 3).map(({ phase, outcome }) => ({ phase, outcome })).sort((left, right) =>
        left.phase.localeCompare(right.phase)
      ),
      [
        { phase: "audio_download", outcome: "success" },
        { phase: "video_download", outcome: "success" },
      ],
    );
    assertEquals(
      phases.slice(3).map(({ phase, outcome }) => ({ phase, outcome })),
      [
        { phase: "mux", outcome: "success" },
        { phase: "validation", outcome: "success" },
      ],
    );
    assertEquals(phases.every((phase) => phase.durationMilliseconds >= 0), true);
    await Deno.remove(dirname(artifact.path), { recursive: true });
  } finally {
    await Deno.remove(temporaryRoot, { recursive: true }).catch(() => undefined);
  }
});

function result(stdout: string) {
  return Promise.resolve({ code: 0, stdout: encoder.encode(stdout), stderr: "" });
}

Deno.test("ambiguous no-video errors fail without retry only after a confirmed X regional restriction", async () => {
  for (const restricted of [true, false]) {
    const root = await Deno.makeTempDir();
    const phases: DownloadPhaseObservation[] = [];
    let processCalls = 0;
    let probes = 0;
    const signal = new AbortController().signal;
    const url = "https://x.com/i/status/123456789";
    const downloader = new YtDlpDownloader(
      downloaderOptions(root, 10, 20),
      () => {
        processCalls++;
        return Promise.resolve({
          code: 1,
          stdout: new Uint8Array(),
          stderr: "ERROR: [twitter] 123456789: No video could be found in this tweet",
        });
      },
      undefined,
      (phase) => phases.push(phase),
      (input, inputSignal) => {
        probes++;
        assertEquals(input, url);
        assertEquals(inputSignal, signal);
        return Promise.resolve(restricted);
      },
    );
    try {
      const error = await assertRejects(() => downloader.download(url, signal), DomainError);
      assertEquals(error.code, restricted ? "source_unavailable" : "extractor_failure");
      assertEquals(error.retryable, !restricted);
      assertEquals(probes, 1);
      assertEquals(processCalls, 1);
      assertEquals(phases[0].sourceRestriction, restricted ? "region_withheld" : undefined);
      if (restricted) {
        assertEquals(
          error.message,
          "X has withheld this post in the download server's region due to local law",
        );
        assertEquals(phases[0].stderrExcerpt, undefined);
      }
      assertEquals(await directoryNames(root), []);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("cancellation during X restriction diagnosis cannot become a source restriction", async () => {
  const root = await Deno.makeTempDir();
  const controller = new AbortController();
  const downloader = new YtDlpDownloader(
    downloaderOptions(root, 10, 20),
    () =>
      Promise.resolve({
        code: 1,
        stdout: new Uint8Array(),
        stderr: "ERROR: [twitter] 123: No video could be found in this tweet",
      }),
    undefined,
    undefined,
    () => {
      controller.abort();
      return Promise.resolve(true);
    },
  );
  try {
    const error = await assertRejects(
      () => downloader.download("https://x.com/i/status/123", controller.signal),
      DomainError,
    );
    assertEquals(error.code, "cancelled");
    assertEquals(await directoryNames(root), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("successful extraction and unrelated extractor errors never call the X restriction endpoint", async () => {
  const root = await Deno.makeTempDir();
  const probe = () => {
    throw new Error("Unexpected diagnostic request");
  };
  try {
    const success = new YtDlpDownloader(
      downloaderOptions(root, 10, 20),
      directRunner(1),
      undefined,
      undefined,
      probe,
    );
    await success.cleanup(await success.download("https://x.com/i/status/123"));
    for (
      const stderr of [
        "The read operation timed out",
        "NSFW tweet requires authentication",
        "Tweet is protected",
      ]
    ) {
      const downloader = new YtDlpDownloader(
        downloaderOptions(root, 10, 20),
        () => Promise.resolve({ code: 1, stdout: new Uint8Array(), stderr }),
        undefined,
        undefined,
        probe,
      );
      const error = await assertRejects(
        () => downloader.download("https://x.com/i/status/123"),
        DomainError,
      );
      assertEquals(error.code, "extractor_failure");
      assertEquals(error.retryable, true);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("metadata failures emit bounded redacted extractor diagnostics", async () => {
  const root = await Deno.makeTempDir();
  const phases: DownloadPhaseObservation[] = [];
  const downloader = new YtDlpDownloader(
    downloaderOptions(root, 10, 20),
    () =>
      Promise.resolve({
        code: 7,
        stdout: new Uint8Array(),
        stderr: `${
          "x".repeat(3_000)
        }\nERROR: unable to read https://x.com/user/status/123?token=secret\nAuthorization: Bearer auth-token\nCookie: session=secret-cookie`,
      }),
    undefined,
    (observation) => phases.push(observation),
  );
  try {
    const error = await assertRejects(
      () => downloader.download("https://x.com/user/status/123"),
      DomainError,
    );
    assertEquals(error.code, "extractor_failure");
    assertEquals(error.message, "The X extractor could not read this post");
    assertEquals(phases.length, 1);
    assertEquals(phases[0].errorCode, "extractor_failure");
    assertEquals(phases[0].failureKind, "process_exit");
    assertEquals(phases[0].processExitCode, 7);
    assertEquals(phases[0].retryKind, undefined);
    assertEquals((phases[0].stderrExcerpt?.length ?? 0) <= 2_048, true);
    assertMatch(phases[0].stderrExcerpt ?? "", /\[REDACTED_URL\]/);
    assertNotMatch(phases[0].stderrExcerpt ?? "", /x\.com|auth-token|secret-cookie/);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("X metadata read timeouts are classified for the short retry path", async () => {
  const root = await Deno.makeTempDir();
  const phases: DownloadPhaseObservation[] = [];
  const downloader = new YtDlpDownloader(
    downloaderOptions(root, 10, 20),
    () =>
      Promise.resolve({
        code: 1,
        stdout: new Uint8Array(),
        stderr:
          "ERROR: [twitter] 1000000000000000005: Unable to download JSON metadata: The read operation timed out (caused by TransportError('The read operation timed out'))",
      }),
    undefined,
    (observation) => phases.push(observation),
  );
  try {
    const error = await assertRejects(
      () => downloader.download("https://x.com/user/status/1000000000000000005"),
      DomainError,
    );
    assertEquals(error.code, "extractor_failure");
    assertEquals(error.details?.retryKind, "source_timeout");
    assertEquals(phases.length, 1);
    assertEquals(phases[0].retryKind, "source_timeout");
    assertEquals(phases[0].failureKind, "process_exit");
    assertEquals(phases[0].processExitCode, 1);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("multi-video X metadata downloads only the first status media entry", async () => {
  const root = await Deno.makeTempDir();
  let metadataArguments: readonly string[] = [];
  let loadedInfoJson: string | null = null;
  const phases: DownloadPhaseObservation[] = [];
  const runner: typeof runProcess = async (executable, args, options) => {
    if (executable === "yt-dlp" && args.includes("--dump-single-json")) {
      metadataArguments = args;
      return result(JSON.stringify({
        _type: "playlist",
        id: "1000000000000000003",
        extractor_key: "Twitter",
        webpage_url: "https://x.com/i/status/1000000000000000003",
        playlist_count: 2,
        entries: [
          {
            ...JSON.parse(directMetadata(1)),
            id: "1000000000000000004",
            duration: 67.986,
            formats: [{
              format_id: "first",
              ext: "mp4",
              vcodec: "h264",
              acodec: "aac",
              height: 720,
              filesize: 1,
            }],
          },
        ],
      }));
    }
    if (executable === "yt-dlp") {
      loadedInfoJson = new TextDecoder().decode(options.stdin);
      const output = args[args.indexOf("--output") + 1].replace("%(ext)s", "mp4");
      await Deno.writeFile(output, new Uint8Array([1]));
      return result("");
    }
    return result(JSON.stringify({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 720, height: 1280 },
        { codec_type: "audio", codec_name: "aac" },
      ],
      format: { duration: "67.986", format_name: "mp4" },
    }));
  };
  const downloader = new YtDlpDownloader(
    { ...downloaderOptions(root, 10, 20), maximumDurationSeconds: 120 },
    runner,
    undefined,
    (observation) => phases.push(observation),
  );
  try {
    const artifact = await downloader.download(
      "https://x.com/i/status/1000000000000000003",
    );
    const loadedInfo = JSON.parse(loadedInfoJson ?? "{}") as Record<string, unknown>;
    assertEquals(artifact.selection.selector, "first");
    assertEquals(loadedInfo.id, "1000000000000000004");
    assertEquals("entries" in loadedInfo, false);
    assertEquals(phases[0].sourceMediaCount, 2);
    assertEquals(phases[0].selectedMediaIndex, 1);
    assertEquals(
      metadataArguments.slice(
        metadataArguments.indexOf("--playlist-items"),
        metadataArguments.indexOf("--playlist-items") + 2,
      ),
      ["--playlist-items", "1"],
    );
    await downloader.cleanup(artifact);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("invalid extractor metadata logs a safe validation issue", async () => {
  const root = await Deno.makeTempDir();
  const phases: DownloadPhaseObservation[] = [];
  const downloader = new YtDlpDownloader(
    downloaderOptions(root, 10, 20),
    () =>
      result(JSON.stringify({
        id: "1000000000000000003",
        extractor_key: "Twitter",
        webpage_url: "https://x.com/i/status/1000000000000000003",
        duration: null,
        formats: [],
      })),
    undefined,
    (observation) => phases.push(observation),
  );
  try {
    const error = await assertRejects(
      () => downloader.download("https://x.com/i/status/1000000000000000003"),
      DomainError,
    );
    assertEquals(error.code, "extractor_failure");
    assertEquals(phases[0].failureKind, "invalid_output");
    assertEquals(phases[0].processExitCode, 0);
    assertMatch(phases[0].metadataValidationIssue ?? "", /formats/);
    assertNotMatch(phases[0].metadataValidationIssue ?? "", /https?:\/\//);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("downloader accepts exact limits and removes oversized or over-budget output", async () => {
  for (
    const testCase of [
      { name: "exact", outputBytes: 6, maximumBytes: 6, temporaryBytes: 6, code: null },
      {
        name: "artifact-oversize",
        outputBytes: 7,
        maximumBytes: 6,
        temporaryBytes: 20,
        code: "no_format_within_limit",
      },
      {
        name: "temporary-oversize",
        outputBytes: 7,
        maximumBytes: 10,
        temporaryBytes: 6,
        code: "temp_storage_limit",
      },
    ] as const
  ) {
    const root = await Deno.makeTempDir();
    const downloader = new YtDlpDownloader(
      downloaderOptions(root, testCase.maximumBytes, testCase.temporaryBytes),
      directRunner(testCase.outputBytes),
    );
    try {
      if (!testCase.code) {
        const artifact = await downloader.download("https://x.com/i/status/1");
        assertEquals(artifact.byteSize, testCase.outputBytes, testCase.name);
        await downloader.cleanup(artifact);
      } else {
        const error = await assertRejects(
          () => downloader.download("https://x.com/i/status/1"),
          DomainError,
        );
        assertEquals(error.code, testCase.code, testCase.name);
      }
      assertEquals(await directoryNames(root), [], testCase.name);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    }
  }
});

for (const code of ["cancelled", "timeout"] as const) {
  Deno.test(`downloader removes partial files after ${code}`, async () => {
    const root = await Deno.makeTempDir();
    const runner: typeof runProcess = async (executable, args) => {
      if (executable === "yt-dlp" && args.includes("--dump-single-json")) {
        return result(directMetadata(1));
      }
      const output = args[args.indexOf("--output") + 1].replace("%(ext)s", "mp4.part");
      await Deno.writeFile(output, new Uint8Array([1, 2, 3]));
      throw new DomainError(code, `safe ${code}`, code === "timeout");
    };
    const downloader = new YtDlpDownloader(downloaderOptions(root, 10, 20), runner);
    try {
      const error = await assertRejects(
        () => downloader.download("https://x.com/i/status/1"),
        DomainError,
      );
      assertEquals(error.code, code);
      assertEquals(await directoryNames(root), []);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    }
  });
}

Deno.test("attempt-specific ownership preserves overlap and later removes only stale work", async () => {
  const root = await Deno.makeTempDir();
  let started = 0;
  let releaseDownloads = () => {};
  let reportBothStarted = () => {};
  const downloadsReleased = new Promise<void>((resolve) => releaseDownloads = resolve);
  const bothStarted = new Promise<void>((resolve) => reportBothStarted = resolve);
  const runner: typeof runProcess = async (executable, args) => {
    if (executable === "yt-dlp" && args.includes("--dump-single-json")) {
      return result(directMetadata(3));
    }
    if (executable === "yt-dlp") {
      const output = args[args.indexOf("--output") + 1].replace("%(ext)s", "mp4");
      await Deno.writeFile(output, new Uint8Array([1, 2, 3]));
      started++;
      if (started === 2) reportBothStarted();
      await downloadsReleased;
      return result("");
    }
    return result(validProbe());
  };
  const downloader = new YtDlpDownloader(downloaderOptions(root, 10, 20), runner);
  const jobId = crypto.randomUUID();
  const firstAttempt = crypto.randomUUID();
  const secondAttempt = crypto.randomUUID();
  try {
    const firstTask = downloader.download("https://x.com/i/status/1", undefined, {
      jobId,
      ownerId: `worker:${firstAttempt}`,
      attemptId: firstAttempt,
    });
    const secondTask = downloader.download("https://x.com/i/status/1", undefined, {
      jobId,
      ownerId: `worker:${secondAttempt}`,
      attemptId: secondAttempt,
    });
    await bothStarted;
    assertEquals((await directoryNames(root)).length, 2);
    releaseDownloads();
    const [first, second] = await Promise.all([firstTask, secondTask]);
    assertEquals(first.temporaryAttemptId, firstAttempt);
    assertEquals(second.temporaryAttemptId, secondAttempt);

    const mismatched = { ...first, temporaryAttemptId: secondAttempt };
    const heartbeatRefused = await assertRejects(
      () => downloader.heartbeat(mismatched),
      DomainError,
    );
    assertEquals(heartbeatRefused.code, "cleanup_failure");
    const refused = await assertRejects(() => downloader.cleanup(mismatched), DomainError);
    assertEquals(refused.code, "cleanup_failure");
    assertEquals((await directoryNames(root)).length, 2);

    const recentPass = await cleanupAbandonedTemporaryDirectories(root, {
      isLeaseActive: () => false,
      staleAfterMs: 1_000,
      now: new Date(),
    });
    assertEquals(recentPass, 0);

    const old = new Date(Date.now() - 2_000);
    for (const directory of await directoryNames(root)) {
      await Deno.utime(`${root}/${directory}/.video-downloader-job.json`, old, old);
    }
    const removed = await cleanupAbandonedTemporaryDirectories(root, {
      isLeaseActive: (marker) => marker.ownerId === `worker:${firstAttempt}`,
      staleAfterMs: 1_000,
      now: new Date(),
    });
    assertEquals(removed, 1);
    await Deno.stat(first.path);
    await assertRejects(() => Deno.stat(second.path), Deno.errors.NotFound);
    await downloader.cleanup(first);
    assertEquals(await directoryNames(root), []);
  } finally {
    releaseDownloads();
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("failed attempt-marker creation removes the unmarked directory", async () => {
  const root = await Deno.makeTempDir();
  const downloader = new YtDlpDownloader(
    downloaderOptions(root, 10, 20),
    directRunner(1),
    () => Promise.reject(new Error("marker unavailable")),
  );
  try {
    await assertRejects(() => downloader.download("https://x.com/i/status/1"), Error);
    assertEquals(await directoryNames(root), []);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

function downloaderOptions(root: string, maximumBytes: number, maximumTemporaryBytes: number) {
  return {
    ytDlpPath: "yt-dlp",
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    temporaryRoot: root,
    timeoutSeconds: 60,
    maximumDurationSeconds: 60,
    maximumHeight: 1080,
    maximumBytes,
    safetyBytes: 0,
    maximumTemporaryBytes,
  };
}

function directRunner(outputBytes: number): typeof runProcess {
  return async (executable, args) => {
    if (executable === "yt-dlp" && args.includes("--dump-single-json")) {
      return result(directMetadata(Math.min(outputBytes, 1)));
    }
    if (executable === "yt-dlp") {
      const output = args[args.indexOf("--output") + 1].replace("%(ext)s", "mp4");
      await Deno.writeFile(output, new Uint8Array(outputBytes).fill(1));
      return result("");
    }
    return result(validProbe());
  };
}

function directMetadata(reportedBytes: number): string {
  return JSON.stringify({
    id: "1000000000000000002",
    extractor_key: "Twitter",
    webpage_url: "https://x.com/i/status/1000000000000000001",
    duration: 1,
    formats: [{
      format_id: "direct",
      ext: "mp4",
      vcodec: "h264",
      acodec: "aac",
      height: 16,
      filesize: reportedBytes,
    }],
  });
}

function validProbe(): string {
  return JSON.stringify({
    streams: [
      { codec_type: "video", codec_name: "h264", width: 16, height: 16 },
      { codec_type: "audio", codec_name: "aac" },
    ],
    format: { duration: "1", format_name: "mp4" },
  });
}

async function directoryNames(root: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(root)) names.push(entry.name);
  return names.sort();
}
