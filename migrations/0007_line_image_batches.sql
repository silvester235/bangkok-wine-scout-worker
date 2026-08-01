CREATE TABLE IF NOT EXISTS line_image_batches (
  id TEXT PRIMARY KEY,
  conversation_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('collecting', 'processing', 'completed', 'needs_review', 'failed')),
  first_received_at TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  processing_at TEXT,
  completed_at TEXT,
  push_target TEXT,
  resulting_event_ids_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  notification_sent_at TEXT
);

CREATE TABLE IF NOT EXISTS line_image_batch_assets (
  batch_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  intake_id TEXT NOT NULL,
  line_message_id TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'line_image',
  source_reference TEXT NOT NULL,
  content_type TEXT NOT NULL,
  r2_object_key TEXT NOT NULL,
  received_at TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (batch_id, asset_id),
  UNIQUE (asset_id),
  UNIQUE (line_message_id),
  FOREIGN KEY (batch_id) REFERENCES line_image_batches(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_line_batches_collecting_conversation
  ON line_image_batches(conversation_key) WHERE status = 'collecting';
CREATE INDEX IF NOT EXISTS idx_line_batches_status_last_received
  ON line_image_batches(status, last_received_at);
CREATE INDEX IF NOT EXISTS idx_line_batches_conversation
  ON line_image_batches(conversation_key, first_received_at);
CREATE INDEX IF NOT EXISTS idx_line_batch_assets_asset
  ON line_image_batch_assets(asset_id);
CREATE INDEX IF NOT EXISTS idx_line_batch_assets_message
  ON line_image_batch_assets(line_message_id);
