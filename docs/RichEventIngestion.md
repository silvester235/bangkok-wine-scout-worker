# Asset-first rich event ingestion

LINE image ingestion treats the original flyer as the source of truth. Delivery registration and acknowledgement ownership are claimed first. After the image is downloaded and stored in R2, the batch anchor creates one deterministic, batch-owned event shell; other images are retained and later linked to that same shell. OCR, QR inspection, extraction, normalization, matching, and enrichment happen afterward. Optional enrichment failures therefore leave a reviewable flyer-backed event.

## Models and evidence

- OCR: `@cf/moondream/moondream3.1-9B-A2B`. A full-image pass is followed by at most one contact/footer-focused pass when the first pass contains no contact evidence.
- Structured extraction: `@cf/meta/llama-3.1-8b-instruct-fast`. Batch extraction is limited to one event and single-asset extraction is the bounded fallback.
- QR: the `QrDecoder` interface is present, but the default decoder reports `not_available`. No maintained Workers-compatible decoder is bundled yet, so QR values are never guessed.

R2 retains the original asset, each OCR attempt and raw response, merged OCR, extraction context, raw extraction response, parsed analysis, fallback analysis, normalization/publication-guard candidate, and the post-persistence canonical snapshot. Logs contain identifiers, statuses, sizes, finish reasons, and errors rather than full OCR/contact payloads.

## Retry and state

`event_enrichment_state` tracks `pending`, `processing`, `complete`, `partial`, `failed`, `retryable`, and `permanently_failed` states plus OCR, extraction, and QR sub-statuses. The processing queue retries failures three times after the initial attempt; the fourth failed attempt is recorded as permanent and acknowledged. Asset and batch retry counts are persisted, stale processing leases can be reclaimed, and duplicate claims cannot create another event shell. OCR itself performs at most two calls, and batch extraction has one single-asset fallback path. Fallback candidates fill missing fields and merge arrays instead of replacing richer structured output.

Administrators can requeue a replayable LINE batch with:

```text
POST /admin/events/{event-id}/reprocess
Authorization: Bearer {ADMIN_API_TOKEN}
```

The endpoint resets enrichment and batch retry state but preserves the existing event, flyer, and populated canonical fields.

## Rollout

1. Back up/export D1.
2. Apply `migrations/0014_rich_event_enrichment.sql`, then `migrations/0015_line_ingestion_hardening.sql`, remotely.
3. Deploy the worker.
4. Verify the health endpoint, public API, asset endpoint, and a test LINE flyer.
5. Deploy the frontend after the expanded worker API is live.

The migration is forward-only and additive. Application rollback means redeploying the previous worker and frontend; the extra nullable columns and enrichment table can remain safely unused. Do not drop columns during an incident rollback.

No new Cloudflare binding or secret is required. Existing `DB`, `EVENT_INTAKES`, `AI`, `IMAGE_PROCESSING_QUEUE`, and `ADMIN_API_TOKEN` configuration is reused.
