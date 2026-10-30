import { assert, assertEquals, assertMatch, assertNotMatch } from "@std/assert";

const telegramApplicationCredentials = /\bTELEGRAM_API_(?:ID|HASH)\b/;

Deno.test("Dokploy Compose is a complete private production topology", async () => {
  const compose = await Deno.readTextFile(
    new URL("../../compose.dokploy.yaml", import.meta.url),
  );
  assertEquals(serviceNames(compose), [
    "postgres",
    "rabbitmq",
    "rustfs",
    "loki",
    "prometheus",
    "rustfs-init",
    "migrate",
    "api",
    "worker",
    "maintenance",
    "telegram-bot-api",
    "telegram-bridge",
  ]);
  assertNotMatch(compose, /(?:^|\n)\s+ports:/);
  assertNotMatch(compose, /\bcontainer_name:/);
  assertEquals([...compose.matchAll(/profiles: \["([a-z0-9-]+)"\]/g)], []);
  assertNotMatch(compose, /\benv_file:/);
  assertNotMatch(compose, /(?:^|\s)- dokploy-network|dokploy-network:|(?:^|\n)\s+labels:/i);
  assertNotMatch(compose, /(?:^|\s)\.\.?\//m);

  assertMatch(networkBlock(compose, "backend"), /internal: true/);
  assertMatch(networkBlock(compose, "observability"), /internal: true/);
  assertNotMatch(networkBlock(compose, "worker-egress"), /internal: true/);
  assertNotMatch(networkBlock(compose, "telegram-egress"), /internal: true/);

  assertServiceNetworks(compose, "postgres", ["backend"]);
  assertServiceNetworks(compose, "rabbitmq", ["backend"]);
  assertMatch(
    serviceBlock(compose, "rabbitmq"),
    /test: \["CMD", "rabbitmq-diagnostics", "-q", "-t", "10", "ping"\][\s\S]*interval: 30s[\s\S]*timeout: 15s/,
  );
  assertMatch(serviceBlock(compose, "rabbitmq"), /RABBITMQ_CTL_ERL_ARGS: "\+S 1:1"/);
  assertServiceNetworks(compose, "rustfs", ["backend"]);
  assertServiceNetworks(compose, "api", ["backend", "observability"]);
  assertServiceNetworks(compose, "worker", ["backend", "observability", "worker-egress"]);
  assertServiceNetworks(compose, "telegram-bot-api", ["telegram-egress"]);
  assertServiceNetworks(compose, "telegram-bridge", [
    "backend",
    "observability",
    "telegram-egress",
  ]);
  const worker = serviceBlock(compose, "worker");
  assertMatch(worker, /worker-temp:\/var\/tmp\/video-downloader/);
  assertMatch(worker, /DOWNLOAD_MAX_TEMP_BYTES: "\$\{DOWNLOAD_MAX_TEMP_BYTES:-3982000000\}"/);
  assertMatch(worker, /MAX_ARTIFACT_BYTES: "\$\{MAX_ARTIFACT_BYTES:-1990000000\}"/);
  assertMatch(worker, /TELEGRAM_MAX_UPLOAD_BYTES: "\$\{TELEGRAM_MAX_UPLOAD_BYTES:-1990000000\}"/);
  assertMatch(
    worker,
    /WORKER_SOURCE_TIMEOUT_RETRY_DELAY_SECONDS: "\$\{WORKER_SOURCE_TIMEOUT_RETRY_DELAY_SECONDS:-5\}"/,
  );
  assertMatch(worker, /WORKER_RETRY_DELAY_SECONDS: "\$\{WORKER_RETRY_DELAY_SECONDS:-30\}"/);
  assertMatch(worker, /DOWNLOADER_MODE: live/);

  assertEquals(declaredVolumes(compose), [
    "loki-data",
    "postgres-data",
    "prometheus-data",
    "rabbitmq-data",
    "rustfs-data",
    "telegram-bot-api-data",
    "worker-temp",
  ]);
});

Deno.test("Dokploy Compose preserves credential ownership and cutover safety", async () => {
  const compose = await Deno.readTextFile(
    new URL("../../compose.dokploy.yaml", import.meta.url),
  );
  const botApi = serviceBlock(compose, "telegram-bot-api");
  const bridge = serviceBlock(compose, "telegram-bridge");

  assertMatch(botApi, /TELEGRAM_API_ID: \$\{TELEGRAM_API_ID:\?/);
  assertMatch(botApi, /TELEGRAM_API_HASH: \$\{TELEGRAM_API_HASH:\?/);
  assertNotMatch(botApi, /\bTELEGRAM_BOT_TOKEN\b/);
  assertMatch(bridge, /TELEGRAM_BOT_TOKEN: \$\{TELEGRAM_BOT_TOKEN:\?/);
  assertNotMatch(bridge, telegramApplicationCredentials);
  assertMatch(bridge, /TELEGRAM_BOT_API_ROOT: http:\/\/telegram-bot-api:8081/);
  assertMatch(bridge, /TELEGRAM_DELIVERY_POLL_INTERVAL_MS: "250"/);
  assertNotMatch(
    bridge,
    /TELEGRAM_DELIVERY_POLL_INTERVAL_MS: "\$\{TELEGRAM_DELIVERY_POLL_INTERVAL_MS:/,
  );
  assertMatch(bridge, /replicas: \$\{TELEGRAM_BRIDGE_REPLICAS:-0\}/);
  assertMatch(
    bridge,
    /api:\s+condition: service_healthy[\s\S]*worker:\s+condition: service_healthy[\s\S]*maintenance:\s+condition: service_healthy[\s\S]*telegram-bot-api:\s+condition: service_healthy/,
  );

  for (const service of serviceNames(compose)) {
    const block = serviceBlock(compose, service);
    if (service !== "telegram-bot-api") assertNotMatch(block, telegramApplicationCredentials);
    if (service !== "telegram-bridge") {
      assertNotMatch(block, /\bTELEGRAM_BOT_TOKEN\b/);
    }
  }

  assertNotMatch(compose, /:-local-|replace-me|fixture/i);
  for (
    const secret of [
      "INTERNAL_API_TOKEN",
      "POSTGRES_PASSWORD",
      "RABBITMQ_PASSWORD",
      "RUSTFS_ACCESS_KEY",
      "RUSTFS_SECRET_KEY",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_ADMIN_USER_IDS",
      "TELEGRAM_API_ID",
      "TELEGRAM_API_HASH",
    ]
  ) {
    assertMatch(compose, new RegExp(`\\$\\{${secret}:\\?`));
  }
});

Deno.test("Dokploy runtime hardening and observability configuration are deployable", async () => {
  const [compose, dockerfile, loki] = await Promise.all([
    Deno.readTextFile(new URL("../../compose.dokploy.yaml", import.meta.url)),
    Deno.readTextFile(new URL("../../Dockerfile.observability", import.meta.url)),
    Deno.readTextFile(new URL("../../tools/observability/loki-config.yaml", import.meta.url)),
  ]);

  const appCommon = extensionBlock(compose, "x-app-common");
  assertMatch(appCommon, /init: true/);
  assertMatch(appCommon, /read_only: true/);
  assertMatch(appCommon, /user: "10001:10001"/);
  assertMatch(appCommon, /no-new-privileges:true/);
  assertMatch(appCommon, /cap_drop:\s+- ALL/);
  assertMatch(appCommon, /stop_grace_period: 1m/);

  for (
    const service of serviceNames(compose).filter((name) =>
      name !== "migrate" && name !== "rustfs-init"
    )
  ) {
    const block = serviceBlock(compose, service);
    assertMatch(block, /healthcheck:/);
    assertMatch(
      block,
      /resources:\s+limits: \{ cpus: "[0-9.]+", memory: [0-9]+[MG], pids: (?:128|256) \}/,
    );
  }

  for (const service of ["rustfs", "loki", "prometheus", "telegram-bot-api"]) {
    const block = serviceBlock(compose, service);
    assertMatch(block, /read_only: true/);
    assertMatch(block, /no-new-privileges:true/);
    assertMatch(block, /cap_drop:\s+- ALL/);
  }
  assertMatch(
    serviceBlock(compose, "rustfs"),
    /\/logs:size=64m,uid=10001,gid=10001,mode=0700/,
  );

  assertMatch(serviceBlock(compose, "migrate"), /restart: "no"/);
  assertMatch(serviceBlock(compose, "rustfs-init"), /restart: "no"/);
  assertMatch(serviceBlock(compose, "worker"), /stop_grace_period: 2m/);
  assertMatch(serviceBlock(compose, "telegram-bridge"), /stop_grace_period: 2m/);
  assertMatch(dockerfile, /FROM grafana\/loki:3\.7\.6 AS loki/);
  assertMatch(dockerfile, /FROM prom\/prometheus:v3\.13\.2 AS prometheus/);
  assertMatch(dockerfile, /COPY --chown=10001:10001 tools\/observability\/loki-config\.yaml/);
  assertMatch(
    dockerfile,
    /COPY --chown=65534:65534 tools\/observability\/prometheus\.yaml/,
  );
  assertNotMatch(serviceBlock(compose, "loki"), /tools\/observability|\.\/|\.\.\//);
  assertNotMatch(serviceBlock(compose, "prometheus"), /tools\/observability|\.\/|\.\.\//);
  assertMatch(loki, /retention_enabled:\s+true/);
  assertMatch(loki, /retention_period:\s+168h/);
  assertMatch(loki, /max_query_lookback:\s+168h/);
});

Deno.test("Dokploy acceptance Compose is isolated, hardened, and disposable", async () => {
  const compose = await Deno.readTextFile(
    new URL("../../compose.acceptance.dokploy.yaml", import.meta.url),
  );

  assertEquals(serviceNames(compose), ["large-file-acceptance"]);
  assertNotMatch(compose, /(?:^|\n)\s+(?:ports|expose|profiles|container_name|env_file|labels):/);
  assertNotMatch(
    compose,
    /dokploy-network|TELEGRAM_MODE|deno task telegram|\bTELEGRAM_API_(?:ID|HASH)\b/i,
  );

  const acceptance = serviceBlock(compose, "large-file-acceptance");
  assertMatch(acceptance, /target: worker/);
  assertMatch(acceptance, /init: true/);
  assertMatch(acceptance, /restart: "no"/);
  assertMatch(acceptance, /read_only: true/);
  assertMatch(acceptance, /user: "10001:10001"/);
  assertMatch(acceptance, /no-new-privileges:true/);
  assertMatch(acceptance, /cap_drop:\s+- ALL/);
  assertMatch(acceptance, /RUN_LARGE_FILE_ACCEPTANCE: "1"/);
  assertMatch(
    acceptance,
    /LARGE_FILE_ACCEPTANCE_CHAT_ID: \$\{TELEGRAM_ADMIN_USER_IDS:\?set TELEGRAM_ADMIN_USER_IDS in Dokploy\}/,
  );
  assertMatch(acceptance, /TELEGRAM_BOT_API_ROOT: http:\/\/telegram-bot-api:8081/);
  assertMatch(acceptance, /acceptance-scratch:\/var\/tmp\/video-downloader/);
  assertMatch(acceptance, /tools\/run_large_file_acceptance\.ts/);
  assertMatch(acceptance, /networks:\s+- production-telegram-egress/);
  assertMatch(acceptance, /resources:\s+limits: \{ cpus: "1\.5", memory: 1G, pids: 256 \}/);

  for (
    const name of [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_ADMIN_USER_IDS",
      "TELEGRAM_MAX_UPLOAD_BYTES",
      "MAX_ARTIFACT_BYTES",
      "DOWNLOAD_FORMAT_SAFETY_BYTES",
      "DOWNLOAD_MAX_TEMP_BYTES",
    ]
  ) {
    assertMatch(compose, new RegExp(`\\$\\{${name}:\\?`));
  }

  const network = networkBlock(compose, "production-telegram-egress");
  assertMatch(network, /external: true/);
  assertMatch(network, /name: \$\{PRODUCTION_TELEGRAM_EGRESS_NETWORK:\?/);
  assertEquals(declaredVolumes(compose), ["acceptance-scratch"]);
});

Deno.test("Dokploy large-file acceptance runner is sequential, bounded, and sanitized", async () => {
  const runner = await Deno.readTextFile(
    new URL("../../tools/run_large_file_acceptance.ts", import.meta.url),
  );

  assertMatch(
    runner,
    /const SCRATCH_ROOT = "\/var\/tmp\/video-downloader\/large-file-acceptance";/,
  );
  assertMatch(runner, /const ACCEPTANCE_CASES = \["above-hosted", "boundary"\] as const;/);
  assertMatch(runner, /TELEGRAM_MAX_UPLOAD_BYTES: "1990000000"/);
  assertMatch(runner, /DOWNLOAD_MAX_TEMP_BYTES: "3982000000"/);
  assertMatch(runner, /const reviewedLimits = requiredReviewedLimits\(\);/);
  assertMatch(runner, /clearEnv: true/);
  assertMatch(runner, /stdout: "piped"/);
  assertMatch(runner, /stderr: "piped"/);
  assertMatch(runner, /artifactCleanup = await removeScratch\(\);/);
  assertMatch(
    runner,
    /if \(failed \|\| !evidence \|\| telegramCleanup !== true \|\| !artifactCleanup\)/,
  );
  assertNotMatch(runner, /console\.(?:log|error)\([^\n]*error/i);
});

function serviceNames(source: string): string[] {
  const services = topLevelSection(source, "services");
  return [...services.matchAll(/^[ ]{2}([a-z0-9][a-z0-9-]*):$/gm)].map((match) => match[1]);
}

function serviceBlock(source: string, name: string): string {
  const services = topLevelSection(source, "services");
  const marker = `  ${name}:\n`;
  const start = services.indexOf(marker);
  if (start < 0) throw new Error(`Compose service not found: ${name}`);
  const remainder = services.slice(start + marker.length);
  const next = remainder.search(/\n[ ]{2}[a-z0-9][a-z0-9-]*:\n/);
  return next < 0 ? remainder : remainder.slice(0, next);
}

function extensionBlock(source: string, name: string): string {
  const normalized = source.replaceAll("\r\n", "\n");
  const marker = `${name}:`;
  const start = normalized.indexOf(marker);
  if (start < 0) throw new Error(`Compose extension not found: ${name}`);
  const remainder = normalized.slice(start + marker.length);
  const next = remainder.search(/\n(?:x-[a-z0-9-]+|services):/);
  return next < 0 ? remainder : remainder.slice(0, next);
}

function networkBlock(source: string, name: string): string {
  const networks = topLevelSection(source, "networks");
  const marker = `  ${name}:\n`;
  const start = networks.indexOf(marker);
  if (start < 0) throw new Error(`Compose network not found: ${name}`);
  const remainder = networks.slice(start + marker.length);
  const next = remainder.search(/\n[ ]{2}[a-z0-9][a-z0-9-]*:\n/);
  return next < 0 ? remainder : remainder.slice(0, next);
}

function assertServiceNetworks(source: string, service: string, expected: string[]): void {
  const block = serviceBlock(source, service);
  const networks = block.match(
    /\n[ ]{4}networks:\n((?:[ ]{6}- [a-z0-9-]+\n)+)/,
  )?.[1];
  assert(networks !== undefined, `No network list found for ${service}`);
  const actual = [...networks.matchAll(/- ([a-z0-9-]+)/g)].map((match) => match[1]);
  assertEquals(actual, expected);
}

function declaredVolumes(source: string): string[] {
  const volumes = topLevelSection(source, "volumes");
  return [...volumes.matchAll(/^[ ]{2}([a-z0-9][a-z0-9-]*):$/gm)]
    .map((match) => match[1])
    .sort();
}

function topLevelSection(source: string, name: string): string {
  const normalized = source.replaceAll("\r\n", "\n");
  const marker = new RegExp(`^${name}:\\n`, "m").exec(normalized);
  if (marker?.index === undefined) throw new Error(`Compose section not found: ${name}`);
  const remainder = normalized.slice(marker.index + marker[0].length);
  const next = remainder.search(/\n[a-z][a-z0-9-]*:\n/);
  return next < 0 ? remainder : remainder.slice(0, next);
}
