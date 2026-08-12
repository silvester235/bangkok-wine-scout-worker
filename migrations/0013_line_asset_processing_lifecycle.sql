ALTER TABLE line_image_batch_assets ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'
  CHECK (status IN ('pending', 'processing', 'completed', 'failed'));
ALTER TABLE line_image_batch_assets ADD COLUMN error TEXT;
ALTER TABLE line_image_batch_assets ADD COLUMN processing_started_at TEXT;
ALTER TABLE line_image_batch_assets ADD COLUMN processed_at TEXT;

-- Existing rows were fully stored before registration under the old architecture.
UPDATE line_image_batch_assets
SET status = 'completed', processed_at = received_at
WHERE status = 'completed' AND processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_line_batch_assets_terminal
  ON line_image_batch_assets(batch_id, status);
