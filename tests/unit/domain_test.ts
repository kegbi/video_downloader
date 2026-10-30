import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { getEventListeners } from "node:events";
import { artifactExpiryAt, isCleanupEligible } from "../../packages/domain/retention.ts";
import {
  assertArtifactTransition,
  assertDeliveryTransition,
  assertJobTransition,
  isTerminalJobState,
} from "../../packages/domain/state.ts";
import { DomainError } from "../../packages/domain/errors.ts";
import { abortableDelay, MutableClock, SequenceIdGenerator } from "../../packages/domain/time.ts";

Deno.test("job, artifact and delivery state machines reject backwards transitions", () => {
  assertJobTransition("queued", "downloading");
  assertJobTransition("failed", "queued");
  assertArtifactTransition("uploading", "ready");
  assertDeliveryTransition("delivering", "retry_wait");
  assertThrows(() => assertJobTransition("ready", "downloading"), DomainError);
  assertThrows(() => assertArtifactTransition("deleted", "ready"), DomainError);
  assertThrows(() => assertDeliveryTransition("delivered", "retry_wait"), DomainError);
  assertEquals(isTerminalJobState("failed"), true);
  assertEquals(isTerminalJobState("ready"), false);
});

Deno.test("retention expiry follows every approved mode", () => {
  const ready = new Date("2026-01-01T00:00:00Z");
  const delivered = new Date("2026-01-02T00:00:00Z");
  assertEquals(
    artifactExpiryAt({ mode: "forever", ttlSeconds: 10, afterDeliveryGraceSeconds: 5 }, ready),
    null,
  );
  assertEquals(
    artifactExpiryAt({ mode: "ttl", ttlSeconds: 10, afterDeliveryGraceSeconds: 5 }, ready)
      ?.toISOString(),
    "2026-01-01T00:00:10.000Z",
  );
  assertEquals(
    artifactExpiryAt(
      { mode: "after_delivery", ttlSeconds: 10, afterDeliveryGraceSeconds: 5 },
      ready,
    ),
    null,
  );
  const afterDelivery = artifactExpiryAt(
    { mode: "after_delivery", ttlSeconds: 10, afterDeliveryGraceSeconds: 5 },
    ready,
    delivered,
  );
  assertEquals(afterDelivery?.toISOString(), "2026-01-02T00:00:05.000Z");
  assertEquals(
    isCleanupEligible("ready", afterDelivery, new Date("2026-01-02T00:00:06Z"), false),
    true,
  );
  assertEquals(
    isCleanupEligible("ready", afterDelivery, new Date("2026-01-02T00:00:06Z"), true),
    false,
  );
});

Deno.test("clock and ID seams are deterministic", () => {
  const clock = new MutableClock(new Date("2026-01-01T00:00:00Z"));
  clock.advance(1500);
  assertEquals(clock.now().toISOString(), "2026-01-01T00:00:01.500Z");
  const ids = new SequenceIdGenerator(["one", "two"]);
  assertEquals(ids.next(), "one");
  assertEquals(ids.next(), "two");
  assertThrows(() => ids.next(), Error, "ID sequence exhausted");
});

Deno.test("abortable delay does not retain listeners after completion", async () => {
  const controller = new AbortController();
  for (let index = 0; index < 100; index++) {
    await abortableDelay(0, controller.signal);
  }
  assertEquals(getEventListeners(controller.signal, "abort").length, 0);
});

Deno.test("abortable delay removes its listener when cancelled", async () => {
  const controller = new AbortController();
  const pending = abortableDelay(60_000, controller.signal);
  assertEquals(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort(new Error("shutdown"));
  await assertRejects(() => pending, Error, "shutdown");
  assertEquals(getEventListeners(controller.signal, "abort").length, 0);
});
