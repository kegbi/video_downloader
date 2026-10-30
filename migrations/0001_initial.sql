CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE principals (
  id uuid PRIMARY KEY,
  bridge text NOT NULL CHECK (bridge = 'telegram'),
  external_user_id text NOT NULL CHECK (external_user_id ~ '^[0-9]+$'),
  role text NOT NULL CHECK (role IN ('admin', 'user')),
  state text NOT NULL CHECK (state IN ('active', 'disabled')),
  expires_at timestamptz,
  note text,
  created_by uuid REFERENCES principals(id),
  updated_by uuid REFERENCES principals(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (bridge, external_user_id)
);

CREATE INDEX principals_authorization_idx
  ON principals (bridge, external_user_id, state, expires_at);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  display_id varchar(16) NOT NULL UNIQUE,
  bridge text NOT NULL CHECK (bridge = 'telegram'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  requester_principal_id uuid NOT NULL REFERENCES principals(id),
  submitted_url text NOT NULL,
  normalized_url text NOT NULL,
  source_type text NOT NULL CHECK (source_type = 'x'),
  source_id text NOT NULL CHECK (source_id ~ '^[0-9]+$'),
  state text NOT NULL CHECK (state IN (
    'queued', 'downloading', 'processing', 'ready', 'delivering',
    'delivered', 'failed', 'cancelled', 'expired'
  )),
  progress_phase text,
  progress_percent smallint CHECK (progress_percent BETWEEN 0 AND 100),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  cancellation_requested_at timestamptz,
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  selected_format jsonb,
  media_metadata jsonb,
  artifact_id uuid,
  error_code text,
  safe_error_message text,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  ready_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  expired_at timestamptz,
  updated_at timestamptz NOT NULL,
  UNIQUE (bridge, idempotency_key)
);

CREATE INDEX jobs_state_lease_idx ON jobs (state, lease_expires_at);
CREATE INDEX jobs_requester_state_idx ON jobs (requester_principal_id, state, created_at DESC);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  temporary_object_key text,
  state text NOT NULL CHECK (state IN ('uploading', 'ready', 'deleting', 'deleted', 'delete_failed')),
  byte_size bigint CHECK (byte_size >= 0),
  sha256 varchar(64) CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  container text,
  video_codec text,
  audio_codec text,
  duration_seconds double precision CHECK (duration_seconds > 0),
  width integer CHECK (width > 0),
  height integer CHECK (height > 0),
  title text,
  expires_at timestamptz,
  delete_attempts integer NOT NULL DEFAULT 0 CHECK (delete_attempts >= 0),
  last_delete_error text,
  created_at timestamptz NOT NULL,
  ready_at timestamptz,
  deleting_at timestamptz,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL
);

ALTER TABLE jobs
  ADD CONSTRAINT jobs_artifact_fk FOREIGN KEY (artifact_id) REFERENCES artifacts(id);

CREATE INDEX artifacts_cleanup_idx ON artifacts (state, expires_at);

CREATE TABLE deliveries (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  artifact_id uuid REFERENCES artifacts(id),
  bridge text NOT NULL CHECK (bridge = 'telegram'),
  destination jsonb NOT NULL CHECK (jsonb_typeof(destination) = 'object'),
  state text NOT NULL CHECK (state IN ('pending', 'leased', 'delivering', 'delivered', 'retry_wait', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  next_attempt_at timestamptz,
  operation_context jsonb,
  result jsonb,
  last_error_code text,
  last_safe_error text,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL,
  UNIQUE (job_id, bridge)
);

CREATE INDEX deliveries_claim_idx ON deliveries (state, next_attempt_at, lease_expires_at);

CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL,
  locked_by text,
  locked_at timestamptz,
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL,
  UNIQUE (event_type, aggregate_id)
);

CREATE INDEX outbox_publish_idx ON outbox (published_at, available_at, created_at);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  actor_principal_id uuid REFERENCES principals(id),
  actor_bridge text,
  actor_external_id text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  result text NOT NULL CHECK (result IN ('success', 'failure')),
  correlation_id text NOT NULL,
  changes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(changes) = 'object'),
  created_at timestamptz NOT NULL
);

CREATE INDEX audit_events_target_idx ON audit_events (target_type, target_id, created_at DESC);
