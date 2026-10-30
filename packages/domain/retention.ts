import { z } from "zod";

export const retentionModeSchema = z.enum(["forever", "ttl", "after_delivery"]);
export type RetentionMode = z.infer<typeof retentionModeSchema>;

export const retentionPolicySchema = z.object({
  mode: retentionModeSchema,
  ttlSeconds: z.number().int().positive(),
  afterDeliveryGraceSeconds: z.number().int().nonnegative(),
});
export type RetentionPolicy = Readonly<z.infer<typeof retentionPolicySchema>>;

export function artifactExpiryAt(
  policy: RetentionPolicy,
  readyAt: Date,
  allDeliveriesCompletedAt?: Date,
): Date | null {
  switch (policy.mode) {
    case "forever":
      return null;
    case "ttl":
      return new Date(readyAt.getTime() + policy.ttlSeconds * 1000);
    case "after_delivery":
      return allDeliveriesCompletedAt
        ? new Date(allDeliveriesCompletedAt.getTime() + policy.afterDeliveryGraceSeconds * 1000)
        : null;
  }
}

export function isCleanupEligible(
  state: "ready" | "delete_failed" | "uploading" | "deleting" | "deleted",
  expiresAt: Date | null,
  now: Date,
  hasActiveDeliveryLease: boolean,
): boolean {
  return (state === "ready" || state === "delete_failed") &&
    expiresAt !== null && expiresAt <= now && !hasActiveDeliveryLease;
}
