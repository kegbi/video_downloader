import type { AppConfig } from "../../packages/config/mod.ts";
import type { Repository } from "../../packages/db/repository.ts";
import type { Logger } from "../../packages/observability/logger.ts";
import type { OutboxPublisher } from "../../packages/queue/outbox.ts";
import type { ArtifactStorage } from "../../packages/storage/s3.ts";

export class MaintenanceService {
  constructor(
    private readonly config: Readonly<AppConfig>,
    private readonly repository: Repository,
    private readonly storage: ArtifactStorage,
    private readonly outbox: OutboxPublisher,
    private readonly logger: Logger,
  ) {}

  async publishOnce(): Promise<{ published: number; publishFailed: number }> {
    const publication = await this.outbox.publishBatch();
    return { published: publication.published, publishFailed: publication.failed };
  }

  async cleanupOnce(): Promise<{
    cleaned: number;
    cleanupFailed: number;
    purgedJobs: number;
    purgedAuditEvents: number;
    purgedOutboxEvents: number;
    purgedAccessRequests: number;
  }> {
    let cleaned = 0;
    let cleanupFailed = 0;
    for (let count = 0; count < 25; count++) {
      const artifact = await this.repository.claimArtifactCleanup(
        this.config.TEMP_OBJECT_MAX_AGE_SECONDS,
      );
      if (!artifact) break;
      try {
        if (artifact.temporaryObjectKey) await this.storage.delete(artifact.temporaryObjectKey);
        await this.storage.delete(artifact.objectKey);
        if (await this.repository.completeArtifactCleanup(artifact.id)) cleaned++;
      } catch (error) {
        cleanupFailed++;
        const safeError = error instanceof Error ? error.name : "StorageError";
        await this.repository.failArtifactCleanup(
          artifact.id,
          safeError,
          Math.min(3600, 2 ** Math.min(artifact.deleteAttempts, 10)),
        );
        this.logger.warn("cleanup.failed", { artifactId: artifact.id, error: safeError });
      }
    }
    const purged = await this.repository.purgeOldJobHistory(
      this.config.JOB_HISTORY_TTL_SECONDS,
      100,
      this.config.ACCESS_REQUEST_TTL_SECONDS,
    );
    return {
      cleaned,
      cleanupFailed,
      purgedJobs: purged.jobs,
      purgedAuditEvents: purged.auditEvents,
      purgedOutboxEvents: purged.outboxEvents,
      purgedAccessRequests: purged.accessRequests,
    };
  }
}
