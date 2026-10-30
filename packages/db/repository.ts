import type { Clock, IdGenerator } from "../domain/time.ts";
import type { JobState } from "../domain/state.ts";
import { assertJobTransition } from "../domain/state.ts";
import { retentionPolicySchema } from "../domain/retention.ts";
import { DomainError } from "../domain/errors.ts";
import { parseTelegramUserId } from "../domain/telegram_id.ts";
import type { Database, Transaction } from "./client.ts";
import type postgres from "postgres";
import { createOrm } from "./orm.ts";
import {
  type AccessDecisionNotificationLease,
  type AccessDecisionPromptRecord,
  type AccessDecisionResult,
  type AccessRequestNotificationLease,
  type AccessRequestRecord,
  type AccessRequestResult,
  type ArtifactCleanupRecord,
  type ArtifactCompletionResult,
  type ArtifactRecord,
  type AuditEventRecord,
  type DeliveryLeaseRecord,
  type DeliveryProgressRecord,
  type JobListRecord,
  type JobRecord,
  mapArtifact,
  mapDeliveryLease,
  mapJob,
  mapPrincipal,
  type OperationalSnapshot,
  type OutboxRecord,
  type PageResult,
  type PrincipalRecord,
  type RawArtifactRow as ArtifactRow,
  type RawDeliveryLeaseRow as DeliveryLeaseRow,
  type RawJobRow as JobRow,
  type RawPrincipalRow as PrincipalRow,
  type SubmissionInput,
  type SubmissionResult,
  type TerminalProgressLeaseRecord,
  type TerminalProgressState,
} from "./records.ts";
import { DrizzleRoutineQueries, type RoutineDataAccess } from "./routine_queries.ts";

export type {
  AccessDecisionNotificationLease,
  AccessDecisionPromptRecord,
  AccessDecisionResult,
  AccessRequestNotificationLease,
  AccessRequestRecord,
  AccessRequestResult,
  ArtifactCleanupRecord,
  ArtifactCompletionResult,
  ArtifactRecord,
  AuditEventRecord,
  DeliveryLeaseRecord,
  DeliveryProgressRecord,
  JobListRecord,
  JobRecord,
  OperationalSnapshot,
  OutboxRecord,
  PageResult,
  PrincipalRecord,
  SubmissionInput,
  SubmissionResult,
  TerminalProgressLeaseRecord,
  TerminalProgressState,
} from "./records.ts";

const ACTIVE_JOB_STATES: readonly JobState[] = ["queued", "downloading", "processing"];

export interface HistoryPurgeResult {
  readonly jobs: number;
  readonly auditEvents: number;
  readonly outboxEvents: number;
  readonly accessRequests: number;
}

export type AccessTargetOperation = "request" | "allow" | "deny";

export interface RepositoryConcurrencyHooks {
  readonly accessTargetLockContended?: (
    operation: AccessTargetOperation,
    externalUserId: string,
  ) => Promise<void> | void;
  readonly accessTargetLocked?: (
    operation: AccessTargetOperation,
    externalUserId: string,
  ) => Promise<void> | void;
}

export class Repository {
  private readonly routine: RoutineDataAccess;

  constructor(
    private readonly sql: Database,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    routine?: RoutineDataAccess,
    private readonly concurrencyHooks?: RepositoryConcurrencyHooks,
  ) {
    this.routine = routine ?? new DrizzleRoutineQueries(createOrm(sql));
  }

  private async lockAccessTarget(
    tx: Transaction,
    operation: AccessTargetOperation,
    externalUserId: string,
  ): Promise<void> {
    const key = `access-request:${externalUserId}`;
    const attempted = await tx<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS acquired
    `;
    if (!attempted[0]?.acquired) {
      await this.concurrencyHooks?.accessTargetLockContended?.(operation, externalUserId);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    }
    await this.concurrencyHooks?.accessTargetLocked?.(operation, externalUserId);
  }

  private async lockAdminPrompt(tx: Transaction, adminPrincipalId: string): Promise<void> {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`access-prompt:${adminPrincipalId}`}))`;
  }

  async bootstrapTelegramAdmins(externalIds: readonly string[]): Promise<number> {
    let changed = 0;
    for (const externalId of externalIds) {
      parseTelegramUserId(externalId);
      const now = this.clock.now();
      await this.sql.begin(async (tx) => {
        const existing = await tx<PrincipalRow[]>`
          SELECT id, bridge, external_user_id, role, state, expires_at, note
          FROM principals WHERE bridge = 'telegram' AND external_user_id = ${externalId}
          FOR UPDATE
        `;
        if (existing[0]?.role === "admin" && existing[0]?.state === "active") return;
        const principalId = existing[0]?.id ?? this.ids.next();
        await tx`
          INSERT INTO principals (
            id, bridge, external_user_id, role, state, note, created_at, updated_at
          ) VALUES (
            ${principalId}, 'telegram', ${externalId}, 'admin', 'active', 'bootstrapped administrator', ${now}, ${now}
          )
          ON CONFLICT (bridge, external_user_id) DO UPDATE SET
            role = 'admin', state = 'active', expires_at = NULL,
            note = COALESCE(principals.note, EXCLUDED.note), updated_at = EXCLUDED.updated_at
        `;
        await insertAudit(tx, this.ids.next(), now, {
          actorBridge: "telegram",
          actorExternalId: externalId,
          action: "principal.bootstrap_admin",
          targetId: principalId,
          correlationId: `bootstrap:${externalId}`,
          changes: { role: "admin", state: "active" },
        });
        changed++;
      });
    }
    return changed;
  }

  async upsertTelegramPrincipal(input: {
    externalUserId: string;
    role?: "admin" | "user";
    state?: "active" | "disabled";
    note?: string | null;
    expiresAt?: Date | null;
    actorPrincipalId?: string | null;
    correlationId?: string;
  }): Promise<PrincipalRecord> {
    parseTelegramUserId(input.externalUserId);
    return await this.routine.upsertTelegramPrincipal(input, this.ids.next(), this.clock.now());
  }

  async findAuthorizedTelegramPrincipal(externalUserId: string): Promise<PrincipalRecord | null> {
    parseTelegramUserId(externalUserId);
    return await this.routine.findAuthorizedTelegramPrincipal(externalUserId, this.clock.now());
  }

  async getTelegramPrincipal(externalUserId: string): Promise<PrincipalRecord | null> {
    parseTelegramUserId(externalUserId);
    return await this.routine.getTelegramPrincipal(externalUserId);
  }

  async requestTelegramAccess(input: {
    externalUserId: string;
    requestKey: string;
    correlationId: string;
    deniedCooldownSeconds: number;
  }): Promise<AccessRequestResult> {
    parseTelegramUserId(input.externalUserId);
    const now = this.clock.now();
    const deniedBefore = new Date(now.getTime() - input.deniedCooldownSeconds * 1000);
    return await this.sql.begin(async (tx) => {
      await this.lockAccessTarget(tx, "request", input.externalUserId);
      const principals = await tx<PrincipalRow[]>`
        SELECT id, bridge, external_user_id, role, state, expires_at, note
        FROM principals WHERE bridge = 'telegram' AND external_user_id = ${input.externalUserId}
        FOR SHARE
      `;
      const principal = principals[0];
      const active = principal?.state === "active" &&
        (principal.expires_at === null || principal.expires_at > now);
      const disabled = principal?.state === "disabled";
      const existing = await tx<{
        id: string;
        external_user_id: string;
        state: "pending" | "approved" | "denied";
        request_count: number;
        last_request_key: string;
        notification_revision: number;
        notification_pending: boolean;
        first_requested_at: Date;
        last_requested_at: Date;
        resolved_at: Date | null;
      }[]>`
        SELECT id, external_user_id, state, request_count, last_request_key,
          notification_revision,
          notification_pending, first_requested_at, last_requested_at, resolved_at
        FROM access_requests
        WHERE bridge = 'telegram' AND external_user_id = ${input.externalUserId}
        FOR UPDATE
      `;
      const previous = existing[0];
      const shouldReopen = (!active && !disabled && previous?.state === "approved") ||
        (!active && !disabled && previous?.state === "denied" &&
          previous.resolved_at !== null && previous.resolved_at <= deniedBefore);
      const deniedCoolingDown = !active && !disabled && previous?.state === "denied" &&
        !shouldReopen;
      const state = active ? "approved" : disabled || deniedCoolingDown ? "denied" : "pending";
      const created = !previous || shouldReopen;
      const requestCount = previous?.last_request_key === input.requestKey
        ? previous.request_count
        : (previous?.request_count ?? 0) + 1;
      const notificationRevision = previous
        ? previous.notification_revision + (shouldReopen ? 1 : 0)
        : 1;
      const id = previous?.id ?? this.ids.next();
      const notificationPending = state === "pending"
        ? created || (previous?.notification_pending ?? true)
        : false;
      await tx`
        INSERT INTO access_requests (
          id, bridge, external_user_id, state, request_count, last_request_key,
          notification_revision, notification_pending, first_requested_at, last_requested_at,
          resolved_at, resolved_by
        ) VALUES (
          ${id}, 'telegram', ${input.externalUserId}, ${state}, ${requestCount},
          ${input.requestKey}, ${notificationRevision}, ${notificationPending}, ${
        previous?.first_requested_at ?? now
      }, ${now},
          ${state === "pending" ? null : now}, ${
        state === "approved" ? principal?.id ?? null : null
      }
        ) ON CONFLICT (bridge, external_user_id) DO UPDATE SET
          state = ${state}, request_count = ${requestCount}, last_request_key = ${input.requestKey},
          notification_revision = ${notificationRevision}, notification_pending = ${notificationPending},
          decision_note = CASE WHEN ${state} = 'pending' THEN NULL ELSE access_requests.decision_note END,
          last_requested_at = ${now},
          resolved_at = ${state === "pending" ? null : previous?.resolved_at ?? now},
          resolved_by = ${state === "approved" ? principal?.id ?? null : null}
        RETURNING id, external_user_id, state, request_count, notification_pending,
          first_requested_at, last_requested_at, resolved_at
      `;
      if (state === "pending") {
        await enqueueAccessRequestNotifications(
          tx,
          this.ids,
          id,
          notificationRevision,
          now,
        );
        await refreshLegacyNotificationPending(tx, id, notificationRevision);
      }
      if (state === "pending" && created) {
        await insertAudit(tx, this.ids.next(), now, {
          actorBridge: "telegram",
          actorExternalId: input.externalUserId,
          action: "access.request",
          targetType: "access_request",
          targetId: id,
          correlationId: input.correlationId,
          changes: { state: "pending" },
        });
      }
      const current = await tx<{
        id: string;
        external_user_id: string;
        state: "pending" | "approved" | "denied";
        request_count: number;
        notification_pending: boolean;
        first_requested_at: Date;
        last_requested_at: Date;
        resolved_at: Date | null;
      }[]>`
        SELECT id, external_user_id, state, request_count, notification_pending,
          first_requested_at, last_requested_at, resolved_at
        FROM access_requests WHERE id = ${id}
      `;
      return {
        request: mapAccessRequest(current[0]),
        created,
      };
    });
  }

  async claimAccessRequestNotification(
    workerId: string,
    leaseSeconds: number,
  ): Promise<AccessRequestNotificationLease | null> {
    const now = this.clock.now();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    return await this.sql.begin(async (tx) => {
      await tx`
        UPDATE access_request_notifications n SET state = 'skipped', lease_owner = NULL,
          lease_expires_at = NULL, last_error_code = 'stale', updated_at = ${now}
        WHERE n.state IN ('pending', 'leased') AND (
          NOT EXISTS (
            SELECT 1 FROM access_requests r
            WHERE r.id = n.access_request_id AND r.state = 'pending'
              AND r.notification_revision = n.request_revision
          ) OR NOT EXISTS (
            SELECT 1 FROM principals p
            WHERE p.id = n.admin_principal_id AND p.role = 'admin' AND p.state = 'active'
              AND (p.expires_at IS NULL OR p.expires_at > ${now})
          )
        )
      `;
      await tx`
        UPDATE access_requests r SET notification_pending = EXISTS (
          SELECT 1 FROM access_request_notifications n
          WHERE n.access_request_id = r.id AND n.request_revision = r.notification_revision
            AND n.state IN ('pending', 'leased')
        )
        WHERE r.state = 'pending'
      `;
      const missing = await tx<{ request_id: string; revision: number; admin_id: string }[]>`
        SELECT r.id AS request_id, r.notification_revision AS revision, p.id AS admin_id
        FROM access_requests r CROSS JOIN principals p
        WHERE r.state = 'pending' AND p.bridge = 'telegram' AND p.role = 'admin'
          AND p.state = 'active' AND (p.expires_at IS NULL OR p.expires_at > ${now})
          AND NOT EXISTS (
            SELECT 1 FROM access_request_notifications n
            WHERE n.access_request_id = r.id AND n.admin_principal_id = p.id
              AND n.request_revision = r.notification_revision
          )
        ORDER BY r.last_requested_at, r.id, p.id
        LIMIT 100
      `;
      for (const row of missing) {
        await tx`
          INSERT INTO access_request_notifications (
            id, access_request_id, admin_principal_id, request_revision, state, attempts,
            available_at, created_at, updated_at
          ) VALUES (
            ${this.ids.next()}, ${row.request_id}, ${row.admin_id}, ${row.revision}, 'pending', 0,
            ${now}, ${now}, ${now}
          ) ON CONFLICT (access_request_id, admin_principal_id, request_revision) DO NOTHING
        `;
        await refreshLegacyNotificationPending(tx, row.request_id, row.revision);
      }
      const available = await tx<{
        id: string;
        access_request_id: string;
        admin_external_user_id: string;
        requester_external_user_id: string;
        attempts: number;
        request_revision: number;
      }[]>`
        SELECT n.id, n.access_request_id, admin.external_user_id AS admin_external_user_id,
          r.external_user_id AS requester_external_user_id, n.attempts, n.request_revision
        FROM access_request_notifications n
        JOIN access_requests r ON r.id = n.access_request_id
        JOIN principals admin ON admin.id = n.admin_principal_id
        WHERE n.available_at <= ${now}
          AND (n.state = 'pending' OR (n.state = 'leased' AND n.lease_expires_at <= ${now}))
          AND r.state = 'pending' AND r.notification_revision = n.request_revision
          AND admin.role = 'admin' AND admin.state = 'active'
          AND (admin.expires_at IS NULL OR admin.expires_at > ${now})
          AND NOT EXISTS (
            SELECT 1 FROM access_decision_prompts prompt
            WHERE prompt.admin_principal_id = admin.id AND prompt.state = 'pending'
              AND prompt.expires_at > ${now}
          )
        ORDER BY n.available_at, n.created_at, n.id
        LIMIT 1
        FOR UPDATE OF n SKIP LOCKED
      `;
      const selected = available[0];
      if (!selected) return null;
      const claimed = await tx<{ attempts: number }[]>`
        UPDATE access_request_notifications SET state = 'leased', attempts = attempts + 1,
          lease_owner = ${workerId}, lease_expires_at = ${leaseExpiresAt}, updated_at = ${now}
        WHERE id = ${selected.id}
        RETURNING attempts
      `;
      return {
        id: selected.id,
        accessRequestId: selected.access_request_id,
        adminExternalUserId: selected.admin_external_user_id,
        requesterExternalUserId: selected.requester_external_user_id,
        attempts: claimed[0].attempts,
      };
    });
  }

  async completeAccessRequestNotification(id: string, workerId: string): Promise<boolean> {
    const now = this.clock.now();
    return await this.sql.begin(async (tx) => {
      const rows = await tx<{ access_request_id: string; request_revision: number }[]>`
        UPDATE access_request_notifications SET state = 'sent', sent_at = ${now},
          lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL, updated_at = ${now}
        WHERE id = ${id} AND state = 'leased' AND lease_owner = ${workerId}
        RETURNING access_request_id, request_revision
      `;
      if (!rows[0]) return false;
      await refreshLegacyNotificationPending(
        tx,
        rows[0].access_request_id,
        rows[0].request_revision,
      );
      await insertAudit(tx, this.ids.next(), now, {
        action: "access.notification_sent",
        targetType: "access_request_notification",
        targetId: id,
        correlationId: `notification:${id}`,
        changes: { state: "sent" },
      });
      return true;
    });
  }

  async failAccessRequestNotification(input: {
    id: string;
    workerId: string;
    retryable: boolean;
    retryAfterSeconds: number;
    maxAttempts: number;
    errorCode: string;
  }): Promise<boolean> {
    const now = this.clock.now();
    const availableAt = new Date(now.getTime() + input.retryAfterSeconds * 1000);
    return await this.sql.begin(async (tx) => {
      const rows = await tx<{
        access_request_id: string;
        request_revision: number;
        state: "pending" | "failed";
      }[]>`
        UPDATE access_request_notifications SET
          state = CASE WHEN ${input.retryable} AND attempts < ${input.maxAttempts}
            THEN 'pending' ELSE 'failed' END,
          available_at = CASE WHEN ${input.retryable} AND attempts < ${input.maxAttempts}
            THEN ${availableAt} ELSE available_at END,
          lease_owner = NULL, lease_expires_at = NULL, last_error_code = ${input.errorCode},
          updated_at = ${now}
        WHERE id = ${input.id} AND state = 'leased' AND lease_owner = ${input.workerId}
        RETURNING access_request_id, request_revision, state
      `;
      if (!rows[0]) return false;
      await refreshLegacyNotificationPending(
        tx,
        rows[0].access_request_id,
        rows[0].request_revision,
      );
      if (rows[0].state === "failed") {
        await insertAudit(tx, this.ids.next(), now, {
          action: "access.notification_failed",
          targetType: "access_request_notification",
          targetId: input.id,
          correlationId: `notification:${input.id}`,
          result: "failure",
          changes: { state: "failed", errorCode: input.errorCode },
        });
      }
      return true;
    });
  }

  async submitJob(input: SubmissionInput): Promise<SubmissionResult> {
    parseTelegramUserId(input.requesterExternalUserId);
    const policy = retentionPolicySchema.parse(input.policy);
    const retentionOrigin = input.retentionOrigin ?? "explicit";
    const storedPolicy = {
      ...policy,
      _submission: { version: 1, retentionOrigin },
    };
    const now = this.clock.now();
    return await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`${input.bridge}:${input.idempotencyKey}`}))`;
      const principals = await tx<PrincipalRow[]>`
        SELECT id, bridge, external_user_id, role, state, expires_at, note
        FROM principals
        WHERE bridge = ${input.bridge} AND external_user_id = ${input.requesterExternalUserId}
          AND state = 'active' AND (expires_at IS NULL OR expires_at > ${now})
        FOR SHARE
      `;
      const principal = principals[0];
      if (!principal) {
        throw new DomainError("unauthorized", "This user is not permitted to submit jobs");
      }

      const duplicate = await tx<(JobRow & { semantic_match: boolean })[]>`
        SELECT j.*, (
          j.submitted_url = ${input.submittedUrl}
          AND j.normalized_url = ${input.normalizedUrl}
          AND j.source_type = 'x'
          AND j.source_id = ${input.sourceId}
          AND CASE
            WHEN j.policy #>> '{_submission,retentionOrigin}' = 'default'
              THEN ${retentionOrigin} = 'default'
            WHEN j.policy #>> '{_submission,retentionOrigin}' = 'explicit'
              THEN ${retentionOrigin} = 'explicit'
                AND (j.policy - '_submission') = ${tx.json(policy)}
            ELSE (j.policy - '_submission') = ${tx.json(policy)}
          END
          AND EXISTS (
            SELECT 1 FROM deliveries d
            WHERE d.job_id = j.id AND d.bridge = ${input.bridge}
              AND (d.destination - 'progressMessageId') =
                (${tx.json(asJson(input.destination))}::jsonb - 'progressMessageId')
          )
        ) AS semantic_match
        FROM jobs j
        WHERE j.bridge = ${input.bridge} AND j.idempotency_key = ${input.idempotencyKey}
      `;
      if (duplicate[0]) {
        if (duplicate[0].requester_principal_id !== principal.id) {
          throw new DomainError("conflict", "The idempotency key cannot be used for this request");
        }
        if (!duplicate[0].semantic_match) {
          throw new DomainError(
            "conflict",
            "The idempotency key cannot be reused with different request data",
          );
        }
        return { job: mapJob(duplicate[0]), created: false };
      }

      const reusable = await tx<(ArtifactRow & { selected_format: unknown })[]>`
        SELECT a.id, a.job_id, a.object_key, a.temporary_object_key, a.state,
          a.byte_size, a.sha256, a.expires_at, source.selected_format
        FROM artifacts a
        JOIN jobs source ON source.artifact_id = a.id
        WHERE source.source_type = 'x' AND source.source_id = ${input.sourceId}
          AND a.state = 'ready'
        ORDER BY a.ready_at DESC, a.id
        LIMIT 1
        FOR SHARE OF a
      `;
      if (reusable[0]) {
        const jobId = this.ids.next();
        const deliveryId = this.ids.next();
        const displayId = jobId.replaceAll("-", "").slice(0, 12);
        const rows = await tx<JobRow[]>`
          INSERT INTO jobs (
            id, display_id, bridge, idempotency_key, requester_principal_id,
            submitted_url, normalized_url, source_type, source_id, state, progress_phase,
            progress_percent, policy, selected_format, artifact_id, ready_at, created_at, updated_at
          ) VALUES (
            ${jobId}, ${displayId}, ${input.bridge}, ${input.idempotencyKey}, ${principal.id},
            ${input.submittedUrl}, ${input.normalizedUrl}, 'x', ${input.sourceId}, 'ready', 'ready',
            100, ${tx.json(storedPolicy)}, ${
          reusable[0].selected_format === null ? null : tx.json(asJson(reusable[0].selected_format))
        },
            ${reusable[0].id}, ${now}, ${now}, ${now}
          ) RETURNING *
        `;
        await tx`
          INSERT INTO deliveries (
            id, job_id, artifact_id, bridge, destination, state, created_at, updated_at
          ) VALUES (
            ${deliveryId}, ${jobId}, ${reusable[0].id}, ${input.bridge},
            ${tx.json(asJson(input.destination))}, 'pending', ${now}, ${now}
          )
        `;
        await recomputeArtifactExpiry(tx, reusable[0].id, now);
        return { job: mapJob(rows[0]), created: true };
      }

      const queueCount = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM jobs WHERE state = ANY(${
        this.sql.array([...ACTIVE_JOB_STATES])
      })
      `;
      if ((queueCount[0]?.count ?? 0) >= input.maxQueuedJobs) {
        throw new DomainError("queue_full", "The download queue is currently full", true);
      }
      const activeCount = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM jobs
        WHERE requester_principal_id = ${principal.id} AND state = ANY(${
        this.sql.array([...ACTIVE_JOB_STATES])
      })
      `;
      if ((activeCount[0]?.count ?? 0) >= input.maxActiveJobsPerUser) {
        throw new DomainError(
          "active_job_limit",
          "The user already has the maximum number of active jobs",
          true,
        );
      }

      const jobId = this.ids.next();
      const deliveryId = this.ids.next();
      const outboxId = this.ids.next();
      const displayId = jobId.replaceAll("-", "").slice(0, 12);
      const rows = await tx<JobRow[]>`
        INSERT INTO jobs (
          id, display_id, bridge, idempotency_key, requester_principal_id,
          submitted_url, normalized_url, source_type, source_id, state, progress_phase, policy,
          created_at, updated_at
        ) VALUES (
          ${jobId}, ${displayId}, ${input.bridge}, ${input.idempotencyKey}, ${principal.id},
          ${input.submittedUrl}, ${input.normalizedUrl}, 'x', ${input.sourceId}, 'queued', 'queued',
          ${this.sql.json(storedPolicy)}, ${now}, ${now}
        ) RETURNING *
      `;
      await tx`
        INSERT INTO deliveries (
          id, job_id, bridge, destination, state, created_at, updated_at
        ) VALUES (
          ${deliveryId}, ${jobId}, ${input.bridge}, ${this.sql.json(asJson(input.destination))},
          'pending', ${now}, ${now}
        )
      `;
      await tx`
        INSERT INTO outbox (
          id, event_type, aggregate_id, payload, deduplication_key, available_at, created_at
        ) VALUES (
          ${outboxId}, 'download.requested', ${jobId},
          ${this.sql.json({ version: 1, jobId })}, ${`download.requested:${jobId}:initial`},
          ${now}, ${now}
        )
      `;
      return { job: mapJob(rows[0]), created: true };
    });
  }

  async getJob(id: string): Promise<JobRecord | null> {
    return await this.routine.getJob(id);
  }

  async getJobAuthorized(id: string, actorExternalUserId: string): Promise<JobRecord | null> {
    return await this.routine.getJobAuthorized(id, actorExternalUserId, this.clock.now());
  }

  async requestCancellation(
    id: string,
    actorExternalUserId: string,
    correlationId: string,
  ): Promise<JobRecord> {
    const now = this.clock.now();
    return await this.sql.begin(async (tx) => {
      const rows = await tx<(JobRow & { actor_role: "admin" | "user"; actor_id: string })[]>`
        SELECT j.*, actor.role AS actor_role, actor.id AS actor_id
        FROM jobs j
        JOIN principals actor ON actor.bridge = 'telegram' AND actor.external_user_id = ${actorExternalUserId}
        WHERE (j.id::text = ${id} OR j.display_id = ${id})
          AND actor.state = 'active' AND (actor.expires_at IS NULL OR actor.expires_at > ${now})
          AND (actor.role = 'admin' OR actor.id = j.requester_principal_id)
        FOR UPDATE OF j
      `;
      const job = rows[0];
      if (!job) throw new DomainError("not_found", "Job not found");
      if (!ACTIVE_JOB_STATES.includes(job.state)) {
        throw new DomainError("conflict", "This job can no longer be cancelled");
      }
      if (job.state === "queued") {
        assertJobTransition("queued", "cancelled");
        const cancelled = await tx<JobRow[]>`
          UPDATE jobs SET state = 'cancelled', cancellation_requested_at = ${now},
            cancelled_at = ${now}, updated_at = ${now}
          WHERE id = ${job.id} AND state = 'queued' RETURNING *
        `;
        await insertAudit(tx, this.ids.next(), now, {
          actorPrincipalId: job.actor_id,
          actorBridge: "telegram",
          actorExternalId: actorExternalUserId,
          action: "job.cancel",
          targetType: "job",
          targetId: job.id,
          correlationId,
          changes: { state: "cancelled" },
        });
        return mapJob(cancelled[0]);
      }
      const requested = await tx<JobRow[]>`
        UPDATE jobs SET cancellation_requested_at = COALESCE(cancellation_requested_at, ${now}),
          updated_at = ${now}
        WHERE id = ${job.id} AND state IN ('downloading', 'processing') RETURNING *
      `;
      await insertAudit(tx, this.ids.next(), now, {
        actorPrincipalId: job.actor_id,
        actorBridge: "telegram",
        actorExternalId: actorExternalUserId,
        action: "job.cancel",
        targetType: "job",
        targetId: job.id,
        correlationId,
        changes: { cancellationRequested: true },
      });
      return mapJob(requested[0]);
    });
  }

  async retryFailedJob(
    id: string,
    actorExternalUserId: string,
    correlationId: string,
  ): Promise<JobRecord> {
    const now = this.clock.now();
    return await this.sql.begin(async (tx) => {
      const actor = await requireAdmin(tx, actorExternalUserId, now);
      const jobs = await tx<JobRow[]>`
        SELECT * FROM jobs WHERE (id::text = ${id} OR display_id = ${id}) FOR UPDATE
      `;
      const job = jobs[0];
      if (!job) throw new DomainError("not_found", "Job not found");
      assertJobTransition(job.state, "queued");
      const updated = await tx<JobRow[]>`
        UPDATE jobs SET state = 'queued', progress_phase = 'queued', progress_percent = NULL,
          attempts = 0, lease_owner = NULL,
          lease_expires_at = NULL, heartbeat_at = NULL, cancellation_requested_at = NULL,
          error_code = NULL, safe_error_message = NULL, failed_at = NULL, updated_at = ${now}
        WHERE id = ${job.id} AND state = 'failed' RETURNING *
      `;
      if (!updated[0]) throw new DomainError("conflict", "The failed job changed before retry");
      await tx`
        UPDATE deliveries SET terminal_progress_state = NULL,
          terminal_progress_lease_owner = NULL, terminal_progress_lease_expires_at = NULL,
          terminal_progress_next_attempt_at = NULL, updated_at = ${now}
        WHERE job_id = ${job.id}
      `;
      const outboxId = this.ids.next();
      await tx`
        INSERT INTO outbox (
          id, event_type, aggregate_id, payload, deduplication_key, available_at, created_at
        ) VALUES (
          ${outboxId}, 'download.requested', ${job.id}, ${tx.json({ version: 1, jobId: job.id })},
          ${`download.requested:${job.id}:retry:${outboxId}`}, ${now}, ${now}
        )
      `;
      await insertAudit(tx, this.ids.next(), now, {
        actorPrincipalId: actor.id,
        actorBridge: "telegram",
        actorExternalId: actorExternalUserId,
        action: "job.retry",
        targetType: "job",
        targetId: job.id,
        correlationId,
        changes: { state: "queued", previousState: job.state },
      });
      return mapJob(updated[0]);
    });
  }

  async listPrincipals(
    actorExternalUserId: string,
    limit: number,
    offset: number,
  ): Promise<PageResult<PrincipalRecord>> {
    return await this.routine.listPrincipals(
      actorExternalUserId,
      limit,
      offset,
      this.clock.now(),
    );
  }

  async listJobs(
    actorExternalUserId: string,
    filter: "active" | "failed" | "recent",
    limit: number,
    offset: number,
  ): Promise<PageResult<JobListRecord>> {
    return await this.routine.listJobs(
      actorExternalUserId,
      filter,
      limit,
      offset,
      this.clock.now(),
    );
  }

  async listAuditEvents(
    actorExternalUserId: string,
    limit: number,
    offset: number,
  ): Promise<PageResult<AuditEventRecord>> {
    return await this.routine.listAuditEvents(
      actorExternalUserId,
      limit,
      offset,
      this.clock.now(),
    );
  }

  async listAccessRequests(
    actorExternalUserId: string,
    limit: number,
    offset: number,
  ): Promise<PageResult<AccessRequestRecord>> {
    return await this.routine.listAccessRequests(
      actorExternalUserId,
      limit,
      offset,
      this.clock.now(),
    );
  }

  async beginAccessDecisionPrompt(input: {
    actorExternalUserId: string;
    accessRequestId: string;
    action: "allow" | "deny";
    ttlSeconds: number;
  }): Promise<AccessDecisionPromptRecord> {
    parseTelegramUserId(input.actorExternalUserId);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
    return await this.sql.begin(async (tx) => {
      const actor = await requireAdmin(tx, input.actorExternalUserId, now);
      await this.lockAdminPrompt(tx, actor.id);
      await expireAdminPrompts(tx, actor.id, now);
      const active = await tx<{ id: string }[]>`
        SELECT id FROM access_decision_prompts
        WHERE admin_principal_id = ${actor.id} AND state = 'pending'
        LIMIT 1
      `;
      if (active[0]) {
        throw new DomainError("conflict", "Finish or cancel the current access decision first");
      }
      const seed = await tx<{
        id: string;
        external_user_id: string;
        notification_revision: number;
      }[]>`
        SELECT id, external_user_id, notification_revision FROM access_requests
        WHERE id = ${input.accessRequestId}
      `;
      if (!seed[0]) throw new DomainError("not_found", "Access request not found");
      await this.lockAccessTarget(tx, input.action, seed[0].external_user_id);
      const requests = await tx<{
        id: string;
        external_user_id: string;
        notification_revision: number;
      }[]>`
        SELECT id, external_user_id, notification_revision FROM access_requests
        WHERE id = ${input.accessRequestId} AND state = 'pending'
        FOR UPDATE
      `;
      const request = requests[0];
      if (!request) throw new DomainError("conflict", "This access request is already resolved");
      const id = this.ids.next();
      const rows = await tx<{
        id: string;
        access_request_id: string;
        requester_external_user_id: string;
        action: "allow" | "deny";
        prompt_message_id: number | null;
        expires_at: Date;
      }[]>`
        INSERT INTO access_decision_prompts (
          id, admin_principal_id, access_request_id, request_revision, action, state,
          expires_at, created_at, updated_at
        ) VALUES (
          ${id}, ${actor.id}, ${request.id}, ${request.notification_revision}, ${input.action},
          'pending', ${expiresAt}, ${now}, ${now}
        )
        RETURNING id, access_request_id, ${request.external_user_id}::text AS requester_external_user_id,
          action, prompt_message_id, expires_at
      `;
      return mapAccessDecisionPrompt(rows[0]);
    });
  }

  async attachAccessDecisionPromptMessage(input: {
    actorExternalUserId: string;
    promptId: string;
    promptMessageId: number;
  }): Promise<AccessDecisionPromptRecord> {
    parseTelegramUserId(input.actorExternalUserId);
    const now = this.clock.now();
    return await this.sql.begin(async (tx) => {
      const actor = await requireAdmin(tx, input.actorExternalUserId, now);
      await this.lockAdminPrompt(tx, actor.id);
      await expireAdminPrompts(tx, actor.id, now);
      const rows = await tx<{
        id: string;
        access_request_id: string;
        requester_external_user_id: string;
        action: "allow" | "deny";
        prompt_message_id: number | null;
        expires_at: Date;
      }[]>`
        UPDATE access_decision_prompts prompt SET prompt_message_id = ${input.promptMessageId},
          updated_at = ${now}
        FROM access_requests request
        WHERE prompt.id = ${input.promptId} AND prompt.admin_principal_id = ${actor.id}
          AND prompt.access_request_id = request.id AND prompt.state = 'pending'
          AND prompt.expires_at > ${now}
        RETURNING prompt.id, prompt.access_request_id,
          request.external_user_id AS requester_external_user_id, prompt.action,
          prompt.prompt_message_id, prompt.expires_at
      `;
      if (!rows[0]) throw new DomainError("conflict", "The access decision prompt expired");
      return mapAccessDecisionPrompt(rows[0]);
    });
  }

  async getActiveAccessDecisionPrompt(
    actorExternalUserId: string,
  ): Promise<AccessDecisionPromptRecord | null> {
    parseTelegramUserId(actorExternalUserId);
    const now = this.clock.now();
    return await this.sql.begin(async (tx) => {
      const actor = await requireAdmin(tx, actorExternalUserId, now);
      await this.lockAdminPrompt(tx, actor.id);
      await expireAdminPrompts(tx, actor.id, now);
      const rows = await tx<{
        id: string;
        access_request_id: string;
        requester_external_user_id: string;
        action: "allow" | "deny";
        prompt_message_id: number | null;
        expires_at: Date;
      }[]>`
        SELECT prompt.id, prompt.access_request_id,
          request.external_user_id AS requester_external_user_id, prompt.action,
          prompt.prompt_message_id, prompt.expires_at
        FROM access_decision_prompts prompt
        JOIN access_requests request ON request.id = prompt.access_request_id
        WHERE prompt.admin_principal_id = ${actor.id} AND prompt.state = 'pending'
          AND prompt.expires_at > ${now}
        LIMIT 1
      `;
      return rows[0] ? mapAccessDecisionPrompt(rows[0]) : null;
    });
  }

  async cancelAccessDecisionPrompt(input: {
    actorExternalUserId: string;
    promptId: string;
  }): Promise<boolean> {
    parseTelegramUserId(input.actorExternalUserId);
    const now = this.clock.now();
    return await this.sql.begin(async (tx) => {
      const actor = await requireAdmin(tx, input.actorExternalUserId, now);
      await this.lockAdminPrompt(tx, actor.id);
      const rows = await tx<{ id: string }[]>`
        UPDATE access_decision_prompts SET state = 'cancelled', completed_at = ${now},
          updated_at = ${now}
        WHERE id = ${input.promptId} AND admin_principal_id = ${actor.id} AND state = 'pending'
        RETURNING id
      `;
      return rows.length === 1;
    });
  }

  async resolveAccessDecisionPrompt(input: {
    actorExternalUserId: string;
    promptId: string;
    note: string | null;
    correlationId: string;
  }): Promise<AccessDecisionResult> {
    parseTelegramUserId(input.actorExternalUserId);
    const now = this.clock.now();
    return await this.sql.begin(async (tx) => {
      const actor = await requireAdmin(tx, input.actorExternalUserId, now);
      await this.lockAdminPrompt(tx, actor.id);
      await expireAdminPrompts(tx, actor.id, now);
      const prompts = await tx<{
        id: string;
        access_request_id: string;
        request_revision: number;
        action: "allow" | "deny";
        external_user_id: string;
      }[]>`
        SELECT prompt.id, prompt.access_request_id, prompt.request_revision, prompt.action,
          request.external_user_id
        FROM access_decision_prompts prompt
        JOIN access_requests request ON request.id = prompt.access_request_id
        WHERE prompt.id = ${input.promptId} AND prompt.admin_principal_id = ${actor.id}
          AND prompt.state = 'pending' AND prompt.expires_at > ${now}
        FOR UPDATE OF prompt
      `;
      const prompt = prompts[0];
      if (!prompt) throw new DomainError("conflict", "The access decision prompt expired");
      await this.lockAccessTarget(tx, prompt.action, prompt.external_user_id);
      const requests = await tx<{
        id: string;
        state: "pending" | "approved" | "denied";
        notification_revision: number;
      }[]>`
        SELECT id, state, notification_revision FROM access_requests
        WHERE id = ${prompt.access_request_id} FOR UPDATE
      `;
      const request = requests[0];
      if (
        !request || request.state !== "pending" ||
        request.notification_revision !== prompt.request_revision
      ) {
        await tx`
          UPDATE access_decision_prompts SET state = 'cancelled', completed_at = ${now},
            updated_at = ${now} WHERE id = ${prompt.id}
        `;
        throw new DomainError("conflict", "This access request is already resolved");
      }
      const decision = prompt.action === "allow" ? "approved" : "denied";
      if (decision === "approved") {
        await allowTelegramPrincipalInTransaction(tx, this.ids, now, {
          actor,
          targetExternalUserId: prompt.external_user_id,
          note: input.note,
          expiresAt: null,
          correlationId: input.correlationId,
        });
      } else {
        await insertAudit(tx, this.ids.next(), now, {
          actorPrincipalId: actor.id,
          actorBridge: "telegram",
          actorExternalId: input.actorExternalUserId,
          action: "access.request_deny",
          targetType: "access_request",
          targetId: request.id,
          correlationId: input.correlationId,
          changes: { state: "denied", reason: input.note },
        });
      }
      await resolveAccessRequestRows(
        tx,
        this.ids,
        now,
        prompt.external_user_id,
        decision,
        actor.id,
        input.note,
        prompt.id,
      );
      return {
        accessRequestId: request.id,
        requesterExternalUserId: prompt.external_user_id,
        decision,
      };
    });
  }

  async claimAccessDecisionNotification(
    workerId: string,
    leaseSeconds: number,
  ): Promise<AccessDecisionNotificationLease | null> {
    const now = this.clock.now();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    return await this.sql.begin(async (tx) => {
      const rows = await tx<{
        id: string;
        access_request_id: string;
        external_user_id: string;
        decision: "approved" | "denied";
        attempts: number;
      }[]>`
        WITH candidate AS (
          SELECT notification.id FROM access_decision_notifications notification
          WHERE notification.available_at <= ${now}
            AND (notification.state = 'pending' OR
              (notification.state = 'leased' AND notification.lease_expires_at <= ${now}))
          ORDER BY notification.available_at, notification.created_at, notification.id
          LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        UPDATE access_decision_notifications notification SET state = 'leased',
          attempts = notification.attempts + 1, lease_owner = ${workerId},
          lease_expires_at = ${leaseExpiresAt}, updated_at = ${now}
        FROM candidate, access_requests request
        WHERE notification.id = candidate.id AND request.id = notification.access_request_id
        RETURNING notification.id, notification.access_request_id, request.external_user_id,
          notification.decision, notification.attempts
      `;
      const row = rows[0];
      return row
        ? {
          id: row.id,
          accessRequestId: row.access_request_id,
          requesterExternalUserId: row.external_user_id,
          decision: row.decision,
          attempts: row.attempts,
        }
        : null;
    });
  }

  async completeAccessDecisionNotification(id: string, workerId: string): Promise<boolean> {
    const now = this.clock.now();
    const rows = await this.sql<{ id: string }[]>`
      UPDATE access_decision_notifications SET state = 'sent', sent_at = ${now},
        lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL, updated_at = ${now}
      WHERE id = ${id} AND state = 'leased' AND lease_owner = ${workerId}
      RETURNING id
    `;
    return rows.length === 1;
  }

  async failAccessDecisionNotification(input: {
    id: string;
    workerId: string;
    retryable: boolean;
    retryAfterSeconds: number;
    maxAttempts: number;
    errorCode: string;
  }): Promise<boolean> {
    const now = this.clock.now();
    const availableAt = new Date(now.getTime() + input.retryAfterSeconds * 1000);
    const rows = await this.sql<{ id: string }[]>`
      UPDATE access_decision_notifications SET
        state = CASE WHEN ${input.retryable} AND attempts < ${input.maxAttempts}
          THEN 'pending' ELSE 'failed' END,
        available_at = CASE WHEN ${input.retryable} AND attempts < ${input.maxAttempts}
          THEN ${availableAt} ELSE available_at END,
        lease_owner = NULL, lease_expires_at = NULL, last_error_code = ${input.errorCode},
        updated_at = ${now}
      WHERE id = ${input.id} AND state = 'leased' AND lease_owner = ${input.workerId}
      RETURNING id
    `;
    return rows.length === 1;
  }

  async adminUpsertTelegramPrincipal(input: {
    actorExternalUserId: string;
    targetExternalUserId: string;
    note?: string | null;
    expiresAt?: Date | null;
    correlationId: string;
  }): Promise<PrincipalRecord> {
    parseTelegramUserId(input.actorExternalUserId);
    parseTelegramUserId(input.targetExternalUserId);
    const now = this.clock.now();
    return await this.sql.begin(async (tx) => {
      const actor = await requireAdmin(tx, input.actorExternalUserId, now);
      await this.lockAccessTarget(tx, "allow", input.targetExternalUserId);
      const principal = await allowTelegramPrincipalInTransaction(tx, this.ids, now, {
        actor,
        targetExternalUserId: input.targetExternalUserId,
        note: input.note ?? null,
        expiresAt: input.expiresAt ?? null,
        correlationId: input.correlationId,
      });
      await resolveAccessRequestRows(
        tx,
        this.ids,
        now,
        input.targetExternalUserId,
        "approved",
        actor.id,
        input.note ?? null,
      );
      return principal;
    });
  }

  async adminDisableTelegramPrincipal(input: {
    actorExternalUserId: string;
    targetExternalUserId: string;
    reason: string;
    correlationId: string;
  }): Promise<PrincipalRecord> {
    parseTelegramUserId(input.actorExternalUserId);
    parseTelegramUserId(input.targetExternalUserId);
    const now = this.clock.now();
    return await this.sql.begin(async (tx) => {
      const actor = await requireAdmin(tx, input.actorExternalUserId, now);
      await this.lockAccessTarget(tx, "deny", input.targetExternalUserId);
      const targets = await tx<PrincipalRow[]>`
        SELECT id, bridge, external_user_id, role, state, expires_at, note FROM principals
        WHERE bridge = 'telegram' AND external_user_id = ${input.targetExternalUserId} FOR UPDATE
      `;
      const target = targets[0];
      if (target?.role === "admin") {
        throw new DomainError("conflict", "Bootstrap administrators cannot be disabled");
      }
      const targetId = target?.id ?? this.ids.next();
      const rows = await tx<PrincipalRow[]>`
        INSERT INTO principals (
          id, bridge, external_user_id, role, state, note,
          created_by, updated_by, created_at, updated_at
        ) VALUES (
          ${targetId}, 'telegram', ${input.targetExternalUserId}, 'user', 'disabled', ${input.reason},
          ${actor.id}, ${actor.id}, ${now}, ${now}
        ) ON CONFLICT (bridge, external_user_id) DO UPDATE SET
          state = 'disabled', note = ${input.reason}, updated_by = ${actor.id}, updated_at = ${now}
        RETURNING id, bridge, external_user_id, role, state, expires_at, note
      `;
      await insertAudit(tx, this.ids.next(), now, {
        actorPrincipalId: actor.id,
        actorBridge: "telegram",
        actorExternalId: input.actorExternalUserId,
        action: "principal.deny",
        targetId,
        correlationId: input.correlationId,
        changes: { state: "disabled", reason: input.reason },
      });
      await resolveAccessRequestRows(
        tx,
        this.ids,
        now,
        input.targetExternalUserId,
        "denied",
        actor.id,
        input.reason,
      );
      return mapPrincipal(rows[0]);
    });
  }

  async claimOutbox(
    publisherId: string,
    limit: number,
    lockSeconds: number,
  ): Promise<readonly OutboxRecord[]> {
    const now = this.clock.now();
    const expiredBefore = new Date(now.getTime() - lockSeconds * 1000);
    const rows = await this.sql<{
      id: string;
      event_type: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
      attempts: number;
    }[]>`
      WITH candidates AS (
        SELECT id FROM outbox
        WHERE published_at IS NULL AND available_at <= ${now}
          AND (locked_at IS NULL OR locked_at <= ${expiredBefore})
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT ${limit}
      )
      UPDATE outbox o SET locked_by = ${publisherId}, locked_at = ${now}, attempts = attempts + 1
      FROM candidates c WHERE o.id = c.id
      RETURNING o.id, o.event_type, o.aggregate_id, o.payload, o.attempts
    `;
    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      aggregateId: row.aggregate_id,
      payload: row.payload,
      attempts: row.attempts,
    }));
  }

  async markOutboxPublished(id: string, publisherId: string): Promise<boolean> {
    const now = this.clock.now();
    const rows = await this.sql<{ id: string }[]>`
      UPDATE outbox SET published_at = ${now}, locked_by = NULL, locked_at = NULL, last_error = NULL
      WHERE id = ${id} AND locked_by = ${publisherId} AND published_at IS NULL RETURNING id
    `;
    return rows.length === 1;
  }

  async releaseOutbox(
    id: string,
    publisherId: string,
    safeError: string,
    delaySeconds: number,
  ): Promise<void> {
    const now = this.clock.now();
    const availableAt = new Date(now.getTime() + delaySeconds * 1000);
    await this.sql`
      UPDATE outbox SET locked_by = NULL, locked_at = NULL, last_error = ${safeError}, available_at = ${availableAt}
      WHERE id = ${id} AND locked_by = ${publisherId} AND published_at IS NULL
    `;
  }

  async claimJob(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<
    (JobRecord & {
      readonly claimedFromState: JobState;
      readonly claimReferenceAt: Date;
      readonly claimedAt: Date;
    }) | null
  > {
    const now = this.clock.now();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    const rows = await this.sql<
      (JobRow & { claimed_from_state: JobState; claim_reference_at: Date })[]
    >`
      WITH candidate AS (
        SELECT id, state AS claimed_from_state, updated_at AS claim_reference_at
        FROM jobs
        WHERE id = ${jobId} AND cancellation_requested_at IS NULL AND (
          (state = 'queued' AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})) OR
          (state IN ('downloading', 'processing') AND lease_expires_at <= ${now})
        )
        FOR UPDATE
      )
      UPDATE jobs j SET
        state = 'downloading', progress_phase = 'downloading', progress_percent = NULL,
        attempts = attempts + 1, lease_owner = ${workerId},
        lease_expires_at = ${leaseExpiresAt}, heartbeat_at = ${now},
        started_at = COALESCE(started_at, ${now}), updated_at = ${now}
      FROM candidate c WHERE j.id = c.id
      RETURNING j.*, c.claimed_from_state, c.claim_reference_at
    `;
    const row = rows[0];
    return row
      ? {
        ...mapJob(row),
        claimedFromState: row.claimed_from_state,
        claimReferenceAt: row.claim_reference_at,
        claimedAt: now,
      }
      : null;
  }

  async heartbeatJob(jobId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    const now = this.clock.now();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    const rows = await this.sql<{ id: string }[]>`
      UPDATE jobs SET lease_expires_at = ${leaseExpiresAt}, heartbeat_at = ${now}, updated_at = ${now}
      WHERE id = ${jobId} AND lease_owner = ${workerId}
        AND state IN ('downloading', 'processing') AND lease_expires_at > ${now}
      RETURNING id
    `;
    return rows.length === 1;
  }

  async reuseReadyArtifactBySource(jobId: string): Promise<ArtifactRecord | null> {
    const now = this.clock.now();
    return await this.sql.begin(async (tx) => {
      const jobs = await tx<JobRow[]>`SELECT * FROM jobs WHERE id = ${jobId} FOR UPDATE`;
      const job = jobs[0];
      if (!job || job.state !== "downloading") return null;
      const candidates = await tx<(ArtifactRow & { selected_format: unknown })[]>`
        SELECT a.id, a.job_id, a.object_key, a.temporary_object_key, a.state,
          a.byte_size, a.sha256, a.expires_at, source.selected_format
        FROM artifacts a
        JOIN jobs source ON source.artifact_id = a.id
        WHERE source.source_type = 'x' AND source.source_id = ${job.source_id}
          AND source.id <> ${job.id} AND a.state = 'ready'
        ORDER BY a.ready_at DESC, a.id
        LIMIT 1
        FOR SHARE OF a
      `;
      const candidate = candidates[0];
      if (!candidate) return null;
      await attachJobToArtifact(tx, job, candidate.id, candidate.selected_format, now);
      return mapArtifact(candidate);
    });
  }

  async reuseReadyArtifactByContent(input: {
    jobId: string;
    byteSize: number;
    sha256: string;
    selectedFormat: Readonly<Record<string, unknown>>;
  }): Promise<ArtifactRecord | null> {
    const now = this.clock.now();
    return await this.sql.begin(async (tx) => {
      await lockArtifactContent(tx, input.sha256, input.byteSize);
      const jobs = await tx<JobRow[]>`SELECT * FROM jobs WHERE id = ${input.jobId} FOR UPDATE`;
      const job = jobs[0];
      if (!job || job.state !== "processing") return null;
      const candidates = await tx<ArtifactRow[]>`
        SELECT id, job_id, object_key, temporary_object_key, state, byte_size, sha256, expires_at
        FROM artifacts
        WHERE state = 'ready' AND sha256 = ${input.sha256} AND byte_size = ${input.byteSize}
        ORDER BY ready_at DESC, id
        LIMIT 1
        FOR SHARE
      `;
      const candidate = candidates[0];
      if (!candidate) return null;
      await attachJobToArtifact(tx, job, candidate.id, input.selectedFormat, now);
      return mapArtifact(candidate);
    });
  }

  async createUploadingArtifact(input: {
    artifactId: string;
    jobId: string;
    objectKey: string;
    temporaryObjectKey: string;
  }): Promise<ArtifactRecord> {
    const now = this.clock.now();
    const rows = await this.sql<ArtifactRow[]>`
      INSERT INTO artifacts (
        id, job_id, object_key, temporary_object_key, state, created_at, updated_at
      ) SELECT
        ${input.artifactId}, id, ${input.objectKey}, ${input.temporaryObjectKey},
        'uploading', ${now}, ${now}
      FROM jobs WHERE id = ${input.jobId} AND state = 'processing'
      ON CONFLICT (job_id) DO UPDATE SET updated_at = artifacts.updated_at
      RETURNING id, job_id, object_key, temporary_object_key, state, byte_size, sha256, expires_at
    `;
    if (!rows[0]) throw new DomainError("conflict", "The job is not ready for artifact upload");
    return mapArtifact(rows[0]);
  }

  async completeArtifact(input: {
    artifactId: string;
    jobId: string;
    objectKey: string;
    byteSize: number;
    sha256: string;
    container: string;
    videoCodec: string;
    audioCodec: string | null;
    durationSeconds: number;
    width: number;
    height: number;
    title: string | null;
    selectedFormat: Readonly<Record<string, unknown>>;
    maxStorageBytes?: number;
  }): Promise<ArtifactCompletionResult> {
    const now = this.clock.now();
    return await this.sql.begin(async (tx) => {
      await lockArtifactContent(tx, input.sha256, input.byteSize);
      const jobs = await tx<JobRow[]>`SELECT * FROM jobs WHERE id = ${input.jobId} FOR UPDATE`;
      const job = jobs[0];
      if (!job) throw new DomainError("not_found", "Job not found");
      if (job.state === "ready" && job.artifact_id) {
        const existing = await tx<ArtifactRow[]>`
          SELECT id, job_id, object_key, temporary_object_key, state, byte_size, sha256, expires_at
          FROM artifacts WHERE id = ${job.artifact_id}
        `;
        return { artifact: mapArtifact(existing[0]), reused: job.artifact_id !== input.artifactId };
      }
      assertJobTransition(job.state, "ready");
      const canonical = await tx<ArtifactRow[]>`
        SELECT id, job_id, object_key, temporary_object_key, state, byte_size, sha256, expires_at
        FROM artifacts
        WHERE state = 'ready' AND sha256 = ${input.sha256} AND byte_size = ${input.byteSize}
          AND id <> ${input.artifactId}
        ORDER BY ready_at DESC, id
        LIMIT 1
        FOR SHARE
      `;
      if (canonical[0]) {
        await attachJobToArtifact(tx, job, canonical[0].id, input.selectedFormat, now);
        const discarded = await tx`
          UPDATE artifacts SET state = 'delete_failed', byte_size = ${input.byteSize},
            sha256 = ${input.sha256}, expires_at = ${now}, last_delete_error = 'deduplicated',
            updated_at = ${now}
          WHERE id = ${input.artifactId} AND job_id = ${input.jobId} AND state = 'uploading'
        `;
        if (discarded.count !== 1) {
          throw new DomainError("conflict", "Artifact upload is not active");
        }
        return { artifact: mapArtifact(canonical[0]), reused: true };
      }
      if ((input.maxStorageBytes ?? 0) > 0) {
        await tx`SELECT pg_advisory_xact_lock(hashtext('artifact-storage-ceiling'))`;
        const usage = await tx<{ bytes: number }[]>`
          SELECT COALESCE(sum(byte_size), 0)::bigint AS bytes
          FROM artifacts WHERE state = 'ready'
        `;
        if (Number(usage[0]?.bytes ?? 0) + input.byteSize > input.maxStorageBytes!) {
          throw new DomainError(
            "storage_full",
            "Artifact storage has reached its configured limit",
            true,
          );
        }
      }
      const artifacts = await tx<ArtifactRow[]>`
        UPDATE artifacts SET
          object_key = ${input.objectKey}, temporary_object_key = NULL, state = 'ready',
          byte_size = ${input.byteSize}, sha256 = ${input.sha256}, container = ${input.container},
          video_codec = ${input.videoCodec}, audio_codec = ${input.audioCodec},
          duration_seconds = ${input.durationSeconds}, width = ${input.width}, height = ${input.height},
          title = ${input.title}, expires_at = NULL, ready_at = ${now}, updated_at = ${now}
        WHERE id = ${input.artifactId} AND job_id = ${input.jobId} AND state = 'uploading'
        RETURNING id, job_id, object_key, temporary_object_key, state, byte_size, sha256, expires_at
      `;
      if (!artifacts[0]) throw new DomainError("conflict", "Artifact upload is not active");
      const updated = await tx`
        UPDATE jobs SET state = 'ready', progress_phase = 'ready', progress_percent = 100,
          artifact_id = ${input.artifactId},
          selected_format = ${tx.json(asJson(input.selectedFormat))}, ready_at = ${now},
          lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ${now}
        WHERE id = ${input.jobId} AND state = 'processing'
      `;
      if (updated.count !== 1) {
        throw new DomainError("conflict", "Job changed during artifact promotion");
      }
      await tx`UPDATE deliveries SET artifact_id = ${input.artifactId}, updated_at = ${now} WHERE job_id = ${input.jobId}`;
      await recomputeArtifactExpiry(tx, input.artifactId, now);
      const completed = await tx<ArtifactRow[]>`
        SELECT id, job_id, object_key, temporary_object_key, state, byte_size, sha256, expires_at
        FROM artifacts WHERE id = ${input.artifactId}
      `;
      return { artifact: mapArtifact(completed[0]), reused: false };
    });
  }

  async markArtifactUploadFailed(artifactId: string, safeError: string): Promise<void> {
    await this.routine.markArtifactUploadFailed(artifactId, safeError, this.clock.now());
  }

  async getReadyArtifact(id: string): Promise<ArtifactRecord | null> {
    return await this.routine.getReadyArtifact(id);
  }

  async setDeliveryProgressMessage(
    jobId: string,
    requesterExternalUserId: string,
    progressMessageId: number,
  ): Promise<boolean> {
    const now = this.clock.now();
    const rows = await this.sql<{ id: string }[]>`
      UPDATE deliveries d SET
        destination = jsonb_set(d.destination, '{progressMessageId}', ${
      this.sql.json(progressMessageId)
    }),
        terminal_progress_state = CASE
          WHEN d.destination->>'progressMessageId' = ${String(progressMessageId)}
          THEN d.terminal_progress_state ELSE NULL END,
        terminal_progress_lease_owner = CASE
          WHEN d.destination->>'progressMessageId' = ${String(progressMessageId)}
          THEN d.terminal_progress_lease_owner ELSE NULL END,
        terminal_progress_lease_expires_at = CASE
          WHEN d.destination->>'progressMessageId' = ${String(progressMessageId)}
          THEN d.terminal_progress_lease_expires_at ELSE NULL END,
        terminal_progress_next_attempt_at = CASE
          WHEN d.destination->>'progressMessageId' = ${String(progressMessageId)}
          THEN d.terminal_progress_next_attempt_at ELSE NULL END,
        updated_at = ${now}
      FROM jobs j
      JOIN principals p ON p.id = j.requester_principal_id
      WHERE d.job_id = j.id AND j.id = ${jobId}
        AND p.bridge = 'telegram' AND p.external_user_id = ${requesterExternalUserId}
        AND p.state = 'active' AND (p.expires_at IS NULL OR p.expires_at > ${now})
      RETURNING d.id
    `;
    return rows.length === 1;
  }

  async listDeliveryProgress(limit = 50): Promise<readonly DeliveryProgressRecord[]> {
    return await this.routine.listDeliveryProgress(limit);
  }

  async claimTerminalProgress(
    workerId: string,
    leaseSeconds: number,
  ): Promise<TerminalProgressLeaseRecord | null> {
    const now = this.clock.now();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    const rows = await this.sql<{
      delivery_id: string;
      job_id: string;
      display_id: string;
      state: TerminalProgressState;
      safe_error_message: string | null;
      attempts: number;
      destination: Record<string, unknown>;
    }[]>`
      WITH candidate AS (
        SELECT d.id
        FROM deliveries d
        JOIN jobs j ON j.id = d.job_id
        WHERE d.bridge = 'telegram'
          AND d.destination ? 'progressMessageId'
          AND d.state <> 'delivered'
          AND j.state IN ('failed', 'cancelled', 'expired')
          AND d.terminal_progress_state IS DISTINCT FROM j.state
          AND COALESCE(d.terminal_progress_next_attempt_at, ${now}) <= ${now}
          AND (
            d.terminal_progress_lease_owner IS NULL OR
            d.terminal_progress_lease_expires_at <= ${now}
          )
        ORDER BY COALESCE(d.terminal_progress_next_attempt_at, j.updated_at), j.updated_at
        FOR UPDATE OF d SKIP LOCKED
        LIMIT 1
      )
      UPDATE deliveries d SET
        terminal_progress_attempts = terminal_progress_attempts + 1,
        terminal_progress_lease_owner = ${workerId},
        terminal_progress_lease_expires_at = ${leaseExpiresAt},
        terminal_progress_next_attempt_at = NULL,
        updated_at = ${now}
      FROM candidate c, jobs j
      WHERE d.id = c.id AND j.id = d.job_id
      RETURNING d.id AS delivery_id, d.job_id, j.display_id, j.state,
        j.safe_error_message, d.terminal_progress_attempts AS attempts, d.destination
    `;
    const row = rows[0];
    return row
      ? {
        deliveryId: row.delivery_id,
        jobId: row.job_id,
        displayId: row.display_id,
        state: row.state,
        safeErrorMessage: row.safe_error_message,
        attempts: row.attempts,
        destination: row.destination,
      }
      : null;
  }

  async completeTerminalProgress(deliveryId: string, workerId: string): Promise<boolean> {
    const now = this.clock.now();
    const rows = await this.sql<{ id: string }[]>`
      UPDATE deliveries d SET
        terminal_progress_state = j.state,
        terminal_progress_lease_owner = NULL,
        terminal_progress_lease_expires_at = NULL,
        terminal_progress_next_attempt_at = NULL,
        updated_at = ${now}
      FROM jobs j
      WHERE d.id = ${deliveryId} AND j.id = d.job_id
        AND j.state IN ('failed', 'cancelled', 'expired')
        AND d.terminal_progress_lease_owner = ${workerId}
        AND d.terminal_progress_lease_expires_at > ${now}
      RETURNING d.id
    `;
    if (rows.length === 1) return true;
    const existing = await this.sql<{ finalized: boolean }[]>`
      SELECT (d.terminal_progress_state = j.state) AS finalized
      FROM deliveries d JOIN jobs j ON j.id = d.job_id
      WHERE d.id = ${deliveryId} AND j.state IN ('failed', 'cancelled', 'expired')
    `;
    return existing[0]?.finalized ?? false;
  }

  async failTerminalProgress(input: {
    deliveryId: string;
    workerId: string;
    retryable: boolean;
    retryAfterSeconds: number;
  }): Promise<boolean> {
    const now = this.clock.now();
    const nextAttemptAt = input.retryable
      ? new Date(now.getTime() + Math.max(1, input.retryAfterSeconds) * 1000)
      : null;
    const rows = await this.sql<{ id: string }[]>`
      UPDATE deliveries d SET
        terminal_progress_state = CASE WHEN ${input.retryable} THEN
          d.terminal_progress_state ELSE j.state END,
        terminal_progress_lease_owner = NULL,
        terminal_progress_lease_expires_at = NULL,
        terminal_progress_next_attempt_at = ${nextAttemptAt},
        updated_at = ${now}
      FROM jobs j
      WHERE d.id = ${input.deliveryId} AND j.id = d.job_id
        AND j.state IN ('failed', 'cancelled', 'expired')
        AND d.terminal_progress_lease_owner = ${input.workerId}
      RETURNING d.id
    `;
    return rows.length === 1;
  }

  async claimDelivery(
    workerId: string,
    leaseSeconds: number,
    jobId?: string,
  ): Promise<DeliveryLeaseRecord | null> {
    const now = this.clock.now();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    return await this.sql.begin(async (tx) => {
      const rows = await tx<DeliveryLeaseRow[]>`
        WITH candidate AS (
          SELECT d.id, j.display_id
          FROM deliveries d
          JOIN jobs j ON j.id = d.job_id
          JOIN artifacts a ON a.id = d.artifact_id
          WHERE d.bridge = 'telegram' AND a.state = 'ready'
            AND d.destination ? 'progressMessageId'
            AND (${jobId ?? null}::text IS NULL OR d.job_id::text = ${jobId ?? null}::text)
            AND j.state IN ('ready', 'delivering')
            AND (
              d.state = 'pending' OR
              (d.state = 'retry_wait' AND COALESCE(d.next_attempt_at, ${now}) <= ${now}) OR
              (d.state IN ('leased', 'delivering') AND d.lease_expires_at <= ${now})
            )
          ORDER BY CASE
            WHEN d.state = 'retry_wait' THEN COALESCE(d.next_attempt_at, d.created_at)
            WHEN d.state IN ('leased', 'delivering') THEN COALESCE(d.lease_expires_at, d.created_at)
            ELSE d.created_at
          END, d.created_at
          FOR UPDATE OF d SKIP LOCKED
          LIMIT 1
        )
        UPDATE deliveries d SET
          state = 'leased', attempts = attempts + 1, lease_owner = ${workerId},
          lease_expires_at = ${leaseExpiresAt}, heartbeat_at = ${now},
          started_at = COALESCE(started_at, ${now}), next_attempt_at = NULL, updated_at = ${now}
        FROM candidate c, artifacts a
        WHERE d.id = c.id AND a.id = d.artifact_id
        RETURNING d.id, d.job_id, c.display_id, d.artifact_id, d.attempts, d.destination,
          d.operation_context, a.byte_size, a.container, a.video_codec, a.audio_codec,
          a.ready_at AS artifact_ready_at
      `;
      const row = rows[0];
      if (!row) return null;
      await tx`
        UPDATE jobs SET state = 'delivering', updated_at = ${now}
        WHERE id = ${row.job_id} AND state = 'ready'
      `;
      return mapDeliveryLease(row);
    });
  }

  async heartbeatDelivery(
    deliveryId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    const now = this.clock.now();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    const rows = await this.sql<{ id: string }[]>`
      UPDATE deliveries SET lease_expires_at = ${leaseExpiresAt}, heartbeat_at = ${now},
        state = 'delivering', updated_at = ${now}
      WHERE id = ${deliveryId} AND lease_owner = ${workerId}
        AND state IN ('leased', 'delivering') AND lease_expires_at > ${now}
      RETURNING id
    `;
    return rows.length === 1;
  }

  async completeDelivery(
    deliveryId: string,
    workerId: string,
    result: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    const now = this.clock.now();
    return await this.sql.begin(async (tx) => {
      const rows = await tx<{ job_id: string; artifact_id: string }[]>`
        UPDATE deliveries SET state = 'delivered', result = ${tx.json(asJson(result))},
          lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
          last_error_code = NULL, last_safe_error = NULL, completed_at = ${now}, updated_at = ${now}
        WHERE id = ${deliveryId} AND lease_owner = ${workerId}
          AND state IN ('leased', 'delivering') AND lease_expires_at > ${now}
        RETURNING job_id, artifact_id
      `;
      const delivery = rows[0];
      if (!delivery) {
        const existing = await tx<{ state: string }[]>`
          SELECT state FROM deliveries WHERE id = ${deliveryId}
        `;
        return existing[0]?.state === "delivered";
      }
      const remaining = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM deliveries
        WHERE job_id = ${delivery.job_id} AND state <> 'delivered'
      `;
      if ((remaining[0]?.count ?? 0) === 0) {
        const jobs = await tx<
          JobRow[]
        >`SELECT * FROM jobs WHERE id = ${delivery.job_id} FOR UPDATE`;
        const job = jobs[0];
        if (job?.state === "delivering") {
          assertJobTransition("delivering", "delivered");
          await tx`
            UPDATE jobs SET state = 'delivered', delivered_at = ${now}, updated_at = ${now}
            WHERE id = ${delivery.job_id} AND state = 'delivering'
          `;
          await recomputeArtifactExpiry(tx, delivery.artifact_id, now);
        }
      }
      return true;
    });
  }

  async recordDeliveryOperation(
    deliveryId: string,
    workerId: string,
    context: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    const now = this.clock.now();
    const rows = await this.sql<{ id: string }[]>`
      UPDATE deliveries SET operation_context = ${
      this.sql.json(asJson(context))
    }, updated_at = ${now}
      WHERE id = ${deliveryId} AND lease_owner = ${workerId}
        AND state IN ('leased', 'delivering') AND lease_expires_at > ${now}
      RETURNING id
    `;
    return rows.length === 1;
  }

  async failDelivery(input: {
    deliveryId: string;
    workerId: string;
    errorCode: "delivery_retryable" | "delivery_permanent";
    safeMessage: string;
    retryAfterSeconds?: number;
  }): Promise<boolean> {
    const now = this.clock.now();
    const retry = input.errorCode === "delivery_retryable";
    const nextAttemptAt = retry
      ? new Date(now.getTime() + Math.max(1, input.retryAfterSeconds ?? 5) * 1000)
      : null;
    return await this.sql.begin(async (tx) => {
      const rows = await tx<{ job_id: string }[]>`
        UPDATE deliveries SET state = ${retry ? "retry_wait" : "failed"},
          lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
          next_attempt_at = ${nextAttemptAt}, last_error_code = ${input.errorCode},
          last_safe_error = ${input.safeMessage},
          completed_at = ${retry ? null : now}, updated_at = ${now}
        WHERE id = ${input.deliveryId} AND lease_owner = ${input.workerId}
          AND state IN ('leased', 'delivering')
        RETURNING job_id
      `;
      if (!rows[0]) return false;
      await tx`
        UPDATE jobs SET state = 'ready', updated_at = ${now}
        WHERE id = ${rows[0].job_id} AND state = 'delivering'
      `;
      return true;
    });
  }

  async claimArtifactCleanup(
    staleClaimSeconds: number,
    artifactId?: string,
  ): Promise<ArtifactCleanupRecord | null> {
    const now = this.clock.now();
    const staleBefore = new Date(now.getTime() - staleClaimSeconds * 1000);
    const rows = await this.sql<ArtifactRow[]>`
      WITH candidate AS (
        SELECT a.id FROM artifacts a
        WHERE (
          (a.state IN ('ready', 'delete_failed') AND a.expires_at IS NOT NULL AND a.expires_at <= ${now}) OR
          (a.state = 'uploading' AND a.created_at <= ${staleBefore}) OR
          (a.state = 'deleting' AND a.deleting_at <= ${staleBefore})
        )
        AND (${artifactId ?? null}::text IS NULL OR a.id::text = ${artifactId ?? null}::text)
        AND NOT EXISTS (
          SELECT 1 FROM deliveries d WHERE d.artifact_id = a.id
            AND d.state IN ('leased', 'delivering') AND d.lease_expires_at > ${now}
        )
        ORDER BY COALESCE(a.expires_at, a.created_at)
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE artifacts a SET state = 'deleting', deleting_at = ${now},
        delete_attempts = delete_attempts + 1, updated_at = ${now}
      FROM candidate c WHERE a.id = c.id
      RETURNING a.id, a.job_id, a.object_key, a.temporary_object_key, a.state,
        a.byte_size, a.sha256, a.expires_at, a.delete_attempts
    `;
    const row = rows[0];
    return row ? { ...mapArtifact(row), deleteAttempts: row.delete_attempts ?? 0 } : null;
  }

  async completeArtifactCleanup(artifactId: string): Promise<boolean> {
    const now = this.clock.now();
    return await this.sql.begin(async (tx) => {
      const rows = await tx<{ job_id: string }[]>`
        UPDATE artifacts SET state = 'deleted', temporary_object_key = NULL,
          last_delete_error = NULL, deleted_at = ${now}, updated_at = ${now}
        WHERE id = ${artifactId} AND state = 'deleting' RETURNING job_id
      `;
      if (!rows[0]) return false;
      await tx`
        UPDATE deliveries SET state = 'failed', last_error_code = 'cleanup_failure',
          last_safe_error = 'Artifact retention period ended before delivery',
          lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
          completed_at = COALESCE(completed_at, ${now}), updated_at = ${now}
        WHERE artifact_id = ${artifactId} AND state <> 'delivered'
      `;
      await tx`
        UPDATE jobs SET state = 'ready', updated_at = ${now}
        WHERE artifact_id = ${artifactId} AND state = 'delivering'
      `;
      await tx`
        UPDATE jobs SET state = 'expired', progress_phase = NULL, progress_percent = NULL,
          expired_at = ${now}, updated_at = ${now}
        WHERE artifact_id = ${artifactId} AND state IN ('ready', 'delivered')
      `;
      await tx`
        UPDATE jobs SET state = 'failed', progress_phase = NULL, progress_percent = NULL,
          error_code = 'cleanup_failure', safe_error_message = 'An abandoned partial artifact was removed',
          lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
          failed_at = ${now}, updated_at = ${now}
        WHERE id = ${rows[0].job_id} AND artifact_id IS NULL
          AND state IN ('downloading', 'processing')
      `;
      return true;
    });
  }

  async failArtifactCleanup(
    artifactId: string,
    safeError: string,
    retryAfterSeconds: number,
  ): Promise<boolean> {
    const now = this.clock.now();
    const retryAt = new Date(now.getTime() + retryAfterSeconds * 1000);
    const rows = await this.sql<{ id: string }[]>`
      UPDATE artifacts SET state = 'delete_failed', last_delete_error = ${safeError},
        expires_at = ${retryAt}, updated_at = ${now}
      WHERE id = ${artifactId} AND state = 'deleting' RETURNING id
    `;
    return rows.length === 1;
  }

  async purgeOldJobHistory(
    historyTtlSeconds: number,
    limit = 100,
    accessRequestTtlSeconds = historyTtlSeconds,
  ): Promise<HistoryPurgeResult> {
    if (historyTtlSeconds <= 0 && accessRequestTtlSeconds <= 0) {
      return { jobs: 0, auditEvents: 0, outboxEvents: 0, accessRequests: 0 };
    }
    const now = this.clock.now();
    const before = new Date(now.getTime() - Math.max(historyTtlSeconds, 0) * 1000);
    const accessBefore = new Date(
      now.getTime() - Math.max(accessRequestTtlSeconds, 0) * 1000,
    );
    return await this.sql.begin(async (tx) => {
      const auditEvents = historyTtlSeconds <= 0 ? { count: 0 } : await tx`
        DELETE FROM audit_events WHERE id IN (
          SELECT id FROM audit_events WHERE created_at <= ${before}
          ORDER BY created_at LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
      `;
      const outboxEvents = historyTtlSeconds <= 0 ? { count: 0 } : await tx`
        DELETE FROM outbox WHERE id IN (
          SELECT id FROM outbox
          WHERE published_at IS NOT NULL AND created_at <= ${before}
          ORDER BY created_at LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
      `;
      const accessRequests = accessRequestTtlSeconds <= 0 ? { count: 0 } : await tx`
        DELETE FROM access_requests WHERE id IN (
          SELECT id FROM access_requests
          WHERE COALESCE(resolved_at, last_requested_at) <= ${accessBefore}
          ORDER BY COALESCE(resolved_at, last_requested_at) LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
      `;
      const jobs = historyTtlSeconds <= 0 ? { count: 0 } : await tx`
        DELETE FROM jobs WHERE id IN (
          SELECT j.id FROM jobs j
          LEFT JOIN artifacts a ON a.job_id = j.id
          WHERE j.state IN ('failed', 'cancelled', 'expired')
            AND COALESCE(
              j.delivered_at, j.failed_at, j.cancelled_at, j.expired_at, j.updated_at
            ) <= ${before}
            AND (
              a.id IS NULL OR (
                a.state = 'deleted' AND NOT EXISTS (
                  SELECT 1 FROM jobs artifact_reference
                  WHERE artifact_reference.artifact_id = a.id
                    AND artifact_reference.id <> j.id
                )
              )
            )
          ORDER BY j.updated_at LIMIT ${limit}
          FOR UPDATE OF j SKIP LOCKED
        )
      `;
      return {
        jobs: Number(jobs.count),
        auditEvents: Number(auditEvents.count),
        outboxEvents: Number(outboxEvents.count),
        accessRequests: Number(accessRequests.count),
      };
    });
  }

  async getOperationalSnapshot(): Promise<OperationalSnapshot> {
    const now = this.clock.now();
    const rows = await this.sql<{
      queued_jobs: number;
      oldest_queued_age_seconds: number;
      active_worker_leases: number;
      active_delivery_leases: number;
      unpublished_outbox: number;
      oldest_outbox_age_seconds: number;
      ready_artifact_bytes: number;
      cleanup_failures: number;
      expired_artifact_lag_seconds: number;
    }[]>`
      SELECT
        (SELECT count(*)::int FROM jobs WHERE state = 'queued') AS queued_jobs,
        (SELECT COALESCE(EXTRACT(EPOCH FROM (${now} - min(created_at))), 0)::float8
          FROM jobs WHERE state = 'queued') AS oldest_queued_age_seconds,
        (SELECT count(*)::int FROM jobs WHERE state IN ('downloading', 'processing')
          AND lease_expires_at > ${now}) AS active_worker_leases,
        (SELECT count(*)::int FROM deliveries WHERE state IN ('leased', 'delivering')
          AND lease_expires_at > ${now}) AS active_delivery_leases,
        (SELECT count(*)::int FROM outbox WHERE published_at IS NULL) AS unpublished_outbox,
        (SELECT COALESCE(EXTRACT(EPOCH FROM (${now} - min(created_at))), 0)::float8
          FROM outbox WHERE published_at IS NULL) AS oldest_outbox_age_seconds,
        (SELECT COALESCE(sum(byte_size), 0)::bigint FROM artifacts
          WHERE state = 'ready') AS ready_artifact_bytes,
        (SELECT count(*)::int FROM artifacts WHERE state = 'delete_failed') AS cleanup_failures,
        (SELECT COALESCE(EXTRACT(EPOCH FROM (${now} - min(expires_at))), 0)::float8
          FROM artifacts WHERE state IN ('ready', 'delete_failed')
            AND expires_at IS NOT NULL AND expires_at <= ${now}) AS expired_artifact_lag_seconds
    `;
    const row = rows[0];
    if (!row) throw new Error("Operational snapshot query returned no row");
    return {
      queuedJobs: Number(row.queued_jobs),
      oldestQueuedAgeSeconds: Math.max(0, Number(row.oldest_queued_age_seconds)),
      activeWorkerLeases: Number(row.active_worker_leases),
      activeDeliveryLeases: Number(row.active_delivery_leases),
      unpublishedOutbox: Number(row.unpublished_outbox),
      oldestOutboxAgeSeconds: Math.max(0, Number(row.oldest_outbox_age_seconds)),
      readyArtifactBytes: Number(row.ready_artifact_bytes),
      cleanupFailures: Number(row.cleanup_failures),
      expiredArtifactLagSeconds: Math.max(0, Number(row.expired_artifact_lag_seconds)),
    };
  }

  async transitionJob(
    jobId: string,
    expected: JobState,
    next: JobState,
    fields: {
      errorCode?: string;
      safeErrorMessage?: string;
      progressPhase?: "retrying_source_timeout";
    } = {},
  ): Promise<JobRecord | null> {
    assertJobTransition(expected, next);
    const now = this.clock.now();
    const rows = await this.sql<JobRow[]>`
      UPDATE jobs SET
        state = ${next}, updated_at = ${now},
        progress_phase = ${fields.progressPhase ?? progressPhase(next)},
        progress_percent = ${next === "ready" || next === "delivered" ? 100 : null},
        lease_owner = CASE WHEN ${next} IN ('queued', 'ready', 'delivered', 'failed', 'cancelled', 'expired') THEN NULL ELSE lease_owner END,
        lease_expires_at = CASE WHEN ${next} IN ('queued', 'ready', 'delivered', 'failed', 'cancelled', 'expired') THEN NULL ELSE lease_expires_at END,
        heartbeat_at = CASE WHEN ${next} IN ('queued', 'ready', 'delivered', 'failed', 'cancelled', 'expired') THEN NULL ELSE heartbeat_at END,
        error_code = ${fields.errorCode ?? null}, safe_error_message = ${
      fields.safeErrorMessage ?? null
    },
        ready_at = CASE WHEN ${next} = 'ready' THEN ${now} ELSE ready_at END,
        delivered_at = CASE WHEN ${next} = 'delivered' THEN ${now} ELSE delivered_at END,
        failed_at = CASE WHEN ${next} = 'failed' THEN ${now} ELSE failed_at END,
        cancelled_at = CASE WHEN ${next} = 'cancelled' THEN ${now} ELSE cancelled_at END,
        expired_at = CASE WHEN ${next} = 'expired' THEN ${now} ELSE expired_at END
      WHERE id = ${jobId} AND state = ${expected}
      RETURNING *
    `;
    return rows[0] ? mapJob(rows[0]) : null;
  }
}

async function lockArtifactContent(
  tx: Transaction,
  sha256: string,
  byteSize: number,
): Promise<void> {
  await tx`
    SELECT pg_advisory_xact_lock(hashtext(${`artifact-content:${sha256}:${byteSize}`}))
  `;
}

async function attachJobToArtifact(
  tx: Transaction,
  job: JobRow,
  artifactId: string,
  selectedFormat: unknown,
  now: Date,
): Promise<void> {
  assertJobTransition(job.state, "ready");
  const serializedFormat = selectedFormat === null || selectedFormat === undefined
    ? null
    : tx.json(asJson(selectedFormat));
  const updated = await tx`
    UPDATE jobs SET state = 'ready', progress_phase = 'ready', progress_percent = 100,
      artifact_id = ${artifactId}, selected_format = ${serializedFormat}, ready_at = ${now},
      error_code = NULL, safe_error_message = NULL, lease_owner = NULL,
      lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ${now}
    WHERE id = ${job.id} AND state = ${job.state}
  `;
  if (updated.count !== 1) {
    throw new DomainError("conflict", "Job changed while reusing an artifact");
  }
  await tx`
    UPDATE deliveries SET artifact_id = ${artifactId}, updated_at = ${now}
    WHERE job_id = ${job.id}
  `;
  await recomputeArtifactExpiry(tx, artifactId, now);
}

async function recomputeArtifactExpiry(
  tx: Transaction,
  artifactId: string,
  now: Date,
): Promise<void> {
  await tx`
    WITH retention AS (
      SELECT CASE
        WHEN COALESCE(bool_or(
          policy->>'mode' = 'forever' OR
          (policy->>'mode' = 'after_delivery' AND delivered_at IS NULL)
        ), false) THEN NULL::timestamptz
        ELSE max(CASE
          WHEN policy->>'mode' = 'ttl' THEN
            COALESCE(ready_at, created_at) +
              ((policy->>'ttlSeconds')::double precision * interval '1 second')
          WHEN policy->>'mode' = 'after_delivery' THEN
            delivered_at +
              ((policy->>'afterDeliveryGraceSeconds')::double precision * interval '1 second')
          ELSE NULL
        END)
      END AS expires_at
      FROM jobs
      WHERE artifact_id = ${artifactId} AND state IN ('ready', 'delivering', 'delivered')
    )
    UPDATE artifacts SET expires_at = retention.expires_at, updated_at = ${now}
    FROM retention WHERE artifacts.id = ${artifactId} AND artifacts.state = 'ready'
  `;
}

function progressPhase(state: JobState): string | null {
  if (state === "queued") return "queued";
  if (state === "downloading") return "downloading";
  if (state === "processing") return "processing";
  if (state === "ready" || state === "delivering" || state === "delivered") return state;
  return null;
}

async function insertAudit(
  tx: Transaction,
  id: string,
  now: Date,
  event: {
    actorPrincipalId?: string;
    actorBridge?: string;
    actorExternalId?: string;
    action: string;
    targetType?: string;
    targetId: string;
    correlationId: string;
    result?: "success" | "failure";
    changes: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await tx`
    INSERT INTO audit_events (
      id, actor_principal_id, actor_bridge, actor_external_id, action, target_type, target_id,
      result, correlation_id, changes, created_at
    ) VALUES (
      ${id}, ${event.actorPrincipalId ?? null}, ${event.actorBridge ?? null},
      ${event.actorExternalId ?? null}, ${event.action},
      ${event.targetType ?? "principal"}, ${event.targetId}, ${event.result ?? "success"},
      ${event.correlationId},
      ${tx.json(asJson(event.changes))}, ${now}
    )
  `;
}

async function enqueueAccessRequestNotifications(
  tx: Transaction,
  ids: IdGenerator,
  accessRequestId: string,
  requestRevision: number,
  now: Date,
): Promise<void> {
  const admins = await tx<{ id: string }[]>`
    SELECT id FROM principals
    WHERE bridge = 'telegram' AND role = 'admin' AND state = 'active'
      AND (expires_at IS NULL OR expires_at > ${now})
    ORDER BY id
  `;
  for (const admin of admins) {
    await tx`
      INSERT INTO access_request_notifications (
        id, access_request_id, admin_principal_id, request_revision, state, attempts,
        available_at, created_at, updated_at
      ) VALUES (
        ${ids.next()}, ${accessRequestId}, ${admin.id}, ${requestRevision}, 'pending', 0,
        ${now}, ${now}, ${now}
      ) ON CONFLICT (access_request_id, admin_principal_id, request_revision) DO NOTHING
    `;
  }
}

async function refreshLegacyNotificationPending(
  tx: Transaction,
  accessRequestId: string,
  requestRevision: number,
): Promise<void> {
  await tx`
    UPDATE access_requests SET notification_pending = EXISTS (
      SELECT 1 FROM access_request_notifications n
      WHERE n.access_request_id = ${accessRequestId}
        AND n.request_revision = ${requestRevision}
        AND n.state IN ('pending', 'leased')
    )
    WHERE id = ${accessRequestId} AND notification_revision = ${requestRevision}
  `;
}

async function expireAdminPrompts(
  tx: Transaction,
  adminPrincipalId: string,
  now: Date,
): Promise<void> {
  await tx`
    UPDATE access_decision_prompts SET state = 'expired', completed_at = ${now}, updated_at = ${now}
    WHERE admin_principal_id = ${adminPrincipalId} AND state = 'pending' AND expires_at <= ${now}
  `;
}

async function allowTelegramPrincipalInTransaction(
  tx: Transaction,
  ids: IdGenerator,
  now: Date,
  input: {
    actor: PrincipalRecord;
    targetExternalUserId: string;
    note: string | null;
    expiresAt: Date | null;
    correlationId: string;
  },
): Promise<PrincipalRecord> {
  const existing = await tx<PrincipalRow[]>`
    SELECT id, bridge, external_user_id, role, state, expires_at, note FROM principals
    WHERE bridge = 'telegram' AND external_user_id = ${input.targetExternalUserId} FOR UPDATE
  `;
  const principalId = existing[0]?.id ?? ids.next();
  const rows = await tx<PrincipalRow[]>`
    INSERT INTO principals (
      id, bridge, external_user_id, role, state, expires_at, note,
      created_by, updated_by, created_at, updated_at
    ) VALUES (
      ${principalId}, 'telegram', ${input.targetExternalUserId}, 'user', 'active',
      ${input.expiresAt}, ${input.note}, ${input.actor.id}, ${input.actor.id}, ${now}, ${now}
    ) ON CONFLICT (bridge, external_user_id) DO UPDATE SET
      state = 'active', expires_at = EXCLUDED.expires_at, note = EXCLUDED.note,
      updated_by = ${input.actor.id}, updated_at = ${now}
    RETURNING id, bridge, external_user_id, role, state, expires_at, note
  `;
  await insertAudit(tx, ids.next(), now, {
    actorPrincipalId: input.actor.id,
    actorBridge: "telegram",
    actorExternalId: input.actor.externalUserId,
    action: "principal.allow",
    targetId: principalId,
    correlationId: input.correlationId,
    changes: {
      state: "active",
      note: input.note,
      expiresAt: input.expiresAt?.toISOString() ?? null,
    },
  });
  return mapPrincipal(rows[0]);
}

async function resolveAccessRequestRows(
  tx: Transaction,
  ids: IdGenerator,
  now: Date,
  targetExternalUserId: string,
  decision: "approved" | "denied",
  actorPrincipalId: string,
  decisionNote: string | null,
  completedPromptId?: string,
): Promise<void> {
  const requests = await tx<{ id: string; notification_revision: number }[]>`
    UPDATE access_requests SET state = ${decision}, notification_pending = false,
      notification_revision = notification_revision +
        CASE WHEN state <> 'pending' AND state <> ${decision} THEN 1 ELSE 0 END,
      decision_note = ${decisionNote}, resolved_at = ${now}, resolved_by = ${actorPrincipalId}
    WHERE bridge = 'telegram' AND external_user_id = ${targetExternalUserId}
      AND (state = 'pending' OR state <> ${decision})
    RETURNING id, notification_revision
  `;
  for (const request of requests) {
    await tx`
      UPDATE access_request_notifications SET state = 'skipped', lease_owner = NULL,
        lease_expires_at = NULL, last_error_code = 'resolved', updated_at = ${now}
      WHERE access_request_id = ${request.id} AND request_revision = ${request.notification_revision}
        AND state IN ('pending', 'leased')
    `;
    await tx`
      UPDATE access_decision_prompts SET state = CASE WHEN id = ${completedPromptId ?? null}
          THEN 'completed' ELSE 'cancelled' END, completed_at = ${now},
        updated_at = ${now}
      WHERE access_request_id = ${request.id} AND request_revision = ${request.notification_revision}
        AND state = 'pending'
    `;
    await tx`
      INSERT INTO access_decision_notifications (
        id, access_request_id, request_revision, decision, state, attempts,
        available_at, created_at, updated_at
      ) VALUES (
        ${ids.next()}, ${request.id}, ${request.notification_revision}, ${decision}, 'pending', 0,
        ${now}, ${now}, ${now}
      ) ON CONFLICT (access_request_id, request_revision) DO NOTHING
    `;
  }
}

async function requireAdmin(
  tx: Transaction,
  externalUserId: string,
  now: Date,
): Promise<PrincipalRecord> {
  const rows = await tx<PrincipalRow[]>`
    SELECT id, bridge, external_user_id, role, state, expires_at, note
    FROM principals WHERE bridge = 'telegram' AND external_user_id = ${externalUserId}
      AND role = 'admin' AND state = 'active' AND (expires_at IS NULL OR expires_at > ${now})
  `;
  if (!rows[0]) throw new DomainError("unauthorized", "Administrator access is required");
  return mapPrincipal(rows[0]);
}

function asJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function mapAccessRequest(
  row: {
    id: string;
    external_user_id: string;
    state: "pending" | "approved" | "denied";
    request_count: number;
    notification_pending: boolean;
    first_requested_at: Date;
    last_requested_at: Date;
    resolved_at: Date | null;
  } | undefined,
): AccessRequestRecord {
  if (!row) throw new Error("Expected access request row");
  return {
    id: row.id,
    externalUserId: row.external_user_id,
    state: row.state,
    requestCount: row.request_count,
    notificationPending: row.notification_pending,
    firstRequestedAt: row.first_requested_at,
    lastRequestedAt: row.last_requested_at,
    resolvedAt: row.resolved_at,
  };
}

function mapAccessDecisionPrompt(
  row: {
    id: string;
    access_request_id: string;
    requester_external_user_id: string;
    action: "allow" | "deny";
    prompt_message_id: number | null;
    expires_at: Date;
  } | undefined,
): AccessDecisionPromptRecord {
  if (!row) throw new Error("Expected access decision prompt row");
  return {
    id: row.id,
    accessRequestId: row.access_request_id,
    requesterExternalUserId: row.requester_external_user_id,
    action: row.action,
    promptMessageId: row.prompt_message_id,
    expiresAt: row.expires_at,
  };
}
