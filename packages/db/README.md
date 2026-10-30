# Database access boundary

This package deliberately uses a hybrid persistence model:

- `schema.ts` is the typed Drizzle representation of the PostgreSQL schema.
- `routine_queries.ts` owns ordinary CRUD and lookup queries built with Drizzle.
- `repository.ts` remains the domain-facing facade. Transactions that depend on advisory locks,
  `FOR UPDATE SKIP LOCKED`, leases, or compare-and-set state transitions stay as parameterized SQL
  so their concurrency semantics remain visible and reviewable.
- `records.ts` contains the stable records returned to the rest of the application.

Drizzle's postgres.js adapter installs timestamp and JSON serializers on its client. The raw and ORM
query paths therefore use separate, lazily opened pools; `closeDatabase` closes both. This prevents
the ORM adapter from changing raw-query parameter handling. `POSTGRES_POOL_SIZE` remains the total
per-process connection budget (minimum 2), divided approximately two-thirds to raw transactional
work and one-third to routine ORM work.

## Migration workflow

The files in `migrations/` predate Drizzle and are immutable. The no-op
`drizzle/0000_existing_schema.sql` baseline pairs with Drizzle's generated snapshot; subsequent
changes are generated with:

```sh
deno task db:generate
deno task db:check
```

Review generated SQL before committing it. The application migration runner applies the legacy
history first and the Drizzle history second, recording both in `schema_migrations`. The integration
schema test compares Drizzle's columns, constraint names, and indexes with a migrated PostgreSQL
database. Drizzle Kit's separate `drizzle.lock` pins and audits its build-time dependency graph
without adding CLI packages to the application lockfile or runtime container.
