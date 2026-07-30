CREATE TABLE IF NOT EXISTS events (
	id TEXT PRIMARY KEY,
	intake_id TEXT NOT NULL,
	asset_id TEXT NOT NULL,
	title TEXT,
	event_date TEXT,
	start_time TEXT,
	price_thb INTEGER,
	venue TEXT,
	contact_email TEXT,
	contact_phone TEXT,
	wines_json TEXT NOT NULL DEFAULT '[]',
	is_wine_event INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_asset_id ON events(asset_id);
CREATE INDEX IF NOT EXISTS idx_events_event_date ON events(event_date);
