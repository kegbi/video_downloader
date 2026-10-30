import postgres from "postgres";
import type { AppConfig } from "../config/mod.ts";

export type Database = postgres.Sql;
export type Transaction = postgres.TransactionSql;

interface DatabaseRegistration {
  readonly postgresUrl: string;
  readonly ormPoolSize: number;
  ormClient?: Database;
}

const registrations = new WeakMap<Database, DatabaseRegistration>();

export function createDatabase(config: Readonly<AppConfig>): Database {
  const ormPoolSize = Math.max(1, Math.floor(config.POSTGRES_POOL_SIZE / 3));
  const sql = createClient(config.postgresUrl, config.POSTGRES_POOL_SIZE - ormPoolSize);
  registrations.set(sql, {
    postgresUrl: config.postgresUrl,
    ormPoolSize,
  });
  return sql;
}

export function getOrmClient(sql: Database): Database {
  const registration = registrations.get(sql);
  if (!registration) {
    throw new Error("ORM access requires a database created by createDatabase");
  }
  registration.ormClient ??= createClient(registration.postgresUrl, registration.ormPoolSize);
  return registration.ormClient;
}

export async function closeDatabase(
  sql: Database,
  options?: Parameters<Database["end"]>[0],
): Promise<void> {
  const ormClient = registrations.get(sql)?.ormClient;
  await Promise.all([sql.end(options), ormClient?.end(options)]);
}

function createClient(postgresUrl: string, poolSize: number): Database {
  return postgres(postgresUrl, {
    max: poolSize,
    connect_timeout: 10,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    prepare: true,
    onnotice: () => undefined,
  });
}

export async function databaseReady(sql: Database): Promise<boolean> {
  try {
    const rows = await sql<{ ready: number }[]>`SELECT 1::int AS ready`;
    return rows[0]?.ready === 1;
  } catch {
    return false;
  }
}
