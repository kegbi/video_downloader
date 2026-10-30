import { downloadMessageSchema, type JobPublisher } from "./rabbitmq.ts";
import type { Repository } from "../db/repository.ts";

export class OutboxPublisher {
  constructor(
    private readonly repository: Repository,
    private readonly publisher: JobPublisher,
    private readonly publisherId: string,
    private readonly observeLifecycle?: (
      event: string,
      fields: Readonly<Record<string, unknown>>,
    ) => void,
  ) {}

  async publishBatch(limit = 25): Promise<{ published: number; failed: number }> {
    const events = await this.repository.claimOutbox(this.publisherId, limit, 60);
    let published = 0;
    let failed = 0;
    for (const event of events) {
      const startedAt = performance.now();
      let jobId: string | undefined;
      try {
        if (event.eventType !== "download.requested") {
          throw new Error("Unsupported outbox event type");
        }
        const message = downloadMessageSchema.parse(event.payload);
        jobId = message.jobId;
        await this.publisher.publishJob(message.jobId);
        if (!await this.repository.markOutboxPublished(event.id, this.publisherId)) {
          throw new Error("Outbox lease was lost after broker confirmation");
        }
        published++;
        this.emit("outbox.job_published", {
          jobId: message.jobId,
          outboxAttempt: event.attempts,
          durationMilliseconds: elapsedMilliseconds(startedAt),
        });
      } catch (error) {
        const safeError = error instanceof Error ? error.name : "PublishError";
        await this.repository.releaseOutbox(
          event.id,
          this.publisherId,
          safeError,
          Math.min(300, 2 ** event.attempts),
        );
        failed++;
        this.emit("outbox.job_publish_failed", {
          ...(jobId ? { jobId } : { aggregateId: event.aggregateId }),
          outboxAttempt: event.attempts,
          errorType: safeError,
          durationMilliseconds: elapsedMilliseconds(startedAt),
        });
      }
    }
    return { published, failed };
  }

  private emit(event: string, fields: Readonly<Record<string, unknown>>): void {
    try {
      this.observeLifecycle?.(event, fields);
    } catch {
      // Observability must never change outbox publication behavior.
    }
  }
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1_000) / 1_000;
}
