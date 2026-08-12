-- Resumable LINE delivery stages. Keep processing_outcome for compatibility with
-- the Worker versions that predate the durable handoff/outbox workflow.
ALTER TABLE line_webhook_delivery_receipts ADD COLUMN delivery_stage TEXT NOT NULL DEFAULT 'registered'
  CHECK (delivery_stage IN (
    'registered', 'dispatch_pending', 'dispatched', 'processing', 'completed',
    'retryable_failed', 'needs_reconciliation', 'permanently_failed', 'ignored'
  ));
ALTER TABLE line_webhook_delivery_receipts ADD COLUMN registration_completed_at TEXT;
ALTER TABLE line_webhook_delivery_receipts ADD COLUMN dispatch_pending_at TEXT;
ALTER TABLE line_webhook_delivery_receipts ADD COLUMN dispatched_at TEXT;
ALTER TABLE line_webhook_delivery_receipts ADD COLUMN handoff_completed_at TEXT;
ALTER TABLE line_webhook_delivery_receipts ADD COLUMN acknowledgement_outcome TEXT
  CHECK (acknowledgement_outcome IS NULL OR acknowledgement_outcome IN (
    'pending', 'claimed', 'sent', 'uncertain', 'expired', 'unavailable', 'suppressed'
  ));
ALTER TABLE line_webhook_delivery_receipts ADD COLUMN acknowledgement_updated_at TEXT;
ALTER TABLE line_webhook_delivery_receipts ADD COLUMN last_progress_at TEXT;
ALTER TABLE line_webhook_delivery_receipts ADD COLUMN reconciliation_reason TEXT;

UPDATE line_webhook_delivery_receipts
SET delivery_stage = CASE processing_outcome
      WHEN 'completed' THEN 'completed'
      WHEN 'ignored' THEN 'ignored'
      WHEN 'retryable_failed' THEN 'retryable_failed'
      WHEN 'registered' THEN 'dispatch_pending'
      ELSE 'registered'
    END,
    registration_completed_at = CASE
      WHEN batch_id IS NOT NULL OR processing_outcome IN ('registered', 'completed') THEN updated_at
      ELSE NULL
    END,
    dispatch_pending_at = CASE
      WHEN processing_outcome = 'registered' THEN updated_at
      ELSE NULL
    END,
    handoff_completed_at = CASE
      WHEN processing_outcome = 'completed' THEN updated_at
      ELSE NULL
    END,
    acknowledgement_outcome = CASE
      WHEN acknowledgement_claimed_at IS NOT NULL THEN 'uncertain'
      ELSE NULL
    END,
    acknowledgement_updated_at = acknowledgement_claimed_at,
    last_progress_at = updated_at;

CREATE TABLE IF NOT EXISTS line_delivery_outbox (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  batch_id TEXT,
  asset_id TEXT,
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'enqueue_process_image', 'enqueue_process_batch',
    'send_image_acknowledgement', 'send_text_acknowledgement',
    'reconciliation_check'
  )),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'leased', 'retryable', 'enqueued', 'completed',
    'uncertain', 'unavailable', 'exhausted'
  )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  enqueued_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (receipt_id) REFERENCES line_webhook_delivery_receipts(webhook_event_id),
  FOREIGN KEY (batch_id) REFERENCES line_image_batches(id)
);

CREATE INDEX IF NOT EXISTS idx_line_delivery_outbox_dispatch
  ON line_delivery_outbox(status, available_at, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_line_delivery_outbox_receipt
  ON line_delivery_outbox(receipt_id, operation_type, status);
CREATE INDEX IF NOT EXISTS idx_line_delivery_outbox_batch
  ON line_delivery_outbox(batch_id, operation_type, status);
CREATE INDEX IF NOT EXISTS idx_line_receipts_reconciliation
  ON line_webhook_delivery_receipts(delivery_stage, last_progress_at, updated_at);
