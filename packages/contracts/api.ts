import { z } from "@hono/zod-openapi";
import { isCanonicalTelegramUserId } from "../domain/telegram_id.ts";

export const telegramUserIdSchema = z.string().max(16).refine(isCanonicalTelegramUserId, {
  message: "Telegram user ID must be a positive canonical integer within the supported range",
});

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    correlationId: z.string(),
    retryable: z.boolean(),
  }),
}).openapi("ErrorEnvelope");

export const retentionPolicyContractSchema = z.object({
  mode: z.enum(["forever", "ttl", "after_delivery"]),
  ttlSeconds: z.number().int().positive(),
  afterDeliveryGraceSeconds: z.number().int().nonnegative(),
}).openapi("RetentionPolicy");

export const jobSchema = z.object({
  id: z.uuid(),
  displayId: z.string(),
  state: z.enum([
    "queued",
    "downloading",
    "processing",
    "ready",
    "delivering",
    "delivered",
    "failed",
    "cancelled",
    "expired",
  ]),
  progress: z.object({ phase: z.string(), percent: z.number().int().min(0).max(100).nullable() })
    .nullable(),
  attempts: z.number().int().nonnegative(),
  sourceId: z.string(),
  artifactId: z.uuid().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).openapi("Job");

export const createJobRequestSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  requester: z.object({ bridge: z.literal("telegram"), externalUserId: telegramUserIdSchema }),
  sourceUrl: z.string().min(1).max(2048),
  destination: z.object({
    chatId: z.string().regex(/^-?\d+$/),
    requestMessageId: z.number().int().positive(),
    progressMessageId: z.number().int().positive().optional(),
  }),
  retention: retentionPolicyContractSchema.optional(),
}).openapi("CreateJobRequest");

export const actorSchema = z.object({ actorUserId: telegramUserIdSchema });
export const requesterSchema = z.object({ requesterUserId: telegramUserIdSchema });

export const principalSchema = z.object({
  id: z.uuid(),
  externalUserId: telegramUserIdSchema,
  role: z.enum(["admin", "user"]),
  state: z.enum(["active", "disabled"]),
  expiresAt: z.iso.datetime().nullable(),
  note: z.string().nullable(),
}).openapi("Principal");

export const principalAccessSchema = z.object({
  state: z.enum(["active", "disabled", "unauthorized"]),
  role: z.enum(["admin", "user"]).nullable(),
  expiresAt: z.iso.datetime().nullable(),
}).openapi("PrincipalAccess");

export const paginationSchema = z.object({
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
}).openapi("Pagination");

export const jobListItemSchema = z.object({
  id: z.uuid(),
  displayId: z.string(),
  state: jobSchema.shape.state,
  attempts: z.number().int().nonnegative(),
  requesterExternalUserId: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).openapi("JobListItem");

export const auditEventSchema = z.object({
  id: z.uuid(),
  actorExternalId: telegramUserIdSchema.nullable(),
  action: z.string().max(100),
  targetType: z.string().max(100),
  targetId: z.string().max(100).nullable(),
  result: z.enum(["success", "failure"]),
  createdAt: z.iso.datetime(),
}).openapi("AuditEvent");

export const accessRequestSchema = z.object({
  id: z.uuid(),
  externalUserId: telegramUserIdSchema,
  state: z.enum(["pending", "approved", "denied"]),
  requestCount: z.number().int().positive(),
  notificationPending: z.boolean(),
  firstRequestedAt: z.iso.datetime(),
  lastRequestedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
}).openapi("AccessRequest");

export const createAccessRequestSchema = z.object({
  requestKey: z.string().min(1).max(200),
});

export const accessRequestNotificationLeaseSchema = z.object({
  id: z.uuid(),
  accessRequestId: z.uuid(),
  adminExternalUserId: telegramUserIdSchema,
  requesterExternalUserId: telegramUserIdSchema,
  attempts: z.number().int().positive(),
}).openapi("AccessRequestNotificationLease");

export const claimAccessRequestNotificationSchema = z.object({
  workerId: z.string().min(1).max(200),
  leaseSeconds: z.number().int().min(5).max(300),
});

export const completeAccessRequestNotificationSchema = z.object({
  workerId: z.string().min(1).max(200),
});

export const failAccessRequestNotificationSchema = completeAccessRequestNotificationSchema.extend({
  retryable: z.boolean(),
  retryAfterSeconds: z.number().int().min(1).max(3600),
  errorCode: z.enum(["retryable", "ambiguous", "permanent", "backend"]),
});

export const accessDecisionPromptSchema = z.object({
  id: z.uuid(),
  accessRequestId: z.uuid(),
  requesterExternalUserId: telegramUserIdSchema,
  action: z.enum(["allow", "deny"]),
  promptMessageId: z.number().int().positive().nullable(),
  expiresAt: z.iso.datetime(),
}).openapi("AccessDecisionPrompt");

export const beginAccessDecisionPromptSchema = actorSchema.extend({
  action: z.enum(["allow", "deny"]),
  ttlSeconds: z.number().int().min(30).max(1800),
});

export const attachAccessDecisionPromptSchema = actorSchema.extend({
  promptMessageId: z.number().int().positive(),
});

export const resolveAccessDecisionPromptSchema = actorSchema.extend({
  note: z.string().max(500).nullable(),
});

export const accessDecisionResultSchema = z.object({
  accessRequestId: z.uuid(),
  requesterExternalUserId: telegramUserIdSchema,
  decision: z.enum(["approved", "denied"]),
}).openapi("AccessDecisionResult");

export const accessDecisionNotificationLeaseSchema = z.object({
  id: z.uuid(),
  accessRequestId: z.uuid(),
  requesterExternalUserId: telegramUserIdSchema,
  decision: z.enum(["approved", "denied"]),
  attempts: z.number().int().positive(),
}).openapi("AccessDecisionNotificationLease");

export const putPrincipalRequestSchema = actorSchema.extend({
  note: z.string().max(500).nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
});

export const disablePrincipalRequestSchema = actorSchema.extend({
  reason: z.string().min(1).max(500),
});

export const deliveryDestinationSchema = z.object({
  chatId: z.string().regex(/^-?\d+$/),
  requestMessageId: z.number().int().positive(),
  progressMessageId: z.number().int().positive(),
}).passthrough();

export const deliveryLeaseSchema = z.object({
  id: z.uuid(),
  jobId: z.uuid(),
  displayId: z.string(),
  artifactId: z.uuid(),
  attempts: z.number().int().positive(),
  destination: deliveryDestinationSchema,
  operationContext: z.record(z.string(), z.unknown()).nullable(),
  artifactByteSize: z.number().int().nonnegative(),
  artifactContentType: z.string(),
  artifactVideoCodec: z.string().nullable().optional(),
  artifactAudioCodec: z.string().nullable().optional(),
  artifactReadyAt: z.iso.datetime().optional(),
}).openapi("DeliveryLease");

export const setDeliveryContextSchema = requesterSchema.extend({
  progressMessageId: z.number().int().positive(),
});

export const claimDeliverySchema = z.object({
  workerId: z.string().min(1).max(200),
  leaseSeconds: z.number().int().min(5).max(3600),
});

export const deliveryLeaseActionSchema = z.object({
  workerId: z.string().min(1).max(200),
  leaseSeconds: z.number().int().min(5).max(3600),
});

export const completeDeliverySchema = z.object({
  workerId: z.string().min(1).max(200),
  result: z.record(z.string(), z.unknown()),
});

export const recordDeliveryOperationSchema = z.object({
  workerId: z.string().min(1).max(200),
  context: z.record(z.string(), z.unknown()),
});

export const failDeliverySchema = z.object({
  workerId: z.string().min(1).max(200),
  errorCode: z.enum(["delivery_retryable", "delivery_permanent"]),
  safeMessage: z.string().min(1).max(500),
  retryAfterSeconds: z.number().int().min(1).max(86400).optional(),
});

export const deliveryProgressSchema = z.object({
  jobId: z.uuid(),
  displayId: z.string(),
  state: z.enum(["queued", "downloading", "processing"]),
  phase: z.string(),
  percent: z.number().min(0).max(100).nullable(),
  destination: deliveryDestinationSchema,
});

export const terminalProgressLeaseSchema = z.object({
  deliveryId: z.uuid(),
  jobId: z.uuid(),
  displayId: z.string(),
  state: z.enum(["failed", "cancelled", "expired"]),
  safeErrorMessage: z.string().nullable(),
  attempts: z.number().int().positive(),
  destination: deliveryDestinationSchema,
}).openapi("TerminalProgressLease");

export const terminalProgressActionSchema = z.object({
  workerId: z.string().min(1).max(200),
});

export const failTerminalProgressSchema = terminalProgressActionSchema.extend({
  retryable: z.boolean(),
  retryAfterSeconds: z.number().int().min(1).max(86400),
});
