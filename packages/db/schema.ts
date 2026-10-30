import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { JobState } from "../domain/state.ts";
import type { RetentionPolicy } from "../domain/retention.ts";

type JsonObject = Readonly<Record<string, unknown>>;
type PrincipalRole = "admin" | "user";
type PrincipalState = "active" | "disabled";
type ArtifactState = "uploading" | "ready" | "deleting" | "deleted" | "delete_failed";
type DeliveryState = "pending" | "leased" | "delivering" | "delivered" | "retry_wait" | "failed";
type AccessRequestState = "pending" | "approved" | "denied";
type AccessRequestNotificationState = "pending" | "leased" | "sent" | "skipped" | "failed";
type AccessDecisionPromptAction = "allow" | "deny";
type AccessDecisionPromptState = "pending" | "completed" | "cancelled" | "expired";
type AccessDecisionNotificationState = "pending" | "leased" | "sent" | "failed";

export const schemaMigrations = pgTable("schema_migrations", {
  version: text().primaryKey().notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
});

export const principals = pgTable(
  "principals",
  {
    id: uuid().primaryKey().notNull(),
    bridge: text().$type<"telegram">().notNull(),
    externalUserId: text("external_user_id").notNull(),
    role: text().$type<PrincipalRole>().notNull(),
    state: text().$type<PrincipalState>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    note: text(),
    createdBy: uuid("created_by"),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    unique("principals_bridge_external_user_id_key").on(table.bridge, table.externalUserId),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [table.id],
      name: "principals_created_by_fkey",
    }),
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [table.id],
      name: "principals_updated_by_fkey",
    }),
    index("principals_authorization_idx").on(
      table.bridge,
      table.externalUserId,
      table.state,
      table.expiresAt,
    ),
    check("principals_bridge_check", sql`${table.bridge} = 'telegram'`),
    check(
      "principals_external_user_id_check",
      sql`(${table.externalUserId} ~ '^[1-9][0-9]{0,14}$' OR (${table.externalUserId} ~ '^[1-9][0-9]{15}$' AND ${table.externalUserId} <= '9007199254740991'))`,
    ),
    check("principals_role_check", sql`${table.role} IN ('admin', 'user')`),
    check("principals_state_check", sql`${table.state} IN ('active', 'disabled')`),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid().primaryKey().notNull(),
    displayId: varchar("display_id", { length: 16 }).notNull(),
    bridge: text().$type<"telegram">().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requesterPrincipalId: uuid("requester_principal_id").notNull(),
    submittedUrl: text("submitted_url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    sourceType: text("source_type").$type<"x">().notNull(),
    sourceId: text("source_id").notNull(),
    state: text().$type<JobState>().notNull(),
    progressPhase: text("progress_phase"),
    progressPercent: smallint("progress_percent"),
    attempts: integer().default(0).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: "date" }),
    cancellationRequestedAt: timestamp("cancellation_requested_at", {
      withTimezone: true,
      mode: "date",
    }),
    policy: jsonb().$type<RetentionPolicy>().notNull(),
    selectedFormat: jsonb("selected_format").$type<JsonObject>(),
    mediaMetadata: jsonb("media_metadata").$type<JsonObject>(),
    artifactId: uuid("artifact_id").references((): AnyPgColumn => artifacts.id),
    errorCode: text("error_code"),
    safeErrorMessage: text("safe_error_message"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    readyAt: timestamp("ready_at", { withTimezone: true, mode: "date" }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
    failedAt: timestamp("failed_at", { withTimezone: true, mode: "date" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    expiredAt: timestamp("expired_at", { withTimezone: true, mode: "date" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.requesterPrincipalId],
      foreignColumns: [principals.id],
      name: "jobs_requester_principal_id_fkey",
    }),
    unique("jobs_display_id_key").on(table.displayId),
    unique("jobs_bridge_idempotency_key_key").on(table.bridge, table.idempotencyKey),
    index("jobs_state_lease_idx").on(table.state, table.leaseExpiresAt),
    index("jobs_requester_state_idx").on(
      table.requesterPrincipalId,
      table.state,
      table.createdAt.desc().nullsFirst(),
    ),
    check("jobs_bridge_check", sql`${table.bridge} = 'telegram'`),
    check(
      "jobs_idempotency_key_check",
      sql`length(${table.idempotencyKey}) BETWEEN 1 AND 200`,
    ),
    check("jobs_source_type_check", sql`${table.sourceType} = 'x'`),
    check("jobs_source_id_check", sql`${table.sourceId} ~ '^[0-9]+$'`),
    check(
      "jobs_state_check",
      sql`${table.state} IN (
        'queued', 'downloading', 'processing', 'ready', 'delivering',
        'delivered', 'failed', 'cancelled', 'expired'
      )`,
    ),
    check(
      "jobs_progress_percent_check",
      sql`${table.progressPercent} BETWEEN 0 AND 100`,
    ),
    check("jobs_attempts_check", sql`${table.attempts} >= 0`),
    check("jobs_policy_check", sql`jsonb_typeof(${table.policy}) = 'object'`),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid().primaryKey().notNull(),
    jobId: uuid("job_id").notNull(),
    objectKey: text("object_key").notNull(),
    temporaryObjectKey: text("temporary_object_key"),
    state: text().$type<ArtifactState>().notNull(),
    byteSize: bigint("byte_size", { mode: "number" }),
    sha256: varchar({ length: 64 }),
    container: text(),
    videoCodec: text("video_codec"),
    audioCodec: text("audio_codec"),
    durationSeconds: doublePrecision("duration_seconds"),
    width: integer(),
    height: integer(),
    title: text(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    deleteAttempts: integer("delete_attempts").default(0).notNull(),
    lastDeleteError: text("last_delete_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    readyAt: timestamp("ready_at", { withTimezone: true, mode: "date" }),
    deletingAt: timestamp("deleting_at", { withTimezone: true, mode: "date" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    unique("artifacts_job_id_key").on(table.jobId),
    unique("artifacts_object_key_key").on(table.objectKey),
    uniqueIndex("artifacts_ready_content_key").on(table.sha256, table.byteSize).where(
      sql`${table.state} = 'ready'`,
    ),
    foreignKey({
      columns: [table.jobId],
      foreignColumns: [jobs.id],
      name: "artifacts_job_id_fkey",
    }).onDelete("cascade"),
    index("artifacts_cleanup_idx").on(table.state, table.expiresAt),
    check(
      "artifacts_state_check",
      sql`${table.state} IN ('uploading', 'ready', 'deleting', 'deleted', 'delete_failed')`,
    ),
    check("artifacts_byte_size_check", sql`${table.byteSize} >= 0`),
    check(
      "artifacts_sha256_check",
      sql`${table.sha256} IS NULL OR ${table.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check("artifacts_duration_seconds_check", sql`${table.durationSeconds} > 0`),
    check("artifacts_width_check", sql`${table.width} > 0`),
    check("artifacts_height_check", sql`${table.height} > 0`),
    check("artifacts_delete_attempts_check", sql`${table.deleteAttempts} >= 0`),
  ],
);

export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid().primaryKey().notNull(),
    jobId: uuid("job_id").notNull(),
    artifactId: uuid("artifact_id"),
    bridge: text().$type<"telegram">().notNull(),
    destination: jsonb().$type<JsonObject>().notNull(),
    state: text().$type<DeliveryState>().notNull(),
    attempts: integer().default(0).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: "date" }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
    operationContext: jsonb("operation_context").$type<JsonObject>(),
    result: jsonb().$type<JsonObject>(),
    lastErrorCode: text("last_error_code"),
    lastSafeError: text("last_safe_error"),
    terminalProgressState: text("terminal_progress_state").$type<
      "failed" | "cancelled" | "expired"
    >(),
    terminalProgressAttempts: integer("terminal_progress_attempts").default(0).notNull(),
    terminalProgressLeaseOwner: text("terminal_progress_lease_owner"),
    terminalProgressLeaseExpiresAt: timestamp("terminal_progress_lease_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    terminalProgressNextAttemptAt: timestamp("terminal_progress_next_attempt_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    unique("deliveries_job_id_bridge_key").on(table.jobId, table.bridge),
    foreignKey({
      columns: [table.jobId],
      foreignColumns: [jobs.id],
      name: "deliveries_job_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.artifactId],
      foreignColumns: [artifacts.id],
      name: "deliveries_artifact_id_fkey",
    }),
    index("deliveries_claim_idx").on(table.state, table.nextAttemptAt, table.leaseExpiresAt),
    index("deliveries_terminal_progress_claim_idx").on(
      table.terminalProgressState,
      table.terminalProgressNextAttemptAt,
      table.terminalProgressLeaseExpiresAt,
    ),
    check("deliveries_bridge_check", sql`${table.bridge} = 'telegram'`),
    check("deliveries_destination_check", sql`jsonb_typeof(${table.destination}) = 'object'`),
    check(
      "deliveries_state_check",
      sql`${table.state} IN (
        'pending', 'leased', 'delivering', 'delivered', 'retry_wait', 'failed'
      )`,
    ),
    check("deliveries_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "deliveries_terminal_progress_state_check",
      sql`${table.terminalProgressState} IS NULL OR ${table.terminalProgressState} IN ('failed', 'cancelled', 'expired')`,
    ),
    check(
      "deliveries_terminal_progress_attempts_check",
      sql`${table.terminalProgressAttempts} >= 0`,
    ),
    check(
      "deliveries_terminal_progress_lease_check",
      sql`(${table.terminalProgressLeaseOwner} IS NULL AND ${table.terminalProgressLeaseExpiresAt} IS NULL) OR (${table.terminalProgressLeaseOwner} IS NOT NULL AND ${table.terminalProgressLeaseExpiresAt} IS NOT NULL)`,
    ),
  ],
);

export const outbox = pgTable(
  "outbox",
  {
    id: uuid().primaryKey().notNull(),
    eventType: text("event_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    payload: jsonb().$type<JsonObject>().notNull(),
    attempts: integer().default(0).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "date" }).notNull(),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "date" }),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    deduplicationKey: text("deduplication_key").notNull(),
  },
  (table) => [
    unique("outbox_deduplication_key_unique").on(table.deduplicationKey),
    index("outbox_publish_idx").on(table.publishedAt, table.availableAt, table.createdAt),
    index("outbox_history_idx").on(table.createdAt).where(sql`${table.publishedAt} IS NOT NULL`),
    check("outbox_payload_check", sql`jsonb_typeof(${table.payload}) = 'object'`),
    check("outbox_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid().primaryKey().notNull(),
    actorPrincipalId: uuid("actor_principal_id"),
    actorBridge: text("actor_bridge"),
    actorExternalId: text("actor_external_id"),
    action: text().notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    result: text().$type<"success" | "failure">().notNull(),
    correlationId: text("correlation_id").notNull(),
    changes: jsonb().$type<JsonObject>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.actorPrincipalId],
      foreignColumns: [principals.id],
      name: "audit_events_actor_principal_id_fkey",
    }),
    index("audit_events_target_idx").on(
      table.targetType,
      table.targetId,
      table.createdAt.desc().nullsFirst(),
    ),
    index("audit_events_created_at_idx").on(table.createdAt),
    check("audit_events_result_check", sql`${table.result} IN ('success', 'failure')`),
    check("audit_events_changes_check", sql`jsonb_typeof(${table.changes}) = 'object'`),
  ],
);

export const accessRequests = pgTable(
  "access_requests",
  {
    id: uuid().primaryKey().notNull(),
    bridge: text().$type<"telegram">().notNull(),
    externalUserId: text("external_user_id").notNull(),
    state: text().$type<AccessRequestState>().notNull(),
    requestCount: integer("request_count").default(1).notNull(),
    lastRequestKey: text("last_request_key").notNull(),
    notificationRevision: integer("notification_revision").default(1).notNull(),
    notificationPending: boolean("notification_pending").default(true).notNull(),
    firstRequestedAt: timestamp("first_requested_at", { withTimezone: true, mode: "date" })
      .notNull(),
    lastRequestedAt: timestamp("last_requested_at", { withTimezone: true, mode: "date" })
      .notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    resolvedBy: uuid("resolved_by"),
    decisionNote: text("decision_note"),
  },
  (table) => [
    unique("access_requests_bridge_external_user_id_key").on(table.bridge, table.externalUserId),
    foreignKey({
      columns: [table.resolvedBy],
      foreignColumns: [principals.id],
      name: "access_requests_resolved_by_fkey",
    }),
    index("access_requests_pending_idx").on(
      table.state,
      table.notificationPending,
      table.lastRequestedAt.desc().nullsFirst(),
    ),
    index("access_requests_retention_idx").on(table.resolvedAt, table.lastRequestedAt),
    check("access_requests_bridge_check", sql`${table.bridge} = 'telegram'`),
    check(
      "access_requests_external_user_id_check",
      sql`(${table.externalUserId} ~ '^[1-9][0-9]{0,14}$' OR (${table.externalUserId} ~ '^[1-9][0-9]{15}$' AND ${table.externalUserId} <= '9007199254740991'))`,
    ),
    check(
      "access_requests_state_check",
      sql`${table.state} IN ('pending', 'approved', 'denied')`,
    ),
    check("access_requests_request_count_check", sql`${table.requestCount} > 0`),
    check("access_requests_notification_revision_check", sql`${table.notificationRevision} > 0`),
    check(
      "access_requests_last_request_key_check",
      sql`length(${table.lastRequestKey}) BETWEEN 1 AND 200`,
    ),
  ],
);

export const accessRequestNotifications = pgTable(
  "access_request_notifications",
  {
    id: uuid().primaryKey().notNull(),
    accessRequestId: uuid("access_request_id").notNull(),
    adminPrincipalId: uuid("admin_principal_id").notNull(),
    requestRevision: integer("request_revision").notNull(),
    state: text().$type<AccessRequestNotificationState>().default("pending").notNull(),
    attempts: integer().default(0).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "date" }).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accessRequestId],
      foreignColumns: [accessRequests.id],
      name: "access_request_notifications_request_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.adminPrincipalId],
      foreignColumns: [principals.id],
      name: "access_request_notifications_admin_fkey",
    }).onDelete("cascade"),
    unique("access_request_notifications_request_admin_key").on(
      table.accessRequestId,
      table.adminPrincipalId,
      table.requestRevision,
    ),
    index("access_request_notifications_claim_idx").on(
      table.state,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    index("access_request_notifications_retention_idx").on(table.updatedAt),
    check(
      "access_request_notifications_state_check",
      sql`${table.state} IN ('pending', 'leased', 'sent', 'skipped', 'failed')`,
    ),
    check("access_request_notifications_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "access_request_notifications_request_revision_check",
      sql`${table.requestRevision} > 0`,
    ),
    check(
      "access_request_notifications_lease_check",
      sql`(${table.state} = 'leased' AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.state} <> 'leased' AND ${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
    ),
  ],
);

export const accessDecisionPrompts = pgTable(
  "access_decision_prompts",
  {
    id: uuid().primaryKey().notNull(),
    adminPrincipalId: uuid("admin_principal_id").notNull(),
    accessRequestId: uuid("access_request_id").notNull(),
    requestRevision: integer("request_revision").notNull(),
    action: text().$type<AccessDecisionPromptAction>().notNull(),
    state: text().$type<AccessDecisionPromptState>().default("pending").notNull(),
    promptMessageId: integer("prompt_message_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.adminPrincipalId],
      foreignColumns: [principals.id],
      name: "access_decision_prompts_admin_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.accessRequestId],
      foreignColumns: [accessRequests.id],
      name: "access_decision_prompts_request_fkey",
    }).onDelete("cascade"),
    uniqueIndex("access_decision_prompts_one_pending_admin_idx").on(table.adminPrincipalId).where(
      sql`${table.state} = 'pending'`,
    ),
    index("access_decision_prompts_expiry_idx").on(table.state, table.expiresAt),
    check(
      "access_decision_prompts_action_check",
      sql`${table.action} IN ('allow', 'deny')`,
    ),
    check(
      "access_decision_prompts_state_check",
      sql`${table.state} IN ('pending', 'completed', 'cancelled', 'expired')`,
    ),
    check("access_decision_prompts_revision_check", sql`${table.requestRevision} > 0`),
    check(
      "access_decision_prompts_message_check",
      sql`${table.promptMessageId} IS NULL OR ${table.promptMessageId} > 0`,
    ),
  ],
);

export const accessDecisionNotifications = pgTable(
  "access_decision_notifications",
  {
    id: uuid().primaryKey().notNull(),
    accessRequestId: uuid("access_request_id").notNull(),
    requestRevision: integer("request_revision").notNull(),
    decision: text().$type<"approved" | "denied">().notNull(),
    state: text().$type<AccessDecisionNotificationState>().default("pending").notNull(),
    attempts: integer().default(0).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "date" }).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accessRequestId],
      foreignColumns: [accessRequests.id],
      name: "access_decision_notifications_request_fkey",
    }).onDelete("cascade"),
    unique("access_decision_notifications_request_revision_key").on(
      table.accessRequestId,
      table.requestRevision,
    ),
    index("access_decision_notifications_claim_idx").on(
      table.state,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    check(
      "access_decision_notifications_decision_check",
      sql`${table.decision} IN ('approved', 'denied')`,
    ),
    check(
      "access_decision_notifications_state_check",
      sql`${table.state} IN ('pending', 'leased', 'sent', 'failed')`,
    ),
    check("access_decision_notifications_attempts_check", sql`${table.attempts} >= 0`),
    check("access_decision_notifications_revision_check", sql`${table.requestRevision} > 0`),
    check(
      "access_decision_notifications_lease_check",
      sql`(${table.state} = 'leased' AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.state} <> 'leased' AND ${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
    ),
  ],
);

export const databaseSchema = {
  schemaMigrations,
  principals,
  jobs,
  artifacts,
  deliveries,
  outbox,
  auditEvents,
  accessRequests,
  accessRequestNotifications,
  accessDecisionPrompts,
  accessDecisionNotifications,
};

export type PrincipalRow = typeof principals.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
