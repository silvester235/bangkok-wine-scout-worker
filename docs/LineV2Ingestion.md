# LINE ingestion V2

V1 remains the production path at `POST /webhook`; it was not redirected, removed, or disabled. V2 is an isolated mailbox at `POST /api/line/v2/webhook`, intended for a separate LINE test channel.

## Production safety controls

`INGESTION_MODE` admits exactly one LINE ingestion route. `v1` enables only
`POST /webhook`, `v2` enables only `POST /api/line/v2/webhook`, and `disabled`
enables neither. Missing and invalid values are treated as `disabled`. Blocked
requests return `503 INGESTION_DISABLED` before the route handler can create a
submission, start a Workflow, download an image, or write R2.

`V2_PUBLICATION_ENABLED` defaults closed: only the case-insensitive value
`true` permits canonical persistence. The Workflow reads the control inside its
`persist_event` step immediately before calling the event repository. A false
control produces `needs_review` with `error_code=publication_disabled`, stores
the reason in submission diagnostics, and sends a review notification rather
than a publication notification.

Worker environment variables are versioned bindings. Cloudflare does not
document that an already-running Workflow adopts bindings from a later Worker
version. Migration `0019_runtime_controls.sql` therefore adds a live D1
override. A `runtime_controls` row with key `v2_publication_enabled` takes
precedence over the environment variable and is read on every persistence
attempt. This is the rollback control for in-flight instances. An absent row
falls back to the versioned environment setting.

Set the live block without deploying a Worker version:

```sql
INSERT INTO runtime_controls(key,value,updated_at,updated_by)
VALUES('v2_publication_enabled','false',datetime('now'),'rollback-operator')
ON CONFLICT(key) DO UPDATE SET value='false',updated_at=datetime('now'),updated_by='rollback-operator';
```

Enabling publication requires an explicit `true` value either in the live D1
override or, when no override row exists, in `V2_PUBLICATION_ENABLED`. Changes
to this table are operational production changes and require the normal approval
and audit process.

```text
LINE V2
  -> Worker mailbox (/api/line/v2/webhook)
  -> R2 originals + D1 submission
  -> WineScoutSubmissionWorkflow
  -> controlled WineScoutEditorialAgent service
  -> deterministic validator + matcher/merger
  -> D1 event
  -> public website (unchanged)
```

The mailbox validates the LINE HMAC, records source identity/order, downloads original images to the existing private R2 bucket, stores text and original URLs, acknowledges receipt, and signals one durable Workflow per submission. It does no OCR, URL fetching, extraction, matching, merging, or publication.

## Data and lifecycle

Migration `0018_agent_submissions_v2.sql` adds `agent_submissions`, ordered `agent_submission_items`, and private `agent_submission_diagnostics`. Image bytes remain in R2. Unique message, webhook, asset, workflow, and collecting-conversation constraints make retries idempotent.

Messages collect for `AGENT_SUBMISSION_WINDOW_SECONDS` (default 60). Each item resets inactivity. `/done` conditionally changes `collecting` to `queued` and signals the same Workflow. The Workflow also closes after inactivity, then runs named retryable preparation, analysis, validation, candidate lookup, identity resolution, persistence, finalization, and notification steps.

The editorial service gets only prepared submission material, not a database write tool. Preparation preserves deterministic `IMAGE_n`, `OCR_IMAGE_n`, `TEXT_n`, and `URL_n` boundaries, original ordering, timestamps, URL extraction results, and per-image OCR. The controlled analysis boundary then reloads every accepted original from private R2 and sends all images together in one structured multimodal Workers AI request, as private base64 data URIs alongside their labels, OCR, LINE text, and URL evidence. R2 objects are never made public or signed for model access.

The prompt requires pixel-level reading and OCR comparison, including small text, contact details, addresses, booking instructions, venue/logo identity, and layout relationships. It also requires the model to distinguish primary flyers from menus, maps, reminders, and wine lists, and to expose per-field source evidence and uncertainty. AI output and request diagnostics are saved privately; diagnostics include the model, asset IDs/R2 keys, content types, byte sizes, inclusion status, OCR availability, and usage, but never duplicate image bytes. The deterministic V2 guard blocks incomplete identity, non-wine content, ambiguous/multiple matches, and menu/map/reminder-only material. Persistence reuses the event repository, matcher, merger, assets, and stable `agent:{submissionId}` identity. LINE notification is a final independent step and cannot roll back publication.

Accepted vision inputs are JPEG, PNG, and WebP. Preparation uses R2 metadata before buffering and enforces 4 MiB per image and 12 MiB across the submission; the analysis boundary rechecks actual buffered sizes. Missing, unsupported, or oversized assets produce a traceable `needs_review` proposal without calling the editorial model. These application limits intentionally sit below the Worker's 128 MB memory ceiling and avoid unbounded base64 expansion.

This controlled service is the future Cloudflare Agents SDK integration point. An SDK adapter should expose the same narrow functions in `wine-scout-editorial-agent.ts`, never unrestricted D1 access.

## Bindings and secrets

`wrangler.jsonc` adds `WINE_SCOUT_SUBMISSION_WORKFLOW` for class `WineScoutSubmissionWorkflow`, `AGENT_SUBMISSION_WINDOW_SECONDS=60`, and `EDITORIAL_VISION_MODEL=@cf/mistralai/mistral-small-3.1-24b-instruct`. The editorial model is independently configurable from the OCR/extraction `AI_MODEL`; keep it set to a Workers AI model that accepts structured multimodal chat content. Configure `LINE_V2_CHANNEL_SECRET` and the separate test channel's `LINE_V2_CHANNEL_ACCESS_TOKEN` with `wrangler secret`; do not put them in `vars`. If the V2 token is absent the code falls back to `LINE_CHANNEL_ACCESS_TOKEN`. V2 reuses `DB`, `EVENT_INTAKES`, `AI`, and `PUBLIC_SITE_ORIGIN`.

## Safe isolated test procedure

1. Create a separate LINE Messaging API channel; do not alter the current channel.
2. Apply migrations to a preview/test D1 database.
3. Set that channel's secret as `LINE_V2_CHANNEL_SECRET` and access token as `LINE_CHANNEL_ACCESS_TOKEN` in an isolated Worker environment.
4. Deploy that preview/test Worker and configure only the test LINE channel with `https://<test-worker>/api/line/v2/webhook`.
5. Send related text/images/URLs and `/done`.
6. Inspect the isolated D1 database directly:

```sql
SELECT * FROM agent_submissions ORDER BY created_at DESC;
SELECT * FROM agent_submission_items WHERE submission_id = ? ORDER BY ordinal;
SELECT * FROM agent_submission_diagnostics WHERE submission_id = ?;
```

Prepared context and raw AI diagnostics live under `agent-submissions/{submissionId}/` in private R2.

## Migration strategy and limitations

Run V1/V2 in parallel on separate channels, compare outcomes, tune extraction and the publication guard, and add a review UI. Move production only after an acceptance period; retain V1 for rollback.

Initial limitations: no review UI; bounded static HTML extraction does not execute JavaScript; the direct base64 request increases memory relative to URL-backed inputs and is therefore deliberately size-capped; this is not yet an Agents SDK Agent; and V2 acknowledgement failures are logged but do not yet use a durable retry outbox.
