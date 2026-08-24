# R2 cleanup

Admin-only orphan scan and guarded deletion for `EVENT_INTAKES` R2 objects.

## Dry run

`GET /admin/r2-cleanup?minAgeDays=14`

The GET endpoint is read-only. It does not delete R2 objects or D1 rows.

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

The top-level result additionally reports `safeToDeleteAssets`, `safeToDeleteObjects`, and `safeToDeleteBytes`.

## Guarded deletion

`POST /admin/r2-cleanup`

Deletion requires normal admin authentication and the exact confirmation phrase `DELETE_SAFE_ORPHANS`.

Delete all currently safe orphan candidates older than the cutoff:

```json
{
  "confirm": "DELETE_SAFE_ORPHANS",
  "minAgeDays": 14,
  "deleteAllSafe": true
}
```

Or delete only specific safe candidates:

```json
{
  "confirm": "DELETE_SAFE_ORPHANS",
  "minAgeDays": 14,
  "assetIds": ["line-message-123"]
}
```

The delete service recomputes the dry run when the POST starts and then performs two additional D1 protection checks for every target, including one immediately before the R2 delete. Any asset referenced by `event_assets`, a result event, an active/review submission or LINE batch, or active delivery-outbox work is skipped.

Only objects under the candidate's exact `intakes/<intake>/assets/<asset>/` prefix are deleted. A SHA-256 hash index is deleted only when the dry run proved that its stored owner exactly matches the candidate `assetId` and `intakeId`. Batch-level prefixes are not deleted.

This cleanup intentionally does not delete D1 rows and does not use event age as a deletion criterion. Past event data and flyers remain protected just like future events.
