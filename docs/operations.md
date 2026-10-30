# Operations

## Deployment checklist

For a Dokploy host, use the dedicated [Dokploy production runbook](dokploy.md) and standalone
`compose.dokploy.yaml`. The checklist below describes the local/general Compose topology;
do not deploy it directly through Dokploy because it publishes loopback development ports and
bind-mounts observability files from the checkout.

1. Use Docker Compose v2 and durable storage for the six default named volumes. Five hold durable
   service data; `worker-temp` holds recoverable temporary media. The local Bot API profile adds a
   seventh working-directory volume.
2. Copy `.env.example` to `.env`. Set `APP_ENV=production` and replace the internal API, PostgreSQL,
   RabbitMQ, RustFS/S3, and Telegram credentials with independent random values.
3. Set numeric `TELEGRAM_ADMIN_USER_IDS`. The API idempotently bootstraps these principals and
   records audit events.
4. Choose `RETENTION_DEFAULT_MODE`, the TTL/grace settings, and `STORAGE_MAX_BYTES`. A value of zero
   disables the aggregate ready-artifact ceiling. Keep `ACCESS_REQUEST_TTL_SECONDS=604800` unless a
   reviewed policy requires another value.
5. Run the isolated test profile before deployment.
6. Start the default services, verify every health check, and only then enable the `live` profile.

```sh
docker compose --profile test up --build --abort-on-container-exit --exit-code-from test-runner test-runner
docker compose up --build -d
docker compose ps
docker compose --profile live up -d telegram-bridge
```

Application containers run as an unprivileged user with a read-only root filesystem, dropped
capabilities, `no-new-privileges`, resource limits, and an internal network. Published development
ports bind to 127.0.0.1. Put a TLS-authenticated reverse proxy in front of any endpoint
intentionally exposed to another machine; the internal API must not be public.

## Worker temporary storage

Compose mounts the dedicated disk-backed `worker-temp` named volume at `/var/tmp/video-downloader`.
Large media never uses the worker's RAM-backed `/tmp`; that tmpfs stays at 16 MiB for harmless
runtime files. `DOWNLOAD_TEMP_DIR` must remain this dedicated absolute path for the supplied Compose
deployment. A custom bind mount requires an explicit deployment override, must be writable only by
UID/GID 10001, and must not overlap RustFS, application code, credentials, or another service's
data.

The three byte limits have distinct roles:

- `TELEGRAM_MAX_UPLOAD_BYTES` is the selected Bot API path's delivery ceiling.
- `MAX_ARTIFACT_BYTES` is the worker's final-artifact ceiling and must be no greater than the
  delivery ceiling.
- `DOWNLOAD_MAX_TEMP_BYTES` is enforced per active job and must be at least
  `(2 * MAX_ARTIFACT_BYTES) + DOWNLOAD_FORMAT_SAFETY_BYTES`. The factor of two permits split input
  streams and the remux output to coexist; the safety bytes cover reviewed estimation/container
  overhead.

The hosted defaults are 49,000,000 artifact/upload bytes and a 200,000,000-byte per-job temporary
budget. A reviewed local-server example with a 10 MB margin below Telegram's ceiling is
`TELEGRAM_MAX_UPLOAD_BYTES=1990000000`, `MAX_ARTIFACT_BYTES=1990000000`, and, with the default
2,000,000-byte safety value, `DOWNLOAD_MAX_TEMP_BYTES=3982000000`. Values at or above 2,000,000,000
for either artifact/upload ceiling are rejected.

The named volume does not reserve or quota host disk. Before rollout, provision usable space of at
least `WORKER_CONCURRENCY * DOWNLOAD_MAX_TEMP_BYTES`, plus filesystem headroom and the separately
sized RustFS and local Bot API volumes. Monitor free space and volume growth; concurrent jobs,
multipart upload, RustFS promotion, and Telegram-local staging can temporarily coexist. The worker
passes fixed size arguments to yt-dlp/FFmpeg, polls logical job-directory bytes while each child
runs, rechecks before validation/upload, hashes incrementally, and streams upload from disk. Disk
exhaustion outside the configured per-job budget can still fail a job, so the application limit is
not a substitute for host capacity monitoring.

Every attempt owns a unique marked directory and an attempt-specific PostgreSQL lease owner.
Success, rejection, cancellation, timeout, and process/storage failure remove that attempt's
directory. Startup and periodic recovery preserve exact active owners and recent marker heartbeats,
then remove only stale service-marked directories. They never clear unmarked paths or a directory
whose artifact attempt token does not match. `worker-temp` therefore should persist across ordinary
worker recreation, but it is disposable scratch state and must not be backed up as an artifact
store.

## Telegram delivery leases

`TELEGRAM_DELIVERY_LEASE_SECONDS` defaults to 300 seconds and `TELEGRAM_DELIVERY_HEARTBEAT_SECONDS`
defaults to 30 seconds. The heartbeat must be strictly below the lease and no greater than one
quarter of it, leaving at least three scheduled renewal attempts in one lease. Each renewal request
has its own deadline equal to the configured heartbeat interval, so a hung backend request becomes
ownership uncertainty well before lease expiry. Production validation errors identify only the
invalid variable names.

The bridge polls for ready deliveries every 250 milliseconds by default and changes the progress
reply to `uploading` after it owns the delivery lease. It renews the exact claimed delivery ID and
owner while it opens and streams the artifact, waits for Telegram, performs a confirmed send-new
fallback and progress cleanup, and persists the result. A rejected, failed, or timed-out heartbeat
cancels the authenticated backend response stream and stops the attempt before another Telegram
operation where possible. On `SIGINT`/`SIGTERM`, the bridge aborts the same stream, stops and joins
the heartbeat task, and leaves any unfinalized row to expire for a later bridge owner. Do not reduce
the lease/heartbeat values merely to accelerate recovery; size them for backend latency and
transient scheduling pauses while retaining multiple renewal opportunities.

## Official local Telegram Bot API

The default and `live` paths continue to use `https://api.telegram.org`. Use the official local
server only when the deployment has a reviewed need for its additional features, such as uploads
above the hosted limit. Telegram documents a 2,000 MB local-server upload ceiling, but
`TELEGRAM_MAX_UPLOAD_BYTES` remains the bridge policy limit and `MAX_ARTIFACT_BYTES` remains the
worker policy limit. Keep both strictly below 2,000,000,000 bytes and size
`DOWNLOAD_MAX_TEMP_BYTES`, RustFS capacity, the Docker host, and the `telegram-bot-api-data` volume
for the chosen value.

Obtain deployment-specific `api_id` and `api_hash` values through Telegram's official
[application configuration flow](https://core.telegram.org/api/obtaining_api_id), then place them
only in the empty `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` entries of the ignored `.env`. They have
no defaults and are not application configuration: Compose passes them only to `telegram-bot-api`.
Compose injects `TELEGRAM_BOT_TOKEN` only into `telegram-bridge`; the local server necessarily
processes that token in the Bot API request URLs it receives over the dedicated network, so neither
side's request URLs belong in logs or diagnostics.

Validate the merged topology without reading any uncommitted environment file by using the
credential-free example plus non-secret validation sentinels. Do not use live values in
`docker compose config` output or diagnostics. Start the profile with the ignored deployment file
only after validation:

```sh
TELEGRAM_API_ID=12345 TELEGRAM_API_HASH=validation-only-not-a-secret \
  docker compose --env-file .env.example -f compose.yaml -f compose.telegram-local.yaml \
  --profile telegram-local config --quiet
docker compose --env-file .env -f compose.yaml -f compose.telegram-local.yaml \
  --profile telegram-local up --build -d
```

The override starts `telegram-bridge` and `telegram-bot-api` under `telegram-local`, points the
bridge at `http://telegram-bot-api:8081`, and leaves every `test` service disabled. The server has
no host port, domain, or proxy labels. It is reachable only from the bridge on their dedicated
Compose network while retaining outbound access required for Telegram. The named working-directory
volume preserves TDLib session and server state across container recreation. Restrict host access
and do not remove it during ordinary upgrades. Backing up this local Bot API volume is outside the
current deployment scope.

The reviewed starting limits are one CPU, 1 GiB memory, and 256 PIDs. They bound an auxiliary
network service without granting it worker-sized resources; monitor restarts, memory pressure,
delivery latency, and volume growth under representative large uploads before changing them. The
container runs as UID/GID 10001 with a read-only root, no added capabilities, `no-new-privileges`,
and a one-minute SIGTERM grace period supported by the upstream shutdown handler.

Moving an already active bot between Telegram's hosted and local Bot API servers is an
operator-controlled account migration. The repository does not call `logOut` or automate the
cutover. Follow Telegram's official
[local-server migration procedure](https://github.com/tdlib/telegram-bot-api#moving-a-bot-to-a-local-server)
in a planned maintenance window before redirecting an existing bot; starting both paths for one bot
can lose or split updates. Preserve `telegram-bot-api-data` during ordinary upgrades and stops;
volume backup and cross-host migration are outside this deployment's scope.

### Opt-in controlled large-file acceptance

This procedure is manual acceptance evidence, not a normal test and not a cutover procedure. It does
not call `logOut`, start a second polling bridge, contact X, or deploy anything. Run it only after
the official local Bot API service and the bridge are healthy, during a quiet window with
no active delivery lease. Use a private operator-controlled chat and keep its numeric ID only in the
invoking shell. The tools print only the case, byte counts, bounded upload observations, heartbeat
count, elapsed time, cleanup result, and pass/fail state; they do not print the token, chat ID,
message/file IDs, artifact path, or media content.

The generator creates a two-second H.264/AAC MP4, appends a valid trailing MP4 `free` box, and
revalidates it with ffprobe. `above-hosted` is exactly 52,000,000 bytes. `boundary` is exactly the
reviewed 1,990,000,000-byte policy ceiling. The extension is normally sparse, but this is not
assumed: provision enough local and Docker-host space for the complete logical file and inspect free
space before each run. The upload still reads and transmits every logical byte. Use a temporary
directory outside the repository or the ignored `.local/` directory, and arrange unconditional local
cleanup.

The following example assumes the merged local-server Compose stack is already running and the
current bridge image contains the acceptance tools. The harness accepts only the documented
`http://telegram-bot-api:8081` endpoint (or an explicit loopback equivalent) and a canonical,
positive private-chat numeric ID. It deliberately passes the chat ID by variable name rather than
putting its value in command arguments. Do not redirect the Compose invocation or shell trace to
durable evidence because process diagnostics are outside the tool's sanitized-output contract.

```sh
set +x
acceptance_dir="$(mktemp -d)"
trap 'rm -rf -- "$acceptance_dir"' EXIT
export LARGE_FILE_ACCEPTANCE_CHAT_ID='operator-supplied-private-chat-id'

for acceptance_case in above-hosted boundary; do
  artifact="$acceptance_dir/$acceptance_case.mp4"
  deno run --allow-env --allow-read --allow-write --allow-run \
    tools/generate_large_fixture.ts "$acceptance_case" "$artifact"
  chmod 0444 "$artifact"
  docker compose --env-file .env -f compose.yaml -f compose.telegram-local.yaml \
    --profile telegram-local run --rm --no-deps \
    -e RUN_LARGE_FILE_ACCEPTANCE=1 \
    -e LARGE_FILE_ACCEPTANCE_CHAT_ID \
    -v "$artifact:/acceptance/artifact.mp4:ro" \
    telegram-bridge deno run --allow-env --allow-net \
      --allow-read=/acceptance/artifact.mp4 \
      tools/large_file_acceptance.ts "$acceptance_case" /acceptance/artifact.mp4
  rm -f -- "$artifact"
done

unset LARGE_FILE_ACCEPTANCE_CHAT_ID
trap - EXIT
rm -rf -- "$acceptance_dir"
```

Record only the final JSON object emitted by each acceptance tool, plus the UTC time and reviewed
deployment revision. A successful upload is confirmed before evidence is emitted, and the Telegram
media/progress message is deleted before the tool reports `telegramCleanup: true`. If the tool emits
only `{"accepted":false}`, inspect sanitized service metrics/logs without copying request URLs,
delete any acceptance messages manually, remove the generated artifact, and stop. Do not retry a
boundary upload until the prior delivery outcome and cleanup are known.

This harness exercises the production grammY adapter, bounded disk stream, renewable bridge lease,
and official local Bot API. It intentionally uses a single-purpose in-memory backend claim so it
cannot mutate production job, delivery, artifact, retention, or download state. A full live
X-to-worker-to-RustFS-to-Telegram job and active process restart are covered only by live
validation against a real deployment.

For Dokploy, use the separate `compose.acceptance.dokploy.yaml` definition instead of a container
console or production profile. Create it as a temporary Git-backed Compose service at the same
reviewed revision. Its non-polling one-shot reuses the worker image but has no backend network,
host port, domain, or restart policy. It receives only the bot token, a single admin ID,
the four reviewed size limits, and the non-secret name of the existing production `telegram-egress`
network. A multiple-admin list is not valid for this run.

1. Verify the normal reviewed revision is healthy, exactly one bridge polls, no delivery lease is
   active, and the host has room for the complete 1,990,000,000-byte logical file plus Bot API
   staging and build headroom.
2. Resolve the exact production `telegram-egress` Docker network with a read-only inspection. Create
   the temporary Compose service with path `./compose.acceptance.dokploy.yaml`; do not change or
   redeploy production.
3. Supply only the allowed environment values, deploy once, and confirm production still has exactly
   one healthy polling bridge. Dokploy's detached Compose command can finish before the one-shot
   does. Monitor the exact `large-file-acceptance` container until it exits. The runner generates,
   validates, uploads, and removes `above-hosted` first. It starts `boundary` only after the first
   case reports `accepted: true`, `telegramCleanup: true`, and `artifactCleanup: true`.
4. Treat container exit 0 plus exactly two allowlisted JSON evidence lines as success. Any other
   output or exit state is failure. If the first case fails or either cleanup field is not true, do
   not attempt the boundary case.
5. On success or failure, delete the temporary Compose service and its exact container and named
   scratch volume. Confirm that no temporary network, domain, custom command, container, or volume
   remains, and that exactly one bridge plus all private production core services are healthy.

The runner uses a read-only root, UID/GID 10001, a dedicated disposable volume only for its bounded
scratch directory, and a minimal child environment. It captures all child output and emits only
allowlisted acceptance JSON. Never render either Compose environment or copy unsanitized container
diagnostics. If the external network cannot be resolved exactly or the temporary service would
expose secrets, stop before deployment.

## Migrations and upgrades

The original `migrations/` files are immutable and frozen. `drizzle/0000_existing_schema.sql` is a
no-op baseline whose snapshot describes that existing schema; all future schema changes are
generated into `drizzle/`. `migrate` applies both histories under the database migration lock and is
a completed dependency of the application services.

To make a schema change, edit `packages/db/schema.ts`, generate a migration, review the SQL, and run
the schema and integration checks. Never use `drizzle-kit push` against a shared or production
database, and never edit an already deployed migration.

```sh
deno task db:generate
deno task db:check
deno task test:integration
```

Before an upgrade:

```sh
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > video-downloader.dump
docker compose pull
docker compose build --pull
docker compose up -d migrate
docker compose up -d
```

Use explicit values instead of shell variables on platforms where those variables are not loaded.
Keep the backup off the Docker host and test restoration regularly. Restore into an empty database:

```sh
docker compose exec -T postgres createdb -U video_downloader video_downloader_restore
docker compose exec -T postgres pg_restore -U video_downloader -d video_downloader_restore --clean --if-exists < video-downloader.dump
```

RustFS is single-node and therefore not redundant. If `forever` is enabled, back up the
`rustfs-data` volume or replicate/export the private bucket according to the deployment's recovery
objectives. Database backups alone do not preserve artifacts.

## Health and observability

| Service         | Endpoint                        | Readiness dependencies                |
| --------------- | ------------------------------- | ------------------------------------- |
| API             | `:8080/health/ready`            | PostgreSQL                            |
| Worker          | `:8081/health/ready` (internal) | PostgreSQL, RabbitMQ, RustFS          |
| Telegram bridge | `:8082/health/ready` (internal) | backend API and verified bot identity |
| Local Bot API   | TCP `:8081` (profile-internal)  | listening official Bot API process    |
| Maintenance     | `:8083/health/ready` (internal) | PostgreSQL, RabbitMQ, RustFS          |

Each application service exposes Prometheus text at `/metrics` when enabled. Prometheus scrapes and
stores these series in `prometheus-data` for seven days. Structured logs contain correlation, job,
delivery, transition, and safe error fields; shared redaction removes authorization values,
credentials, tokens, and media URL query strings. Do not increase log verbosity by logging raw
Telegram updates, yt-dlp URLs, or process environments.

Applications send those JSON records to Loki's `loki-data` volume, also with seven-day retention.
Delivery to Loki is best-effort so an observability outage cannot stop downloads. Docker stdout is
limited to two 10 MiB files per container and is only a recent fallback. Both UIs/APIs bind to
loopback: Prometheus at `http://127.0.0.1:9090` and Loki at `http://127.0.0.1:3100`.

Download lifecycle events are correlated by `jobId` without logging the source URL, Telegram user,
chat, or message identifiers. The expected sequence is `telegram.download_request_received`,
`job.submitted`, `telegram.request_queued`, `outbox.job_published`, `job.claimed`, worker
`job.download_phase`/`job.phase`, `job.ready`, `telegram.delivery_claimed`, per-delivery
`telegram.delivery_phase` (including `uploading_status`), `telegram.media_accepted`, and
`telegram.delivery_completed`. Queue age, phase duration, artifact-ready delivery wait, stream
time-to-first-byte, stream duration, Telegram response wait, and end-to-end service totals are
numeric millisecond fields. `telegram.delivery_loop_started` records the effective delivery poll
interval after configuration has been parsed; Dokploy pins it to 250 ms. A `telegram.media_accepted`
record means the Bot API returned success; Telegram provides bots no human read/open receipt, so it
must not be described as proof that the user viewed the message.

Neither endpoint has an application password in this Compose deployment. Loki has no built-in
authentication layer, and Prometheus web authentication is intentionally not enabled because both
ports are loopback-only. Do not publish either port or attach a public proxy route directly. For
remote access, use an SSH/VPN tunnel or a TLS-authenticated reverse proxy; keep the direct container
ports private. No Loki or Prometheus credential environment variables are required in this mode.

Useful diagnostics:

```sh
docker compose ps
docker compose logs --since=15m api worker maintenance
curl -G --data-urlencode 'query={service="worker"}' --data-urlencode 'since=1h' http://127.0.0.1:3100/loki/api/v1/query_range
curl -G --data-urlencode 'query={service=~"api|maintenance|worker|telegram"} | json | jobId="JOB_UUID"' --data-urlencode 'since=24h' http://127.0.0.1:3100/loki/api/v1/query_range
curl -G --data-urlencode 'query=video_downloader_jobs_queued' http://127.0.0.1:9090/api/v1/query
docker compose exec -T postgres psql -U video_downloader -d video_downloader -c "select state,count(*) from jobs group by state order by state"
docker compose exec -T rabbitmq rabbitmq-diagnostics -q check_running
```

If Docker reports RabbitMQ as unhealthy while AMQP clients remain connected, inspect the probe
history before restarting it:

```sh
docker inspect --format '{{json .State.Health}}' "$(docker compose ps -q rabbitmq)"
docker compose exec -T rabbitmq time rabbitmq-diagnostics -q -t 10 ping
```

The Compose healthcheck limits its CLI runtime to one Erlang scheduler, gives the minimal
authenticated probe 10 seconds internally, and gives it 15 seconds at the Docker boundary. Repeated
`Healthcheck timed out` entries indicate scheduler or host contention; authentication or node-name
errors instead require checking the Erlang cookie and container hostname. Preserve the probe output
with the incident logs.

## Failure and recovery behavior

- An unpublished outbox row is reclaimed after its lock expires. Publication after a broker confirm
  but before the database mark may duplicate a message; the PostgreSQL job lease prevents duplicate
  processing.
- An unacknowledged RabbitMQ message is redelivered after worker death. Expired PostgreSQL worker
  leases are reclaimable. Each claim has an attempt-specific owner, so an old attempt cannot renew a
  replacement attempt's lease. Recent/active temp markers are preserved during overlap and stale
  abandoned attempt directories are reclaimed periodically. A yt-dlp X metadata transport timeout
  is routed through the dedicated `WORKER_SOURCE_TIMEOUT_RETRY_DELAY_SECONDS` delay (five seconds by
  default), while storage and other infrastructure failures use `WORKER_RETRY_DELAY_SECONDS` (30
  seconds by default). Telegram displays `retrying after source timeout` during the short wait.
- Expired Telegram delivery leases return to the polling claim path. Ambiguous Telegram outcomes
  retry the same edit without send-new fallback. A confirmed permanent edit incompatibility records
  the new message ID before deleting/editing the old progress reply. If renewal ownership is lost,
  the old owner cannot renew, persist an operation, fail, or complete the replacement owner's lease.
- RustFS upload uses a temporary key, verifies metadata, promotes to an opaque final key, then
  commits `ready`. Failed attempts remove both keys when possible.
- Maintenance never claims an artifact with an active delivery lease. Cleanup deletion is
  idempotent, transient failures move to `delete_failed`, and abandoned uploads are reclaimed.

For a controlled live recovery exercise, inspect only safe job/delivery identifiers and states.
Restart `telegram-bridge` while a delivery is ready, leased, or retrying, then verify that the same
job/artifact reaches a terminal delivery state and that the worker attempt count does not increase.
Restart `worker` only while a queued or leased download can be observed safely; after its lease
expires, verify reclaim or a bounded failure. Never print source URLs, Telegram payloads, or service
environment values while collecting this evidence.

## Telegram access administration

- `/help` is role-aware and the command menu has a normal private-chat scope plus
  per-bootstrap-admin scopes. These menus are informational; every API call rechecks the persistent
  principal.
- `/request`, or a valid first X URL from an unknown private-chat user, records a pending request
  but never creates a download job. Administrators receive a numeric-ID-only notification. Both that
  notification and `/requests [page]` include allow/deny buttons; the command alternatives remain
  `/allow USER_ID [note]` and `/deny USER_ID reason`. Numeric IDs in `/requests` are inline
  `tg://user?id=...` profile links; Telegram privacy settings can prevent a profile from opening.
- A button opens a `ForceReply` prompt. Reply with an optional internal note, `/skip` for an empty
  note, or `/cancel_action` to cancel the action. Telegram cannot submit a truly empty message and
  has no native free-text bot modal. Until the prompt is answered, cancelled, or expires after
  `TELEGRAM_ADMIN_PROMPT_TTL_SECONDS`, new access-request notices stay queued for that administrator
  only; other administrators continue receiving theirs.
- Internal notes are stored in PostgreSQL and full audit changes. `/users` can display a principal
  note, but requester decision messages and `/audit` never disclose it. A reject button denies the
  current request without disabling a principal. The requester receives a neutral decline and can
  reopen the request after `ACCESS_REQUEST_DENIED_COOLDOWN_SECONDS` (604800 by default). `/deny`
  instead disables the principal until `/allow`.
- Notifications are a PostgreSQL per-admin outbox. The bridge periodically claims them with a lease,
  retries transient/ambiguous errors with bounded backoff, records permanent failure for operator
  inspection, skips rows resolved before send, and discovers newly active administrators. Partial
  success does not resend notifications already recorded sent. An ambiguous crash-after-send may
  duplicate the safe notice because Telegram offers no idempotency key; allow/deny remains
  idempotent and server-authorized.
- Repeated pending requests update one row and do not create repeated jobs. A denial suppresses a
  new pending request during the seven-day request-retention window. Request/allow/deny transactions
  serialize on the target numeric ID, including before a principal exists; no operator repair is
  expected after concurrent resolution.
- `/users [page]`, `/jobs [active|failed|recent] [page]`, and `/audit [page]` keep output below the
  Telegram message limit. Audit output omits raw change payloads.

## Retention

- `forever`: no automatic artifact expiry. Requires a deliberate backup policy.
- `ttl`: expiry is calculated from artifact readiness using the per-job snapshot.
- `after_delivery`: expiry is scheduled only after all intended deliveries are durably complete,
  plus the configured grace period.

Identical immutable X source IDs reuse a ready artifact without entering the download queue.
Different sources that produce the same SHA-256 and byte size also share one object. Shared files
use the most conservative policy across all referencing jobs, so a shorter policy can never delete
an object still required by a longer one.

`JOB_HISTORY_TTL_SECONDS=604800` removes audit events and published outbox records after seven days.
It also removes terminal job history after seven days once the referenced artifact is confirmed
deleted. Set it to zero only for an explicit indefinite metadata-retention policy.

`ACCESS_REQUEST_TTL_SECONDS=604800` independently removes pending and resolved access-request
metadata and cascade-deletes decision prompts and both notification outboxes after seven days.
Disabled principals remain disabled until an administrator allows them; purging a request never
grants access.

Bot command-menu registration is bounded and best-effort. `telegram.command_registration_incomplete`
means one or more `setMyCommands` calls failed or timed out; it does not make the bridge unready or
stop polling/delivery, and backend authorization continues to control every command.

## Troubleshooting

- `ConfigError` on startup: production placeholder detection is intentional. Inspect the listed
  variable names; values are not emitted.
- Worker not ready: check the RabbitMQ vhost/credentials, bucket initialization, and that yt-dlp,
  FFmpeg, and ffprobe exist in the worker image. A worker that exits during startup may also have an
  unwritable, symlinked, broad, or incorrectly mounted `DOWNLOAD_TEMP_DIR`.
- Jobs stay queued for more than a few seconds: the outbox normally publishes within 250 ms. Check
  maintenance health, unpublished-outbox metrics, then RabbitMQ and worker health.
- `retrying after source timeout`: yt-dlp reached the X metadata request but its HTTP read timed out
  before metadata was returned. This is not a JSON parser failure. The bounded retry uses the short
  source-timeout queue; use the logged failure kind, process exit code, and redacted stderr excerpt
  to distinguish it from invalid metadata. An inline Telegram X preview may still appear because
  Telegram's preview retrieval/cache is independent of the worker's live yt-dlp request.
- Delivery stays ready/retry_wait: check bridge health and Telegram rate-limit logs. Delivery retry
  does not require another download.
- Local Bot API is unhealthy: verify only that `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are set in
  the ignored deployment environment, that the named volume is writable by UID 10001, and that the
  host can reach Telegram. Never inspect or print the service environment. A server that is healthy
  while the bridge is unready usually indicates an incomplete hosted-to-local bot migration or an
  invalid BotFather token, not a reason to delete the working volume.
- Cleanup retries: verify RustFS credentials/capacity and inspect `delete_failed` artifacts. Do not
  manually delete PostgreSQL rows before reconciling object storage.
- Extractor regressions: run the opt-in live X smoke test in [verification](verification.md),
  review [compatibility](compatibility.md), and update yt-dlp deliberately with its pinned checksum.
  Normal CI never depends on live X.
- `X has withheld this post in the download server's region due to local law`: X's public
  syndication endpoint confirmed a regional restriction. A post may play in the requester's country
  while being withheld in the server's country. The job fails as `source_unavailable` after one
  attempt, with `sourceRestriction=region_withheld` in the metadata-phase log. Retrying or updating
  yt-dlp does not remove the restriction. The diagnostic runs only after the exact ambiguous
  `No video could be found in this tweet` extractor error; it is limited to five seconds and 64 KiB,
  follows no redirects, and preserves the original retryable error if X does not confirm a block.
