import { dirname, fromFileUrl, join } from "@std/path";

const dependencies = [
  { specifier: "@aws-sdk/client-s3", name: "@aws-sdk/client-s3", allowed: ["Apache-2.0"] },
  { specifier: "@aws-sdk/lib-storage", name: "@aws-sdk/lib-storage", allowed: ["Apache-2.0"] },
  {
    specifier: "@cloudamqp/amqp-client",
    name: "@cloudamqp/amqp-client",
    allowed: ["Apache-2.0"],
  },
  { specifier: "@hono/zod-openapi", name: "@hono/zod-openapi", allowed: ["MIT"] },
  {
    specifier: "npm:drizzle-kit@0.31.10",
    name: "drizzle-kit",
    allowed: ["MIT"],
    packageJson: new URL(
      "../node_modules/.deno/drizzle-kit@0.31.10/node_modules/drizzle-kit/package.json",
      import.meta.url,
    ),
  },
  { specifier: "drizzle-orm", name: "drizzle-orm", allowed: ["Apache-2.0"] },
  { specifier: "grammy", name: "grammy", allowed: ["MIT"] },
  { specifier: "hono", name: "hono", allowed: ["MIT"] },
  { specifier: "postgres", name: "postgres", allowed: ["Unlicense"] },
  { specifier: "zod", name: "zod", allowed: ["MIT"] },
] as const;

const inventory: Array<{ name: string; version: string; license: string }> = [];
for (const dependency of dependencies) {
  if ("packageJson" in dependency) {
    const packageData = JSON.parse(await Deno.readTextFile(dependency.packageJson));
    verifyAndRecord(dependency, packageData);
    continue;
  }
  let directory = dirname(fromFileUrl(import.meta.resolve(dependency.specifier)));
  let packageData: { name?: string; version?: string; license?: string } | null = null;
  for (let depth = 0; depth < 10; depth++) {
    try {
      const value = JSON.parse(await Deno.readTextFile(join(directory, "package.json")));
      if (value.name === dependency.name) {
        packageData = value;
        break;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    directory = dirname(directory);
  }
  verifyAndRecord(dependency, packageData);
}
console.log(JSON.stringify({ approved: true, dependencies: inventory }));

function verifyAndRecord(
  dependency: (typeof dependencies)[number],
  packageData: { name?: string; version?: string; license?: string } | null,
): void {
  if (!packageData?.version || !packageData.license) {
    throw new Error(`Could not determine license metadata for ${dependency.name}`);
  }
  if (!(dependency.allowed as readonly string[]).includes(packageData.license)) {
    throw new Error(`${dependency.name} has unapproved license ${packageData.license}`);
  }
  inventory.push({
    name: dependency.name,
    version: packageData.version,
    license: packageData.license,
  });
}
