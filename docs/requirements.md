# Modular Video Downloader — Project Requirements

## 1. Purpose

Build a self-hosted service that initially accepts public X (Twitter) video
links, downloads the requested media asynchronously, and returns the resulting
file to the requester through a messaging or API bridge. YouTube, TikTok, and
other supported sites may be added through later downloader adapters.

The first client will be a Telegram bot. The downloader, job queue, storage, and
delivery-independent API must remain separate from Telegram so that other
bridges or clients can be added later.

## 2. Goals

- Accept a supported video URL through Telegram and enqueue it without blocking
  the bot.
- Acknowledge promptly that the download has started or has been queued.
- Download the best suitable media with predictable format and size behavior.
- Deliver the downloaded media back to the requesting Telegram message as a
  playable video when possible, or as a document/file when necessary.
- Keep transport-specific code out of the downloader backend.
- Make retention configurable: keep indefinitely, retain for a fixed period
  (initially one week), or delete after successful delivery.
- Restrict use to an editable allowlist of users and/or chats.
- Expose enough job state and operational information to diagnose failures.
- Make it straightforward to add new chat bridges, an admin interface, and new
  downloader implementations later.

## 3. Non-goals for the initial version

- Searching for videos by keywords.
- Editing or producing new video content beyond remuxing/transcoding needed for
  compatibility or size limits.
- Public, anonymous use.
- Circumventing DRM, access controls, paywalls, or private-content permissions.
- Mirroring an entire account, channel, or playlist by default.
- A full multi-tenant billing or quota platform.

## 4. Actors and permissions

### 4.1 User

An allowlisted Telegram user or member of an allowlisted chat who may submit a
URL, view the resulting status, receive the file, and cancel their own queued
job when cancellation is still possible.

### 4.2 Administrator

May add, disable, or remove allowed users/chats; inspect jobs; retry or cancel
jobs; change relevant runtime policies; and view service health and errors.

### 4.3 Service bridge

An authenticated client, initially the Telegram bot, that submits jobs, queries
or receives job-state changes, retrieves result metadata/files, acknowledges
delivery, and reports delivery failures.

## 5. Primary Telegram workflow

1. An allowlisted user sends a message containing a single supported URL.
2. The bot validates authorization and performs lightweight URL validation.
3. The bot replies to the original message with an acknowledgement containing a
   short job identifier and the initial state (`queued` or `downloading`).
4. The bot submits the request to the backend. The backend owns the durable job
   and returns its identifier; the bot must not perform the download itself.
5. The bot updates the acknowledgement at meaningful state changes without
   producing excessive chat noise.
6. When ready, the bot returns the video in reply to the user's original
   message. It should send it as a Telegram video when compatible, otherwise as
   a document/file.
7. The acknowledgement is removed or edited to a final concise status so the
   completed file effectively replaces the transient progress message. The
   implementation may use delete-and-send if Telegram cannot edit that message
   type into the result.
8. The bot acknowledges successful delivery to the backend. The backend then
   applies the configured retention policy.

For unsupported URLs, unauthorized users, duplicate active requests, oversized
results, and download/delivery failures, the bot returns a short actionable
error tied to the original message.

## 6. Functional requirements

### 6.1 URL intake and validation

- Normalize URLs only when doing so does not change the referenced content.
- Allow HTTPS input only. Query parameters (for example share-tracking suffixes) are
  ignored, and the downloader receives only a URL rebuilt from the numeric status ID.
- Initially support only explicitly recognized X status URLs. YouTube, TikTok,
  and other sources are post-MVP capabilities.
- Do not expose the downloader's generic URL extractor in the MVP.
- Make supported sites discoverable from backend capabilities rather than hard
  coding the complete site list into the Telegram bridge.
- Reject messages with no valid URL. Handling multiple URLs in one message is a
  post-MVP feature unless explicitly enabled with a per-message limit.
- Preserve the submitted URL for audit/debugging while avoiding sensitive URL
  data in normal logs.

### 6.2 Jobs and queue

- Job submission is asynchronous and idempotent when the same bridge retries
  the same request identifier.
- A job records its requester, bridge, source URL, timestamps, policy snapshot,
  progress, attempts, error details, output metadata, and delivery state.
- Required states are `queued`, `downloading`, `processing`, `ready`,
  `delivering`, `delivered`, `failed`, `cancelled`, and `expired`.
- Enforce configurable limits for global concurrency, per-user active jobs,
  maximum queue depth, attempts, execution time, input duration, and output
  size.
- Failed transient jobs may retry with bounded exponential backoff. Permanent
  extractor, authorization, and policy failures must not retry indefinitely.
- A worker restart must not silently lose queued jobs. Jobs abandoned by a
  crashed worker must be recoverable after a visibility/lease timeout.
- Expose job progress when the downloader can report it, without making precise
  percentage reporting a correctness requirement.

### 6.3 Downloading and media processing

- Put extractor-specific behavior behind a downloader adapter/interface.
- Prefer an output that Telegram and common players can consume directly
  (typically MP4 with compatible video/audio codecs), subject to source
  availability and configured quality.
- Support merging separate video and audio streams through FFmpeg.
- Make maximum resolution/quality and file-size handling configurable.
- If the preferred result exceeds the bridge limit, apply a configured policy:
  choose a smaller source format, transcode/compress, send as a document where
  that changes the applicable limit, or fail with an actionable reason.
- Capture title, source site, source identifier, duration, dimensions, codecs,
  size, and optional thumbnail when available.
- Use unique temporary paths and atomic promotion into managed storage.
- Never execute arbitrary options or filenames supplied by users.

### 6.4 Backend API

The backend must provide a versioned, bridge-neutral API or equivalent contract
for:

- submitting and cancelling jobs;
- reading job state and result metadata;
- receiving state changes by event/callback or polling;
- retrieving/streaming a completed artifact through authenticated access;
- acknowledging successful delivery or reporting delivery failure;
- querying supported sources and operational health;
- administering allowed principals and reviewing jobs, when authorized.

API authentication, request size limits, rate limits, idempotency keys, and
timeouts are required. A bridge must never receive unrestricted filesystem
paths; artifacts are referenced by opaque identifiers.

### 6.5 Storage and retention

Support these per-deployment defaults, with an optional per-job policy selected
only by an authorized client:

- `forever`: preserve completed artifacts until an administrator deletes them.
- `ttl`: delete artifacts after a configured duration; the initial desired TTL
  is seven days.
- `after_delivery`: delete after every intended delivery has been acknowledged
  successfully, optionally after a short safety grace period.

Additional storage requirements:

- Store metadata separately from large artifacts so job history can outlive a
  file when desired.
- Retain terminal job history, audit events, and published outbox records for
  seven days. Never purge a job before its referenced artifact is deleted.
- Run a periodic, idempotent cleanup task for expired output, abandoned
  temporary files, and stale partial downloads.
- Do not delete a ready artifact while a delivery is actively leased.
- Use a private RustFS bucket through an S3-compatible storage interface. Object
  identifiers exposed outside the storage adapter must remain opaque.
- Track artifact size and enforce a configurable total-storage ceiling with a
  documented eviction/failure policy.
- Reuse one immutable artifact for equal X source IDs before download and for
  equal SHA-256 plus byte-size values after download. Recheck the content key
  atomically before committing a newly uploaded artifact and delete a redundant
  object if another worker won the race.
- Reconcile shared-artifact retention conservatively: `forever` or an incomplete
  `after_delivery` reference prevents expiry; otherwise use the latest TTL or
  after-delivery deadline across every referencing job.

### 6.6 Telegram bridge

- Use Telegram long polling only. Webhooks are not implemented; exactly one polling
  bridge instance may own a bot.
- Associate Telegram chat/message/user identifiers with the backend job without
  coupling the backend data model to Telegram-specific behavior.
- Escape or construct all bot messages using the selected Telegram parse mode
  safely.
- Coalesce/throttle progress edits to respect API limits.
- Handle Telegram API timeouts and retryable errors without redownloading the
  artifact.
- Renew the exact claimed Telegram delivery lease while opening and consuming
  the backend artifact stream, uploading or editing media, performing a
  confirmed fallback, and persisting the final result. The configured heartbeat
  must be strictly shorter than the lease and leave room for at least three
  renewal attempts per lease.
- Bound every renewal request below the lease. If renewal fails, times out, or
  the bridge shuts down, cancel the backend/local stream and do not begin a
  later Telegram operation. An already in-flight Telegram request remains an
  ambiguous boundary: retry the fixed edit after recovery, and never use
  send-new fallback unless edit incompatibility was confirmed permanent.
- If delivery permanently fails, keep or remove the artifact according to a
  separate failed-delivery policy; do not treat an attempted send as confirmed
  delivery.
- Provide at least `/start`, `/help`, `/status`, and `/cancel` commands. Admin
  commands may be added as an interim control surface before a web panel.

### 6.7 Allowlist and administration

- Default-deny access.
- Allow authorization rules for individual bridge users and, optionally, group
  chats. Store stable platform identifiers rather than changeable display names.
- Support active/disabled state, optional expiry, display note, creation time,
  and who created or changed a rule.
- Bootstrap the first administrator from deployment configuration or a one-time
  command, without committing secrets or personal identifiers to source control.
- Initial management may use a protected CLI or Telegram admin commands.
- Pending access requests should offer allow/deny controls both on the administrator notification
  and in the pending-request list. A button decision may carry an optional administrator-only note;
  requester-facing outcome messages must not disclose it.
- A request-specific rejection must not permanently disable the user. Re-request timing is a
  configurable policy; an explicit principal disable remains in force until an administrator
  allows that principal again.
- A later admin web panel should use the same backend administration API and
  provide allowlist management, job inspection/retry/cancel, retention settings,
  storage usage, supported-site status, and an audit log.
- Every administrative mutation must be authenticated and audited.

## 7. Suggested service boundaries

1. **Backend/API** — validates authenticated requests, owns jobs, policies,
   metadata, authorization, and artifact access.
2. **Queue/broker** — durably schedules work and coordinates retries/leases.
3. **Downloader worker** — invokes the extractor and FFmpeg inside constrained
   resources, then publishes artifacts through the storage interface.
4. **Telegram bridge** — converts Telegram updates into backend calls and job
   events into Telegram messages/files.
5. **Cleanup worker/scheduler** — applies retention and temporary-file policy.
6. **Admin client** — initially CLI or bot commands; later a web UI consuming the
   backend API.

These may be deployed together during development, but code ownership and
interfaces must preserve the boundaries.

## 8. Initial data concepts

- `Principal`: bridge type, external user/chat identifier, role, state, expiry,
  note, and audit fields.
- `Job`: opaque ID, idempotency key, requester/principal, bridge request context,
  source URL/site/ID, state, progress, attempts, policy snapshot, timestamps,
  error category/message, and artifact reference.
- `Artifact`: opaque ID, storage key, media metadata, checksum, size, creation
  time, expiry time, and deletion state.
- `Delivery`: job/artifact, bridge, destination reference, state, attempts,
  leased time, completion time, and last error.
- `AuditEvent`: actor, action, target, timestamp, and sanitized change details.

## 9. Security and abuse-resistance requirements

- Run download/processing workers with least privilege, resource limits, and no
  unnecessary access to bot/API credentials.
- Treat submitted URLs and extractor output as untrusted. Defend against SSRF,
  local/file URLs, internal-network access, unsafe redirects, path traversal,
  command injection, archive tricks, and malicious media metadata.
- Restrict outbound traffic where practical to public destinations required for
  supported sources; explicitly reject loopback, link-local, private, and cloud
  metadata address ranges after DNS resolution and redirects.
- Keep tokens and secrets in environment/deployment secrets, never Git.
- Authenticate service-to-service traffic and use TLS outside a trusted local
  network.
- Rate-limit users and administrators and cap resource use per job.
- Avoid logging bot tokens, cookies, signed media URLs, full sensitive query
  strings, or downloaded content.
- If cookies are configured for sources that require an authenticated session,
  isolate and encrypt them, restrict access, and document the account risk.
- Follow source terms, applicable law, and content permissions. The system is not
  intended to bypass DRM or redistribute content without authorization.

## 10. Reliability and observability

- Structured logs must include a correlation/job ID and sanitized state changes.
- Provide health/readiness checks for the API, queue, database, workers, storage,
  extractor, FFmpeg, and Telegram bridge.
- Record metrics for queue depth/age, job duration and outcomes, retries,
  extractor/site failures, artifact bytes, storage usage, delivery latency, and
  cleanup results.
- Persist application logs and scraped metrics outside application containers
  for seven days. Container stdout is only a bounded diagnostic buffer.
- Pin or deliberately control extractor/FFmpeg versions and make upgrades
  testable because supported sites change frequently.
- Graceful shutdown must stop accepting work, preserve queued jobs, and avoid
  corrupting in-progress artifacts.
- Back up durable metadata and, when the `forever` policy is used, retained
  artifacts according to deployment needs.

## 11. Configuration

At minimum, configuration must cover:

- Telegram token, admin IDs, and polling settings;
- Telegram Bot API root, a default delivery ceiling of 49,000,000 bytes, a worker artifact ceiling
  no greater than that delivery ceiling, and a disk-backed per-job temporary-media budget sized for
  split inputs plus bounded merge/remux overhead;
- backend/bridge credentials and public/internal endpoints;
- PostgreSQL, RabbitMQ, temporary directory, and RustFS/S3 artifact storage;
- retention mode, TTL, cleanup interval, and failed-delivery behavior;
- quality, codec/container preference, duration and size limits;
- concurrency, per-user limits, retries, timeouts, and rate limits;
- initial administrator bootstrap;
- logging level and optional metrics/error-reporting integrations;
- optional source cookies/proxy settings, isolated from ordinary configuration.

Non-secret defaults may live in version control. Secrets and environment-specific
personal identifiers must not.

## 12. MVP acceptance criteria

- An allowlisted user can send a public X status URL to the Telegram bot and receive
  a playable video or a clear policy/source error.
- A non-X URL is rejected before a downloader job is created.
- An unauthorized user receives no download service and cannot infer job or
  artifact details.
- The bot acknowledges the job promptly and remains responsive while one or more
  workers download in the background.
- Restarting the bot does not cancel or lose the backend job; restarting a worker
  allows a leased job to recover or fail predictably.
- Two configured worker slots can process independent jobs concurrently while
  per-user and global limits are enforced.
- Delivery retries do not cause the video to be downloaded again.
- Each of the three retention modes is covered by an automated integration test,
  including successful-delivery acknowledgement and cleanup of partial files.
- A source failure, size-limit failure, timeout, and Telegram delivery failure
  produce distinct job/error states and useful user-facing messages.
- The downloader can be exercised through its API without importing or running
  Telegram-specific code.
- No secret is present in the repository, application logs, or returned error
  messages.

## 13. Approved implementation decisions

- All application code uses TypeScript on Deno 2.x. yt-dlp and FFmpeg/ffprobe
  are external worker tools.
- Hono provides the HTTP API; Zod provides runtime validation and OpenAPI-backed
  contracts.
- PostgreSQL is authoritative for jobs, authorization, delivery, retention,
  audit history, and the transactional outbox.
- RabbitMQ provides durable work dispatch through a TypeScript client. Dramatiq
  is not used because it is Python-specific.
- RustFS is the initial private S3-compatible artifact store.
- grammY provides the Telegram bridge, initially using long polling and
  Telegram's hosted Bot API.
- The hosted Bot API limit is handled with a configurable 49,000,000-byte
  default. The worker selects the best compatible X format below the limit and
  returns a size-policy failure if none fits; MVP transcoding is not required.
- `TELEGRAM_ADMIN_USER_IDS` bootstraps numeric administrator IDs. Administrators
  manage the persistent allowlist through audited Telegram commands.
- Docker Compose is the initial deployment target.
- SHA-256 plus exact byte size is the artifact content identity. Source ID reuse
  avoids known duplicate downloads, while the content identity catches equal
  media reached through different sources and is rechecked transactionally.
- Loki and Prometheus persist logs and metrics respectively with seven-day
  retention; applications remain functional if the optional log push fails.
- Terminal job history, audit events, and published outbox records use the same
  seven-day deployment default, while live job rows remain until their artifacts
  can be safely removed.
- Core application code has a minimum 80% line-coverage CI gate, supplemented by
  required integration and recovery tests.
- [The approved architecture](architecture.md) is the detailed implementation decision record and controls
  if a general requirement is ambiguous.

## 14. Decisions taken and future considerations

Decided in the implementation:

- Private Telegram chats by default (`ALLOW_PRIVATE_CHATS_ONLY=true`); group-chat authorization is
  not designed.
- Exactly one X URL per request. Generic playlists and live streams are rejected; a status with
  several videos selects its first video.
- Public X sources only; authenticated or private source downloads are not supported.
- No transcoding: when no source format fits the artifact ceiling, the job fails with a
  size-policy error.
- Operational defaults: two worker slots, two active jobs per user, a 30-minute maximum source
  duration, and a 1080p maximum height, all configurable.
- Indefinite retention (`forever`) has no user-facing browsing or re-download.

Future considerations:

- Additional source adapters (YouTube, TikTok) and a web administration panel.
- Group-chat support and its authorization model (by user, chat, or both).
- Optional transcoding when no source format fits the Telegram limit.
- Webhook delivery mode for the Telegram bridge.
