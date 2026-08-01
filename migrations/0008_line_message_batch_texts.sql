CREATE TABLE IF NOT EXISTS line_message_batch_texts (
  batch_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  text_content TEXT NOT NULL,
  received_at TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (batch_id, message_id),
  UNIQUE (message_id),
  UNIQUE (asset_id),
  FOREIGN KEY (batch_id) REFERENCES line_image_batches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_line_message_batch_texts_batch
  ON line_message_batch_texts(batch_id, ordinal, received_at);
