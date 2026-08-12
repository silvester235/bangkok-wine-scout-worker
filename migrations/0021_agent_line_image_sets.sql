-- Durable LINE multi-image grouping and /done settlement metadata for V2.
ALTER TABLE agent_submissions ADD COLUMN image_set_id TEXT;
ALTER TABLE agent_submissions ADD COLUMN expected_image_count INTEGER;
ALTER TABLE agent_submissions ADD COLUMN grouping_strategy TEXT;
ALTER TABLE agent_submissions ADD COLUMN done_requested_at TEXT;
ALTER TABLE agent_submissions ADD COLUMN done_settle_until TEXT;
ALTER TABLE agent_submissions ADD COLUMN closure_reason TEXT;
ALTER TABLE agent_submissions ADD COLUMN append_race_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_submissions ADD COLUMN webhook_event_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_submissions ADD COLUMN image_event_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_agent_submissions_collecting_image_set
  ON agent_submissions(conversation_key, image_set_id) WHERE status = 'collecting';

ALTER TABLE agent_submission_items ADD COLUMN image_set_id TEXT;
ALTER TABLE agent_submission_items ADD COLUMN image_set_index INTEGER;
ALTER TABLE agent_submission_items ADD COLUMN image_set_total INTEGER;
ALTER TABLE agent_submission_items ADD COLUMN webhook_batch_id TEXT;
ALTER TABLE agent_submission_items ADD COLUMN append_race_resolved INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_agent_submission_items_image_set
  ON agent_submission_items(submission_id, image_set_id, image_set_index);
