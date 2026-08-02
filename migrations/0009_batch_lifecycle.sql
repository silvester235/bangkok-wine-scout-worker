ALTER TABLE line_image_batches ADD COLUMN created_at TEXT;
ALTER TABLE line_image_batches ADD COLUMN last_activity_at TEXT;
ALTER TABLE line_image_batches ADD COLUMN expires_at TEXT;
ALTER TABLE line_image_batches ADD COLUMN closed_at TEXT;
ALTER TABLE line_image_batches ADD COLUMN updated_at TEXT;

UPDATE line_image_batches
SET created_at = first_received_at,
    last_activity_at = last_received_at,
    expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', last_received_at, '+60 seconds'),
    updated_at = COALESCE(
      strftime('%Y-%m-%dT%H:%M:%fZ', completed_at),
      strftime('%Y-%m-%dT%H:%M:%fZ', processing_at),
      last_received_at
    ),
    closed_at = CASE WHEN status <> 'collecting' THEN COALESCE(
      strftime('%Y-%m-%dT%H:%M:%fZ', processing_at),
      strftime('%Y-%m-%dT%H:%M:%fZ', completed_at),
      last_received_at
    ) END;

-- Keep the pre-0009 Worker safe during the short migration-to-deploy window.
-- Its INSERT does not name the lifecycle columns, so fill them synchronously.
CREATE TRIGGER IF NOT EXISTS trg_line_batches_backfill_lifecycle_after_insert
AFTER INSERT ON line_image_batches
WHEN NEW.created_at IS NULL
  OR NEW.last_activity_at IS NULL
  OR NEW.expires_at IS NULL
  OR NEW.updated_at IS NULL
BEGIN
  UPDATE line_image_batches
  SET created_at = COALESCE(NEW.created_at, NEW.first_received_at),
      last_activity_at = COALESCE(NEW.last_activity_at, NEW.last_received_at),
      expires_at = COALESCE(
        NEW.expires_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', NEW.last_received_at, '+60 seconds')
      ),
      updated_at = COALESCE(NEW.updated_at, NEW.last_received_at)
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_line_batches_backfill_lifecycle_after_activity
AFTER UPDATE OF last_received_at ON line_image_batches
WHEN NEW.status = 'collecting'
  AND NEW.last_received_at <> OLD.last_received_at
  AND NEW.last_activity_at IS OLD.last_activity_at
  AND NEW.expires_at IS OLD.expires_at
BEGIN
  UPDATE line_image_batches
  SET last_activity_at = NEW.last_received_at,
      expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.last_received_at, '+60 seconds'),
      updated_at = NEW.last_received_at
  WHERE id = NEW.id;
END;

ALTER TABLE line_image_batch_assets ADD COLUMN webhook_event_id TEXT;
UPDATE line_image_batch_assets SET webhook_event_id = line_message_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_line_batch_assets_webhook_event ON line_image_batch_assets(webhook_event_id);

ALTER TABLE line_message_batch_texts ADD COLUMN webhook_event_id TEXT;
UPDATE line_message_batch_texts SET webhook_event_id = message_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_line_batch_texts_webhook_event ON line_message_batch_texts(webhook_event_id);

CREATE INDEX IF NOT EXISTS idx_line_batches_active_expiry
  ON line_image_batches(conversation_key, status, expires_at);
