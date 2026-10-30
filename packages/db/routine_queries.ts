import {
  and,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DomainError } from "../domain/errors.ts";
import { retentionPolicySchema } from "../domain/retention.ts";
import type {
  AccessRequestRecord,
  ArtifactRecord,
  AuditEventRecord,
  DeliveryProgressRecord,
  JobListRecord,
  JobRecord,
  PageResult,
  PrincipalRecord,
} from "./records.ts";
import type { OrmDatabase } from "./orm.ts";
import {
  accessRequests,
  type ArtifactRow,
  artifacts,
  auditEvents,
  deliveries,
  type JobRow,
  jobs,
  principals,
} from "./schema.ts";

export interface UpsertPrincipalInput {
  readonly externalUserId: string;
  readonly role?: "admin" | "user";
  readonly state?: "active" | "disabled";
  readonly note?: string | null;
  readonly expiresAt?: Date | null;
  readonly actorPrincipalId?: string | null;
}

export interface RoutineDataAccess {
  upsertTelegramPrincipal(
    input: UpsertPrincipalInput,
    id: string,
    now: Date,
  ): Promise<PrincipalRecord>;
  findAuthorizedTelegramPrincipal(
    externalUserId: string,
    now: Date,
  ): Promise<PrincipalRecord | null>;
  getJob(id: string): Promise<JobRecord | null>;
  getJobAuthorized(id: string, actorExternalUserId: string, now: Date): Promise<JobRecord | null>;
  getTelegramPrincipal(externalUserId: string): Promise<PrincipalRecord | null>;
  listPrincipals(
    actorExternalUserId: string,
    limit: number,
    offset: number,
    now: Date,
  ): Promise<PageResult<PrincipalRecord>>;
  listJobs(
    actorExternalUserId: string,
    filter: "active" | "failed" | "recent",
    limit: number,
    offset: number,
    now: Date,
  ): Promise<PageResult<JobListRecord>>;
  listAuditEvents(
    actorExternalUserId: string,
    limit: number,
    offset: number,
    now: Date,
  ): Promise<PageResult<AuditEventRecord>>;
  listAccessRequests(
    actorExternalUserId: string,
    limit: number,
    offset: number,
    now: Date,
  ): Promise<PageResult<AccessRequestRecord>>;
  markArtifactUploadFailed(artifactId: string, safeError: string, now: Date): Promise<void>;
  getReadyArtifact(id: string): Promise<ArtifactRecord | null>;
  listDeliveryProgress(limit: number): Promise<readonly DeliveryProgressRecord[]>;
}

const principalSelection = {
  id: principals.id,
  bridge: principals.bridge,
  externalUserId: principals.externalUserId,
  role: principals.role,
  state: principals.state,
  expiresAt: principals.expiresAt,
  note: principals.note,
};

export class DrizzleRoutineQueries implements RoutineDataAccess {
  constructor(private readonly db: OrmDatabase) {}

  async upsertTelegramPrincipal(
    input: UpsertPrincipalInput,
    id: string,
    now: Date,
  ): Promise<PrincipalRecord> {
    const rows = await this.db.insert(principals).values({
      id,
      bridge: "telegram",
      externalUserId: input.externalUserId,
      role: input.role ?? "user",
      state: input.state ?? "active",
      expiresAt: input.expiresAt ?? null,
      note: input.note ?? null,
      createdBy: input.actorPrincipalId ?? null,
      updatedBy: input.actorPrincipalId ?? null,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [principals.bridge, principals.externalUserId],
      set: {
        role: sql<"admin" | "user">`CASE
          WHEN ${principals.role} = 'admin' THEN 'admin'
          ELSE excluded.role
        END`,
        state: input.state ?? "active",
        expiresAt: input.expiresAt ?? null,
        note: input.note ?? null,
        updatedBy: input.actorPrincipalId ?? null,
        updatedAt: now,
      },
    }).returning(principalSelection);
    return required(rows[0], "principal upsert");
  }

  async findAuthorizedTelegramPrincipal(
    externalUserId: string,
    now: Date,
  ): Promise<PrincipalRecord | null> {
    const rows = await this.db.select(principalSelection).from(principals).where(and(
      eq(principals.bridge, "telegram"),
      eq(principals.externalUserId, externalUserId),
      eq(principals.state, "active"),
      or(isNull(principals.expiresAt), gt(principals.expiresAt, now)),
    )).limit(1);
    return rows[0] ?? null;
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const rows = await this.db.select().from(jobs).where(or(
      sql`${jobs.id}::text = ${id}`,
      eq(jobs.displayId, id),
    )).limit(1);
    return rows[0] ? mapTypedJob(rows[0]) : null;
  }

  async getJobAuthorized(
    id: string,
    actorExternalUserId: string,
    now: Date,
  ): Promise<JobRecord | null> {
    const actor = alias(principals, "actor");
    const rows = await this.db.select(getTableColumns(jobs)).from(jobs).innerJoin(
      actor,
      and(
        eq(actor.bridge, "telegram"),
        eq(actor.externalUserId, actorExternalUserId),
        eq(actor.state, "active"),
        or(isNull(actor.expiresAt), gt(actor.expiresAt, now)),
      ),
    ).where(and(
      or(sql`${jobs.id}::text = ${id}`, eq(jobs.displayId, id)),
      or(eq(actor.role, "admin"), eq(actor.id, jobs.requesterPrincipalId)),
    )).limit(1);
    return rows[0] ? mapTypedJob(rows[0]) : null;
  }

  async getTelegramPrincipal(externalUserId: string): Promise<PrincipalRecord | null> {
    const rows = await this.db.select(principalSelection).from(principals).where(and(
      eq(principals.bridge, "telegram"),
      eq(principals.externalUserId, externalUserId),
    )).limit(1);
    return rows[0] ?? null;
  }

  async listPrincipals(
    actorExternalUserId: string,
    limit: number,
    offset: number,
    now: Date,
  ): Promise<PageResult<PrincipalRecord>> {
    await this.requireAdmin(actorExternalUserId, now);
    const rows = await this.db.select(principalSelection).from(principals)
      .orderBy(desc(principals.updatedAt), principals.id).limit(limit + 1).offset(offset);
    return page(rows, limit, offset);
  }

  async listJobs(
    actorExternalUserId: string,
    filter: "active" | "failed" | "recent",
    limit: number,
    offset: number,
    now: Date,
  ): Promise<PageResult<JobListRecord>> {
    const actor = await this.findAuthorizedTelegramPrincipal(actorExternalUserId, now);
    if (!actor) throw new DomainError("unauthorized", "Access is required");
    const requester = alias(principals, "requester");
    const stateCondition = filter === "active"
      ? inArray(jobs.state, ["queued", "downloading", "processing", "ready", "delivering"])
      : filter === "failed"
      ? eq(jobs.state, "failed")
      : undefined;
    const ownership = actor.role === "admin" ? undefined : eq(jobs.requesterPrincipalId, actor.id);
    const conditions = [stateCondition, ownership].filter((condition) => condition !== undefined);
    const rows = await this.db.select({
      id: jobs.id,
      displayId: jobs.displayId,
      state: jobs.state,
      attempts: jobs.attempts,
      requesterExternalUserId: requester.externalUserId,
      errorCode: jobs.errorCode,
      safeErrorMessage: jobs.safeErrorMessage,
      createdAt: jobs.createdAt,
      updatedAt: jobs.updatedAt,
    }).from(jobs).innerJoin(requester, eq(requester.id, jobs.requesterPrincipalId))
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(jobs.createdAt), jobs.id).limit(limit + 1).offset(offset);
    return page(
      rows.map((row) => ({
        ...row,
        requesterExternalUserId: actor.role === "admin" ? row.requesterExternalUserId : null,
      })),
      limit,
      offset,
    );
  }

  async listAuditEvents(
    actorExternalUserId: string,
    limit: number,
    offset: number,
    now: Date,
  ): Promise<PageResult<AuditEventRecord>> {
    await this.requireAdmin(actorExternalUserId, now);
    const rows = await this.db.select({
      id: auditEvents.id,
      actorExternalId: auditEvents.actorExternalId,
      action: auditEvents.action,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      result: auditEvents.result,
      createdAt: auditEvents.createdAt,
    }).from(auditEvents).orderBy(desc(auditEvents.createdAt), auditEvents.id)
      .limit(limit + 1).offset(offset);
    return page(rows, limit, offset);
  }

  async listAccessRequests(
    actorExternalUserId: string,
    limit: number,
    offset: number,
    now: Date,
  ): Promise<PageResult<AccessRequestRecord>> {
    await this.requireAdmin(actorExternalUserId, now);
    const rows = await this.db.select({
      id: accessRequests.id,
      externalUserId: accessRequests.externalUserId,
      state: accessRequests.state,
      requestCount: accessRequests.requestCount,
      notificationPending: accessRequests.notificationPending,
      firstRequestedAt: accessRequests.firstRequestedAt,
      lastRequestedAt: accessRequests.lastRequestedAt,
      resolvedAt: accessRequests.resolvedAt,
    }).from(accessRequests).where(eq(accessRequests.state, "pending"))
      .orderBy(desc(accessRequests.lastRequestedAt), accessRequests.id)
      .limit(limit + 1).offset(offset);
    return page(rows, limit, offset);
  }

  async markArtifactUploadFailed(
    artifactId: string,
    safeError: string,
    now: Date,
  ): Promise<void> {
    await this.db.update(artifacts).set({
      state: "delete_failed",
      lastDeleteError: safeError,
      updatedAt: now,
    }).where(and(eq(artifacts.id, artifactId), eq(artifacts.state, "uploading")));
  }

  async getReadyArtifact(id: string): Promise<ArtifactRecord | null> {
    const rows = await this.db.select().from(artifacts).where(and(
      eq(artifacts.id, id),
      eq(artifacts.state, "ready"),
    )).limit(1);
    return rows[0] ? mapTypedArtifact(rows[0]) : null;
  }

  async listDeliveryProgress(limit: number): Promise<readonly DeliveryProgressRecord[]> {
    const rows = await this.db.select({
      jobId: jobs.id,
      displayId: jobs.displayId,
      state: jobs.state,
      phase: jobs.progressPhase,
      percent: jobs.progressPercent,
      destination: deliveries.destination,
    }).from(jobs).innerJoin(deliveries, eq(deliveries.jobId, jobs.id)).where(and(
      inArray(jobs.state, ["queued", "downloading", "processing"]),
      isNotNull(jobs.progressPhase),
      sql`${deliveries.destination} ? 'progressMessageId'`,
      inArray(deliveries.state, ["pending", "retry_wait"]),
    )).orderBy(jobs.updatedAt).limit(limit);
    return rows.map((row) => ({
      ...row,
      phase: required(row.phase, "delivery progress phase"),
    }));
  }

  private async requireAdmin(actorExternalUserId: string, now: Date): Promise<void> {
    const actor = alias(principals, "actor");
    const authorized = await this.db.select({ id: actor.id }).from(actor).where(and(
      eq(actor.bridge, "telegram"),
      eq(actor.externalUserId, actorExternalUserId),
      eq(actor.role, "admin"),
      eq(actor.state, "active"),
      or(isNull(actor.expiresAt), gt(actor.expiresAt, now)),
    )).limit(1);
    if (authorized.length === 0) {
      throw new DomainError("unauthorized", "Administrator access is required");
    }
  }
}

function page<Value>(rows: readonly Value[], limit: number, offset: number): PageResult<Value> {
  return {
    items: rows.slice(0, limit),
    limit,
    offset,
    hasMore: rows.length > limit,
  };
}

function mapTypedJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    displayId: row.displayId,
    requesterPrincipalId: row.requesterPrincipalId,
    idempotencyKey: row.idempotencyKey,
    submittedUrl: row.submittedUrl,
    normalizedUrl: row.normalizedUrl,
    sourceId: row.sourceId,
    state: row.state,
    progressPhase: row.progressPhase,
    progressPercent: row.progressPercent,
    attempts: row.attempts,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt,
    cancellationRequestedAt: row.cancellationRequestedAt,
    policy: retentionPolicySchema.parse(row.policy),
    artifactId: row.artifactId,
    errorCode: row.errorCode,
    safeErrorMessage: row.safeErrorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapTypedArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    jobId: row.jobId,
    objectKey: row.objectKey,
    temporaryObjectKey: row.temporaryObjectKey,
    state: row.state,
    byteSize: row.byteSize,
    sha256: row.sha256,
    expiresAt: row.expiresAt,
  };
}

function required<Value>(value: Value | undefined | null, context: string): Value {
  if (value === undefined || value === null) throw new Error(`Expected ${context}`);
  return value;
}
