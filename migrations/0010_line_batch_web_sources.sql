CREATE TABLE IF NOT EXISTS line_message_batch_web_sources (
  batch_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  webhook_event_id TEXT NOT NULL UNIQUE,
  asset_id TEXT NOT NULL UNIQUE,
  requested_url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  final_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('completed', 'unsupported', 'failed')),
  http_status INTEGER,
  content_type TEXT,
  response_bytes INTEGER,
  redirect_count INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  description TEXT,
  canonical_url TEXT,
  main_image_url TEXT,
  json_ld_json TEXT NOT NULL DEFAULT '[]',
  extracted_text TEXT,
  error_code TEXT,
  error_message TEXT,
  fetched_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (batch_id, message_id),
  UNIQUE (batch_id, normalized_url),
  FOREIGN KEY (batch_id) REFERENCES line_image_batches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_line_batch_web_sources_batch
  ON line_message_batch_web_sources(batch_id, ordinal, received_at);
