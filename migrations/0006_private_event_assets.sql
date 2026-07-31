PRAGMA defer_foreign_keys = ON;

CREATE TABLE event_assets_new (
  event_id TEXT NOT NULL,
  intake_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_role TEXT NOT NULL DEFAULT 'other',
  linked_at TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'line_image',
  source_message_id TEXT,
  text_content TEXT,
  is_public INTEGER NOT NULL DEFAULT 0,
  r2_object_key TEXT,
  content_type TEXT,
  PRIMARY KEY (event_id, asset_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

INSERT INTO event_assets_new (
  event_id,
  intake_id,
  asset_id,
  asset_role,
  linked_at,
  source_type,
  source_message_id,
  text_content,
  is_public,
  r2_object_key,
  content_type
)
SELECT
  event_id,
  intake_id,
  asset_id,
  asset_role,
  linked_at,
  source_type,
  source_message_id,
  text_content,
  is_public,
  r2_object_key,
  content_type
FROM event_assets;

DROP TABLE event_assets;
ALTER TABLE event_assets_new RENAME TO event_assets;

CREATE INDEX idx_event_assets_event_id
  ON event_assets(event_id);

CREATE UNIQUE INDEX idx_event_assets_asset_id
  ON event_assets(asset_id);

CREATE UNIQUE INDEX idx_event_assets_source_message_id
  ON event_assets(source_message_id)
  WHERE source_message_id IS NOT NULL;

CREATE INDEX idx_event_assets_public_order
  ON event_assets(event_id, is_public, asset_role, linked_at, asset_id);
