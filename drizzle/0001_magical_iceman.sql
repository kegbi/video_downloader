CREATE TEMP TABLE artifact_dedupe ON COMMIT DROP AS
SELECT id AS duplicate_id, first_value(id) OVER (
  PARTITION BY sha256, byte_size ORDER BY ready_at NULLS LAST, id
) AS canonical_id
FROM artifacts
WHERE state = 'ready' AND sha256 IS NOT NULL AND byte_size IS NOT NULL;

DELETE FROM artifact_dedupe WHERE duplicate_id = canonical_id;

UPDATE jobs j SET artifact_id = d.canonical_id, updated_at = now()
FROM artifact_dedupe d WHERE j.artifact_id = d.duplicate_id;

UPDATE deliveries delivery SET artifact_id = d.canonical_id, updated_at = now()
FROM artifact_dedupe d WHERE delivery.artifact_id = d.duplicate_id;

UPDATE artifacts artifact SET state = 'delete_failed', expires_at = now(),
  last_delete_error = 'deduplicated by migration', updated_at = now()
FROM artifact_dedupe d WHERE artifact.id = d.duplicate_id;

CREATE UNIQUE INDEX "artifacts_ready_content_key" ON "artifacts" USING btree ("sha256","byte_size") WHERE "artifacts"."state" = 'ready';
