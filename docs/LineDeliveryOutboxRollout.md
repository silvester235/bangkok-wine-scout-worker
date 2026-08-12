# LINE delivery outbox rollout

This document is a production plan only. None of the commands or recovery actions below are run as part of implementing migration 0017.

## Read-only preflight queries

Incomplete receipts:

```sql
SELECT webhook_event_id, message_id, message_type, batch_id,
       delivery_stage, processing_outcome, processing_claimed_at,
       last_progress_at, reconciliation_reason, created_at, updated_at
FROM line_webhook_delivery_receipts
WHERE delivery_stage IN (
  'registered', 'dispatch_pending', 'processing',
  'retryable_failed', 'needs_reconciliation'
)
ORDER BY COALESCE(last_progress_at, updated_at), created_at;
```

Receipts whose durable records imply a missing image intent:

```sql
SELECT r.webhook_event_id AS receipt_id,
       a.batch_id,
       a.asset_id,
       a.line_message_id,
       a.status AS asset_status,
       a.processing_attempt_count,
       b.status AS batch_status,
       b.minimal_event_id
FROM line_webhook_delivery_receipts r
JOIN line_image_batch_assets a
  ON a.line_message_id = r.message_id
  OR a.webhook_event_id = r.webhook_event_id
JOIN line_image_batches b ON b.id = a.batch_id
LEFT JOIN line_delivery_outbox o
  ON o.idempotency_key = r.webhook_event_id || ':process-image'
WHERE r.message_type = 'image'
  AND o.id IS NULL
ORDER BY r.created_at;
```

Missing or nonterminal mandatory intents:

```sql
SELECT r.webhook_event_id AS receipt_id,
       r.batch_id,
       r.delivery_stage,
       SUM(CASE WHEN o.operation_type = 'enqueue_process_image' THEN 1 ELSE 0 END) AS image_intents,
       SUM(CASE WHEN o.operation_type = 'enqueue_process_batch' THEN 1 ELSE 0 END) AS batch_intents,
       SUM(CASE WHEN o.status IN ('pending', 'leased', 'retryable') THEN 1 ELSE 0 END) AS dispatchable_intents,
       SUM(CASE WHEN o.status = 'exhausted' THEN 1 ELSE 0 END) AS exhausted_intents
FROM line_webhook_delivery_receipts r
LEFT JOIN line_delivery_outbox o ON o.receipt_id = r.webhook_event_id
WHERE r.delivery_stage NOT IN ('completed', 'ignored', 'permanently_failed')
GROUP BY r.webhook_event_id, r.batch_id, r.delivery_stage
ORDER BY r.created_at;
```

All queries are content-free: they do not select LINE text, OCR output, reply tokens, credentials, or R2 data.

## Controlled migration and deployment sequence

1. Record the current Worker version, deployment, queue backlog, error rate, and the results of the read-only preflight queries.
2. Back up D1 using the established production backup procedure.
3. Apply additive migration `0017_line_delivery_outbox.sql`. Do not modify migrations 0015 or 0016.
4. Verify the new columns, table, constraints, and indexes using schema-only/read-only queries.
5. Deploy the Worker version containing the outbox code and the two-minute Cron Trigger. Do not manually enqueue recovery jobs yet.
6. Confirm `/health`, the public list/detail APIs, and an existing flyer asset.
7. Observe `reconciliation_scan_started`, `outbox_claimed`, `outbox_enqueued`, `handoff_completed`, Queue errors, and 5xx responses for at least two cron intervals.
8. Let the bounded reconciler create missing intents for generic, uniquely resolvable records. Review ambiguous or exhausted records before any operator action.
9. Compare receipt, batch, asset, event, event-asset, and R2 cardinality before declaring recovery complete.

## Existing stranded-record recovery

The scheduled reconciler scans at most 25 incomplete receipts per invocation. For an image receipt it resolves the asset by the existing unique LINE message/webhook identity, repairs `receipt.batch_id`, and creates stable image, batch-timeout, and acknowledgement intents with `INSERT OR IGNORE`. It does not create an event. The normal image consumer downloads the original while LINE still permits it, preserves it in R2, and claims the batch-owned shell.

If the content can no longer be downloaded, normal Queue retries are finite. Exhaustion marks the originating outbox intent and receipt `needs_reconciliation` with the download error; the existing asset remains present and no event identity is invented. Acknowledgements without a live reply token become `expired`/`unavailable` and do not block ingestion.

For ordinary text, the reconciler resolves the already-persisted text row. For a `/done` interruption after the batch claim, it attaches only when exactly one processing batch in the narrow time window has the same hashed conversation identity. Zero or multiple candidates are not guessed.

## Rollback

1. Stop rollout progression and record the failing version and diagnostics.
2. Shift Worker traffic to the previously recorded version using Cloudflare version traffic controls.
3. Leave migration 0017 and its data in place. It is additive and older Workers ignore it; do not drop the outbox table or receipt columns.
4. If the new Cron Trigger is part of the deployment rollback, verify its removal after propagation. Do not purge or pause the Queue as an automatic rollback step.
5. Re-run read-only receipt/outbox queries. Pending intents remain durable for a corrected deployment.

## Monitoring and acceptance

- Alert on `outbox_retry_exhausted`, `reconciliation_item_failed`, `outbox_enqueue_uncertain`, `continuation_enqueue_failed`, unexpected `reconciliation_required`, Queue consumer errors, and Worker 5xx responses.
- Track the oldest `pending`, `retryable`, and expired `leased` intent and receipts with no progress for more than two cron intervals.
- Verify that attempts never exceed six and that acknowledgement ownership never exceeds one claim per receipt.
- For recovered images, verify one receipt, one asset placeholder, one original R2 object, one batch-owned event shell, and no duplicate event-assets link.
- Keep the bounded pending-asset continuation limit from migration 0016 independently monitored; the outbox does not reset continuation counters or terminal batches.
