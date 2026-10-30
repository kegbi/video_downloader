# Verification Status

Last verified: 2026-10-29

All prescribed quality gates pass on the current revision:

- 77 unit tests on the host (`deno task test:unit`), plus the integration and fake end-to-end
  suites.
- 96 tests in the full coverage run inside the isolated container suite, with 88.2% aggregate core
  line coverage against the 80% threshold.
- Formatting, lint, type checking, Drizzle migration checks, license inventory, secret scanning,
  and the dependency audit at the configured high-severity threshold.

Moderate audit findings may remain in the application and Drizzle tooling graphs; there are no high
or critical findings. The service has also been validated end to end against the real X and Telegram
services as part of its production rollout.

## What the automated gates cover

Normal gates use fixture media, disposable PostgreSQL, RabbitMQ, and RustFS instances, and a fake
Telegram Bot API server. They never contact live X or Telegram endpoints.

- Unit: configuration and placeholder rejection, redaction, X URL policy, domain state machines,
  format selection and size estimation, yt-dlp metadata parsing, process handling, downloader
  adapter behavior, Telegram bridge logic, and Compose contract checks (secret ownership, Dokploy
  hardening, zero host ports, the stopped-bridge default).
- Integration: schema and constraints, compare-and-set job and delivery leases, outbox publication,
  idempotent submission and authorization ordering, access-request concurrency, RabbitMQ
  publication and redelivery, RustFS multipart upload and range reads, retention and cleanup,
  content deduplication, worker recovery, and the grammY adapter against the fake Bot API.
- End to end: fake Telegram update to API, outbox, queue, fixture worker, RustFS, delivery edit,
  persisted delivery, and restart and ambiguity recovery with exactly one downloader invocation.
- Large files: format and artifact-size boundaries at the reviewed 1,990,000,000-byte ceiling use
  stat-only seams over tiny physical files; storage and Telegram uploads are chunked to 64 KiB and
  exercised under backpressure, cancellation, timeout ambiguity, and fallback without allocating
  multi-gigabyte buffers.
- Delivery leases: virtual-time tests cover uploads spanning many heartbeat intervals, heartbeat
  rejection and timeout, stream cancellation, clean heartbeat shutdown, and bridge restart; the
  PostgreSQL boundary proves a renewed row stays unclaimable and a stale owner cannot renew.

## Running the checks

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
docker compose --profile test up --build --abort-on-container-exit --exit-code-from test-runner test-runner
```

The integration, e2e, and coverage tasks need the PostgreSQL, RabbitMQ, and RustFS endpoints that
the `test` profile provides; the container suite starts them. Remove the disposable Compose
project afterward. The verified tool versions are Deno 2.9.5 and Docker Compose v2.

## Opt-in live X smoke test

X availability and extractor behavior are external and mutable, so these checks are evidence, not a
deterministic gate. Use only a public, non-live post whose content you have the right to download,
and never commit or retain the downloaded media.

1. Direct download without Telegram: in a disposable worker-image container, construct
   `YtDlpDownloader` (`packages/downloader/adapter.ts`) with the production options and call
   `download(url)`. This bypasses the bridge, API, queue, database, and object storage. Confirm the
   returned artifact against ffprobe (MP4 family, H.264 video, optional AAC audio, expected
   dimensions and duration).
2. Delete the artifact and the container afterward.

For a full-path check, the optional live Telegram bridge and the large-file acceptance procedure
are described in [operations](operations.md); they require operator-supplied credentials and are
never part of the automated gates.

## Durable findings

- X's yt-dlp extractor can return a playlist-shaped result for a single status that contains
  several videos. The downloader selects the first video deterministically for an already validated
  single X status and constrains yt-dlp to the first playlist item; no extractor upgrade is
  required.
- Some X formats identify streams only through `video_ext` and `audio_ext` and omit codec names.
  The downloader recognizes those explicit stream extensions.
- X animated GIFs arrive as silent MP4s, and yt-dlp may omit `duration`. The worker accepts an
  absent duration while keeping hard size and temporary-storage bounds, measures the real duration
  with ffprobe before promotion, and does not require an audio partner for silent formats. The
  bridge delivers validated H.264 MP4s without audio as Telegram animations, including fallback
  replies, and persists the animation file ID.
- A post can play in the requester's country yet be withheld in the server's country. yt-dlp then
  reports the ambiguous `No video could be found in this tweet`. The adapter diagnoses that exact
  error through the fixed public syndication endpoint (five seconds, 64 KiB, no redirects) and, on
  a confirmed regional tombstone, fails the job once as non-retryable `source_unavailable` with a
  static explanation and `sourceRestriction=region_withheld` in the log. This removes futile
  retries; it does not make a withheld post available from that region.
- Telegram offers bots no read receipt, so `telegram.media_accepted` means only that the Bot API
  returned success.
