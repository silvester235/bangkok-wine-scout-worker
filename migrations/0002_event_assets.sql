CREATE TABLE IF NOT EXISTS event_assets (
  event_id TEXT NOT NULL,
  intake_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_role TEXT NOT NULL DEFAULT 'other',
  linked_at TEXT NOT NULL,
  PRIMARY KEY (event_id, asset_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_assets_event_id
  ON event_assets(event_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_assets_asset_id
  ON event_assets(asset_id);
