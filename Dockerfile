# syntax=docker/dockerfile:1.9
ARG DENO_VERSION=2.9.5

FROM denoland/deno:${DENO_VERSION} AS dependencies
WORKDIR /app
COPY deno.json deno.lock* ./
COPY apps ./apps
COPY packages ./packages
COPY tools ./tools
COPY tests ./tests
RUN deno cache apps/api/main.ts apps/worker/main.ts apps/telegram_bridge/main.ts \
    apps/maintenance/main.ts tools/migrate.ts tools/init_storage.ts \
    tools/generate_large_fixture.ts tools/large_file_acceptance.ts \
    tools/run_large_file_acceptance.ts tests/unit/*.ts

FROM dependencies AS test
COPY . .
RUN deno task check && deno task test:unit

FROM denoland/deno:${DENO_VERSION} AS runtime-base
WORKDIR /app
ENV DENO_DIR=/deno-dir
RUN groupadd --gid 10001 app && useradd --uid 10001 --gid app --home-dir /nonexistent --shell /usr/sbin/nologin app
COPY --from=dependencies --chown=10001:10001 /deno-dir /deno-dir
COPY --from=dependencies --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=dependencies --chown=10001:10001 /app/deno.json /app/deno.lock* ./
COPY --from=dependencies --chown=10001:10001 /app/apps ./apps
COPY --from=dependencies --chown=10001:10001 /app/packages ./packages
COPY --from=dependencies --chown=10001:10001 /app/tools ./tools
COPY --chown=10001:10001 migrations ./migrations
COPY --chown=10001:10001 drizzle ./drizzle
USER 10001:10001

FROM runtime-base AS app
CMD ["deno", "task", "api"]

FROM runtime-base AS worker-root
USER root
ARG YTDLP_VERSION=2026.06.09
ARG YTDLP_SHA256=e5d57466682cfa9d61e9cf7c8a4f09b00f4a62af37d3bbdc4bcffdf63615feac
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl ffmpeg python3 \
    && curl --fail --location --output /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
    && echo "${YTDLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum --check --strict \
    && chmod 0555 /usr/local/bin/yt-dlp \
    && install -d -o 10001 -g 10001 -m 0700 /var/tmp/video-downloader \
    && rm -rf /var/lib/apt/lists/*

FROM worker-root AS worker
USER 10001:10001
CMD ["deno", "task", "worker"]
