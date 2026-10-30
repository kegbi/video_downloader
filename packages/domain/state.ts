import { z } from "zod";
import { DomainError } from "./errors.ts";

export const jobStateSchema = z.enum([
  "queued",
  "downloading",
  "processing",
  "ready",
  "delivering",
  "delivered",
  "failed",
  "cancelled",
  "expired",
]);
export type JobState = z.infer<typeof jobStateSchema>;

export const artifactStateSchema = z.enum([
  "uploading",
  "ready",
  "deleting",
  "deleted",
  "delete_failed",
]);
export type ArtifactState = z.infer<typeof artifactStateSchema>;

export const deliveryStateSchema = z.enum([
  "pending",
  "leased",
  "delivering",
  "delivered",
  "retry_wait",
  "failed",
]);
export type DeliveryState = z.infer<typeof deliveryStateSchema>;

const jobTransitions: Readonly<Record<JobState, ReadonlySet<JobState>>> = {
  queued: new Set(["downloading", "cancelled", "failed"]),
  downloading: new Set(["queued", "processing", "ready", "cancelled", "failed"]),
  processing: new Set(["queued", "ready", "cancelled", "failed"]),
  ready: new Set(["delivering", "expired", "failed"]),
  delivering: new Set(["ready", "delivered", "failed"]),
  delivered: new Set(["expired"]),
  failed: new Set(["queued"]),
  cancelled: new Set(),
  expired: new Set(),
};

const artifactTransitions: Readonly<Record<ArtifactState, ReadonlySet<ArtifactState>>> = {
  uploading: new Set(["ready", "deleting", "delete_failed"]),
  ready: new Set(["deleting"]),
  deleting: new Set(["deleted", "delete_failed"]),
  deleted: new Set(),
  delete_failed: new Set(["deleting"]),
};

const deliveryTransitions: Readonly<Record<DeliveryState, ReadonlySet<DeliveryState>>> = {
  pending: new Set(["leased", "failed"]),
  leased: new Set(["delivering", "retry_wait", "failed"]),
  delivering: new Set(["delivered", "retry_wait", "failed"]),
  delivered: new Set(),
  retry_wait: new Set(["leased", "failed"]),
  failed: new Set(["retry_wait"]),
};

function assertTransition<State extends string>(
  family: string,
  transitions: Readonly<Record<State, ReadonlySet<State>>>,
  from: State,
  to: State,
): void {
  if (!transitions[from]?.has(to)) {
    throw new DomainError("conflict", `Illegal ${family} transition: ${from} -> ${to}`);
  }
}

export function assertJobTransition(from: JobState, to: JobState): void {
  assertTransition("job", jobTransitions, from, to);
}

export function assertArtifactTransition(from: ArtifactState, to: ArtifactState): void {
  assertTransition("artifact", artifactTransitions, from, to);
}

export function assertDeliveryTransition(from: DeliveryState, to: DeliveryState): void {
  assertTransition("delivery", deliveryTransitions, from, to);
}

export function isTerminalJobState(state: JobState): boolean {
  return state === "delivered" || state === "failed" || state === "cancelled" ||
    state === "expired";
}
