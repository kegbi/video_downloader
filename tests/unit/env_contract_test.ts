import { assertEquals } from "@std/assert";

const composeOnlyVariables = new Set([
  "APP_TIMEZONE",
  "LOKI_PORT",
  "PROMETHEUS_PORT",
  "RABBITMQ_MANAGEMENT_PORT",
  "RUSTFS_ACCESS_KEY",
  "RUSTFS_CONSOLE_ENABLE",
  "RUSTFS_PORT",
  "RUSTFS_SECRET_KEY",
  "TELEGRAM_API_HASH",
  "TELEGRAM_API_ID",
  "TELEGRAM_BRIDGE_REPLICAS",
]);

Deno.test("deployment template and Compose environments stay in lockstep", async () => {
  const [example, compose, localCompose, dokployCompose, configSource] = await Promise.all([
    Deno.readTextFile(new URL("../../.env.example", import.meta.url)),
    Deno.readTextFile(new URL("../../compose.yaml", import.meta.url)),
    Deno.readTextFile(new URL("../../compose.telegram-local.yaml", import.meta.url)),
    Deno.readTextFile(new URL("../../compose.dokploy.yaml", import.meta.url)),
    Deno.readTextFile(new URL("../../packages/config/mod.ts", import.meta.url)),
  ]);

  const exampleKeys = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
  const composeKeys = [compose, localCompose, dokployCompose].flatMap((source) =>
    [...source.matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)(?=[:}])/g)].map((match) => match[1])
  );

  assertEquals(duplicates(exampleKeys), []);
  assertEquals(uniqueSorted(exampleKeys), uniqueSorted(composeKeys));

  const schemaBody = configSource.match(/const environmentSchema = z\.object\(\{([\s\S]*?)\n\}\);/)
    ?.[1];
  if (!schemaBody) throw new Error("Unable to locate the application environment schema");
  const schemaKeys = [...schemaBody.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map(
    (match) => match[1],
  );
  const applicationKeys = exampleKeys.filter((key) => !composeOnlyVariables.has(key));

  assertEquals(uniqueSorted(schemaKeys), uniqueSorted(applicationKeys));
  assertEquals(example.match(/^TELEGRAM_API_ID=(.*)$/m)?.[1], "");
  assertEquals(example.match(/^TELEGRAM_API_HASH=(.*)$/m)?.[1], "");
});

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function duplicates(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) !== index).sort();
}
