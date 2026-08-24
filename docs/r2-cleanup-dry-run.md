# R2 cleanup dry run

Admin-only orphan scan for `EVENT_INTAKES` R2 objects.

Endpoint after routing is enabled:

`GET /admin/r2-cleanup?minAgeDays=14`

The endpoint is read-only. It does not delete R2 objects or D1 rows.

An intake asset is protected when its `asset_id` is referenced by:

- `event_assets`
- an agent submission with status `pending`, `processing`, or `needs_review`
- a LINE image batch with status `collecting` or `processing`
- a non-terminal `line_delivery_outbox` row

Only unprotected intake asset prefixes whose newest R2 object is older than the cutoff are returned as candidates.
