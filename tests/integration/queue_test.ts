import { assertEquals } from "@std/assert";
import { AMQPClient } from "@cloudamqp/amqp-client";
import { loadConfig } from "../../packages/config/mod.ts";
import {
  RabbitJobConsumer,
  RabbitJobQueue,
  sourceTimeoutRetryQueueName,
} from "../../packages/queue/rabbitmq.ts";

Deno.test({
  name: "RabbitMQ adapter separates source timeout and infrastructure retry delays",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const suffix = crypto.randomUUID();
    const config = loadConfig("test", {
      APP_ENV: "test",
      RABBITMQ_HOST: Deno.env.get("TEST_RABBITMQ_HOST") ?? "127.0.0.1",
      RABBITMQ_USER: Deno.env.get("TEST_RABBITMQ_USER") ?? "video_downloader_test",
      RABBITMQ_PASSWORD: Deno.env.get("TEST_RABBITMQ_PASSWORD") ?? "local-rabbitmq-password",
      RABBITMQ_VHOST: Deno.env.get("TEST_RABBITMQ_VHOST") ?? "video_downloader_test",
      RABBITMQ_DOWNLOAD_QUEUE: `video.download.test.${suffix}`,
      RABBITMQ_DOWNLOAD_RETRY_QUEUE: `video.download.test.${suffix}.retry`,
      RABBITMQ_DOWNLOAD_DEAD_LETTER_QUEUE: `video.download.test.${suffix}.dead`,
      WORKER_SOURCE_TIMEOUT_RETRY_DELAY_SECONDS: "1",
      WORKER_RETRY_DELAY_SECONDS: "3",
      WORKER_MAX_ATTEMPTS: "2",
    });
    const publisher = new RabbitJobQueue(config);
    const consumer = new RabbitJobConsumer(config);
    const attempts = new Map<string, number>();
    const completed = new Set<string>();
    const retryCompletionOrder: string[] = [];
    const retryId = crypto.randomUUID();
    const sourceTimeoutRetryId = crypto.randomUUID();
    const deadId = crypto.randomUUID();
    try {
      await publisher.connect();
      await consumer.start((jobId) => {
        const attempt = (attempts.get(jobId) ?? 0) + 1;
        attempts.set(jobId, attempt);
        if (jobId === retryId && attempt === 1) return Promise.resolve("retry");
        if (jobId === sourceTimeoutRetryId && attempt === 1) {
          return Promise.resolve("retry_source_timeout");
        }
        if (jobId === deadId) {
          completed.add(jobId);
          return Promise.resolve("dead");
        }
        if (jobId === retryId || jobId === sourceTimeoutRetryId) retryCompletionOrder.push(jobId);
        completed.add(jobId);
        return Promise.resolve("ack");
      });
      await publisher.publishJob(retryId);
      await publisher.publishJob(sourceTimeoutRetryId);
      await publisher.publishJob(deadId);
      await waitFor(
        () =>
          completed.has(retryId) && completed.has(sourceTimeoutRetryId) && completed.has(deadId),
        10_000,
      );
      assertEquals(attempts.get(retryId), 2);
      assertEquals(attempts.get(sourceTimeoutRetryId), 2);
      assertEquals(retryCompletionOrder, [sourceTimeoutRetryId, retryId]);
      assertEquals(publisher.healthy(), true);
      assertEquals(consumer.healthy(), true);

      const client = new AMQPClient(config.rabbitmqUrl);
      const connection = await client.connect();
      const channel = await connection.channel();
      let deadPayload: string | null = null;
      await channel.basicConsume(
        config.RABBITMQ_DOWNLOAD_DEAD_LETTER_QUEUE,
        { noAck: false },
        async (message) => {
          deadPayload = message.bodyToString();
          await message.ack();
        },
      );
      await waitFor(() => deadPayload !== null, 5_000);
      assertEquals(JSON.parse(deadPayload!).jobId, deadId);
      await connection.close();
    } finally {
      await consumer.close().catch(() => undefined);
      await publisher.close().catch(() => undefined);
      await deleteFixtureQueues(config.rabbitmqUrl, [
        config.RABBITMQ_DOWNLOAD_QUEUE,
        config.RABBITMQ_DOWNLOAD_RETRY_QUEUE,
        sourceTimeoutRetryQueueName(config.RABBITMQ_DOWNLOAD_RETRY_QUEUE),
        config.RABBITMQ_DOWNLOAD_DEAD_LETTER_QUEUE,
      ]).catch(() => undefined);
    }
  },
});

async function deleteFixtureQueues(url: string, names: readonly string[]): Promise<void> {
  const client = new AMQPClient(url);
  const connection = await client.connect();
  try {
    const channel = await connection.channel();
    for (const name of names) await channel.queueDelete(name);
  } finally {
    await connection.close();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for RabbitMQ test state");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
