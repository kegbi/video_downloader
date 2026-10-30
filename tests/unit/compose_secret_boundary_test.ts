import { assert, assertEquals, assertMatch, assertNotMatch } from "@std/assert";

const apiCredentialNames = /\bTELEGRAM_API_(?:ID|HASH)\b/;

Deno.test("local Bot API topology is private, persistent, and least-privileged", async () => {
  const [base, local, dockerfile] = await Promise.all([
    Deno.readTextFile(new URL("../../compose.yaml", import.meta.url)),
    Deno.readTextFile(new URL("../../compose.telegram-local.yaml", import.meta.url)),
    Deno.readTextFile(new URL("../../Dockerfile.telegram-bot-api", import.meta.url)),
  ]);
  const botApi = serviceBlock(local, "telegram-bot-api");
  const bridgeOverride = serviceBlock(local, "telegram-bridge");

  assertEquals(serviceNames(local), ["telegram-bot-api", "telegram-bridge"]);
  assertMatch(botApi, /profiles: \["telegram-local"\]/);
  assertMatch(botApi, /dockerfile: Dockerfile\.telegram-bot-api/);
  assertMatch(botApi, /(?:^|\s)--local(?:\s|$)/);
  assertMatch(botApi, /telegram-bot-api-data:\/var\/lib\/telegram-bot-api/);
  assertMatch(botApi, /healthcheck:/);
  assertMatch(botApi, /stop_signal: SIGTERM/);
  assertMatch(botApi, /stop_grace_period: 1m/);
  assertMatch(botApi, /user: "10001:10001"/);
  assertMatch(botApi, /read_only: true/);
  assertMatch(botApi, /no-new-privileges:true/);
  assertMatch(botApi, /cap_drop:\s+- ALL/);
  assertMatch(botApi, /limits: \{ cpus: "1\.0", memory: 1G, pids: 256 \}/);
  assertMatch(botApi, /networks:\s+- telegram-bot-api/);
  assertNotMatch(botApi, /(?:^|\n)\s+ports:/);
  assertNotMatch(botApi, /traefik|public|domain/i);

  assertMatch(bridgeOverride, /TELEGRAM_BOT_API_ROOT: http:\/\/telegram-bot-api:8081/);
  assertMatch(bridgeOverride, /telegram-bot-api:\s+condition: service_healthy/);
  assertNotMatch(local, /profiles: \["test"\]/);

  assertMatch(
    dockerfile,
    /FROM alpine:3\.22\.1@sha256:[a-f0-9]{64} AS builder/,
  );
  assertMatch(
    dockerfile,
    /git fetch --depth=1 origin adfd7f6a8e990272851777eeb3ae0def4216f161/,
  );
  assertMatch(
    dockerfile,
    /test "\$\(git -C td rev-parse HEAD\)" = "a9966eb3704a3351568c28013fed67d797c17828"/,
  );
  assertMatch(dockerfile, /USER 10001:10001/);
  assertNotMatch(dockerfile, /^FROM (?!alpine:3\.22\.1@sha256:)/m);

  // The base deployment has no knowledge of these credentials. In the opt-in override they are
  // scoped to the official server and are required rather than defaulted.
  assertNotMatch(base, apiCredentialNames);
  assertMatch(botApi, /TELEGRAM_API_ID: \$\{TELEGRAM_API_ID:\?/);
  assertMatch(botApi, /TELEGRAM_API_HASH: \$\{TELEGRAM_API_HASH:\?/);
  assertNotMatch(bridgeOverride, apiCredentialNames);
});

Deno.test("Telegram credential environment variables stay within their owning services", async () => {
  const [base, local] = await Promise.all([
    Deno.readTextFile(new URL("../../compose.yaml", import.meta.url)),
    Deno.readTextFile(new URL("../../compose.telegram-local.yaml", import.meta.url)),
  ]);
  const botApi = serviceBlock(local, "telegram-bot-api");
  const bridge = [
    serviceBlock(base, "telegram-bridge"),
    serviceBlock(local, "telegram-bridge"),
  ].join("\n");

  // This checks Compose environment/config ownership. At runtime the local server necessarily
  // receives the BotFather token in request URLs sent by the bridge.
  assertMatch(botApi, apiCredentialNames);
  assertNotMatch(botApi, /\bTELEGRAM_BOT_TOKEN\b/);
  assertMatch(bridge, /\bTELEGRAM_BOT_TOKEN\b/);
  assertNotMatch(bridge, apiCredentialNames);

  for (
    const service of [
      "api",
      "worker",
      "maintenance",
      "migrate",
      "rustfs-init",
      "rabbitmq",
      "postgres",
      "rustfs",
      "loki",
      "prometheus",
    ]
  ) {
    const definitions = [
      serviceBlock(base, service),
      serviceBlock(local, service, false),
    ].join("\n");
    assertNotMatch(definitions, apiCredentialNames);
    assertNotMatch(definitions, /\bTELEGRAM_BOT_TOKEN\b/);
  }
});

Deno.test("worker media temporary storage is disk-backed and independent of memory limits", async () => {
  const compose = await Deno.readTextFile(new URL("../../compose.yaml", import.meta.url));
  const worker = serviceBlock(compose, "worker");
  assertMatch(worker, /worker-temp:\/var\/tmp\/video-downloader/);
  assertMatch(worker, /DOWNLOAD_MAX_TEMP_BYTES:/);
  assertMatch(worker, /MAX_ARTIFACT_BYTES:/);
  assertNotMatch(worker, /tmpfs:[\s\S]*video-downloader/);
  assertMatch(compose, /^\s{2}worker-temp:$/m);
  assertMatch(worker, /memory: 768M/);
});

function serviceNames(source: string): string[] {
  const normalized = source.replaceAll("\r\n", "\n");
  const services = normalized.match(
    /^services:\n([\s\S]*?)(?=^[a-z][a-z-]*:\n|(?![\s\S]))/m,
  )?.[1];
  if (services === undefined) throw new Error("Compose services section not found");
  return [...services.matchAll(/^[ ]{2}([a-z0-9][a-z0-9-]*):$/gm)].map((match) => match[1]);
}

function serviceBlock(source: string, name: string, required = true): string {
  const normalized = source.replaceAll("\r\n", "\n");
  const marker = `  ${name}:\n`;
  const start = normalized.indexOf(marker);
  if (start < 0) {
    if (required) throw new Error(`Compose service not found: ${name}`);
    return "";
  }
  const bodyStart = start + marker.length;
  const remainder = normalized.slice(bodyStart);
  const next = remainder.search(
    /\n[ ]{2}[a-z0-9][a-z0-9-]*:\n|\n(?:networks|volumes):\n/,
  );
  assert(next !== 0);
  return next < 0 ? remainder : remainder.slice(0, next);
}
