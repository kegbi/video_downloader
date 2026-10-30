import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { type Database, getOrmClient } from "./client.ts";
import { databaseSchema } from "./schema.ts";

export type OrmDatabase = PostgresJsDatabase<typeof databaseSchema>;

export function createOrm(sql: Database): OrmDatabase {
  return drizzle({ client: getOrmClient(sql), schema: databaseSchema, casing: "snake_case" });
}
