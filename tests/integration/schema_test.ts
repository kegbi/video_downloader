import { assertEquals } from "@std/assert";
import { getTableConfig } from "drizzle-orm/pg-core";
import { loadConfig } from "../../packages/config/mod.ts";
import { closeDatabase, createDatabase } from "../../packages/db/client.ts";
import { runMigrations } from "../../packages/db/migrations.ts";
import { databaseSchema } from "../../packages/db/schema.ts";

const databaseEnvironment = {
  APP_ENV: "test",
  POSTGRES_HOST: Deno.env.get("TEST_POSTGRES_HOST") ?? "127.0.0.1",
  POSTGRES_PORT: Deno.env.get("TEST_POSTGRES_PORT") ?? "5432",
  POSTGRES_DB: Deno.env.get("TEST_POSTGRES_DB") ?? "video_downloader_test",
  POSTGRES_USER: Deno.env.get("TEST_POSTGRES_USER") ?? "video_downloader_test",
  POSTGRES_PASSWORD: Deno.env.get("TEST_POSTGRES_PASSWORD") ?? "local-postgres-password",
};

Deno.test({
  name: "Drizzle schema matches migrated PostgreSQL tables",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const config = loadConfig("test", databaseEnvironment);
    const sql = createDatabase(config);
    try {
      await runMigrations(sql, [
        new URL("../../migrations/", import.meta.url),
        new URL("../../drizzle/", import.meta.url),
      ]);
      const tables = Object.values(databaseSchema).map(getTableConfig);
      const tableNames = tables.map((table) => table.name);

      const expectedColumns = tables.flatMap((table) =>
        table.columns.map((column) =>
          `${table.name}:${column.name}:${normalizeType(column.getSQLType())}:${column.notNull}`
        )
      ).sort();
      const actualColumns = await sql<{
        table_name: string;
        column_name: string;
        data_type: string;
        not_null: boolean;
      }[]>`
        SELECT relation.relname AS table_name, attribute.attname AS column_name,
          format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
          attribute.attnotnull AS not_null
        FROM pg_attribute attribute
        JOIN pg_class relation ON relation.oid = attribute.attrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relname = ANY(${tableNames})
          AND attribute.attnum > 0 AND NOT attribute.attisdropped
      `;
      assertEquals(
        actualColumns.map((column) =>
          `${column.table_name}:${column.column_name}:${
            normalizeType(column.data_type)
          }:${column.not_null}`
        ).sort(),
        expectedColumns,
      );

      const expectedConstraints = tables.flatMap((table) => [
        ...table.foreignKeys.map((constraint) => `${table.name}:${constraint.getName()}`),
        ...table.uniqueConstraints.map((constraint) => `${table.name}:${constraint.name}`),
        ...table.checks.map((constraint) => `${table.name}:${constraint.name}`),
      ]).sort();
      const actualConstraints = await sql<{ table_name: string; constraint_name: string }[]>`
        SELECT relation.relname AS table_name,
          database_constraint.conname AS constraint_name
        FROM pg_constraint database_constraint
        JOIN pg_class relation ON relation.oid = database_constraint.conrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relname = ANY(${tableNames})
          AND database_constraint.contype IN ('f', 'u', 'c')
      `;
      assertEquals(
        actualConstraints.map((constraint) =>
          `${constraint.table_name}:${constraint.constraint_name}`
        ).sort(),
        expectedConstraints,
      );

      const expectedIndexes = tables.flatMap((table) =>
        table.indexes.map((databaseIndex) => `${table.name}:${databaseIndex.config.name}`)
      ).sort();
      const actualIndexes = await sql<{ table_name: string; index_name: string }[]>`
        SELECT relation.relname AS table_name, index_relation.relname AS index_name
        FROM pg_index database_index
        JOIN pg_class relation ON relation.oid = database_index.indrelid
        JOIN pg_class index_relation ON index_relation.oid = database_index.indexrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relname = ANY(${tableNames})
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint constraint_index
            WHERE constraint_index.conindid = index_relation.oid
          )
      `;
      assertEquals(
        actualIndexes.map((databaseIndex) =>
          `${databaseIndex.table_name}:${databaseIndex.index_name}`
        ).sort(),
        expectedIndexes,
      );
    } finally {
      await closeDatabase(sql, { timeout: 5 });
    }
  },
});

function normalizeType(type: string): string {
  return type.replace(/^character varying/, "varchar");
}
