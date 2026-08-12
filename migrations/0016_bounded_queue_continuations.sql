-- Durable bounds and reconciliation state for pending-asset continuations.
ALTER TABLE line_image_batches ADD COLUMN pending_asset_wait_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE line_image_batches ADD COLUMN first_pending_asset_wait_at TEXT;
ALTER TABLE line_image_batches ADD COLUMN last_pending_asset_wait_at TEXT;
ALTER TABLE line_image_batches ADD COLUMN pending_asset_wait_deadline_at TEXT;
ALTER TABLE line_image_batches ADD COLUMN continuation_state TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE line_image_batches ADD COLUMN continuation_claim_token TEXT;
ALTER TABLE line_image_batches ADD COLUMN continuation_enqueue_error TEXT;
ALTER TABLE line_image_batches ADD COLUMN reconciliation_required_at TEXT;

CREATE INDEX IF NOT EXISTS idx_line_batches_continuation_reconciliation
  ON line_image_batches(status, continuation_state, reconciliation_required_at);

CREATE INDEX IF NOT EXISTS idx_line_batches_pending_wait_deadline
  ON line_image_batches(status, pending_asset_wait_deadline_at)
  WHERE status = 'processing';
