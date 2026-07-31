CREATE TABLE IF NOT EXISTS line_text_contexts (
  message_id TEXT PRIMARY KEY,
  conversation_key TEXT NOT NULL,
  text_content TEXT NOT NULL,
  received_at TEXT NOT NULL,
  consumed_at TEXT,
  linked_image_asset_id TEXT UNIQUE,
  linked_event_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_line_text_context_lookup
  ON line_text_contexts(conversation_key, consumed_at, received_at DESC);

ALTER TABLE event_assets ADD COLUMN source_type TEXT NOT NULL DEFAULT 'line_image';
ALTER TABLE event_assets ADD COLUMN source_message_id TEXT;
ALTER TABLE event_assets ADD COLUMN text_content TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_assets_source_message_id
  ON event_assets(source_message_id)
  WHERE source_message_id IS NOT NULL;
