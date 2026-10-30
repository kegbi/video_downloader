ALTER TABLE outbox DROP CONSTRAINT outbox_event_type_aggregate_id_key;
ALTER TABLE outbox ADD COLUMN deduplication_key text;
UPDATE outbox SET deduplication_key = event_type || ':' || aggregate_id::text || ':initial';
ALTER TABLE outbox ALTER COLUMN deduplication_key SET NOT NULL;
ALTER TABLE outbox ADD CONSTRAINT outbox_deduplication_key_unique UNIQUE (deduplication_key);
