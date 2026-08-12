-- Durable, content-free idempotency receipts for every LINE webhook delivery.
CREATE TABLE IF NOT EXISTS line_webhook_delivery_receipts (
  webhook_event_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  conversation_id TEXT,
  batch_id TEXT,
  processing_outcome TEXT NOT NULL DEFAULT 'processing'
    CHECK (processing_outcome IN ('processing', 'registered', 'completed', 'ignored', 'retryable_failed')),
  processing_claimed_at TEXT NOT NULL,
  acknowledgement_claimed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_line_webhook_receipts_message
  ON line_webhook_delivery_receipts(message_type, message_id);
CREATE INDEX IF NOT EXISTS idx_line_webhook_receipts_batch
  ON line_webhook_delivery_receipts(batch_id, created_at);

-- A batch, rather than an individual image job, owns exactly one event shell.
ALTER TABLE line_image_batches ADD COLUMN minimal_event_id TEXT;
ALTER TABLE line_image_batches ADD COLUMN shell_anchor_asset_id TEXT;
ALTER TABLE line_image_batches ADD COLUMN shell_created_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_line_batches_minimal_event
  ON line_image_batches(minimal_event_id) WHERE minimal_event_id IS NOT NULL;

-- Persist asset-job retry state. Existing terminal assets start at attempt zero.
ALTER TABLE line_image_batch_assets ADD COLUMN processing_attempt_count INTEGER NOT NULL DEFAULT 0;
