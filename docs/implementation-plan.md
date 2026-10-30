# Implementation Plan

Status: complete. Milestones 0–6 are implemented and the service runs in production; this document
is retained as the record of the implementation plan and its gates. Where later work superseded a
planning detail (for example the official local Telegram Bot API server, large-file delivery, and
the Dokploy topology), [architecture](architecture.md), [operations](operations.md), and
[Dokploy](dokploy.md) are authoritative.

Plan date: 2026-08-12

Governing documents: [requirements](requirements.md) and [approved architecture](architecture.md)

## 1. Delivery objective

Deliver a self-hosted, X-only MVP in which an authorized user sends one public X status URL to a
Telegram bot, sees a single acknowledgement/progress reply, and receives the finished video in that
reply. Downloads run outside the bridge, jobs survive process restarts, artifacts follow the
configured retention policy, and administration starts with audited Telegram commands.

The implementation was considered complete only when the fake end-to-end suite, restart/recovery
tests, Compose health checks, security checks, and the 80% core line-coverage gate pass. A real
Telegram test was a final deployment validation, not a prerequisite for building the system.

## 2. Fixed MVP decisions

- TypeScript on Deno 2.x for all application-owned code.
- Hono HTTP API with Zod runtime validation and generated OpenAPI.
- PostgreSQL as the authoritative state store.
- RabbitMQ as the durable job dispatcher; no Dramatiq or Python service.
- RustFS as private S3-compatible artifact storage.
- grammY Telegram bridge, initially using long polling and Telegram's hosted Bot API.
- yt-dlp, FFmpeg, and ffprobe as external worker processes.
- Public X status URLs only; one URL per request; no generic extractor.
- Private Telegram chats only for the MVP.
- 49,000,000-byte default output ceiling, source-format downgrade permitted, transcoding excluded.
- Seven-day TTL as the default retention mode, while `forever` and `after_delivery` remain
  configurable and tested.
- Numeric administrator IDs bootstrapped through environment configuration; the persistent allowlist
  and audit trail live in PostgreSQL.
- Docker Compose as the local and initial production deployment model.

## 3. Repository layout

```text
video_downloader/
├── apps/
│   ├── api/                  # Hono routes, authentication, health, OpenAPI
│   ├── worker/               # RabbitMQ consumer and download orchestration
│   ├── telegram_bridge/      # grammY update and delivery handlers
│   └── maintenance/          # outbox publisher, expiry, cleanup, recovery
├── packages/
│   ├── config/               # typed environment parsing and secret redaction
│   ├── contracts/            # Zod API/message schemas and error codes
│   ├── domain/               # state machines and policy functions
│   ├── db/                   # postgres client, repositories, transactions
│   ├── queue/                # RabbitMQ topology, publisher, consumer helpers
│   ├── storage/              # S3/RustFS artifact adapter
│   ├── downloader/           # yt-dlp/FFmpeg adapter and progress parser
│   ├── telegram/             # Telegram-independent delivery mapping helpers
│   └── observability/        # structured logs, metrics, correlation IDs
├── migrations/               # frozen, immutable pre-Drizzle SQL migrations
├── drizzle/                  # reviewed, generated Drizzle migrations
├── tests/
│   ├── fixtures/             # yt-dlp JSON and media fixtures
│   ├── unit/                 # pure logic and Compose contract tests
│   ├── integration/          # PostgreSQL/RabbitMQ/RustFS tests
│   └── e2e/                  # fake Telegram-to-artifact workflow
├── tools/                    # migration, storage init, quality gates, acceptance tools
├── compose.yaml
├── compose.telegram-local.yaml
├── compose.dokploy.yaml
├── compose.acceptance.dokploy.yaml
├── Dockerfile
├── Dockerfile.observability
├── Dockerfile.telegram-bot-api
├── deno.json
├── deno.lock
└── .env.example
```

One application image exposes separate entry tasks (`api`, `worker`, `telegram`, `maintenance`).
This keeps the dependency set consistent without collapsing service boundaries.

## 4. Configuration contract

`packages/config` is the only module that reads environment variables. It validates them once at
startup using Zod, returns an immutable typed config, and fails fast with variable names but never
secret values.

Configuration categories are represented in `.env.example`:

- application/API;
- PostgreSQL;
- RabbitMQ topology and credentials;
- RustFS/S3 endpoint, bucket, and credentials;
- Telegram token, admin IDs, Bot API root, and delivery limits;
- authorization and queue limits;
- worker leases, retries, external tool paths, and download limits;
- retention/cleanup;
- metrics and optional telemetry.

Production startup must reject placeholder secrets, `DOWNLOADER_MODE=fixture`, an empty admin list
for the live bridge, an insecure public RustFS bucket, and inconsistent timing such as a heartbeat
interval greater than its job lease.

The operational defaults are two worker slots, two active jobs per user, 30-minute
maximum source duration, 1080p maximum height, 15-minute execution timeout, and a 49 MB Telegram
ceiling. All remain configurable.

## 5. Domain model

### 5.1 Principal

Fields:

- internal UUID;
- bridge type (`telegram` initially);
- stable external user ID stored as text/bigint-safe data;
- role (`admin` or `user`);
- state (`active`, `disabled`);
- optional expiry and note;
- creator/updater and timestamps.

A unique constraint on `(bridge, external_user_id)` prevents duplicate rules. Admins from
`TELEGRAM_ADMIN_USER_IDS` are idempotently upserted at startup and cannot accidentally be demoted by
a bootstrap run.

### 5.2 Job

Fields:

- UUID and public short display ID;
- bridge and idempotency key;
- requester principal;
- submitted and normalized source URL;
- source type (`x`) and extracted source status/media ID;
- state, progress phase/percentage, queue position hint;
- attempt count, lease owner/expiry, heartbeat, cancellation request;
- immutable limits and retention-policy snapshot;
- selected format and sanitized media metadata;
- artifact reference;
- structured error code and safe message;
- created, started, ready, delivered, failed, cancelled, and expired timestamps.

The unique idempotency key is derived from the Telegram update/message identity, not from the URL.
Reposting the same URL intentionally creates a new job, while Telegram/API retries of one update
return the existing job. Authorization precedes the lookup, and the persisted submission snapshot
distinguishes omitted retention from an explicit client policy. An omitted-policy retry remains
idempotent if the server default changes; crossing the omitted/explicit boundary or changing other
request semantics conflicts. Legacy jobs without the marker use their resolved policy for
backward-compatible comparison.

### 5.3 Artifact

Fields:

- UUID and opaque RustFS object key;
- lifecycle state (`uploading`, `ready`, `deleting`, `deleted`, `delete_failed`);
- byte size and SHA-256 checksum;
- container, codecs, duration, dimensions, and optional title;
- creation, ready, expiry, and deletion timestamps;
- active delivery lease count/marker.

No API response exposes a host filesystem path, S3 credentials, or unrestricted object URL.

### 5.4 Delivery

Fields:

- UUID, job/artifact, bridge type, and opaque destination JSON;
- Telegram chat ID, user request message ID, and bot progress message ID inside the
  Telegram-specific destination payload;
- state (`pending`, `leased`, `delivering`, `delivered`, `retry_wait`, `failed`);
- attempts, lease owner/expiry, next attempt time, last safe error;
- resulting Telegram message/file IDs where available;
- created, started, and completed timestamps.

Download readiness and delivery success are independent. An artifact is not eligible for
`after_delivery` deletion until every intended delivery is durably acknowledged.

### 5.5 Outbox and audit event

The transactional outbox contains event ID, type, aggregate ID, validated JSON payload, attempt
state, and publication timestamps. Initially it publishes download job IDs; it is designed to add
bridge events later without changing the job transaction.

Audit events record actor, action, target, result, timestamp, correlation ID, and sanitized change
details. Administrative failures are audited as well as successes.

## 6. Job state machine

Allowed primary transitions:

```text
queued -> downloading -> processing -> ready -> delivering -> delivered
   |          |              |           |           |
   +----------+--------------+-----------+-----------+-> failed
   |          |              |
   +----------+--------------+--------------------------> cancelled
                                      ready/delivered --> expired
```

Rules:

- `queued` is committed before the RabbitMQ message is published.
- A worker can claim only `queued` or an expired leased/retryable job.
- Cancellation is a request first. The worker terminates its child process, removes partial output,
  then commits `cancelled`.
- `ready` requires a validated RustFS object and artifact row.
- `delivered` requires a successful Telegram API result persisted on the delivery row.
- `failed` contains a stable error code and user-safe message; raw process output is limited to
  sanitized diagnostic logs.
- `expired` reflects successful policy cleanup or confirmed absence. Failed deletion remains
  retryable and visible to operators.
- Every transition is implemented by a compare-and-set repository operation so duplicate messages
  cannot move state backward.

Initial error-code families include invalid/unsupported URL, unauthorized, queue full, cancelled,
source unavailable, extractor failure, timeout, no format within limit, processing failure, storage
failure/full, delivery retryable, delivery permanent, and cleanup failure.

## 7. API surface

All `/v1` routes except health/readiness and optional metrics require the shared internal bearer
token. Request/response bodies and error envelopes use exported Zod schemas and appear in OpenAPI.

Endpoints:

| Method and path                                        | Purpose                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `GET /health/live`                                     | Process liveness only.                                                                        |
| `GET /health/ready`                                    | PostgreSQL plus service-specific dependency readiness.                                        |
| `GET /metrics`                                         | Prometheus-format metrics when enabled.                                                       |
| `POST /v1/jobs`                                        | Authorize principal, validate X URL, create idempotent job and delivery, insert outbox event. |
| `GET /v1/jobs`                                         | Paginate filtered own jobs, or all matching jobs for an administrator.                        |
| `GET /v1/jobs/{id}`                                    | Read requester-safe job and artifact metadata.                                                |
| `POST /v1/jobs/{id}/cancel`                            | Request cancellation with ownership/admin checks.                                             |
| `POST /v1/jobs/{id}/retry`                             | Admin-only retry of eligible terminal jobs.                                                   |
| `GET /v1/artifacts/{id}/content`                       | Authenticated, range-capable artifact stream for the bridge.                                  |
| `POST /v1/deliveries/claim`                            | Lease the next ready Telegram delivery.                                                       |
| `POST /v1/deliveries/{id}/heartbeat`                   | Extend an active delivery lease.                                                              |
| `POST /v1/deliveries/{id}/complete`                    | Persist Telegram result and delivery acknowledgement.                                         |
| `POST /v1/deliveries/{id}/fail`                        | Schedule retry or record a permanent safe failure.                                            |
| `GET /v1/principals`                                   | Admin list of allowed/disabled principals.                                                    |
| `PUT /v1/principals/telegram/{userId}`                 | Admin allow/upsert.                                                                           |
| `DELETE /v1/principals/telegram/{userId}`              | Admin disable; retain audit history.                                                          |
| `POST /v1/access-requests/telegram/{userId}`           | Deduplicate an update-derived access request without granting access.                         |
| `GET /v1/access-requests`                              | Admin-only paginated pending access requests.                                                 |
| `POST /v1/access-requests/{id}/decision-prompts`       | Begin an expiring admin allow/deny prompt.                                                    |
| `GET /v1/access-decision-prompts/active`               | Read the acting admin's active reply prompt.                                                  |
| `POST /v1/access-decision-prompts/{id}/message`        | Attach the Telegram `ForceReply` message ID.                                                  |
| `POST /v1/access-decision-prompts/{id}/resolve`        | Resolve the prompt with an optional internal note.                                            |
| `POST /v1/access-decision-prompts/{id}/cancel`         | Cancel the prompt without deciding the request.                                               |
| `POST /v1/access-decision-notifications/claim`         | Lease a neutral requester decision notice.                                                    |
| `POST /v1/access-decision-notifications/{id}/complete` | Persist requester-notice success.                                                             |
| `POST /v1/access-decision-notifications/{id}/fail`     | Retry or terminally fail a requester notice.                                                  |
| `GET /v1/audit-events`                                 | Admin-only paginated, sanitized audit events.                                                 |

The Telegram bridge is a trusted internal client, but the backend still applies authorization from
the supplied stable Telegram user ID. This keeps policy out of the bridge and prevents a bridge bug
from bypassing the allowlist.

## 8. RabbitMQ topology and semantics

Phase zero tested candidate TypeScript clients under Deno before the adapter was finalized. The
selected client is `@cloudamqp/amqp-client` 4.0.0 (see [compatibility](compatibility.md)). The
spike demonstrated:

- connecting to RabbitMQ 4.x from the production Deno image;
- declaring/passing a durable quorum work queue;
- persistent publication with publisher confirmation;
- manual acknowledgement and negative acknowledgement;
- message redelivery after terminating a worker;
- reconnecting after a RabbitMQ restart;
- bounded retry through retry/dead-letter routing;
- clean cancellation and shutdown without losing an unacknowledged message.

The adapter API exposes `publishJob(jobId)`, `consumeJobs(handler)`, and health/shutdown
operations. Domain code does not import the selected client.

Outbox publication sequence:

1. select unpublished events with `FOR UPDATE SKIP LOCKED`;
2. validate the stored payload;
3. publish a persistent message and wait for broker confirmation;
4. mark the event published;
5. if the publisher dies after step 3, republish is allowed and the worker's compare-and-set claim
   absorbs the duplicate.

Only identifiers and schema versions are placed on RabbitMQ. URLs, secrets, large metadata, and
artifacts stay in PostgreSQL/RustFS.

## 9. X downloader pipeline

### 9.1 URL policy

The URL parser uses the platform URL API, permits HTTPS only, rejects embedded credentials, ports,
fragments, non-X hosts, and non-status paths, and extracts a numeric status ID. Query parameters
(share tracking such as `s`, `t`, or `a`) are ignored because they never reach the downloader.
Accepted shapes are:

- `https://x.com/{user}/status/{id}`;
- `https://x.com/i/status/{id}`;
- equivalent `www.x.com`, `twitter.com`, and `www.twitter.com` forms.

The normalized URL becomes `https://x.com/i/status/{id}`. The submitted value is retained for audit
but redacted from routine logs. yt-dlp is constrained to the Twitter extractor and one item; the
generic extractor and playlists are disabled.

### 9.2 Metadata and format selection

The worker first runs a metadata-only yt-dlp invocation and validates the JSON through a narrow Zod
schema. Unknown fields are ignored and required media fields are checked explicitly.

Candidate selection prefers:

1. MP4 container;
2. H.264 video and AAC/M4A audio where available;
3. the highest resolution no greater than `DOWNLOAD_MAX_HEIGHT`;
4. a known or conservatively estimated combined size below
   `TELEGRAM_MAX_UPLOAD_BYTES - DOWNLOAD_FORMAT_SAFETY_BYTES`.

Size estimation uses reported `filesize`, then `filesize_approx`, then duration times bitrate.
Unknown estimates are lower priority. The worker enforces a hard temporary-byte ceiling while
downloading and checks the final merged object. If a candidate unexpectedly exceeds the final limit,
it removes partial output and may try the next lower source format without transcoding.

### 9.3 Execution and cancellation

- Spawn yt-dlp with an argument array, never a shell command string.
- Use a unique job-scoped directory owned by the unprivileged worker.
- Parse only explicit JSON/progress templates.
- Throttle progress persistence; completion never depends on exact percentages.
- Capture bounded stderr for diagnostics and apply secret/URL redaction.
- Send graceful termination on cancellation/timeout, then force termination after a short grace
  period.
- Remove all partial files on terminal failure or cancellation.
- Invoke FFmpeg with fixed merge/remux arguments only when needed.
- Run ffprobe on the final MP4 and reject missing video, invalid duration, or an oversized result.
- Calculate SHA-256 during/after finalization before upload.

No public X source cookies are used in the MVP. YouTube EJS, Deno challenge execution, and cookies
are explicitly outside this implementation phase.

## 10. RustFS storage workflow

Use the AWS S3 TypeScript client with path-style addressing against RustFS. A Compose initialization
service creates the private bucket idempotently.

Artifact write sequence:

1. create artifact row in `uploading` state;
2. upload to `temporary/{artifact_id}` with metadata containing only safe IDs;
3. verify reported size and checksum;
4. copy/promote to `artifacts/{artifact_id}`;
5. delete the temporary object;
6. atomically mark the artifact `ready` and job `ready` in PostgreSQL.

Recovery scans reconcile stale `uploading` rows and temporary objects. Content is streamed through
the authenticated backend using range requests so the bridge never receives S3 credentials or a
permanent public URL.

Retention behavior:

- `forever`: no automatic artifact expiry;
- `ttl`: expiry is calculated from artifact readiness using the job's immutable TTL snapshot;
- `after_delivery`: expiry is scheduled only after all deliveries succeed, plus the configured grace
  period.

Cleanup claims eligible artifact rows, ensures no live delivery lease exists, deletes the S3 object,
and then records deletion. Missing objects are treated as idempotent success; transient failures use
bounded retries and metrics.

## 11. Telegram workflow

### 11.1 Intake

1. grammY receives an update through long polling.
2. The bridge ignores non-private chats for download intake.
3. Commands route separately from link messages.
4. A message must contain exactly one accepted X URL and no second URL.
5. The bridge calls `POST /v1/jobs` with the Telegram user, chat, request message ID, and
   update-derived idempotency key.
6. Unauthorized and invalid requests receive concise safe errors.
7. On success, the bridge replies once and persists the returned bot progress message ID through the
   backend delivery context.

The bridge remains responsive because it never runs yt-dlp or FFmpeg.

### 11.2 Progress and delivery

Progress updates are coalesced and edited no more often than the configured interval. Phase changes
are more important than percentage changes.

The delivery loop leases ready rows from the backend, opens the authenticated artifact stream, and
calls `editMessageMedia` on the fixed progress reply. On a confirmed success it persists the
Telegram message/file identifiers, then marks the delivery complete.

Idempotency/error rules:

- retry editing the same message after timeouts or ambiguous network errors;
- treat Telegram's equivalent of “message is not modified” as success only when the stored operation
  context proves the target is already final;
- use send-new-and-delete-old fallback only for a confirmed permanent edit/media incompatibility,
  never merely for a timeout;
- store the fallback message ID before completing delivery;
- a failed Telegram attempt does not change the download job or artifact;
- honor Telegram retry-after information and bounded exponential backoff.

### 11.3 Commands

- `/start` and `/help`: role-aware usage guidance; unauthorized and normal users never receive the
  administrator command list.
- `/request`: create or repeat a deduplicated pending access request. A valid first X URL from an
  unknown user follows the same path and never creates a job before allow.
- `/jobs [active|failed|recent] [page]`: paginated own history; administrators may inspect matching
  jobs across users.
- `/status [job]`: own recent/current job status; admins may inspect by ID.
- `/cancel [job]`: cancel the user's own eligible job.
- `/allow <numeric-user-id> [note]`: admin upsert/enable.
- `/deny <numeric-user-id> [reason]`: admin disable.
- `/users`: paginated admin allowlist.
- `/requests`: paginated pending access requests.
- `/audit`: paginated sanitized audit history without raw change payloads.
- `/retry <job-id>`: admin retry of an eligible failed job.

Every admin command validates numeric IDs, records the acting administrator, and returns a
correlation ID on failure.

The bridge idempotently installs a normal private-chat command menu and an admin-scoped menu for
each configured bootstrap administrator at startup. Registration is bounded and best-effort, so a
429, 5xx, transport, timeout, or permanent menu failure is logged without blocking intake or
delivery. Menus do not replace backend authorization. Pending and resolved access-request metadata
and their prompts and durable notification rows are removed after seven days by maintenance.

Safe access-request notifications and `/requests` pages attach a numeric-ID profile button (subject
to Telegram privacy settings) plus allow/deny inline buttons. A decision callback opens a durable,
expiring Telegram `ForceReply` prompt: reply text is the optional internal note, `/skip` resolves
without one, and `/cancel_action` cancels without resolving. Telegram bots do not have a native
free-text modal. While a prompt remains active, the notification claimant skips that administrator
but continues serving other administrators. `TELEGRAM_ADMIN_PROMPT_TTL_SECONDS` bounds abandoned
prompts.

An allow note is stored on both the principal and resolved request; a request-specific rejection
note is stored on the request. Audit changes retain the internal note, while `/audit` and the
requester's separate neutral decision notification omit it. Button rejection does not create a
disabled principal and the request can reopen after `ACCESS_REQUEST_DENIED_COOLDOWN_SECONDS`;
`/deny` remains a persistent principal disable until `/allow`.

Access-request notifications use one transactional row for each active administrator and request
revision. The bridge periodically reconciles newly active administrators, claims rows with a lease,
and records sent, skipped, retryable, or terminal failure outcomes. Resolution makes unsent work
stale. Telegram provides no idempotency key for `sendMessage`, so crash-after-send remains an
explicit at-least-once duplicate-notice boundary; it never grants access or creates a download.
Request, allow, and deny transactions share one advisory lock per target numeric ID before target
state is read, including when no principal row exists, so concurrent decisions cannot leave a
pending request or deliverable notification behind an active/disabled final principal.

OpenAPI validation failures for malformed path, query, and body data use the standard safe error
envelope and preserve a valid caller correlation ID or generate one. Telegram-local command
validation uses the same user-visible `Reference:` contract without exposing parser details.

## 12. Observability and operations

Structured JSON logs include service, correlation ID, job ID, delivery ID, state transition,
duration, and safe error code. A shared redactor removes authorization headers, bot tokens,
S3/Rabbit/Postgres credentials, cookie-like values, and query strings from external media URLs.

Metrics include:

- job submissions/outcomes and duration by phase/error family;
- queue/outbox age, publication retries, active worker leases, and redeliveries;
- selected format/resolution and downloaded/stored bytes;
- RustFS usage, cleanup outcomes, and expired-object lag;
- Telegram intake, edit/send outcomes, retry-after waits, and delivery latency;
- unauthorized/rate-limited request counts without user labels that create unbounded metric
  cardinality.

Readiness is service-specific:

- API: PostgreSQL and configuration/migrations current;
- worker: PostgreSQL, RabbitMQ, RustFS, yt-dlp, FFmpeg, and ffprobe available;
- bridge: PostgreSQL/API reachable; Telegram identity check only in live mode;
- maintenance: PostgreSQL, RabbitMQ publisher, and RustFS reachable.

Graceful shutdown stops new intake/claims, allows a bounded completion window, terminates external
children when required, and leaves broker messages unacknowledged when durable completion was not
recorded.

## 13. Security work

- Run every application container as a non-root user with a read-only root filesystem where
  practical and a dedicated writable temp mount for workers.
- Give the bridge no PostgreSQL, RabbitMQ, RustFS, yt-dlp, or FFmpeg credentials; it uses only the
  internal API and Telegram token.
- Give workers no Telegram token or administrator configuration.
- Give the API no yt-dlp execution capability.
- Keep RustFS and RabbitMQ management ports off public interfaces by default.
- Use non-default deployment credentials and fail production startup on example placeholders.
- Use parameterized SQL exclusively.
- Validate all API, broker, database JSON, yt-dlp JSON, and Telegram callback boundaries with Zod.
- Apply body limits, timeouts, per-user active-job limits, and global queue caps.
- Do not support `file:`, FTP, arbitrary HTTP, private IP, custom proxy, or user downloader
  arguments.
- Produce a dependency/license inventory for the Deno modules, yt-dlp distribution, FFmpeg build,
  RabbitMQ client, and RustFS image.
- Add secret scanning and dependency vulnerability scanning to CI.

## 14. Test strategy and coverage

### 14.1 Unit tests

- typed configuration, placeholder rejection, and redaction;
- accepted/rejected URL matrix and normalization;
- authorization, expiry, and admin bootstrap rules;
- all job/artifact/delivery state transitions and illegal transitions;
- idempotency-key behavior;
- format ranking and size estimation;
- yt-dlp metadata/progress/error parsing from fixtures;
- retry classification and backoff calculation;
- retention calculations and cleanup eligibility;
- Telegram command parsing, user messages, and fallback classification.

### 14.2 Database tests

- migrations forward from an empty database;
- unique constraints and foreign keys;
- concurrent job submission with one idempotency key;
- compare-and-set worker/delivery leases;
- expired lease reclamation;
- outbox transaction atomicity and `SKIP LOCKED` concurrency;
- admin bootstrap/upsert and audit history;
- retention claims never racing an active delivery.

### 14.3 Adapter integration tests

- RabbitMQ publication confirmation, nack/retry/dead letter, reconnect, and worker-crash redelivery;
- RustFS multipart/stream upload, checksum, range read, deletion, and missing object reconciliation;
- yt-dlp child cancellation, timeout, bounded logs, cleanup, FFmpeg merge, and ffprobe validation
  using local fixtures;
- fake Telegram API acknowledgement, progress edit, media replacement, 429, timeout, permanent
  error, and fallback.

### 14.4 End-to-end tests

The principal automated scenario is:

1. fake Telegram update from bootstrapped admin/allowed user;
2. bridge submits a valid sample-style X URL;
3. API commits job, delivery, and outbox;
4. publisher confirms RabbitMQ message;
5. fixture worker creates and uploads a small MP4;
6. delivery loop edits the fake progress message into media;
7. backend records delivery;
8. each retention mode is advanced with a controllable clock and verified.

Negative/recovery scenarios include unauthorized user, invalid/non-X URL, queue full, extractor
failure, no fitting format, cancellation, API restart after job commit, publisher death after Rabbit
confirmation, worker death during download, bridge death after Telegram success boundary, RustFS
outage, and cleanup retry.

### 14.5 Coverage and CI gates

- Run `deno fmt --check`, `deno lint`, `deno check`, unit/integration/e2e tests, secret scanning,
  and dependency/license checks.
- Generate V8 coverage with `deno test --coverage` and an LCOV/HTML artifact.
- Enforce at least 80% line coverage over `apps/` and `packages/`, excluding only trivial executable
  entry points and generated OpenAPI artifacts.
- Report branch and function coverage and reject material unexplained regression.
- Tests cannot ignore core state-machine or error paths merely to meet the aggregate percentage.

Normal CI has no dependency on live X or Telegram. A manual smoke test may use a public X post or a
controlled public fixture, and must never print media URLs or credentials (see
[verification](verification.md)).

## 15. Compose and container plan

Compose services:

- `postgres` with health check and persistent volume;
- `rabbitmq` with management UI bound locally, health check, definitions/topology created by the
  application adapter;
- `rustfs` with persistent volume and health check;
- `rustfs-init` idempotently creating the private artifact bucket;
- `migrate` one-shot database migration job;
- `api`, dependent on successful migration and healthy PostgreSQL;
- `worker`, with isolated temp volume and external media tools;
- `telegram-bridge`, enabled only when Telegram credentials are present or under a `live` profile;
- `maintenance`, running outbox publication, lease recovery, and cleanup.

A separate `test` profile uses isolated databases/buckets/queues and the fake Telegram/downloader
services. Container tags are pinned; `latest` is not used in the committed production example.

## 16. Milestones and verification gates

### Milestone 0 — toolchain and risk spikes

Deliver:

- Deno workspace, formatting/lint/check/test/coverage tasks;
- configuration package and sanitized logging skeleton;
- production/test multi-stage container skeleton;
- RabbitMQ client recovery spike under Deno;
- RustFS AWS-SDK compatibility spike;
- yt-dlp metadata-only probe contract for the supplied X URL.

Gate: all three external compatibility spikes work inside containers and the selected
versions/clients are recorded before domain implementation builds on them.

### Milestone 1 — database and domain foundation

Deliver:

- initial migrations for principals, jobs, artifacts, deliveries, outbox, and audit events;
- repository/transaction layer;
- typed state machines, policies, error model, and admin bootstrap;
- deterministic clock/ID interfaces for tests.

Gate: concurrency/idempotency/lease database tests pass; illegal state transitions are rejected.

### Milestone 2 — API and durable submission

Deliver:

- Hono application, bearer auth, health/readiness, metrics foundation;
- X URL validation and job/status/cancel/retry endpoints;
- principal administration endpoints;
- OpenAPI generation;
- transactional job plus delivery plus outbox creation;
- outbox publisher with confirmations.

Gate: an API restart at every submission/publication boundary cannot lose a job or create two
processable jobs for one idempotency key.

### Milestone 3 — downloader and artifact worker

Deliver:

- yt-dlp metadata/progress adapter;
- format selection and size policy;
- subprocess timeout/cancellation and FFmpeg/ffprobe validation;
- RustFS temporary/final object workflow;
- Rabbit worker claims, heartbeats, retries, dead letters, and recovery;
- artifact status/content API.

Gate: fixture downloads cover success, downgrade, oversize, cancellation, timeout, process crash,
storage failure, and duplicate delivery without orphaned ready/temporary artifacts.

### Milestone 4 — Telegram bridge and administration

Deliver:

- grammY long-polling bridge with internal API client;
- private-chat/single-X intake and idempotency mapping;
- acknowledgement/progress coalescing;
- delivery claim/heartbeat/edit/complete loop and safe fallback;
- user and admin commands with audit behavior;
- complete fake Telegram API.

Gate: bridge restart and ambiguous Telegram errors do not redownload media or produce a confirmed
duplicate delivery in the modeled scenarios. Committed access requests recover their leased
per-admin notification work after bridge restart.

### Milestone 5 — retention, hardening, and full Compose

Deliver:

- all retention modes and cleanup/reconciliation;
- complete service-specific health checks and metrics;
- non-root/read-only/resource-limited containers;
- Compose production and test profiles;
- migration, backup/restore, operations, and troubleshooting documentation;
- CI with the 80% line gate, secret scanning, and dependency/license inventory.

Gate: full automated end-to-end and restart matrix passes from a clean clone with only generated
local infrastructure credentials.

### Milestone 6 — live validation and handoff

Status: complete. Delivered work:

- live Telegram validation of bot identity, admin bootstrap, real X deliveries, status-message
  replacement, and idle bridge/worker recreation; unauthorized-user and active-lease recovery
  behavior are covered deterministically by the fake suite;
- a dedicated 250 ms outbox publication loop, two-slot consumption, content/source deduplication,
  seven-day Loki/Prometheus persistence, role-scoped administration, job/audit inspection, and
  deduplicated access requests;
- the official local Telegram Bot API server, disk-backed bounded worker storage, renewable
  delivery leases, and large-file delivery up to the reviewed 1,990,000,000-byte ceiling;
- a standalone Dokploy production topology and the hosted-to-local Bot API cutover, now running in
  production (see [Dokploy](dokploy.md)).

Gate: the Telegram user experience and operational runbook were accepted. Live credentials remain
outside Git and are rotated if they were ever exposed. Deterministic restart and recovery coverage
is recorded in [verification](verification.md).
