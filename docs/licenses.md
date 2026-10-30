# Direct dependency license inventory

`deno.lock` contains the application graph and `drizzle.lock` isolates the build-time Drizzle Kit
graph from runtime images. `deno task licenses` verifies the direct npm packages against this
approved inventory at build time.

| Dependency | Pinned version | License |
| --- | ---: | --- |
| `@aws-sdk/client-s3` | 3.1108.0 | Apache-2.0 |
| `@aws-sdk/lib-storage` | 3.1108.0 | Apache-2.0 |
| `@cloudamqp/amqp-client` | 4.0.0 | Apache-2.0 |
| `@hono/zod-openapi` | 1.5.2 | MIT |
| `drizzle-kit` | 0.31.10 | MIT |
| `drizzle-orm` | 0.45.2 | Apache-2.0 |
| `grammy` | 1.45.1 | MIT |
| `hono` | 4.13.14 | MIT |
| `postgres` | 3.4.9 | Unlicense |
| `zod` | 4.6.7 | MIT |
| `@std/assert` | 1.0.16 | MIT |
| `@std/path` | 1.1.4 | MIT |

Container/tool components are pinned separately in `Dockerfile` and `compose.yaml`: Deno 2.9.5,
PostgreSQL 17.6, RabbitMQ 4.3.1, RustFS 1.0.0-beta.10, Grafana Loki 3.7.6 (AGPL-3.0), Prometheus
3.13.2 (Apache-2.0), yt-dlp 2026.06.09 (SHA-256 verified), and the Debian FFmpeg package from the
pinned Deno base image.

The optional local service is built from official source rather than a third-party image:

| Component | Pinned revision/version | License |
| --- | --- | --- |
| Telegram Bot API server | `adfd7f6a8e990272851777eeb3ae0def4216f161` (Bot API 10.2) | BSL-1.0 |
| TDLib submodule | `a9966eb3704a3351568c28013fed67d797c17828` | BSL-1.0 |
| Alpine runtime base | 3.22.1, pinned OCI index digest | MIT and component licenses |

`Dockerfile.telegram-bot-api` copies the upstream `LICENSE_1_0.txt` into the runtime image. Build-only
packages do not enter the final stage; shipped Alpine runtime packages retain their package license
metadata.
