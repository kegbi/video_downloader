import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bodyLimit } from "npm:hono@4.13.14/body-limit";
import { secureHeaders } from "npm:hono@4.13.14/secure-headers";
import type { AppConfig } from "../../packages/config/mod.ts";
import {
  accessDecisionNotificationLeaseSchema,
  accessDecisionPromptSchema,
  accessDecisionResultSchema,
  accessRequestNotificationLeaseSchema,
  accessRequestSchema,
  actorSchema,
  attachAccessDecisionPromptSchema,
  auditEventSchema,
  beginAccessDecisionPromptSchema,
  claimAccessRequestNotificationSchema,
  claimDeliverySchema,
  completeAccessRequestNotificationSchema,
  completeDeliverySchema,
  createAccessRequestSchema,
  createJobRequestSchema,
  deliveryLeaseActionSchema,
  deliveryLeaseSchema,
  deliveryProgressSchema,
  disablePrincipalRequestSchema,
  errorEnvelopeSchema,
  failAccessRequestNotificationSchema,
  failDeliverySchema,
  failTerminalProgressSchema,
  jobListItemSchema,
  jobSchema,
  paginationSchema,
  principalAccessSchema,
  principalSchema,
  putPrincipalRequestSchema,
  recordDeliveryOperationSchema,
  requesterSchema,
  resolveAccessDecisionPromptSchema,
  setDeliveryContextSchema,
  telegramUserIdSchema,
  terminalProgressActionSchema,
  terminalProgressLeaseSchema,
} from "../../packages/contracts/api.ts";
import type {
  AccessRequestRecord,
  AuditEventRecord,
  JobListRecord,
  JobRecord,
  PageResult,
  PrincipalRecord,
  Repository,
} from "../../packages/db/repository.ts";
import { type Database, databaseReady } from "../../packages/db/client.ts";
import { DomainError } from "../../packages/domain/errors.ts";
import { parseXStatusUrl } from "../../packages/domain/x_url.ts";
import type { MetricsRegistry } from "../../packages/observability/metrics.ts";
import type { ArtifactStorage } from "../../packages/storage/s3.ts";

export interface ApiDependencies {
  readonly config: Readonly<AppConfig>;
  readonly repository: Repository;
  readonly database: Database;
  readonly metrics: MetricsRegistry;
  readonly id: () => string;
  readonly storage?: ArtifactStorage;
  readonly observeLifecycle?: (
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ) => void;
}

const jsonContent = <Schema extends z.ZodType>(schema: Schema, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
const idParams = z.object({
  id: z.string().min(1).max(64).openapi({ param: { name: "id", in: "path" } }),
});
const userParams = z.object({
  userId: telegramUserIdSchema.openapi({ param: { name: "userId", in: "path" } }),
});
const deliveryParams = z.object({
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
});
const actorQuery = z.object({
  actorUserId: telegramUserIdSchema,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});
const pageQuery = actorQuery;
const jobsQuery = actorQuery.extend({
  filter: z.enum(["active", "failed", "recent"]).default("recent"),
});
const statusQuery = requesterSchema;

const createJobRoute = createRoute({
  method: "post",
  path: "/v1/jobs",
  request: { body: { content: { "application/json": { schema: createJobRequestSchema } } } },
  responses: {
    200: jsonContent(z.object({ job: jobSchema, created: z.boolean() }), "Idempotent job result"),
    400: jsonContent(errorEnvelopeSchema, "Invalid request"),
    401: jsonContent(errorEnvelopeSchema, "Unauthorized"),
  },
});
const listJobsRoute = createRoute({
  method: "get",
  path: "/v1/jobs",
  request: { query: jobsQuery },
  responses: {
    200: jsonContent(
      z.object({ jobs: z.array(jobListItemSchema), page: paginationSchema }),
      "Authorized job list",
    ),
    401: jsonContent(errorEnvelopeSchema, "Access required"),
  },
});
const getJobRoute = createRoute({
  method: "get",
  path: "/v1/jobs/{id}",
  request: { params: idParams, query: statusQuery },
  responses: {
    200: jsonContent(jobSchema, "Job status"),
    404: jsonContent(errorEnvelopeSchema, "Not found"),
  },
});
const cancelJobRoute = createRoute({
  method: "post",
  path: "/v1/jobs/{id}/cancel",
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: requesterSchema } } },
  },
  responses: {
    200: jsonContent(jobSchema, "Cancellation requested"),
    409: jsonContent(errorEnvelopeSchema, "Not cancellable"),
  },
});
const retryJobRoute = createRoute({
  method: "post",
  path: "/v1/jobs/{id}/retry",
  request: { params: idParams, body: { content: { "application/json": { schema: actorSchema } } } },
  responses: {
    200: jsonContent(jobSchema, "Job requeued"),
    401: jsonContent(errorEnvelopeSchema, "Administrator required"),
    409: jsonContent(errorEnvelopeSchema, "Not retryable"),
  },
});
const setDeliveryContextRoute = createRoute({
  method: "post",
  path: "/v1/jobs/{id}/delivery-context",
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: setDeliveryContextSchema } } },
  },
  responses: { 200: jsonContent(z.object({ updated: z.boolean() }), "Delivery context updated") },
});
const claimDeliveryRoute = createRoute({
  method: "post",
  path: "/v1/deliveries/claim",
  request: { body: { content: { "application/json": { schema: claimDeliverySchema } } } },
  responses: {
    200: jsonContent(z.object({ delivery: deliveryLeaseSchema.nullable() }), "Claimed delivery"),
  },
});
const deliveryProgressRoute = createRoute({
  method: "get",
  path: "/v1/deliveries/progress",
  request: {
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
  },
  responses: {
    200: jsonContent(z.object({ progress: z.array(deliveryProgressSchema) }), "Active progress"),
  },
});
const claimTerminalProgressRoute = createRoute({
  method: "post",
  path: "/v1/deliveries/progress/claim",
  request: { body: { content: { "application/json": { schema: claimDeliverySchema } } } },
  responses: {
    200: jsonContent(
      z.object({ progress: terminalProgressLeaseSchema.nullable() }),
      "Claimed terminal progress update",
    ),
  },
});
const completeTerminalProgressRoute = createRoute({
  method: "post",
  path: "/v1/deliveries/progress/{id}/complete",
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: terminalProgressActionSchema } } },
  },
  responses: {
    200: jsonContent(z.object({ completed: z.boolean() }), "Terminal progress finalized"),
  },
});
const failTerminalProgressRoute = createRoute({
  method: "post",
  path: "/v1/deliveries/progress/{id}/fail",
  request: {
    params: idParams,
    body: { content: { "application/json": { schema: failTerminalProgressSchema } } },
  },
  responses: {
    200: jsonContent(z.object({ recorded: z.boolean() }), "Terminal progress failure recorded"),
  },
});
const heartbeatDeliveryRoute = createRoute({
  method: "post",
  path: "/v1/deliveries/{id}/heartbeat",
  request: {
    params: deliveryParams,
    body: { content: { "application/json": { schema: deliveryLeaseActionSchema } } },
  },
  responses: { 200: jsonContent(z.object({ extended: z.boolean() }), "Lease heartbeat") },
});
const completeDeliveryRoute = createRoute({
  method: "post",
  path: "/v1/deliveries/{id}/complete",
  request: {
    params: deliveryParams,
    body: { content: { "application/json": { schema: completeDeliverySchema } } },
  },
  responses: { 200: jsonContent(z.object({ completed: z.boolean() }), "Delivery completed") },
});
const recordDeliveryOperationRoute = createRoute({
  method: "post",
  path: "/v1/deliveries/{id}/operation",
  request: {
    params: deliveryParams,
    body: { content: { "application/json": { schema: recordDeliveryOperationSchema } } },
  },
  responses: { 200: jsonContent(z.object({ recorded: z.boolean() }), "Operation recorded") },
});
const failDeliveryRoute = createRoute({
  method: "post",
  path: "/v1/deliveries/{id}/fail",
  request: {
    params: deliveryParams,
    body: { content: { "application/json": { schema: failDeliverySchema } } },
  },
  responses: { 200: jsonContent(z.object({ recorded: z.boolean() }), "Delivery failure recorded") },
});
const listPrincipalsRoute = createRoute({
  method: "get",
  path: "/v1/principals",
  request: { query: actorQuery },
  responses: {
    200: jsonContent(
      z.object({ principals: z.array(principalSchema), page: paginationSchema }),
      "Principals",
    ),
  },
});
const principalAccessRoute = createRoute({
  method: "get",
  path: "/v1/principals/telegram/{userId}/access",
  request: { params: userParams },
  responses: { 200: jsonContent(principalAccessSchema, "Current server-side access") },
});
const putPrincipalRoute = createRoute({
  method: "put",
  path: "/v1/principals/telegram/{userId}",
  request: {
    params: userParams,
    body: { content: { "application/json": { schema: putPrincipalRequestSchema } } },
  },
  responses: { 200: jsonContent(principalSchema, "Allowed principal") },
});
const deletePrincipalRoute = createRoute({
  method: "delete",
  path: "/v1/principals/telegram/{userId}",
  request: {
    params: userParams,
    body: { content: { "application/json": { schema: disablePrincipalRequestSchema } } },
  },
  responses: { 200: jsonContent(principalSchema, "Disabled principal") },
});
const createAccessRequestRoute = createRoute({
  method: "post",
  path: "/v1/access-requests/telegram/{userId}",
  request: {
    params: userParams,
    body: { content: { "application/json": { schema: createAccessRequestSchema } } },
  },
  responses: {
    200: jsonContent(
      z.object({ request: accessRequestSchema, created: z.boolean() }),
      "Deduplicated access request",
    ),
  },
});
const listAccessRequestsRoute = createRoute({
  method: "get",
  path: "/v1/access-requests",
  request: { query: pageQuery },
  responses: {
    200: jsonContent(
      z.object({ requests: z.array(accessRequestSchema), page: paginationSchema }),
      "Pending access requests",
    ),
    401: jsonContent(errorEnvelopeSchema, "Administrator required"),
  },
});
const accessRequestParams = z.object({
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
});
const claimAccessRequestNotificationRoute = createRoute({
  method: "post",
  path: "/v1/access-request-notifications/claim",
  request: {
    body: { content: { "application/json": { schema: claimAccessRequestNotificationSchema } } },
  },
  responses: {
    200: jsonContent(
      z.object({ notification: accessRequestNotificationLeaseSchema.nullable() }),
      "Claimed access request notification",
    ),
  },
});
const completeAccessRequestNotificationRoute = createRoute({
  method: "post",
  path: "/v1/access-request-notifications/{id}/complete",
  request: {
    params: accessRequestParams,
    body: {
      content: { "application/json": { schema: completeAccessRequestNotificationSchema } },
    },
  },
  responses: { 200: jsonContent(z.object({ completed: z.boolean() }), "Notification completed") },
});
const failAccessRequestNotificationRoute = createRoute({
  method: "post",
  path: "/v1/access-request-notifications/{id}/fail",
  request: {
    params: accessRequestParams,
    body: { content: { "application/json": { schema: failAccessRequestNotificationSchema } } },
  },
  responses: { 200: jsonContent(z.object({ recorded: z.boolean() }), "Notification failure") },
});
const beginAccessDecisionPromptRoute = createRoute({
  method: "post",
  path: "/v1/access-requests/{id}/decision-prompts",
  request: {
    params: accessRequestParams,
    body: { content: { "application/json": { schema: beginAccessDecisionPromptSchema } } },
  },
  responses: { 200: jsonContent(accessDecisionPromptSchema, "Decision prompt started") },
});
const activeAccessDecisionPromptRoute = createRoute({
  method: "get",
  path: "/v1/access-decision-prompts/active",
  request: { query: actorSchema },
  responses: {
    200: jsonContent(
      z.object({ prompt: accessDecisionPromptSchema.nullable() }),
      "Active administrator prompt",
    ),
  },
});
const attachAccessDecisionPromptRoute = createRoute({
  method: "post",
  path: "/v1/access-decision-prompts/{id}/message",
  request: {
    params: accessRequestParams,
    body: { content: { "application/json": { schema: attachAccessDecisionPromptSchema } } },
  },
  responses: { 200: jsonContent(accessDecisionPromptSchema, "Prompt message attached") },
});
const resolveAccessDecisionPromptRoute = createRoute({
  method: "post",
  path: "/v1/access-decision-prompts/{id}/resolve",
  request: {
    params: accessRequestParams,
    body: { content: { "application/json": { schema: resolveAccessDecisionPromptSchema } } },
  },
  responses: { 200: jsonContent(accessDecisionResultSchema, "Access request resolved") },
});
const cancelAccessDecisionPromptRoute = createRoute({
  method: "post",
  path: "/v1/access-decision-prompts/{id}/cancel",
  request: {
    params: accessRequestParams,
    body: { content: { "application/json": { schema: actorSchema } } },
  },
  responses: { 200: jsonContent(z.object({ cancelled: z.boolean() }), "Prompt cancelled") },
});
const claimAccessDecisionNotificationRoute = createRoute({
  method: "post",
  path: "/v1/access-decision-notifications/claim",
  request: {
    body: { content: { "application/json": { schema: claimAccessRequestNotificationSchema } } },
  },
  responses: {
    200: jsonContent(
      z.object({ notification: accessDecisionNotificationLeaseSchema.nullable() }),
      "Claimed requester decision notification",
    ),
  },
});
const completeAccessDecisionNotificationRoute = createRoute({
  method: "post",
  path: "/v1/access-decision-notifications/{id}/complete",
  request: {
    params: accessRequestParams,
    body: { content: { "application/json": { schema: completeAccessRequestNotificationSchema } } },
  },
  responses: { 200: jsonContent(z.object({ completed: z.boolean() }), "Notification completed") },
});
const failAccessDecisionNotificationRoute = createRoute({
  method: "post",
  path: "/v1/access-decision-notifications/{id}/fail",
  request: {
    params: accessRequestParams,
    body: { content: { "application/json": { schema: failAccessRequestNotificationSchema } } },
  },
  responses: { 200: jsonContent(z.object({ recorded: z.boolean() }), "Notification failure") },
});
const listAuditRoute = createRoute({
  method: "get",
  path: "/v1/audit-events",
  request: { query: pageQuery },
  responses: {
    200: jsonContent(
      z.object({ events: z.array(auditEventSchema), page: paginationSchema }),
      "Sanitized audit events",
    ),
    401: jsonContent(errorEnvelopeSchema, "Administrator required"),
  },
});

export function createApi(dependencies: ApiDependencies): OpenAPIHono {
  const { config, repository, database, metrics, id } = dependencies;
  const correlationIds = new WeakMap<object, string>();
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (result.success) return;
      metrics.increment("video_downloader_api_errors_total");
      return c.json(
        errorBody("invalid_url", "Invalid request", correlation(c), false),
        400,
      );
    },
  });
  app.use("*", secureHeaders());
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (c) =>
        c.json(errorBody("invalid_url", "Request body is too large", correlation(c), false), 413),
    }),
  );
  app.use("/v1/*", async (c, next) => {
    const authorization = c.req.header("authorization");
    if (
      !authorization?.startsWith("Bearer ") ||
      !constantTimeEqual(authorization.slice(7), config.INTERNAL_API_TOKEN)
    ) {
      metrics.increment("video_downloader_api_unauthorized_total");
      return c.json(
        errorBody("unauthorized", "Invalid service credentials", correlation(c), false),
        401,
      );
    }
    await next();
  });
  app.use("/v1/*", async (c, next) => {
    if (c.req.raw.body !== null && isJsonMediaType(c.req.header("content-type"))) {
      try {
        await c.req.json();
      } catch {
        metrics.increment("video_downloader_api_errors_total");
        return c.json(
          errorBody("invalid_url", "Invalid request", correlation(c), false),
          400,
        );
      }
    }
    await next();
  });
  app.onError((error, c) => {
    const domain = error instanceof DomainError
      ? error
      : new DomainError("internal_error", "An internal error occurred");
    metrics.increment("video_downloader_api_errors_total");
    const status = statusFor(domain);
    return c.json(errorBody(domain.code, domain.message, correlation(c), domain.retryable), status);
  });
  app.get("/health/live", (c) => c.json({ status: "ok" }));
  app.get("/health/ready", async (c) => {
    const ready = await databaseReady(database);
    return c.json({ status: ready ? "ready" : "not_ready", database: ready }, ready ? 200 : 503);
  });
  app.get(
    config.METRICS_PATH,
    (c) =>
      config.METRICS_ENABLED
        ? c.text(metrics.render(), 200, { "content-type": "text/plain; version=0.0.4" })
        : c.notFound(),
  );
  app.get("/v1/artifacts/:id/content", async (c) => {
    if (!dependencies.storage) {
      throw new DomainError("storage_failure", "Artifact storage is unavailable", true);
    }
    const artifact = await repository.getReadyArtifact(c.req.param("id"));
    if (!artifact) throw new DomainError("not_found", "Artifact not found");
    const range = c.req.header("range");
    if (range && !/^bytes=\d*-\d*$/.test(range)) {
      throw new DomainError("conflict", "Only one valid byte range may be requested");
    }
    const content = await dependencies.storage.read(artifact.objectKey, range);
    const headers = new Headers({
      "accept-ranges": "bytes",
      "content-type": content.contentType,
      "content-length": String(content.contentLength),
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${artifact.id}.mp4"`,
    });
    if (content.contentRange) headers.set("content-range", content.contentRange);
    return new Response(content.body, { status: range ? 206 : 200, headers });
  });

  app.openapi(createJobRoute, async (c) => {
    const startedAt = performance.now();
    const input = c.req.valid("json");
    const parsed = parseXStatusUrl(input.sourceUrl, config.sourceAllowedHosts);
    const result = await repository.submitJob({
      bridge: input.requester.bridge,
      idempotencyKey: input.idempotencyKey,
      requesterExternalUserId: input.requester.externalUserId,
      submittedUrl: parsed.submittedUrl,
      normalizedUrl: parsed.normalizedUrl,
      sourceId: parsed.statusId,
      destination: input.destination,
      policy: input.retention ?? {
        mode: config.RETENTION_DEFAULT_MODE,
        ttlSeconds: config.RETENTION_TTL_SECONDS,
        afterDeliveryGraceSeconds: config.RETENTION_AFTER_DELIVERY_GRACE_SECONDS,
      },
      retentionOrigin: input.retention === undefined ? "default" : "explicit",
      maxQueuedJobs: config.MAX_QUEUED_JOBS,
      maxActiveJobsPerUser: config.MAX_ACTIVE_JOBS_PER_USER,
    });
    metrics.increment("video_downloader_jobs_submitted_total", result.created ? 1 : 0);
    try {
      dependencies.observeLifecycle?.("job.submitted", {
        jobId: result.job.id,
        created: result.created,
        durationMilliseconds: elapsedMilliseconds(startedAt),
      });
    } catch {
      // Observability must never change API behavior.
    }
    return c.json({ job: jobResponse(result.job), created: result.created }, 200);
  });
  app.openapi(listJobsRoute, async (c) => {
    const query = c.req.valid("query");
    const result = await repository.listJobs(
      query.actorUserId,
      query.filter,
      query.limit,
      query.offset,
    );
    return c.json({
      jobs: result.items.map(jobListResponse),
      page: paginationResponse(result),
    }, 200);
  });
  app.openapi(getJobRoute, async (c) => {
    const job = await repository.getJobAuthorized(
      c.req.valid("param").id,
      c.req.valid("query").requesterUserId,
    );
    if (!job) throw new DomainError("not_found", "Job not found");
    return c.json(jobResponse(job), 200);
  });
  app.openapi(
    cancelJobRoute,
    async (c) =>
      c.json(
        jobResponse(
          await repository.requestCancellation(
            c.req.valid("param").id,
            c.req.valid("json").requesterUserId,
            correlation(c),
          ),
        ),
        200,
      ),
  );
  app.openapi(
    retryJobRoute,
    async (c) =>
      c.json(
        jobResponse(
          await repository.retryFailedJob(
            c.req.valid("param").id,
            c.req.valid("json").actorUserId,
            correlation(c),
          ),
        ),
        200,
      ),
  );
  app.openapi(setDeliveryContextRoute, async (c) => {
    const body = c.req.valid("json");
    const updated = await repository.setDeliveryProgressMessage(
      c.req.valid("param").id,
      body.requesterUserId,
      body.progressMessageId,
    );
    if (!updated) throw new DomainError("not_found", "Job delivery not found");
    return c.json({ updated }, 200);
  });
  app.openapi(claimDeliveryRoute, async (c) => {
    const body = c.req.valid("json");
    const delivery = await repository.claimDelivery(body.workerId, body.leaseSeconds);
    if (delivery && !delivery.destination.progressMessageId) {
      await repository.failDelivery({
        deliveryId: delivery.id,
        workerId: body.workerId,
        errorCode: "delivery_retryable",
        safeMessage: "Delivery acknowledgement is not ready",
        retryAfterSeconds: 2,
      });
      return c.json({ delivery: null }, 200);
    }
    return c.json({
      delivery: delivery
        ? { ...delivery, artifactReadyAt: delivery.artifactReadyAt.toISOString() }
        : null,
    }, 200);
  });
  app.openapi(deliveryProgressRoute, async (c) => {
    return c.json({
      progress: await repository.listDeliveryProgress(c.req.valid("query").limit),
    }, 200);
  });
  app.openapi(claimTerminalProgressRoute, async (c) => {
    const body = c.req.valid("json");
    return c.json({
      progress: await repository.claimTerminalProgress(body.workerId, body.leaseSeconds),
    }, 200);
  });
  app.openapi(completeTerminalProgressRoute, async (c) => {
    const body = c.req.valid("json");
    return c.json({
      completed: await repository.completeTerminalProgress(
        c.req.valid("param").id,
        body.workerId,
      ),
    }, 200);
  });
  app.openapi(failTerminalProgressRoute, async (c) => {
    const body = c.req.valid("json");
    return c.json({
      recorded: await repository.failTerminalProgress({
        deliveryId: c.req.valid("param").id,
        workerId: body.workerId,
        retryable: body.retryable,
        retryAfterSeconds: body.retryAfterSeconds,
      }),
    }, 200);
  });
  app.openapi(heartbeatDeliveryRoute, async (c) => {
    const body = c.req.valid("json");
    return c.json({
      extended: await repository.heartbeatDelivery(
        c.req.valid("param").id,
        body.workerId,
        body.leaseSeconds,
      ),
    }, 200);
  });
  app.openapi(completeDeliveryRoute, async (c) => {
    const body = c.req.valid("json");
    const completed = await repository.completeDelivery(
      c.req.valid("param").id,
      body.workerId,
      body.result,
    );
    if (!completed) throw new DomainError("conflict", "Delivery lease is no longer active");
    return c.json({ completed }, 200);
  });
  app.openapi(recordDeliveryOperationRoute, async (c) => {
    const body = c.req.valid("json");
    const recorded = await repository.recordDeliveryOperation(
      c.req.valid("param").id,
      body.workerId,
      body.context,
    );
    if (!recorded) throw new DomainError("conflict", "Delivery lease is no longer active");
    return c.json({ recorded }, 200);
  });
  app.openapi(failDeliveryRoute, async (c) => {
    const body = c.req.valid("json");
    const recorded = await repository.failDelivery({
      deliveryId: c.req.valid("param").id,
      ...body,
    });
    if (!recorded) throw new DomainError("conflict", "Delivery lease is no longer active");
    return c.json({ recorded }, 200);
  });
  app.openapi(listPrincipalsRoute, async (c) => {
    const query = c.req.valid("query");
    const result = await repository.listPrincipals(
      query.actorUserId,
      query.limit,
      query.offset,
    );
    return c.json({
      principals: result.items.map(principalResponse),
      page: paginationResponse(result),
    }, 200);
  });
  app.openapi(principalAccessRoute, async (c) => {
    const userId = c.req.valid("param").userId;
    const [principal, authorized] = await Promise.all([
      repository.getTelegramPrincipal(userId),
      repository.findAuthorizedTelegramPrincipal(userId),
    ]);
    const active = authorized !== null;
    return c.json({
      state: active ? "active" : principal?.state === "disabled" ? "disabled" : "unauthorized",
      role: authorized?.role ?? null,
      expiresAt: authorized?.expiresAt?.toISOString() ?? null,
    }, 200);
  });
  app.openapi(putPrincipalRoute, async (c) => {
    const body = c.req.valid("json");
    const principal = await repository.adminUpsertTelegramPrincipal({
      actorExternalUserId: body.actorUserId,
      targetExternalUserId: c.req.valid("param").userId,
      note: body.note,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : body.expiresAt,
      correlationId: correlation(c),
    });
    return c.json(principalResponse(principal), 200);
  });
  app.openapi(deletePrincipalRoute, async (c) => {
    const body = c.req.valid("json");
    const principal = await repository.adminDisableTelegramPrincipal({
      actorExternalUserId: body.actorUserId,
      targetExternalUserId: c.req.valid("param").userId,
      reason: body.reason,
      correlationId: correlation(c),
    });
    return c.json(principalResponse(principal), 200);
  });
  app.openapi(createAccessRequestRoute, async (c) => {
    const result = await repository.requestTelegramAccess({
      externalUserId: c.req.valid("param").userId,
      requestKey: c.req.valid("json").requestKey,
      correlationId: correlation(c),
      deniedCooldownSeconds: config.ACCESS_REQUEST_DENIED_COOLDOWN_SECONDS,
    });
    return c.json({ request: accessRequestResponse(result.request), created: result.created }, 200);
  });
  app.openapi(listAccessRequestsRoute, async (c) => {
    const query = c.req.valid("query");
    const result = await repository.listAccessRequests(
      query.actorUserId,
      query.limit,
      query.offset,
    );
    return c.json({
      requests: result.items.map(accessRequestResponse),
      page: paginationResponse(result),
    }, 200);
  });
  app.openapi(claimAccessRequestNotificationRoute, async (c) => {
    const body = c.req.valid("json");
    return c.json({
      notification: await repository.claimAccessRequestNotification(
        body.workerId,
        body.leaseSeconds,
      ),
    }, 200);
  });
  app.openapi(completeAccessRequestNotificationRoute, async (c) => {
    return c.json({
      completed: await repository.completeAccessRequestNotification(
        c.req.valid("param").id,
        c.req.valid("json").workerId,
      ),
    }, 200);
  });
  app.openapi(failAccessRequestNotificationRoute, async (c) => {
    const body = c.req.valid("json");
    return c.json({
      recorded: await repository.failAccessRequestNotification({
        id: c.req.valid("param").id,
        workerId: body.workerId,
        retryable: body.retryable,
        retryAfterSeconds: body.retryAfterSeconds,
        maxAttempts: config.TELEGRAM_ACCESS_NOTIFICATION_MAX_ATTEMPTS,
        errorCode: body.errorCode,
      }),
    }, 200);
  });
  app.openapi(beginAccessDecisionPromptRoute, async (c) => {
    const body = c.req.valid("json");
    return c.json(
      accessDecisionPromptResponse(
        await repository.beginAccessDecisionPrompt({
          actorExternalUserId: body.actorUserId,
          accessRequestId: c.req.valid("param").id,
          action: body.action,
          ttlSeconds: body.ttlSeconds,
        }),
      ),
      200,
    );
  });
  app.openapi(activeAccessDecisionPromptRoute, async (c) => {
    const prompt = await repository.getActiveAccessDecisionPrompt(c.req.valid("query").actorUserId);
    return c.json({ prompt: prompt ? accessDecisionPromptResponse(prompt) : null }, 200);
  });
  app.openapi(attachAccessDecisionPromptRoute, async (c) => {
    const body = c.req.valid("json");
    return c.json(
      accessDecisionPromptResponse(
        await repository.attachAccessDecisionPromptMessage({
          actorExternalUserId: body.actorUserId,
          promptId: c.req.valid("param").id,
          promptMessageId: body.promptMessageId,
        }),
      ),
      200,
    );
  });
  app.openapi(resolveAccessDecisionPromptRoute, async (c) => {
    const body = c.req.valid("json");
    return c.json(
      await repository.resolveAccessDecisionPrompt({
        actorExternalUserId: body.actorUserId,
        promptId: c.req.valid("param").id,
        note: body.note,
        correlationId: correlation(c),
      }),
      200,
    );
  });
  app.openapi(cancelAccessDecisionPromptRoute, async (c) => {
    return c.json({
      cancelled: await repository.cancelAccessDecisionPrompt({
        actorExternalUserId: c.req.valid("json").actorUserId,
        promptId: c.req.valid("param").id,
      }),
    }, 200);
  });
  app.openapi(claimAccessDecisionNotificationRoute, async (c) => {
    const body = c.req.valid("json");
    return c.json({
      notification: await repository.claimAccessDecisionNotification(
        body.workerId,
        body.leaseSeconds,
      ),
    }, 200);
  });
  app.openapi(completeAccessDecisionNotificationRoute, async (c) => {
    return c.json({
      completed: await repository.completeAccessDecisionNotification(
        c.req.valid("param").id,
        c.req.valid("json").workerId,
      ),
    }, 200);
  });
  app.openapi(failAccessDecisionNotificationRoute, async (c) => {
    const body = c.req.valid("json");
    return c.json({
      recorded: await repository.failAccessDecisionNotification({
        id: c.req.valid("param").id,
        workerId: body.workerId,
        retryable: body.retryable,
        retryAfterSeconds: body.retryAfterSeconds,
        maxAttempts: config.TELEGRAM_ACCESS_NOTIFICATION_MAX_ATTEMPTS,
        errorCode: body.errorCode,
      }),
    }, 200);
  });
  app.openapi(listAuditRoute, async (c) => {
    const query = c.req.valid("query");
    const result = await repository.listAuditEvents(
      query.actorUserId,
      query.limit,
      query.offset,
    );
    return c.json({
      events: result.items.map(auditEventResponse),
      page: paginationResponse(result),
    }, 200);
  });
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Video Downloader API", version: "1.0.0" },
  });
  return app;

  function correlation(c: { req: { header(name: string): string | undefined } }): string {
    const supplied = c.req.header("x-correlation-id");
    if (supplied && /^[A-Za-z0-9._:-]{1,100}$/.test(supplied)) return supplied;
    const key = c as object;
    const existing = correlationIds.get(key);
    if (existing) return existing;
    const generated = id();
    correlationIds.set(key, generated);
    return generated;
  }
}

function jobResponse(job: JobRecord): z.infer<typeof jobSchema> {
  return {
    id: job.id,
    displayId: job.displayId,
    state: job.state,
    progress: job.progressPhase ? { phase: job.progressPhase, percent: job.progressPercent } : null,
    attempts: job.attempts,
    sourceId: job.sourceId,
    artifactId: job.artifactId,
    error: job.errorCode
      ? { code: job.errorCode, message: job.safeErrorMessage ?? "Job failed" }
      : null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
function principalResponse(principal: PrincipalRecord): z.infer<typeof principalSchema> {
  return {
    id: principal.id,
    externalUserId: principal.externalUserId,
    role: principal.role,
    state: principal.state,
    expiresAt: principal.expiresAt?.toISOString() ?? null,
    note: principal.note,
  };
}
function jobListResponse(job: JobListRecord): z.infer<typeof jobListItemSchema> {
  return {
    id: job.id,
    displayId: job.displayId,
    state: job.state,
    attempts: job.attempts,
    requesterExternalUserId: job.requesterExternalUserId,
    error: job.errorCode
      ? { code: job.errorCode, message: job.safeErrorMessage ?? "Job failed" }
      : null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
function auditEventResponse(event: AuditEventRecord): z.infer<typeof auditEventSchema> {
  return {
    id: event.id,
    actorExternalId: /^\d+$/.test(event.actorExternalId ?? "") ? event.actorExternalId : null,
    action: event.action.slice(0, 100),
    targetType: event.targetType.slice(0, 100),
    targetId: event.targetId?.slice(0, 100) ?? null,
    result: event.result,
    createdAt: event.createdAt.toISOString(),
  };
}
function accessRequestResponse(request: AccessRequestRecord): z.infer<typeof accessRequestSchema> {
  return {
    id: request.id,
    externalUserId: request.externalUserId,
    state: request.state,
    requestCount: request.requestCount,
    notificationPending: request.notificationPending,
    firstRequestedAt: request.firstRequestedAt.toISOString(),
    lastRequestedAt: request.lastRequestedAt.toISOString(),
    resolvedAt: request.resolvedAt?.toISOString() ?? null,
  };
}

function accessDecisionPromptResponse(
  prompt: import("../../packages/db/records.ts").AccessDecisionPromptRecord,
): z.infer<typeof accessDecisionPromptSchema> {
  return {
    id: prompt.id,
    accessRequestId: prompt.accessRequestId,
    requesterExternalUserId: prompt.requesterExternalUserId,
    action: prompt.action,
    promptMessageId: prompt.promptMessageId,
    expiresAt: prompt.expiresAt.toISOString(),
  };
}
function paginationResponse<Value>(page: PageResult<Value>): z.infer<typeof paginationSchema> {
  return {
    limit: page.limit,
    offset: page.offset,
    hasMore: page.hasMore,
    nextOffset: page.hasMore ? page.offset + page.limit : null,
  };
}
function errorBody(code: string, message: string, correlationId: string, retryable: boolean) {
  return { error: { code, message, correlationId, retryable } };
}

function isJsonMediaType(contentType: string | undefined): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" ||
    (mediaType?.startsWith("application/") === true && mediaType.endsWith("+json"));
}
function statusFor(error: DomainError): 400 | 401 | 404 | 409 | 429 | 500 | 503 {
  if (error.code === "unauthorized") return 401;
  if (error.code === "not_found") return 404;
  if (error.code === "conflict") return 409;
  if (error.code === "queue_full" || error.code === "active_job_limit") return 429;
  if (error.code === "internal_error") return 500;
  if (error.retryable) return 503;
  return 400;
}
function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1_000) / 1_000;
}
