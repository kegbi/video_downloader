# Compatibility Decisions

Verified on 2026-08-30 with Deno 2.9.5 and Docker Engine 29.7.2.

## Official Telegram Bot API server

- Server: Bot API 10.2, built from the official `tdlib/telegram-bot-api` commit
  `adfd7f6a8e990272851777eeb3ae0def4216f161` (the upstream repository publishes no release
  artifacts or tags).
- TDLib is the source tree's pinned gitlink at
  `a9966eb3704a3351568c28013fed67d797c17828`; the build verifies both revisions before compiling.
- Build/runtime base: official Alpine 3.22.1 multi-platform image index
  `sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1`.
- Direct build packages are version-pinned: build-base 0.5-r3, CMake 3.31.7-r1, Git 2.49.1-r0,
  gperf 3.3-r0, Linux headers 6.14.2-r0, OpenSSL 3.5.9-r0, and zlib 1.3.2-r1. Runtime packages and
  the CA bundle are pinned separately in `Dockerfile.telegram-bot-api`.
- Alpine removes superseded package revisions from the v3.22 index, so exact pins break clean
  rebuilds. They were last refreshed on 2026-10-29 (CA certificates 20261020-r0, musl 1.2.5-r13).
  Build and runtime use matching OpenSSL/zlib revisions; the Alpine image digest and Bot API/TDLib
  source commits are unchanged. When a Dokploy build reports `unable to select packages`, refresh
  the named pins with `apk policy` inside the pinned base image.
- The server follows the official CMake Release build, uses environment-only `api_id`/`api_hash`
  input, and runs with `--local`, a dedicated working directory, and a separate temporary directory.
  Official documentation states that local mode accepts uploads up to 2,000 MB.
- The opt-in Compose validation uses Docker Compose 5.3.1. The internal TCP health check requires no
  bot token, API request, or live Telegram contact.

## RabbitMQ

- Server: `rabbitmq:4.3.1-management-alpine`.
- Client: `@cloudamqp/amqp-client` 4.0.0.
- The low-level client passed durable quorum declaration, persistent publish with
  publisher confirmation, manual acknowledgement, and retry/dead-letter topology.
- The high-level `AMQPSession` passed a real broker restart, automatic reconnect,
  consumer recovery, and re-publication after reconnect.
- A message delivered but not acknowledged was redelivered after the connection
  closed. Application handlers must therefore remain idempotent.
- On the Windows/Docker Desktop development host, use `127.0.0.1` for a published
  AMQP port because `localhost` may resolve to an IPv6 endpoint Docker did not bind.
  Compose services use Docker DNS and are unaffected.

## RustFS

- Server: `rustfs/rustfs:1.0.0-beta.10`.
- Client: AWS SDK `@aws-sdk/client-s3` 3.1108.0 with path-style addressing.
- The client passed bucket creation, temporary upload, server-side copy/promotion,
  HEAD verification, byte-range streaming, and idempotent deletion.
- AWS SDK user-agent construction requires Deno's narrow `--allow-sys=osRelease`
  permission.
- RustFS is still a beta dependency and this Compose deployment is single-node.
  `forever` retention therefore requires an independent backup.

## Media tools

- yt-dlp: 2026.06.09 zipapp, downloaded with its release SHA-256 checksum.
- FFmpeg/ffprobe: Debian stable package in the worker image.
- Python: Debian `python3`, used only to execute the yt-dlp zipapp. No application
  service, contract, or domain code is Python.
- The metadata-only X probe selected the `Twitter` extractor for the supplied public
  status URL and returned six formats without downloading media.
- The zipapp choice permits a read-only root filesystem and non-executable `/tmp`.
  The PyInstaller standalone artifact was rejected because it needs an executable
  extraction mount.
- yt-dlp's fixed `--max-filesize` and FFmpeg's fixed `-fs` arguments are supplemented by
  process-lifetime directory-size monitoring because source estimates can be absent or inaccurate.
  Boundary tests use metadata-only logical sizes over 32-byte physical fixtures; they do not depend
  on host sparse-file behavior or allocate/download multi-gigabyte media.
- Deno's Node compatibility `createReadStream` interoperates with AWS SDK multipart `Upload`, so
  validated artifacts are streamed from the disk-backed worker volume instead of being read into a
  multi-gigabyte `Uint8Array`. The RustFS multipart integration test writes its 6 MiB local fixture
  in 64 KiB pieces and observes every storage read: total bytes must match, more than one read must
  occur, and no read may exceed 64 KiB.
- The grammY upload adapter splits even deliberately oversized upstream chunks into at most 64 KiB
  pieces before passing them to multipart upload. The fake Bot API observes a 64 MiB generated
  stream under server-side backpressure, and a separate cancellation case exposes a
  1,990,000,000-byte logical stream while producing only bounded chunks until cancellation.
- Worker media storage is the Compose `worker-temp` named volume at
  `/var/tmp/video-downloader`. The remaining 16 MiB `/tmp` tmpfs is not used for media bytes, and the
  application enforces the per-job temporary limit independently of both volume and memory limits.
- Worker final-artifact boundary coverage uses 32-byte physical files plus an injected metadata-only
  stat view for logical sizes 1,989,999,999, 1,990,000,000, and 1,990,000,001. It verifies the real
  fixture remains 32 bytes, so normal tests cannot accidentally allocate multi-gigabyte files.

The live X checks in [verification](verification.md) are optional because source availability is not
deterministic.
