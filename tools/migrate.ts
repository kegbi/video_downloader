import { loadConfig } from "../packages/config/mod.ts";
import { closeDatabase, createDatabase } from "../packages/db/client.ts";
import { runMigrations } from "../packages/db/migrations.ts";

const config = loadConfig("migrate");
const sql = createDatabase(config);
try {
  const migrations = await runMigrations(sql, [
    new URL("../migrations/", import.meta.url),
    new URL("../drizzle/", import.meta.url),
  ]);
  console.log(JSON.stringify({ applied: migrations }));
} finally {
  await closeDatabase(sql, { timeout: 5 });
}
