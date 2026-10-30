# Dokploy production deployment

This runbook deploys the complete production stack from this repository with
`compose.dokploy.yaml`. Size the host from the resource envelope and disk budget below. The
repository never mutates Dokploy, migrates the bot account, or uses live Telegram credentials; the hosted-to-local account cutover is an
operator-controlled procedure described at the end of this runbook.

## Deployment invariants

- Do not add a Dokploy domain, Traefik label, host port, or `dokploy-network` attachment to any
  service. This stack has no public HTTP surface.
- Use `compose.dokploy.yaml` as the single Compose path. It is standalone so Dokploy does not need a
  fragile multi-file merge command.
- Dokploy performs a fresh Git clone for each deployment. All build contexts and Dockerfile paths
  are relative to the repository root. Runtime state uses named volumes only.
- Loki and Prometheus configuration is copied into images by `Dockerfile.observability`; no runtime
  service bind-mounts a mutable file from the cloned checkout.
- Keep `TELEGRAM_BRIDGE_REPLICAS=0` through the first deployment and health review. Set it to `1`
  only after the bot has been moved to the local Bot API server (or for a bot that never used the
  hosted API). Exactly one polling bridge may own the bot.
- Never render, inspect, screenshot, or copy a Compose configuration containing real credentials.
  Use the validation sentinels below for offline checks.

## Private topology

Compose `expose` entries document container ports; they do not publish host ports. Docker DNS uses
the service names shown below.

| Service                                   | Private networks                              | Internal port | Outbound internet          | Persistent state                |
| ----------------------------------------- | --------------------------------------------- | ------------: | -------------------------- | ------------------------------- |
| PostgreSQL                                | `backend`                                     |          5432 | no                         | `postgres-data`                 |
| RabbitMQ                                  | `backend`                                     |          5672 | no                         | `rabbitmq-data`                 |
| RustFS                                    | `backend`                                     |          9000 | no                         | `rustfs-data`                   |
| API                                       | `backend`, `observability`                    |          8080 | no                         | PostgreSQL/RustFS only          |
| Worker                                    | `backend`, `observability`, `worker-egress`   |          8081 | yes, for public X media    | `worker-temp` scratch           |
| Maintenance                               | `backend`, `observability`                    |          8083 | no                         | PostgreSQL/RustFS only          |
| Telegram bridge                           | `backend`, `observability`, `telegram-egress` |          8082 | yes                        | PostgreSQL through API          |
| Local Bot API                             | `telegram-egress`                             |          8081 | yes, for Telegram          | `telegram-bot-api-data`         |
| Large-file acceptance (temporary Compose) | existing `telegram-egress`                    |          none | only through local Bot API | disposable `acceptance-scratch` |
| Loki                                      | `observability`                               |          3100 | no                         | `loki-data`                     |
| Prometheus                                | `observability`                               |          9090 | no                         | `prometheus-data`               |

`backend` and `observability` have `internal: true`. `worker-egress` contains only the worker.
`telegram-egress` contains only the bridge and official Bot API server during normal operation. A
separate temporary Compose service from `compose.acceptance.dokploy.yaml` may join the exact
existing network for one controlled acceptance run. The Bot API and acceptance services never join
`backend`, and the backend remains Telegram-independent.

The RabbitMQ management image remains pinned for compatibility, but port 15672 is neither declared
nor published. RustFS console support is disabled. Do not add either endpoint to Dokploy Domains.

## Volumes and disk budget

The seven named volumes survive ordinary container replacement:

| Volume                  | Purpose                                                | Current backup boundary                                                                                         |
| ----------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `postgres-data`         | authoritative metadata, job, delivery, and audit state | no automated backup is provided; do not delete on rollback                                    |
| `rabbitmq-data`         | durable dispatcher queues                              | no automated backup is provided; PostgreSQL remains authoritative                             |
| `rustfs-data`           | private artifacts                                      | no automated backup is provided; `forever` retention needs an independent backup policy |
| `loki-data`             | seven-day logs                                         | reproducible operational history, not application authority                                                     |
| `prometheus-data`       | seven-day metrics, capped at 5 GB                      | reproducible operational history                                                                                |
| `telegram-bot-api-data` | sensitive TDLib/Bot API working state                  | backup is out of scope for this deployment; preserve it during ordinary rollback                                |
| `worker-temp`           | marked, recoverable download/remux scratch             | backup is out of scope; never treat it as artifact storage                                                      |

The worker enforces `DOWNLOAD_MAX_TEMP_BYTES` per active job. The acceptance one-shot reuses the
worker image with its own disposable `acceptance-scratch` volume; it creates one controlled artifact
at a time and removes its exact working directory before emitting success or starting the boundary
case. The reviewed 1,990,000,000-byte artifact ceiling uses a 3,982,000,000-byte temporary budget;
two worker slots can therefore account for 7,964,000,000 bytes before filesystem headroom. A named
volume is not a filesystem quota. RustFS multipart promotion, local Bot API staging, logs,
databases, container layers, and an active build can consume disk at the same time.

The production default `STORAGE_MAX_BYTES=100000000000` caps ready artifact bytes at 100 GB. Keep
enough free disk beyond that ceiling for the operating system, Dokploy, image/build layers, temporary
media, Bot API state, and operational headroom. Lower the artifact ceiling if other
services grow; do not raise it without a new capacity review.

## Resource envelope and hardening

Long-running limits total 5.5 CPUs and approximately 6.4 GB RAM. The two one-shot initialization
jobs add at most 0.5 CPU and 256 MB while they run, leaving host capacity for Dokploy, the OS, and
build overhead. The first Telegram Bot API source build uses two compiler jobs and should be watched
from another session because image builds are outside runtime resource limits.

| Service         | CPU limit | Memory limit | Stop grace |
| --------------- | --------: | -----------: | ---------: |
| PostgreSQL      |      0.50 |         1 GB |   1 minute |
| RabbitMQ        |      0.50 |       768 MB |   1 minute |
| RustFS          |      0.50 |         1 GB |   1 minute |
| Loki            |      0.25 |       512 MB | 30 seconds |
| Prometheus      |      0.25 |       384 MB | 30 seconds |
| API             |      0.50 |       256 MB |   1 minute |
| Worker          |      1.50 |         1 GB |  2 minutes |
| Maintenance     |      0.25 |       192 MB |   1 minute |
| Telegram bridge |      0.25 |       256 MB |  2 minutes |
| Local Bot API   |      1.00 |         1 GB |   1 minute |

Application, RustFS, Loki, Prometheus, and Bot API containers run non-root with read-only roots,
dropped capabilities, `no-new-privileges`, PID limits, bounded tmpfs mounts, and writable named
volumes only where needed. PostgreSQL uses a read-only root plus its data volume and runtime tmpfs.
RustFS receives a bounded 64 MB `/logs` tmpfs for telemetry files while its structured service logs
still flow through stdout and Loki. RabbitMQ retains its official entrypoint privileges because
first-start volume ownership is part of that image's supported initialization path; it still has
`no-new-privileges`, a PID limit, resource limits, private networking, and a 4 GB free-disk alarm.

All long-running services have health checks and `unless-stopped` restart behavior. `migrate` and
`rustfs-init` are one-shot jobs with `restart: "no"`. API, worker, and maintenance wait for healthy
infrastructure and successful initialization. When scaled to one, the bridge waits for healthy API,
worker, maintenance, and Bot API services.

## Git source setup

Dokploy needs read access to a Git source that contains this repository at the revision to deploy.
Use a public repository URL, or connect a GitHub provider (GitHub App) and grant it access to the
repository. Do not create or paste a personal access token into the stack environment.

1. In Dokploy, create a Compose service in the intended project. Choose the Git or GitHub provider,
   select the repository and branch (for example `main`), and set the Compose path to
   `./compose.dokploy.yaml`. If a GitHub provider is used and the repository is not listed, fix the
   App installation's repository access and refresh the provider rather than falling back to an
   unauthenticated clone URL.
2. Leave Domains empty, do not add ports, and do not attach the service to `dokploy-network`.
3. Disable automatic deploy for the first rollout and any account cutover. Re-enable it only if
   every push to the selected branch should deploy a stateful production stack.

Dokploy creates a new checkout on deploy, so `./Dockerfile`, `./Dockerfile.telegram-bot-api`,
`./Dockerfile.observability`, and the `tools/observability` files must all be committed on the
selected revision. No Dokploy File Mount is required.

## Environment and secrets

Enter values in the Compose service's Environment tab. Dokploy uses them for Compose substitution;
the definition explicitly forwards each value to its owning container. Do not upload `.env` or use
Dokploy's raw-Compose editor as a secret store.

Required deployment values:

```env
INTERNAL_API_TOKEN=
POSTGRES_PASSWORD=
RABBITMQ_PASSWORD=
RUSTFS_ACCESS_KEY=
RUSTFS_SECRET_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_USER_IDS=
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_BRIDGE_REPLICAS=0
```

Generate independent random values for the internal API, PostgreSQL, RabbitMQ, and RustFS secrets.
`TELEGRAM_ADMIN_USER_IDS` is a comma-separated list of canonical positive numeric IDs. It is an
identifier, not a credential, but it must not be committed. `TELEGRAM_API_ID` and
`TELEGRAM_API_HASH` are production secrets and intentionally remain empty in environment examples.
The BotFather token belongs only to `telegram-bridge`; the Telegram application credentials belong
only to `telegram-bot-api`.

The production definition has these reviewed non-secret defaults. Add a value in Dokploy only to
override one deliberately:

```env
APP_LOG_LEVEL=info
APP_TIMEZONE=UTC
POSTGRES_DB=video_downloader
POSTGRES_USER=video_downloader
POSTGRES_POOL_SIZE=10
RABBITMQ_USER=video_downloader
RABBITMQ_VHOST=video_downloader
S3_BUCKET=video-artifacts
S3_REGION=us-east-1
WORKER_CONCURRENCY=2
TELEGRAM_MAX_UPLOAD_BYTES=1990000000
MAX_ARTIFACT_BYTES=1990000000
DOWNLOAD_FORMAT_SAFETY_BYTES=2000000
DOWNLOAD_MAX_TEMP_BYTES=3982000000
STORAGE_MAX_BYTES=100000000000
RETENTION_DEFAULT_MODE=ttl
RETENTION_TTL_SECONDS=604800
JOB_HISTORY_TTL_SECONDS=604800
ACCESS_REQUEST_TTL_SECONDS=604800
```

The production Compose definition pins `TELEGRAM_DELIVERY_POLL_INTERVAL_MS=250` inside the Telegram
bridge. This latency budget is intentionally not overridable from Dokploy, so a stale platform value
cannot restore the former one-second delivery poll. Local Compose remains configurable through
`.env`.

Do not set `APP_ENV`, internal hostnames, `DOWNLOADER_MODE`, `TELEGRAM_MODE`,
`TELEGRAM_BOT_API_ROOT`, or credential aliases in Dokploy; the production topology fixes them to
reviewed values. `.env.example` remains the complete configuration reference.

Required-variable expansions make Compose rendering fail when a secret or administrator ID is empty.
Application startup separately rejects recognizable placeholder secrets, fixture mode, and
inconsistent size or lease settings.

## Offline preflight

Run this from a clean checkout with Docker Compose v2. It uses validation-only values and never
contacts X or Telegram:

```powershell
$env:INTERNAL_API_TOKEN = "validation-only-internal-token-0000000000000000"
$env:POSTGRES_PASSWORD = "validation-only-postgres-password"
$env:RABBITMQ_PASSWORD = "validation-only-rabbitmq-password"
$env:RUSTFS_ACCESS_KEY = "validation-only-rustfs-access"
$env:RUSTFS_SECRET_KEY = "validation-only-rustfs-secret"
$env:TELEGRAM_BOT_TOKEN = "validation-only-bot-token"
$env:TELEGRAM_ADMIN_USER_IDS = "123456789"
$env:TELEGRAM_API_ID = "12345"
$env:TELEGRAM_API_HASH = "validation-only-api-hash"
$env:TELEGRAM_BRIDGE_REPLICAS = "0"
docker compose -f compose.dokploy.yaml config --quiet
```

Do not save or share a rendered configuration. The committed contract tests additionally verify
private networks, secret ownership, named volumes, hardening, initialization order, the stopped
bridge default, and the absence of ports, profiles, host bind mounts, and Traefik metadata. The
temporary acceptance definition is validated separately without rendering real values:

```powershell
$env:TELEGRAM_BOT_TOKEN = "validation-only-bot-token"
$env:TELEGRAM_ADMIN_USER_IDS = "123456789"
$env:TELEGRAM_MAX_UPLOAD_BYTES = "1990000000"
$env:MAX_ARTIFACT_BYTES = "1990000000"
$env:DOWNLOAD_FORMAT_SAFETY_BYTES = "2000000"
$env:DOWNLOAD_MAX_TEMP_BYTES = "3982000000"
$env:PRODUCTION_TELEGRAM_EGRESS_NETWORK = "validation-only-private-network"
docker compose -f compose.acceptance.dokploy.yaml config --quiet
```

Create `compose.acceptance.dokploy.yaml` as a separate Git-backed Dokploy Compose service, never as
a production override. Its environment contains only the token, a single admin
ID, the four reviewed size limits, and the non-secret external network name. Do not add a domain or
custom command. Delete that entire temporary Compose service and its exact scratch volume after the
one-shot exits.

## First deployment and health verification

1. Complete the Git source setup and enter production secrets with `TELEGRAM_BRIDGE_REPLICAS=0`.
2. In Dokploy, deploy the selected reviewed commit. Watch host memory and CPU during the
   first source builds; do not start another heavy build concurrently.
3. Confirm `migrate` and `rustfs-init` both exit successfully with code 0. A failed one-shot job is
   a failed deployment; do not bypass it by manually starting API or worker containers.
4. Confirm PostgreSQL, RabbitMQ, RustFS, Loki, Prometheus, API, worker, maintenance, and local Bot
   API are healthy. Confirm the Telegram bridge has zero replicas; this is intentional before
   the bot is moved to the local Bot API.
5. Review only sanitized logs. Do not inspect container environments, Bot API request targets, or
   rendered Compose output with real values.
6. Leave the stack private. Do not add a temporary domain for health checks.

Dokploy's service view is the preferred check. From the host, container health can also be inspected
without reading environment values:

```sh
sudo docker ps -a --filter label=com.docker.compose.project --format \
  'table {{.Names}}\t{{.Status}}'
sudo docker ps -a --filter label=com.docker.compose.service=migrate --format \
  'table {{.Names}}\t{{.Status}}'
sudo docker ps -a --filter label=com.docker.compose.service=rustfs-init --format \
  'table {{.Names}}\t{{.Status}}'
```

The two one-shot rows must show an exit code of 0. Long-running rows must show `healthy`; an absent
bridge row is correct while its replica count is zero. Prometheus should eventually report API,
worker, maintenance, and bridge targets; the bridge target remains down while the bridge is scaled
to zero. Loki and Prometheus are operational aids and never application dependencies.

## Rollback

While the bridge is still at zero, rollback is a code/config operation only:

1. Keep `TELEGRAM_BRIDGE_REPLICAS=0`.
2. Select the last reviewed Git commit in Dokploy and redeploy it.
3. Preserve every named volume. Do not recreate the Compose service, rename it, or run a volume
   removal command; those actions change Dokploy's generated volume names or destroy state.
4. Verify initialization jobs and health again. If a future revision includes a forward-only schema
   migration, confirm the older application understands that schema before rolling code back.

Once the bridge is live, first scale the bridge back to zero if the new revision is unsafe, then
redeploy the last reviewed code while preserving PostgreSQL, RustFS, and Bot API volumes. Do not
switch back to Telegram's hosted Bot API merely because a container failed: after the official
hosted `logOut`, Telegram may temporarily prevent that return path. Database/artifact rollback and
Bot API account migration are separate operations.

Automated backup creation is not implemented. In particular, `telegram-bot-api-data` and
`worker-temp` are outside the backup scope. A backup policy must not treat either volume as
interchangeable with PostgreSQL or RustFS.

## Disk monitoring

Check disk during the initial build, representative large uploads, and at least daily until alerts
exist:

```sh
df -h / /var/lib/docker
sudo docker system df -v
sudo du -x -h --max-depth=1 /var/lib/docker/volumes | sort -h
```

Use `docker volume ls` and `docker volume inspect` to map Dokploy-generated names before examining a
specific volume. Never delete an unfamiliar volume. Alert at 75% host utilization, investigate and
pause new intake at 85%, and do not allow the filesystem to approach 100%; PostgreSQL, RabbitMQ,
RustFS, Bot API state, and Dokploy itself can all fail when the disk is full.

Watch these separately:

- `rustfs-data` against `STORAGE_MAX_BYTES` and the selected retention policy;
- `worker-temp` against `WORKER_CONCURRENCY * DOWNLOAD_MAX_TEMP_BYTES` plus headroom;
- `telegram-bot-api-data` during multi-gigabyte delivery;
- `loki-data` and the 5 GB-capped `prometheus-data`;
- Docker images/build cache after the source-built Bot API image is replaced.

Do not prune images or volumes as an automated reaction to a disk alert. Identify the owner and
retention state first.

## Hosted-to-local cutover

A new deployment of an existing bot first runs with the bridge at zero; moving that bot from
Telegram's hosted Bot API to the local server is a separate, operator-controlled account migration
and not part of the first deployment. A bot that has never used the hosted API needs no migration:
set `TELEGRAM_BRIDGE_REPLICAS=1` once the core stack is healthy. Otherwise:

1. Confirm the Dokploy core stack and local Bot API are healthy with the bridge still at zero.
2. Record a safe backend snapshot proving there is no active download or delivery lease.
3. Stop every old polling bridge. Confirm only the existing hosted path currently owns the bot.
4. In a maintenance window, follow Telegram's official
   [hosted-to-local migration procedure](https://github.com/tdlib/telegram-bot-api#moving-a-bot-to-a-local-server),
   including hosted `logOut`. Never place the token in shell history or logs.
5. Change only `TELEGRAM_BRIDGE_REPLICAS` from `0` to `1` in Dokploy and redeploy. The bridge waits
   for healthy core services and `telegram-bot-api` before polling.
6. Validate identity, commands, authorization, sub-50 MB and controlled above-50 MB delivery,
   restart recovery, retention, disk growth, and sanitized observability evidence.
7. Keep any local development containers stopped so they cannot compete for polling.

Never run hosted and local polling bridges concurrently. If cutover cannot be completed safely,
leave the Dokploy bridge at zero and stop; do not delete the Bot API state volume or improvise an
account migration.
