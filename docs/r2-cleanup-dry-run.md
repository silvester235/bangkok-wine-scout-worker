# R2 cleanup dry run

Admin-only orphan scan for `EVENT_INTAKES` R2 objects.

Endpoint:

`GET /admin/r2-cleanup?minAgeDays=14`

The endpoint is read-only. It does not delete R2 objects or D1 rows.

An intake asset is pre-protected when its `asset_id` is referenced by:

- `event_assets`
- an agent submission with status `collecting`, `queued`, `processing`, or `needs_review`
- a LINE image batch with status `collecting`, `processing`, or `needs_review`
- a non-terminal `line_delivery_outbox` row (`pending`, `leased`, `retryable`, `enqueued`, or `uncertain`)

Only unprotected intake asset prefixes whose newest R2 object is older than the cutoff are returned as candidates.

Each candidate then gets a second provenance/safety pass. The response includes:

- pipeline (`v1_line`, `v2_agent`, `text_or_web`, or `unknown`)
- canonical event references
- agent submission id/status/result event
- LINE batch id/status/resulting event ids
- active delivery-outbox statuses
- SHA-256 hash-index key and whether the index is owned by exactly this asset/intake
- `safeToDelete` plus explicit blocking `reasons`

A candidate is not safe to delete when any event reference remains, an agent submission is active/review/published or has a result event, a LINE batch is active/review or has resulting event ids, or delivery-outbox work is still active.

The top-level result additionally reports `safeToDeleteAssets`, `safeToDeleteObjects`, and `safeToDeleteBytes`. No delete operation is implemented.
