export interface BridgeJob {
  readonly id: string;
  readonly displayId: string;
  readonly state: string;
  readonly artifactId: string | null;
  readonly error: { code: string; message: string } | null;
}

export interface DeliveryLease {
  readonly id: string;
  readonly jobId: string;
  readonly displayId: string;
  readonly artifactId: string;
  readonly attempts: number;
  readonly destination: {
    readonly chatId: string;
    readonly requestMessageId: number;
    readonly progressMessageId: number;
  };
  readonly operationContext: Readonly<Record<string, unknown>> | null;
  readonly artifactByteSize: number;
  readonly artifactContentType: string;
  readonly artifactVideoCodec?: string | null;
  readonly artifactAudioCodec?: string | null;
  readonly artifactReadyAt?: string;
}

export interface ArtifactStream {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentLength: number;
  readonly contentType: string;
}

export interface PrincipalView {
  readonly externalUserId: string;
  readonly role: "admin" | "user";
  readonly state: "active" | "disabled";
  readonly expiresAt: string | null;
  readonly note: string | null;
}

export interface PrincipalAccessView {
  readonly state: "active" | "disabled" | "unauthorized";
  readonly role: "admin" | "user" | null;
  readonly expiresAt: string | null;
}

export interface PaginationView {
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
}

export interface JobListView {
  readonly id: string;
  readonly displayId: string;
  readonly state: string;
  readonly attempts: number;
  readonly requesterExternalUserId: string | null;
  readonly error: { code: string; message: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuditEventView {
  readonly id: string;
  readonly actorExternalId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly result: "success" | "failure";
  readonly createdAt: string;
}

export interface AccessRequestView {
  readonly id: string;
  readonly externalUserId: string;
  readonly state: "pending" | "approved" | "denied";
  readonly requestCount: number;
  readonly notificationPending: boolean;
  readonly firstRequestedAt: string;
  readonly lastRequestedAt: string;
  readonly resolvedAt: string | null;
}

export interface AccessRequestNotificationLeaseView {
  readonly id: string;
  readonly accessRequestId: string;
  readonly adminExternalUserId: string;
  readonly requesterExternalUserId: string;
  readonly attempts: number;
}

export interface AccessDecisionPromptView {
  readonly id: string;
  readonly accessRequestId: string;
  readonly requesterExternalUserId: string;
  readonly action: "allow" | "deny";
  readonly promptMessageId: number | null;
  readonly expiresAt: string;
}

export interface AccessDecisionResultView {
  readonly accessRequestId: string;
  readonly requesterExternalUserId: string;
  readonly decision: "approved" | "denied";
}

export interface AccessDecisionNotificationLeaseView {
  readonly id: string;
  readonly accessRequestId: string;
  readonly requesterExternalUserId: string;
  readonly decision: "approved" | "denied";
  readonly attempts: number;
}

export interface DeliveryProgress {
  readonly jobId: string;
  readonly displayId: string;
  readonly state: "queued" | "downloading" | "processing";
  readonly phase: string;
  readonly percent: number | null;
  readonly destination: {
    readonly chatId: string;
    readonly requestMessageId: number;
    readonly progressMessageId: number;
  };
}

export interface TerminalProgressLease {
  readonly deliveryId: string;
  readonly jobId: string;
  readonly displayId: string;
  readonly state: "failed" | "cancelled" | "expired";
  readonly safeErrorMessage: string | null;
  readonly attempts: number;
  readonly destination: DeliveryProgress["destination"];
}

export interface Backend {
  submit(input: {
    idempotencyKey: string;
    requesterUserId: string;
    sourceUrl: string;
    chatId: string;
    requestMessageId: number;
  }): Promise<{ job: BridgeJob; created: boolean }>;
  setProgressMessage(jobId: string, requesterUserId: string, messageId: number): Promise<void>;
  getJob(id: string, requesterUserId: string): Promise<BridgeJob>;
  cancelJob(id: string, requesterUserId: string): Promise<BridgeJob>;
  retryJob(id: string, actorUserId: string): Promise<BridgeJob>;
  allowPrincipal(
    actorUserId: string,
    targetUserId: string,
    note: string | null,
    expiresAt: string | null,
  ): Promise<PrincipalView>;
  denyPrincipal(actorUserId: string, targetUserId: string, reason: string): Promise<PrincipalView>;
  getPrincipalAccess(userId: string): Promise<PrincipalAccessView>;
  listPrincipals(
    actorUserId: string,
    limit: number,
    offset: number,
  ): Promise<{ principals: readonly PrincipalView[]; page: PaginationView }>;
  listJobs(
    actorUserId: string,
    filter: "active" | "failed" | "recent",
    limit: number,
    offset: number,
  ): Promise<{ jobs: readonly JobListView[]; page: PaginationView }>;
  listAuditEvents(
    actorUserId: string,
    limit: number,
    offset: number,
  ): Promise<{ events: readonly AuditEventView[]; page: PaginationView }>;
  requestAccess(
    userId: string,
    requestKey: string,
  ): Promise<{ request: AccessRequestView; created: boolean }>;
  listAccessRequests(
    actorUserId: string,
    limit: number,
    offset: number,
  ): Promise<{ requests: readonly AccessRequestView[]; page: PaginationView }>;
  claimAccessRequestNotification(
    workerId: string,
    leaseSeconds: number,
  ): Promise<AccessRequestNotificationLeaseView | null>;
  completeAccessRequestNotification(id: string, workerId: string): Promise<boolean>;
  failAccessRequestNotification(input: {
    id: string;
    workerId: string;
    retryable: boolean;
    retryAfterSeconds: number;
    errorCode: "retryable" | "ambiguous" | "permanent" | "backend";
  }): Promise<boolean>;
  beginAccessDecisionPrompt(
    actorUserId: string,
    accessRequestId: string,
    action: "allow" | "deny",
    ttlSeconds: number,
  ): Promise<AccessDecisionPromptView>;
  attachAccessDecisionPromptMessage(
    actorUserId: string,
    promptId: string,
    promptMessageId: number,
  ): Promise<AccessDecisionPromptView>;
  getActiveAccessDecisionPrompt(actorUserId: string): Promise<AccessDecisionPromptView | null>;
  resolveAccessDecisionPrompt(
    actorUserId: string,
    promptId: string,
    note: string | null,
  ): Promise<AccessDecisionResultView>;
  cancelAccessDecisionPrompt(actorUserId: string, promptId: string): Promise<boolean>;
  claimAccessDecisionNotification(
    workerId: string,
    leaseSeconds: number,
  ): Promise<AccessDecisionNotificationLeaseView | null>;
  completeAccessDecisionNotification(id: string, workerId: string): Promise<boolean>;
  failAccessDecisionNotification(input: {
    id: string;
    workerId: string;
    retryable: boolean;
    retryAfterSeconds: number;
    errorCode: "retryable" | "ambiguous" | "permanent" | "backend";
  }): Promise<boolean>;
  listDeliveryProgress(): Promise<readonly DeliveryProgress[]>;
  claimTerminalProgress(
    workerId: string,
    leaseSeconds: number,
  ): Promise<TerminalProgressLease | null>;
  completeTerminalProgress(deliveryId: string, workerId: string): Promise<boolean>;
  failTerminalProgress(input: {
    deliveryId: string;
    workerId: string;
    retryable: boolean;
    retryAfterSeconds: number;
  }): Promise<boolean>;
  claimDelivery(
    workerId: string,
    leaseSeconds: number,
    signal?: AbortSignal,
  ): Promise<DeliveryLease | null>;
  heartbeatDelivery(
    id: string,
    workerId: string,
    leaseSeconds: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
  openArtifact(id: string, signal?: AbortSignal): Promise<ArtifactStream>;
  recordDeliveryOperation(
    id: string,
    workerId: string,
    context: Record<string, unknown>,
  ): Promise<void>;
  completeDelivery(id: string, workerId: string, result: Record<string, unknown>): Promise<void>;
  failDelivery(input: {
    id: string;
    workerId: string;
    retryable: boolean;
    safeMessage: string;
    retryAfterSeconds?: number;
  }): Promise<void>;
  healthy(): Promise<boolean>;
}

export class BackendError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly correlationId: string | null = null,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class HttpBackend implements Backend {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async submit(input: {
    idempotencyKey: string;
    requesterUserId: string;
    sourceUrl: string;
    chatId: string;
    requestMessageId: number;
  }): Promise<{ job: BridgeJob; created: boolean }> {
    return await this.json("/v1/jobs", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: input.idempotencyKey,
        requester: { bridge: "telegram", externalUserId: input.requesterUserId },
        sourceUrl: input.sourceUrl,
        destination: {
          chatId: input.chatId,
          requestMessageId: input.requestMessageId,
        },
      }),
    });
  }

  async setProgressMessage(
    jobId: string,
    requesterUserId: string,
    messageId: number,
  ): Promise<void> {
    await this.json(`/v1/jobs/${encodeURIComponent(jobId)}/delivery-context`, {
      method: "POST",
      body: JSON.stringify({ requesterUserId, progressMessageId: messageId }),
    });
  }

  getJob(id: string, requesterUserId: string): Promise<BridgeJob> {
    const query = new URLSearchParams({ requesterUserId });
    return this.json(`/v1/jobs/${encodeURIComponent(id)}?${query}`);
  }

  cancelJob(id: string, requesterUserId: string): Promise<BridgeJob> {
    return this.json(`/v1/jobs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ requesterUserId }),
    });
  }

  retryJob(id: string, actorUserId: string): Promise<BridgeJob> {
    return this.json(`/v1/jobs/${encodeURIComponent(id)}/retry`, {
      method: "POST",
      body: JSON.stringify({ actorUserId }),
    });
  }

  allowPrincipal(
    actorUserId: string,
    targetUserId: string,
    note: string | null,
    expiresAt: string | null,
  ): Promise<PrincipalView> {
    return this.json(`/v1/principals/telegram/${encodeURIComponent(targetUserId)}`, {
      method: "PUT",
      body: JSON.stringify({ actorUserId, note, expiresAt }),
    });
  }

  denyPrincipal(actorUserId: string, targetUserId: string, reason: string): Promise<PrincipalView> {
    return this.json(`/v1/principals/telegram/${encodeURIComponent(targetUserId)}`, {
      method: "DELETE",
      body: JSON.stringify({ actorUserId, reason }),
    });
  }

  getPrincipalAccess(userId: string): Promise<PrincipalAccessView> {
    return this.json(`/v1/principals/telegram/${encodeURIComponent(userId)}/access`);
  }

  listPrincipals(
    actorUserId: string,
    limit: number,
    offset: number,
  ): Promise<{ principals: readonly PrincipalView[]; page: PaginationView }> {
    const query = pageQuery(actorUserId, limit, offset);
    return this.json(`/v1/principals?${query}`);
  }

  listJobs(
    actorUserId: string,
    filter: "active" | "failed" | "recent",
    limit: number,
    offset: number,
  ): Promise<{ jobs: readonly JobListView[]; page: PaginationView }> {
    const query = pageQuery(actorUserId, limit, offset);
    query.set("filter", filter);
    return this.json(`/v1/jobs?${query}`);
  }

  listAuditEvents(
    actorUserId: string,
    limit: number,
    offset: number,
  ): Promise<{ events: readonly AuditEventView[]; page: PaginationView }> {
    const query = pageQuery(actorUserId, limit, offset);
    return this.json(`/v1/audit-events?${query}`);
  }

  requestAccess(
    userId: string,
    requestKey: string,
  ): Promise<{ request: AccessRequestView; created: boolean }> {
    return this.json(`/v1/access-requests/telegram/${encodeURIComponent(userId)}`, {
      method: "POST",
      body: JSON.stringify({ requestKey }),
    });
  }

  listAccessRequests(
    actorUserId: string,
    limit: number,
    offset: number,
  ): Promise<{ requests: readonly AccessRequestView[]; page: PaginationView }> {
    const query = pageQuery(actorUserId, limit, offset);
    return this.json(`/v1/access-requests?${query}`);
  }

  async claimAccessRequestNotification(
    workerId: string,
    leaseSeconds: number,
  ): Promise<AccessRequestNotificationLeaseView | null> {
    const result = await this.json<{ notification: AccessRequestNotificationLeaseView | null }>(
      "/v1/access-request-notifications/claim",
      { method: "POST", body: JSON.stringify({ workerId, leaseSeconds }) },
    );
    return result.notification;
  }

  async completeAccessRequestNotification(id: string, workerId: string): Promise<boolean> {
    const result = await this.json<{ completed: boolean }>(
      `/v1/access-request-notifications/${encodeURIComponent(id)}/complete`,
      { method: "POST", body: JSON.stringify({ workerId }) },
    );
    return result.completed;
  }

  async failAccessRequestNotification(input: {
    id: string;
    workerId: string;
    retryable: boolean;
    retryAfterSeconds: number;
    errorCode: "retryable" | "ambiguous" | "permanent" | "backend";
  }): Promise<boolean> {
    const result = await this.json<{ recorded: boolean }>(
      `/v1/access-request-notifications/${encodeURIComponent(input.id)}/fail`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return result.recorded;
  }

  beginAccessDecisionPrompt(
    actorUserId: string,
    accessRequestId: string,
    action: "allow" | "deny",
    ttlSeconds: number,
  ): Promise<AccessDecisionPromptView> {
    return this.json(
      `/v1/access-requests/${encodeURIComponent(accessRequestId)}/decision-prompts`,
      { method: "POST", body: JSON.stringify({ actorUserId, action, ttlSeconds }) },
    );
  }

  attachAccessDecisionPromptMessage(
    actorUserId: string,
    promptId: string,
    promptMessageId: number,
  ): Promise<AccessDecisionPromptView> {
    return this.json(`/v1/access-decision-prompts/${encodeURIComponent(promptId)}/message`, {
      method: "POST",
      body: JSON.stringify({ actorUserId, promptMessageId }),
    });
  }

  async getActiveAccessDecisionPrompt(
    actorUserId: string,
  ): Promise<AccessDecisionPromptView | null> {
    const query = new URLSearchParams({ actorUserId });
    const result = await this.json<{ prompt: AccessDecisionPromptView | null }>(
      `/v1/access-decision-prompts/active?${query}`,
    );
    return result.prompt;
  }

  resolveAccessDecisionPrompt(
    actorUserId: string,
    promptId: string,
    note: string | null,
  ): Promise<AccessDecisionResultView> {
    return this.json(`/v1/access-decision-prompts/${encodeURIComponent(promptId)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ actorUserId, note }),
    });
  }

  async cancelAccessDecisionPrompt(actorUserId: string, promptId: string): Promise<boolean> {
    const result = await this.json<{ cancelled: boolean }>(
      `/v1/access-decision-prompts/${encodeURIComponent(promptId)}/cancel`,
      { method: "POST", body: JSON.stringify({ actorUserId }) },
    );
    return result.cancelled;
  }

  async claimAccessDecisionNotification(
    workerId: string,
    leaseSeconds: number,
  ): Promise<AccessDecisionNotificationLeaseView | null> {
    const result = await this.json<{ notification: AccessDecisionNotificationLeaseView | null }>(
      "/v1/access-decision-notifications/claim",
      { method: "POST", body: JSON.stringify({ workerId, leaseSeconds }) },
    );
    return result.notification;
  }

  async completeAccessDecisionNotification(id: string, workerId: string): Promise<boolean> {
    const result = await this.json<{ completed: boolean }>(
      `/v1/access-decision-notifications/${encodeURIComponent(id)}/complete`,
      { method: "POST", body: JSON.stringify({ workerId }) },
    );
    return result.completed;
  }

  async failAccessDecisionNotification(input: {
    id: string;
    workerId: string;
    retryable: boolean;
    retryAfterSeconds: number;
    errorCode: "retryable" | "ambiguous" | "permanent" | "backend";
  }): Promise<boolean> {
    const result = await this.json<{ recorded: boolean }>(
      `/v1/access-decision-notifications/${encodeURIComponent(input.id)}/fail`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return result.recorded;
  }

  async listDeliveryProgress(): Promise<readonly DeliveryProgress[]> {
    const result = await this.json<{ progress: DeliveryProgress[] }>("/v1/deliveries/progress");
    return result.progress;
  }

  async claimTerminalProgress(
    workerId: string,
    leaseSeconds: number,
  ): Promise<TerminalProgressLease | null> {
    const result = await this.json<{ progress: TerminalProgressLease | null }>(
      "/v1/deliveries/progress/claim",
      { method: "POST", body: JSON.stringify({ workerId, leaseSeconds }) },
    );
    return result.progress;
  }

  async completeTerminalProgress(deliveryId: string, workerId: string): Promise<boolean> {
    const result = await this.json<{ completed: boolean }>(
      `/v1/deliveries/progress/${encodeURIComponent(deliveryId)}/complete`,
      { method: "POST", body: JSON.stringify({ workerId }) },
    );
    return result.completed;
  }

  async failTerminalProgress(input: {
    deliveryId: string;
    workerId: string;
    retryable: boolean;
    retryAfterSeconds: number;
  }): Promise<boolean> {
    const result = await this.json<{ recorded: boolean }>(
      `/v1/deliveries/progress/${encodeURIComponent(input.deliveryId)}/fail`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return result.recorded;
  }

  async claimDelivery(
    workerId: string,
    leaseSeconds: number,
    signal?: AbortSignal,
  ): Promise<DeliveryLease | null> {
    const result = await this.json<{ delivery: DeliveryLease | null }>("/v1/deliveries/claim", {
      method: "POST",
      body: JSON.stringify({ workerId, leaseSeconds }),
      signal,
    });
    return result.delivery;
  }

  async heartbeatDelivery(
    id: string,
    workerId: string,
    leaseSeconds: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await this.json<{ extended: boolean }>(
      `/v1/deliveries/${encodeURIComponent(id)}/heartbeat`,
      {
        method: "POST",
        body: JSON.stringify({ workerId, leaseSeconds }),
        signal,
      },
    );
    return result.extended;
  }

  async openArtifact(id: string, signal?: AbortSignal): Promise<ArtifactStream> {
    const response = await this.request(`/v1/artifacts/${encodeURIComponent(id)}/content`, {
      signal,
    });
    if (!response.ok || !response.body) await throwBackendError(response);
    return {
      body: response.body!,
      contentLength: Number(response.headers.get("content-length") ?? 0),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async completeDelivery(
    id: string,
    workerId: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    await this.json(`/v1/deliveries/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      body: JSON.stringify({ workerId, result }),
    });
  }

  async recordDeliveryOperation(
    id: string,
    workerId: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    await this.json(`/v1/deliveries/${encodeURIComponent(id)}/operation`, {
      method: "POST",
      body: JSON.stringify({ workerId, context }),
    });
  }

  async failDelivery(input: {
    id: string;
    workerId: string;
    retryable: boolean;
    safeMessage: string;
    retryAfterSeconds?: number;
  }): Promise<void> {
    await this.json(`/v1/deliveries/${encodeURIComponent(input.id)}/fail`, {
      method: "POST",
      body: JSON.stringify({
        workerId: input.workerId,
        errorCode: input.retryable ? "delivery_retryable" : "delivery_permanent",
        safeMessage: input.safeMessage,
        retryAfterSeconds: input.retryAfterSeconds,
      }),
    });
  }

  async healthy(): Promise<boolean> {
    try {
      return (await this.fetcher(new URL("/health/ready", this.baseUrl))).ok;
    } catch {
      return false;
    }
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) await throwBackendError(response);
    return await response.json() as T;
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (init.body) headers.set("content-type", "application/json");
    headers.set("x-correlation-id", crypto.randomUUID());
    return this.fetcher(new URL(path, this.baseUrl), { ...init, headers });
  }
}

async function throwBackendError(response: Response): Promise<never> {
  try {
    const value = await response.json() as {
      error?: { code?: string; message?: string; retryable?: boolean; correlationId?: string };
    };
    throw new BackendError(
      value.error?.code ?? "internal_error",
      value.error?.message ?? "The backend request failed",
      value.error?.retryable ?? response.status >= 500,
      safeCorrelationId(value.error?.correlationId),
    );
  } catch (error) {
    if (error instanceof BackendError) throw error;
    throw new BackendError("internal_error", "The backend request failed", response.status >= 500);
  }
}

function safeCorrelationId(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9._:-]{1,100}$/.test(value) ? value : null;
}

function pageQuery(actorUserId: string, limit: number, offset: number): URLSearchParams {
  return new URLSearchParams({
    actorUserId,
    limit: String(limit),
    offset: String(offset),
  });
}
