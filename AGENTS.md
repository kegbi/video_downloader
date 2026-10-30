# Repository Guidance

## Start here

- [README](README.md) — service overview, local startup, quality gates, and repository map.
- [Product requirements](docs/requirements.md) and
  [approved architecture](docs/architecture.md) — governing product and technical decisions. The
  architecture document controls when a general requirement is ambiguous.
- [Implementation plan](docs/implementation-plan.md) — milestone boundaries and gates; a record of
  the completed implementation.
- [Operations](docs/operations.md), [Dokploy runbook](docs/dokploy.md), and
  [security](docs/security.md) — deployment, recovery, trust boundaries, and incident procedures.
- [Database boundary](packages/db/README.md) — Drizzle ownership, explicit SQL exceptions, and the
  migration workflow.
- [Compatibility](docs/compatibility.md), [verification](docs/verification.md), and
  [licenses](docs/licenses.md) — pinned infrastructure decisions and current evidence.

## Working rules

- Use Deno 2.9.5 and Docker Compose v2. Keep application code in TypeScript; yt-dlp, FFmpeg, and
  ffprobe remain fixed-argument external worker tools.
- Keep the backend independent of Telegram. Normal automated tests must use fixture media and the
  fake Telegram server; they must not contact live X or Telegram endpoints.
- Treat PostgreSQL as authoritative. Use Drizzle for routine typed queries, but preserve explicit,
  parameterized SQL where advisory locks, leases, compare-and-set transitions, or
  `FOR UPDATE SKIP LOCKED` make concurrency semantics important.
- Never edit the frozen `migrations/` history. Generate new schema changes into `drizzle/` with
  `deno task db:generate`, review the SQL, and run `deno task db:check`. Do not use `drizzle push`
  against shared or production databases.
- Do not commit credentials, live tokens, downloaded media, or local volume data. A live X smoke
  test is opt-in, nondeterministic evidence; delete its artifact after validation.
- Keep changes coherent and run the narrowest relevant tests while iterating, followed by the full
  quality gates before handoff.

## Validation

Run host checks with:

```sh
deno task fmt
deno task lint
deno task check
deno task db:check
deno task test:unit
deno task test:integration
deno task test:e2e
deno task coverage
deno task licenses
deno task scan:secrets
deno task audit
```

Run the fully isolated infrastructure suite with:

```sh
docker compose --profile test up --build --abort-on-container-exit --exit-code-from test-runner test-runner
```

Live Telegram testing requires operator-supplied credentials and is never part of the automated
gates. Do not start the `live` Compose profile unless the owner explicitly requests it.
