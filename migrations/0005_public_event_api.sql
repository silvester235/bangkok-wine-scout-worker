ALTER TABLE events ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE events ADD COLUMN published_at TEXT;
ALTER TABLE events ADD COLUMN slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_slug
  ON events(slug)
  WHERE slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_public_date
  ON events(status, event_date, start_time, id)
  WHERE published_at IS NOT NULL;

ALTER TABLE event_assets ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1;
ALTER TABLE event_assets ADD COLUMN r2_object_key TEXT;
ALTER TABLE event_assets ADD COLUMN content_type TEXT;

CREATE INDEX IF NOT EXISTS idx_event_assets_public_order
  ON event_assets(event_id, is_public, asset_role, linked_at, asset_id);
