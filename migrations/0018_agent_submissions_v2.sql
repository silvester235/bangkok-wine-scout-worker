-- Isolated V2 mailbox, provenance, and workflow diagnostics.
CREATE TABLE IF NOT EXISTS agent_submissions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'line_v2',
  conversation_key TEXT NOT NULL,
  push_target TEXT,
  status TEXT NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting','queued','processing','needs_review','published','failed')),
  first_received_at TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  closed_at TEXT,
  workflow_instance_id TEXT UNIQUE,
  result_event_id TEXT,
  result_action TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_submissions_active_conversation
  ON agent_submissions(source, conversation_key) WHERE status = 'collecting';
CREATE INDEX IF NOT EXISTS idx_agent_submissions_status
  ON agent_submissions(status, last_received_at);

CREATE TABLE IF NOT EXISTS agent_submission_items (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  webhook_event_id TEXT,
  item_type TEXT NOT NULL CHECK (item_type IN ('image','text','url')),
  asset_id TEXT,
  intake_id TEXT,
  r2_object_key TEXT,
  content_type TEXT,
  text_content TEXT,
  source_url TEXT,
  ordinal INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES agent_submissions(id) ON DELETE CASCADE,
  UNIQUE (submission_id, ordinal),
  UNIQUE (source_message_id),
  UNIQUE (webhook_event_id),
  UNIQUE (asset_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_submission_items_submission
  ON agent_submission_items(submission_id, ordinal);

CREATE TABLE IF NOT EXISTS agent_v2_webhook_receipts (
  webhook_event_id TEXT PRIMARY KEY,
  source_message_id TEXT NOT NULL UNIQUE,
  submission_id TEXT,
  acknowledgement_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES agent_submissions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS agent_submission_diagnostics (
  submission_id TEXT PRIMARY KEY,
  ai_result_json TEXT,
  validation_diagnostics_json TEXT NOT NULL DEFAULT '[]',
  matching_diagnostics_json TEXT NOT NULL DEFAULT '{}',
  uncertainty_reasons_json TEXT NOT NULL DEFAULT '[]',
  url_diagnostics_json TEXT NOT NULL DEFAULT '[]',
  raw_ai_r2_key TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES agent_submissions(id) ON DELETE CASCADE
);
