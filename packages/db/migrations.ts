import type { Database } from "./client.ts";

export async function runMigrations(
  sql: Database,
  directoryOrDirectories: string | URL | readonly (string | URL)[],
): Promise<readonly string[]> {
  const directories = Array.isArray(directoryOrDirectories)
    ? directoryOrDirectories
    : [directoryOrDirectories as string | URL];
  const migrations: Array<{ name: string; url: URL }> = [];
  const names = new Set<string>();
  for (const directory of directories) {
    const files: string[] = [];
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isFile && /^\d+_[a-z0-9_]+\.sql$/.test(entry.name)) files.push(entry.name);
    }
    files.sort();
    const base = toDirectoryUrl(directory);
    for (const name of files) {
      if (names.has(name)) throw new Error(`Duplicate migration filename: ${name}`);
      names.add(name);
      migrations.push({ name, url: new URL(name, base) });
    }
  }
  const applied: string[] = [];

  await sql`SELECT pg_advisory_lock(hashtext('video_downloader_migrations'))`;
  try {
    await sql.unsafe(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const migration of migrations) {
      const existing = await sql<
        { version: string }[]
      >`SELECT version FROM schema_migrations WHERE version = ${migration.name}`;
      if (existing.length > 0) continue;
      const contents = await Deno.readTextFile(migration.url);
      await sql.begin(async (transaction) => {
        await transaction.unsafe(contents);
        await transaction`INSERT INTO schema_migrations (version) VALUES (${migration.name})`;
      });
      applied.push(migration.name);
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('video_downloader_migrations'))`;
  }
  return applied;
}

function toDirectoryUrl(directory: string | URL): URL {
  if (directory instanceof URL) return directory;
  return new URL(`file:///${directory.replaceAll("\\", "/").replace(/\/?$/, "/")}`);
}
