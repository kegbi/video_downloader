# Security

## Trust boundaries

Telegram and X are untrusted external systems. The Telegram bridge is the only service with a
BotFather token and can call only the bearer-authenticated API. When enabled, the official local Bot
API service is the only service with `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`. It is not configured
with a bot-token environment variable, but necessarily receives and processes the token embedded in
Bot API request URLs from the bridge. The worker has PostgreSQL, RabbitMQ, and S3 credentials but no
Telegram credential. Maintenance has the same infrastructure access needed for publication and
deletion. PostgreSQL is authoritative; RabbitMQ and Telegram are at-least-once boundaries.

## Controls

- Input accepts only one HTTPS URL with an allowlisted X/Twitter host and exact status path.
  Credentials, ports, fragments, generic playlists, live streams, and arbitrary yt-dlp options are
  rejected. Query parameters are ignored: the downloader only receives the URL rebuilt from the
  numeric status ID. A playlist-shaped yt-dlp result is accepted only as the
  internal representation of that already-validated status's media and selects the first video. This
  is the primary SSRF boundary.
- yt-dlp, FFmpeg, and ffprobe run through fixed argument arrays with no shell. Output paths are
  service-generated, stderr is bounded, and timeout/cancellation escalates from graceful to forced
  termination. Per-job media bytes are bounded before and during download/remux; budget failures use
  a typed safe error that includes no URL, filename, media bytes, tool output, or configuration
  value.
- An ambiguous yt-dlp no-video failure may trigger a diagnostic request to the fixed public X
  syndication endpoint. It accepts only a validated X status ID, follows no redirects, caps the
  response at 64 KiB and five seconds, and never uses returned media URLs or prints the response.
  An explicit regional-withholding tombstone produces a static safe error; it does not trigger a
  proxy, authenticated session, alternate download route, or restriction bypass.
- Large worker media uses the dedicated disk-backed `worker-temp` volume rather than tmpfs. Unique
  directories have attempt-specific markers tied to exact PostgreSQL lease owners. Cleanup accepts
  only a direct child of the configured root whose marker token matches the returned artifact;
  unmarked, mismatched, symlinked, and unrelated paths are never recursively removed.
- The API uses a constant-time bearer comparison, a small body limit, runtime Zod validation, secure
  response headers, opaque IDs, and requester/admin authorization. Artifact access is authenticated,
  private, and range-capable; no S3 URL or host path is exposed. Malformed path, query, or body
  input returns the same safe error envelope with a supplied or generated correlation ID and never
  exposes validator details.
- Telegram numeric IDs come only from the bridge's parsed update boundary and use the same canonical
  validator in config, API contracts, commands, repository, and database checks: digits only,
  positive, no leading zero, bounded to the maximum safe integer. Unknown users can create a
  deduplicated access request, but the backend still default-denies job submission until an
  administrator allows the persistent principal. Notifications and `/requests` expose no username,
  display name, raw message, or source URL; `/audit` omits raw change payloads. Per-admin
  notification outbox rows are created transactionally, claimed with leases, reconciled against
  active admins, and cascaded with their seven-day request retention.
- Inline access decisions create one durable, expiring prompt per administrator. The optional note
  is internal authorization metadata: allow stores it on the principal and request, rejection stores
  it on the request, and neither requester decision notices nor `/audit` output expose it. An active
  prompt pauses access-request notice claims for that administrator without blocking other admins.
  Request-specific rejection does not create a disabled principal; only the authenticated `/deny`
  operation persists a disable.
- Request creation and administrator allow/deny decisions serialize on one target-scoped database
  lock before reading a possibly nonexistent principal or request. A concurrent decision therefore
  cannot leave active access paired with pending request/notification state.
- PostgreSQL compare-and-set leases and transactions protect state transitions. These
  concurrency-critical operations remain explicit, parameterized SQL; routine CRUD uses the typed
  Drizzle schema. The outbox closes the database/broker loss window. Telegram completion is
  persisted only after a confirmed result.
- Telegram delivery heartbeats retain the exact claimed delivery owner across authenticated artifact
  fetch, streaming upload, fallback cleanup, and result finalization. Every renewal is
  deadline-bounded. Renewal failure, timeout, or bridge shutdown aborts cancellable stream work and
  gates every subsequent Telegram operation; stale owners remain unable to persist through the
  existing compare-and-set boundary.
- Artifacts use private RustFS keys, checksum/size verification, a configurable total ceiling, and
  retention cleanup that respects active delivery leases.
- Production application containers are non-root, read-only, capability-free, resource-limited, and
  isolated on an internal network. Only explicitly documented loopback ports are published by
  default. The worker's small `/tmp` tmpfs is independent of its disk-backed media volume and its
  multi-gigabyte temporary budget does not increase the 768 MiB memory limit.
- The local Bot API is separately opt-in, built only from an immutable official source revision, and
  attached only to a dedicated network shared with the bridge. It publishes no port and has no
  domain or Traefik metadata. Its persistent working directory is sensitive operational state;
  preserve it across ordinary recreation, restrict host access, and never expose it through the API
  or observability stack. Backups are outside this deployment's scope.
- Loki and Prometheus are unauthenticated inside that trusted boundary and bind only to host
  loopback. They must not receive public proxy routes; remote operator access requires an SSH/VPN
  tunnel or a separate TLS-authenticated reverse proxy.
- The Dokploy topology is stricter: it publishes no host ports at all, attaches no service to
  `dokploy-network`, and defines no domain or Traefik metadata. Backend and observability networks
  are internal; outbound access is confined to a worker-only network and a network shared only by
  the bridge and local Bot API. Observability configuration is baked into images rather than mounted
  from Dokploy's disposable Git checkout.
- Logs use a shared recursive redactor. CI scans for common credential formats, audits high/critical
  dependency vulnerabilities, verifies direct dependency licenses, and enforces tests/coverage.

## Secrets

Never commit `.env`, cookies, bot tokens, private keys, database dumps, or object-store exports. Use
independent credentials per service/deployment and rotate the internal API token, Telegram bot
token, database password, RabbitMQ password, and S3 keys after any suspected disclosure. Docker
Compose environment variables are suitable for initial self-hosting; deployments with stricter
requirements should inject mounted secrets or use an orchestrator secret store.

Development defaults are not safe credentials. `APP_ENV=production` rejects placeholders and missing
service-specific secrets. Telegram administrator IDs are identifiers rather than secrets, but
changes to the persistent allowlist are audited.

The local Bot API's `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are operator secrets even though an
API ID is numeric. They intentionally have empty `.env.example` values and required Compose
expansions, are excluded from `packages/config`, and are never passed to the API, worker,
maintenance, bridge, PostgreSQL, RabbitMQ, RustFS, Loki, Prometheus, migration, or storage-init
services. Environment/config ownership of `TELEGRAM_BOT_TOKEN` remains exclusive to
`telegram-bridge`; it is never injected into the local Bot API container environment. The local
server nevertheless receives and processes that token as part of each Bot API request URL, so
request-target logging on the bridge/server network is also a credential disclosure. Do not use a
real credential value in rendered Compose output, screenshots, logs, or support bundles.

The API hash authenticates a Telegram developer application but not a user or bot; with only the ID
and hash an attacker cannot read chats. The standalone risk is abusive use attributed to the
application, which can get the API ID limited or disabled. If the values are published, remove the
disclosure and contact Telegram support; if a bot token or user session was also exposed, rotate or
revoke it immediately.

## Residual risks

- Site extractors break when X changes behavior; update yt-dlp only after compatibility tests.
- A single RustFS node and a single PostgreSQL node are not highly available. Backups and restore
  tests remain operator responsibilities.
- Configured artifact and per-job temporary ceilings limit pressure, but Telegram upload and hostile
  media parsing remain expensive. A named volume is not a host-disk quota, concurrent budgets add,
  filesystem polling can observe a child only after it writes, and RustFS/local Bot API staging also
  consumes disk. Keep capacity monitoring, container limits, filesystem isolation, and host patching
  current.
- The bearer-authenticated API is intended for a trusted internal network. It is not a public
  multi-tenant authentication scheme.
- Bot API timeouts have ambiguous outcomes. The bridge intentionally does not send a second message
  on ambiguity; operator-visible retries may be delayed until the lease/retry window.
- Renewal loss cannot reliably cancel a Telegram operation after the remote server has already
  accepted all request bytes. The bridge persists a known successful result when its owner CAS still
  permits it; otherwise normal recovery preserves fixed-message edit retries and the documented
  fallback crash-after-send boundary.
- The local Bot API adds persistent TDLib state and an outbound Telegram client to the host. A lost
  or copied working-directory volume, concurrent hosted/local use, undersized disk, or unreviewed
  increase above the starting 1 GiB memory limit can disrupt updates or large deliveries. Account
  migration and capacity changes remain explicit operator actions.
- Access-request notifications are at-least-once at the Telegram boundary. A crash after Telegram
  accepts a notification but before the database completion commits can duplicate that safe
  numeric-ID-only notice; it cannot grant access or duplicate a download.
- Neutral requester decision notifications use a separate leased outbox and share the same
  crash-after-send duplicate boundary. They never contain the administrator's note or reason.

## Reporting a vulnerability

Do not disclose live credentials or exploit details in a public issue. Use GitHub private
vulnerability reporting on this repository (Security tab, then Report a vulnerability) with the
affected revision, reproduction steps, impact, and any suggested fix. Revoke compromised
credentials before collecting additional diagnostics.
