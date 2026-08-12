-- Live operational overrides read by running Workflow instances. An absent row
-- falls back to the versioned Worker environment variable.
CREATE TABLE IF NOT EXISTS runtime_controls (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_runtime_controls_updated
  ON runtime_controls(updated_at);
