import type { JobState } from "../domain/state.ts";
import type { RetentionPolicy } from "../domain/retention.ts";
import { retentionPolicySchema } from "../domain/retention.ts";

export interface PrincipalRecord {
  readonly id: string;
  readonly bridge: "telegram";
  readonly externalUserId: string;
  readonly role: "admin" | "user";
  readonly state: "active" | "disabled";
  readonly expiresAt: Date | null;
  readonly note: string | null;
}

export interface PageResult<Value> {
  readonly items: readonly Value[];
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

export interface JobListRecord {
  readonly id: string;
  readonly displayId: string;
  readonly state: JobState;
  readonly attempts: number;
  readonly requesterExternalUserId: string | null;
  readonly errorCode: string | null;
  readonly safeErrorMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AuditEventRecord {
  readonly id: string;
  readonly actorExternalId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly result: "success" | "failure";
  readonly createdAt: Date;
}

export interface AccessRequestRecord {
  readonly id: string;
  readonly externalUserId: string;
  readonly state: "pending" | "approved" | "denied";
  readonly requestCount: number;
  readonly notificationPending: boolean;
  readonly firstRequestedAt: Date;
  readonly lastRequestedAt: Date;
  readonly resolvedAt: Date | null;
}

export interface AccessRequestResult {
  readonly request: AccessRequestRecord;
  readonly created: boolean;
}

export interface AccessRequestNotificationLease {
  readonly id: string;
  readonly accessRequestId: string;
  readonly adminExternalUserId: string;
  readonly requesterExternalUserId: string;
  readonly attempts: number;
}

export interface AccessDecisionPromptRecord {
  readonly id: string;
  readonly accessRequestId: string;
  readonly requesterExternalUserId: string;
  readonly action: "allow" | "deny";
  readonly promptMessageId: number | null;
  readonly expiresAt: Date;
}

export interface AccessDecisionResult {
  readonly accessRequestId: string;
  readonly requesterExternalUserId: string;
  readonly decision: "approved" | "denied";
}

export interface AccessDecisionNotificationLease {
  readonly id: string;
  readonly accessRequestId: string;
  readonly requesterExternalUserId: string;
  readonly decision: "approved" | "denied";
  readonly attempts: number;
}

export interface JobRecord {
  readonly id: string;
  readonly displayId: string;
  readonly requesterPrincipalId: string;
  readonly idempotencyKey: string;
  readonly submittedUrl: string;
  readonly normalizedUrl: string;
  readonly sourceId: string;
  readonly state: JobState;
  readonly progressPhase: string | null;
  readonly progressPercent: number | null;
  readonly attempts: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly cancellationRequestedAt: Date | null;
  readonly policy: RetentionPolicy;
  readonly artifactId: string | null;
  readonly errorCode: string | null;
  readonly safeErrorMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SubmissionInput {
  readonly bridge: "telegram";
  readonly idempotencyKey: string;
  readonly requesterExternalUserId: string;
  readonly submittedUrl: string;
  readonly normalizedUrl: string;
  readonly sourceId: string;
  readonly destination: Readonly<Record<string, unknown>>;
  readonly policy: RetentionPolicy;
  /** Whether retention was present in the client request. Omitted means an explicit caller policy. */
  readonly retentionOrigin?: "default" | "explicit";
  readonly maxQueuedJobs: number;
  readonly maxActiveJobsPerUser: number;
}

export interface SubmissionResult {
  readonly job: JobRecord;
  readonly created: boolean;
}

export interface OutboxRecord {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempts: number;
}

export interface ArtifactRecord {
  readonly id: string;
  readonly jobId: string;
  readonly objectKey: string;
  readonly temporaryObjectKey: string | null;
  readonly state: "uploading" | "ready" | "deleting" | "deleted" | "delete_failed";
  readonly byteSize: number | null;
  readonly sha256: string | null;
  readonly expiresAt: Date | null;
}

export interface ArtifactCompletionResult {
  readonly artifact: ArtifactRecord;
  readonly reused: boolean;
}

export interface DeliveryLeaseRecord {
  readonly id: string;
  readonly jobId: string;
  readonly displayId: string;
  readonly artifactId: string;
  readonly attempts: number;
  readonly destination: Readonly<Record<string, unknown>>;
  readonly operationContext: Readonly<Record<string, unknown>> | null;
  readonly artifactByteSize: number;
  readonly artifactContentType: string;
  readonly artifactVideoCodec: string | null;
  readonly artifactAudioCodec: string | null;
  readonly artifactReadyAt: Date;
}

export interface ArtifactCleanupRecord extends ArtifactRecord {
  readonly deleteAttempts: number;
}

export interface DeliveryProgressRecord {
  readonly jobId: string;
  readonly displayId: string;
  readonly state: JobState;
  readonly phase: string;
  readonly percent: number | null;
  readonly destination: Readonly<Record<string, unknown>>;
}

export type TerminalProgressState = "failed" | "cancelled" | "expired";

export interface TerminalProgressLeaseRecord {
  readonly deliveryId: string;
  readonly jobId: string;
  readonly displayId: string;
  readonly state: TerminalProgressState;
  readonly safeErrorMessage: string | null;
  readonly attempts: number;
  readonly destination: Readonly<Record<string, unknown>>;
}

export interface OperationalSnapshot {
  readonly queuedJobs: number;
  readonly oldestQueuedAgeSeconds: number;
  readonly activeWorkerLeases: number;
  readonly activeDeliveryLeases: number;
  readonly unpublishedOutbox: number;
  readonly oldestOutboxAgeSeconds: number;
  readonly readyArtifactBytes: number;
  readonly cleanupFailures: number;
  readonly expiredArtifactLagSeconds: number;
}

export interface RawPrincipalRow {
  id: string;
  bridge: "telegram";
  external_user_id: string;
  role: "admin" | "user";
  state: "active" | "disabled";
  expires_at: Date | null;
  note: string | null;
}

export interface RawJobRow {
  id: string;
  display_id: string;
  requester_principal_id: string;
  idempotency_key: string;
  submitted_url: string;
  normalized_url: string;
  source_id: string;
  state: JobState;
  progress_phase: string | null;
  progress_percent: number | null;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  cancellation_requested_at: Date | null;
  policy: unknown;
  artifact_id: string | null;
  error_code: string | null;
  safe_error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RawArtifactRow {
  id: string;
  job_id: string;
  object_key: string;
  temporary_object_key: string | null;
  state: ArtifactRecord["state"];
  byte_size: number | null;
  sha256: string | null;
  expires_at: Date | null;
  delete_attempts?: number;
}

export interface RawDeliveryLeaseRow {
  id: string;
  job_id: string;
  display_id: string;
  artifact_id: string;
  attempts: number;
  destination: Record<string, unknown>;
  operation_context: Record<string, unknown> | null;
  byte_size: number;
  container: string | null;
  artifact_ready_at: Date;
  video_codec: string | null;
  audio_codec: string | null;
}

export function mapPrincipal(row: RawPrincipalRow | undefined): PrincipalRecord {
  if (!row) throw new Error("Expected principal row");
  return {
    id: row.id,
    bridge: row.bridge,
    externalUserId: row.external_user_id,
    role: row.role,
    state: row.state,
    expiresAt: row.expires_at,
    note: row.note,
  };
}

export function mapJob(row: RawJobRow | undefined): JobRecord {
  if (!row) throw new Error("Expected job row");
  return {
    id: row.id,
    displayId: row.display_id,
    requesterPrincipalId: row.requester_principal_id,
    idempotencyKey: row.idempotency_key,
    submittedUrl: row.submitted_url,
    normalizedUrl: row.normalized_url,
    sourceId: row.source_id,
    state: row.state,
    progressPhase: row.progress_phase,
    progressPercent: row.progress_percent,
    attempts: row.attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    cancellationRequestedAt: row.cancellation_requested_at,
    policy: retentionPolicySchema.parse(row.policy),
    artifactId: row.artifact_id,
    errorCode: row.error_code,
    safeErrorMessage: row.safe_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapArtifact(row: RawArtifactRow | undefined): ArtifactRecord {
  if (!row) throw new Error("Expected artifact row");
  return {
    id: row.id,
    jobId: row.job_id,
    objectKey: row.object_key,
    temporaryObjectKey: row.temporary_object_key,
    state: row.state,
    byteSize: row.byte_size,
    sha256: row.sha256,
    expiresAt: row.expires_at,
  };
}

export function mapDeliveryLease(row: RawDeliveryLeaseRow): DeliveryLeaseRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    displayId: row.display_id,
    artifactId: row.artifact_id,
    attempts: row.attempts,
    destination: row.destination,
    operationContext: row.operation_context,
    artifactByteSize: Number(row.byte_size),
    artifactContentType: row.container === "mp4" ? "video/mp4" : "application/octet-stream",
    artifactVideoCodec: row.video_codec,
    artifactAudioCodec: row.audio_codec,
    artifactReadyAt: row.artifact_ready_at,
  };
}
