ALTER TABLE events ADD COLUMN organizer TEXT;
ALTER TABLE events ADD COLUMN address TEXT;
ALTER TABLE events ADD COLUMN district TEXT;
ALTER TABLE events ADD COLUMN website_url TEXT;
ALTER TABLE events ADD COLUMN booking_url TEXT;
ALTER TABLE events ADD COLUMN booking_instructions TEXT;
ALTER TABLE events ADD COLUMN contact_text TEXT;
ALTER TABLE events ADD COLUMN description TEXT;
ALTER TABLE events ADD COLUMN course_count INTEGER;
ALTER TABLE events ADD COLUMN price_text TEXT;
ALTER TABLE events ADD COLUMN currency TEXT;
ALTER TABLE events ADD COLUMN price_qualifier TEXT;
ALTER TABLE events ADD COLUMN end_time TEXT;
ALTER TABLE events ADD COLUMN timezone TEXT;
ALTER TABLE events ADD COLUMN wine_producers_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE events ADD COLUMN partners_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE events ADD COLUMN merchants_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE events ADD COLUMN menu_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE events ADD COLUMN notes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE events ADD COLUMN source_contact_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE events ADD COLUMN updated_at TEXT;

CREATE TABLE IF NOT EXISTS event_enrichment_state (
  asset_id TEXT PRIMARY KEY,
  event_id TEXT,
  intake_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'complete', 'partial', 'failed', 'retryable', 'permanently_failed')),
  ocr_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (ocr_status IN ('pending', 'processing', 'complete', 'failed')),
  extraction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending', 'processing', 'complete', 'partial', 'failed')),
  qr_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (qr_status IN ('pending', 'processing', 'complete', 'not_available', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempted_at TEXT,
  next_retry_at TEXT,
  last_error_code TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_event_enrichment_retry
  ON event_enrichment_state(status, next_retry_at, attempt_count);
