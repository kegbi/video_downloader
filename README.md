# Video Downloader

A self-hosted, X-only video download service with a Telegram bridge. The backend is independent of
Telegram: Hono accepts durable jobs, RabbitMQ dispatches work, PostgreSQL owns all state, and
private RustFS object storage holds validated artifacts. Downloads use pinned yt-dlp and FFmpeg
inside the worker image. Telegram's hosted Bot API remains the default; an opt-in Compose override
builds and runs the official local Bot API server for larger-file deployments.

All milestones (0–6) of the [implementation plan](docs/implementation-plan.md) are complete, and the
service runs in production on Dokploy against the official local Bot API server. Live Telegram
validation requires credentials supplied by the operator and is never part of the automated suite.

The reviewed production topology is [`compose.dokploy.yaml`](compose.dokploy.yaml). It is a standalone private stack with the
official local Bot API, named state volumes, and image-baked observability configuration. See the
[Dokploy runbook](docs/dokploy.md); no service in that topology receives a host port or public
domain.

## Architecture

```text
Telegram bridge -> authenticated Hono API -> PostgreSQL/outbox
                                               |
                                    maintenance publisher
                                               v
                                           RabbitMQ
                                               |
                                        download worker
                                               v
                                      private RustFS bucket
                                               |
                         bridge delivery lease + authenticated stream
```

The worker never receives a Telegram token. The bridge receives no database, RabbitMQ, or S3
credentials. Telegram delivery retries never redownload an artifact.

## Local quick start

Requirements: Docker with Compose v2. The host-side quality commands additionally require Deno
2.9.5.

```sh
docker compose up --build -d
docker compose ps
```

The default development deployment binds only loopback ports:

- API and OpenAPI: `http://127.0.0.1:8080/health/ready` and `http://127.0.0.1:8080/openapi.json`
- RabbitMQ management: `http://127.0.0.1:15672`
- RustFS S3 API: `http://127.0.0.1:9000`
- Prometheus metrics history: `http://127.0.0.1:9090`
- Loki log API: `http://127.0.0.1:3100`

Development defaults are intentionally recognizable and are rejected when `APP_ENV=production`. For
a real deployment, copy `.env.example` to `.env`, replace every credential, set at least one numeric
`TELEGRAM_ADMIN_USER_IDS`, and review retention/storage limits. Worker media uses the disk-backed
`worker-temp` named volume; the small `/tmp` tmpfs does not hold downloads. Keep
`MAX_ARTIFACT_BYTES` within `TELEGRAM_MAX_UPLOAD_BYTES` and provision `DOWNLOAD_MAX_TEMP_BYTES` plus
concurrency headroom as described in [operations](docs/operations.md). Start the live bridge only
after providing a bot token:

```sh
docker compose --profile live up --build -d
```

Do not use the live profile as an automated test. The normal suite does not contact X or Telegram.

For the official local Bot API, additionally set the empty `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`
entries in `.env`, review the upload/temp-storage limits, and use the dedicated override. It starts
the bridge against `http://telegram-bot-api:8081` without publishing that port or enabling the test
profile:

```sh
docker compose --env-file .env -f compose.yaml -f compose.telegram-local.yaml \
  --profile telegram-local up --build -d
```

See [operations](docs/operations.md) before moving an existing bot between the hosted and local
servers. The repository never performs that account-level migration automatically.

## Quality gates

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

`deno task coverage` enforces at least 80% aggregate line coverage over core `apps/` and
`packages/`, excluding executable `main.ts` entry points. The fully isolated container suite is:

```sh
docker compose --profile test up --build --abort-on-container-exit --exit-code-from test-runner test-runner
```

The test profile uses ephemeral PostgreSQL, RabbitMQ, and RustFS instances and fixture media. See
[operations](docs/operations.md) for deployment, backup, recovery, and troubleshooting,
[security](docs/security.md) for the security model, and [verification](docs/verification.md) for
the latest tested status, including the opt-in direct X download smoke test that bypasses Telegram.

## Supported input and behavior

- Exactly one HTTPS `x.com` or `twitter.com` status URL per request.
- Query parameters such as share-tracking suffixes are ignored.
- Public, non-live X video and animated GIF posts; for a status containing multiple videos, the
  first video is selected deterministically. Generic playlists and arbitrary extractor options are
  rejected.
- MP4/H.264/AAC is preferred and source quality may be downgraded to fit the configured artifact
  ceiling (49,000,000 bytes by default).
- No oversized transcoding is performed in the MVP.
- Silent H.264 MP4s are returned as looping Telegram animations. X may omit their duration;
  ffprobe measures the downloaded file and enforces the duration limit before storage.
- Retention modes: `forever`, fixed `ttl` (seven days by default), and `after_delivery`.
- Job retries preserve the client's retention intent: an omitted policy remains idempotent even if
  the deployment default later changes, while omitted and explicit policies are distinct requests.
- Identical sources or SHA-256 plus byte-size content reuse one immutable artifact with conservative
  shared retention.
- User commands: `/start`, `/help`, `/request`, `/jobs [active|failed|recent] [page]`, `/status ID`,
  `/cancel ID`.
- Admin commands: `/retry ID`, `/allow USER_ID [note]`, `/deny USER_ID reason`, `/users [page]`,
  `/requests [page]`, `/audit [page]`.

`/help` and the Bot API command menu are role-scoped. The backend remains authoritative for every
authorization decision. A valid first URL from an unknown private-chat user, or `/request`, creates
one deduplicated pending access request without creating a download job; configured administrators
receive safe numeric-ID-only notifications through a transactional per-admin outbox and can resolve
them either with inline allow/deny buttons in the notification or `/requests`, or with the existing
commands. A button opens a Telegram `ForceReply` prompt for an optional internal note; `/skip`
submits no note and `/cancel_action` leaves the request pending. While that prompt is active, new
access-request notices are queued for that administrator only. Notes are stored in PostgreSQL and
audit history but are never included in the requester's neutral approved/declined message. Numeric
user IDs in `/requests` are inline Telegram profile links and each request also has a dedicated
profile button (both are subject to the user's Telegram privacy settings). Button denial rejects
only the current request, which can reopen after `ACCESS_REQUEST_DENIED_COOLDOWN_SECONDS` (seven
days by default); `/deny` disables the principal until a later `/allow`. Claims use leases and
bounded retry/backoff, so bridge restart and partial multi-admin delivery cannot lose committed
work. Access requests, prompts, and notification rows are retained for seven days by default. Access
requests and administrator allow/deny decisions serialize per numeric Telegram ID, preventing a
concurrent decision from leaving an active principal with a pending request or notification.

## Repository map

- `apps/api`: authenticated Hono/OpenAPI service and range-capable artifact streaming.
- `apps/worker`: RabbitMQ consumer and idempotent download/artifact orchestration.
- `apps/telegram_bridge`: grammY polling bridge and health endpoint.
- `Dockerfile.telegram-bot-api` and `compose.telegram-local.yaml`: pinned official local Bot API
  build and isolated opt-in topology.
- `compose.dokploy.yaml`, `Dockerfile.observability`, and `docs/dokploy.md`: complete private
  Dokploy production topology and operator runbook.
- `apps/maintenance`: transactional outbox publication and retention cleanup.
- `packages`: contracts, domain rules, typed database access, adapters, logging, and metrics.
- `migrations`: immutable pre-Drizzle PostgreSQL migrations; this directory is frozen.
- `drizzle`: reviewed, generated migrations starting from the existing-schema baseline.
- `tests`: unit, adapter/infrastructure integration, and fake end-to-end coverage.
- `docs`: requirements, architecture, operations, security, compatibility, and verification records.

## License

Released under the [MIT License](LICENSE). Third-party components keep their own licenses; some
differ from MIT, for example Loki (AGPL-3.0) and the Telegram Bot API server and TDLib (BSL-1.0).
See [licenses](docs/licenses.md).

## Disclaimer

This is a self-hosted personal tool provided as is, with no support guarantee. You are responsible
for complying with X's terms of service and applicable copyright law. Only download content you
have the right to download.
