import { type AMQPQueue, AMQPSession } from "@cloudamqp/amqp-client";
import { z } from "zod";
import type { AppConfig } from "../config/mod.ts";

export const downloadMessageSchema = z.object({ version: z.literal(1), jobId: z.uuid() });
export type DownloadMessage = z.infer<typeof downloadMessageSchema>;

export interface JobPublisher {
  publishJob(jobId: string): Promise<void>;
  healthy(): boolean;
  close(): Promise<void>;
}

export type JobHandler = (
  jobId: string,
) => Promise<"ack" | "retry" | "retry_source_timeout" | "dead">;

export function sourceTimeoutRetryQueueName(retryQueueName: string): string {
  return `${retryQueueName}.source-timeout`;
}

export class RabbitJobQueue implements JobPublisher {
  private session?: AMQPSession;
  private workQueue?: AMQPQueue;
  private connected = false;

  constructor(private readonly config: Readonly<AppConfig>) {}

  async connect(): Promise<void> {
    if (this.session) return;
    this.session = await AMQPSession.connect(this.config.rabbitmqUrl, {
      name: `${this.config.service}-publisher`,
      reconnectInterval: 500,
      maxReconnectInterval: 10_000,
      maxRetries: 0,
      logger: null,
      onconnect: () => this.connected = true,
      ondisconnect: () => this.connected = false,
      onfailed: () => this.connected = false,
    });
    const dead = await this.session.queue(this.config.RABBITMQ_DOWNLOAD_DEAD_LETTER_QUEUE, {
      durable: true,
      arguments: { "x-queue-type": "quorum" },
    });
    const retry = await this.session.queue(this.config.RABBITMQ_DOWNLOAD_RETRY_QUEUE, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-message-ttl": this.config.WORKER_RETRY_DELAY_SECONDS * 1000,
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": this.config.RABBITMQ_DOWNLOAD_QUEUE,
      },
    });
    const sourceTimeoutRetry = await this.session.queue(
      sourceTimeoutRetryQueueName(this.config.RABBITMQ_DOWNLOAD_RETRY_QUEUE),
      {
        durable: true,
        arguments: {
          "x-queue-type": "quorum",
          "x-message-ttl": this.config.WORKER_SOURCE_TIMEOUT_RETRY_DELAY_SECONDS * 1000,
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": this.config.RABBITMQ_DOWNLOAD_QUEUE,
        },
      },
    );
    this.workQueue = await this.session.queue(this.config.RABBITMQ_DOWNLOAD_QUEUE, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-delivery-limit": this.config.WORKER_MAX_ATTEMPTS + 2,
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": dead.name,
      },
    });
    // Keep handles alive so the session redeclares all topology after reconnect.
    void retry;
    void sourceTimeoutRetry;
  }

  async publishJob(jobId: string): Promise<void> {
    if (!this.workQueue) await this.connect();
    const message = downloadMessageSchema.parse({ version: 1, jobId });
    await this.workQueue!.publish(JSON.stringify(message), {
      deliveryMode: 2,
      messageId: jobId,
      timestamp: new Date(),
    });
  }

  healthy(): boolean {
    return this.connected && this.session?.closed === false;
  }

  async close(): Promise<void> {
    await this.session?.stop();
    this.connected = false;
    this.session = undefined;
    this.workQueue = undefined;
  }
}

export class RabbitJobConsumer {
  private session?: AMQPSession;
  private subscription?: { cancel(): Promise<unknown> };
  private connected = false;

  constructor(private readonly config: Readonly<AppConfig>) {}

  async start(handler: JobHandler): Promise<void> {
    this.session = await AMQPSession.connect(this.config.rabbitmqUrl, {
      name: "download-worker",
      reconnectInterval: 500,
      maxReconnectInterval: 10_000,
      maxRetries: 0,
      logger: null,
      onconnect: () => this.connected = true,
      ondisconnect: () => this.connected = false,
      onfailed: () => this.connected = false,
    });
    const dead = await this.session.queue(this.config.RABBITMQ_DOWNLOAD_DEAD_LETTER_QUEUE, {
      durable: true,
      arguments: { "x-queue-type": "quorum" },
    });
    const retry = await this.session.queue(this.config.RABBITMQ_DOWNLOAD_RETRY_QUEUE, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-message-ttl": this.config.WORKER_RETRY_DELAY_SECONDS * 1000,
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": this.config.RABBITMQ_DOWNLOAD_QUEUE,
      },
    });
    const sourceTimeoutRetry = await this.session.queue(
      sourceTimeoutRetryQueueName(this.config.RABBITMQ_DOWNLOAD_RETRY_QUEUE),
      {
        durable: true,
        arguments: {
          "x-queue-type": "quorum",
          "x-message-ttl": this.config.WORKER_SOURCE_TIMEOUT_RETRY_DELAY_SECONDS * 1000,
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": this.config.RABBITMQ_DOWNLOAD_QUEUE,
        },
      },
    );
    const work = await this.session.queue(this.config.RABBITMQ_DOWNLOAD_QUEUE, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-delivery-limit": this.config.WORKER_MAX_ATTEMPTS + 2,
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": dead.name,
      },
    });
    this.subscription = await work.subscribe(
      { prefetch: this.config.WORKER_CONCURRENCY },
      async (message) => {
        const parsed = downloadMessageSchema.parse(JSON.parse(message.bodyString() ?? "null"));
        const disposition = await handler(parsed.jobId);
        if (disposition === "retry_source_timeout") {
          await sourceTimeoutRetry.publish(JSON.stringify(parsed), {
            deliveryMode: 2,
            messageId: parsed.jobId,
          });
        } else if (disposition === "retry") {
          await retry.publish(JSON.stringify(parsed), { deliveryMode: 2, messageId: parsed.jobId });
        } else if (disposition === "dead") {
          await dead.publish(JSON.stringify(parsed), { deliveryMode: 2, messageId: parsed.jobId });
        }
      },
    );
  }

  healthy(): boolean {
    return this.connected && this.session?.closed === false;
  }

  async close(): Promise<void> {
    await this.subscription?.cancel();
    await this.session?.stop();
    this.connected = false;
  }
}
