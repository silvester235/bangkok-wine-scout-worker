CREATE TABLE IF NOT EXISTS line_url_ingestion_deliveries (
  webhook_event_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  batch_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('completed', 'unsupported', 'failed')),
  error_code TEXT,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_line_url_deliveries_batch
  ON line_url_ingestion_deliveries(batch_id, created_at);
