# Architecture

## Product scope

Bangkok Wine Scout collects, analyses, reviews, and publishes wine-event information for Bangkok.

The MVP processes events from two source types:

1. Text and flyers or images sent through LINE
2. Event pages discovered on websites

All source types converge on one source-independent event pipeline. LINE and website integrations are adapters; they do not own event business logic.

## Current architecture

```text
LINE user
   |
   v
LINE Messaging API
   |
   v
Cloudflare Worker webhook
   |
   v
Command router
   |-- help
   |-- about
   |-- version
   `-- ping
   |
   v
LINE reply service
```

Non-command LINE text and images bypass the command path and enter the durable event-ingestion pipeline.

## Event ingestion pipeline

```text
LINE text + image / event link / website discovery
                    |
                    v
             1. Source adapter
                    |
                    v
        2. Durable source collection
          /                     \
         v                       v
 D1 pending LINE text       R2 image asset
          \                     /
           v                   v
          3. Conservative correlation
                    |
                    v
              4. Flyer OCR
                    |
                    v
       5. Labeled extraction context
       [LINE MESSAGE] + [FLYER OCR]
                    |
                    v
              6. Extraction
                    |
                    v
              7. Normalization
                    |
                    v
       8. Informational metadata checks
                    |
                    v
          9. D1 candidate lookup
                    |
                    v
       10. Deterministic event matching
          /          |          \
         v           v           v
 high-confidence  ambiguous   low-confidence
     match            |          new event
         |             v              |
         |       11. AI resolution    |
         |          /       \         |
         v         v         v        v
      12. Existing event  12. New event
              \             /
               v           v
       13. Canonical event merge
                    |
                    v
             14. Asset linking
                    |
                    v
             15. Publication
                    |
                    v
       16. Optional enrichment
            |
            v
       Public Event API
            |
            v
       Website / LINE search
```

## Pipeline stages

### 1. Source adapter

A source adapter converts provider-specific input into a shared intake request.

Examples:

- LINE image message
- LINE text containing an event URL
- Website crawler result
- Manual dashboard submission

Adapters may authenticate requests, fetch provider content, and capture source metadata. They must not extract or publish events.

### 2. Durable source collection and correlation

The intake layer stores original images in R2 and non-command LINE text in D1 before expensive processing begins. Text is keyed by LINE message ID for idempotency and is not held in process memory.

Responsibilities:

- Generate an internal intake ID
- Record source type and source reference
- Preserve the original URL or submitted text
- Store original image bytes in R2 when applicable
- Record MIME type, object key, and optional content hash
- Make repeated delivery idempotent where a stable source reference exists
- Move the intake from `received` to `stored`

When LINE does not supply an explicit parent relationship, an image atomically claims the newest unconsumed text from the same conservative conversation identity within `LINE_TEXT_CONTEXT_WINDOW_SECONDS` (600 seconds by default). User chats use the user ID; group and room keys include both the conversation ID and sender ID. Expired or consumed text is not reused for another image. Invalid window configuration disables correlation for that event and does not stop image ingestion.

A successful LINE acknowledgement means the source was accepted and stored. Publication follows automatically only after the remaining technical processing and persistence steps succeed.

### 3–6. OCR, extraction context, and extraction

OCR remains responsible only for image-to-text conversion. The extraction boundary then builds and persists an `EventExtractionContext` with separate `sourceText` and `ocrText` fields plus a deterministic `combinedText`. Present sources are labeled `[LINE MESSAGE]` and `[FLYER OCR]`; missing sources do not create empty sections.

The extraction service reads that preserved, labeled context and attempts to produce a provider-neutral structured proposal. AI receives both sources with explicit boundaries and instructions to use both as evidence, avoid invention, and retain uncertainty when they conflict. OCR-only ingestion remains supported. Empty OCR, AI timeouts, invalid JSON, schema violations, and other recoverable extraction failures are retained as diagnostic artifacts and route to fallback publication rather than stopping ingestion.

Fallback publication creates a minimal canonical event titled `Wine Event`. Its date, time, venue, price, booking and contact fields remain `NULL`; wines and regions remain `[]`. The stable intake and asset identifiers feed the existing unique slug generation, and the stored flyer is linked as a public `flyer` asset.

Typical fields:

- Event title
- Date and start time
- End time
- Venue and address
- Organizer
- Price and currency
- Description
- Booking URL
- Contact details

The raw AI or parser response is stored unchanged for troubleshooting and later reprocessing.

### 7. Normalization

Normalization converts extracted values into canonical event fields without inventing missing information.

Examples:

- Convert Thai and English date expressions to ISO 8601
- Apply `Asia/Bangkok` as the default timezone
- Normalize currency codes to ISO values such as `THB`
- Separate numeric price from original wording
- Normalize URLs and whitespace
- Preserve source wording alongside normalized values where meaning could be lost

Normalization is deterministic and independent of the AI provider.

### 8. Informational metadata checks

Metadata checks identify fields that were not detected or could not be normalized. They produce informational warnings and never reject a technically successful flyer.

Checks include:

- Title was detected
- Date and time were detected and parseable
- Price was detected and plausible
- Booking URL was detected and syntactically valid
- Venue and contact details were detected
- Published dates are not silently inferred from unrelated flyer text

Warnings use messages such as `Date not detected`, `Booking URL not detected`, and `Published with partial metadata`. Missing scalar values remain `NULL`, and missing collections are stored as `[]`. `Wine Event` is used only as the defined fallback title when extraction produces no event. Only integrity failures—such as a failed LINE image download, R2 write, D1 write, asset link, invalid queue message, or missing required binding—stop publication.

### 9. D1 candidate lookup

Before insertion, D1 returns a bounded set of plausible candidates using event date, venue, and title. Exact-date candidates are ranked first; nearby dates may be considered so the deterministic matcher can reject or assess them.

### 10. Deterministic event matching

The pure Event Matcher compares the normalized proposal with D1 candidates using date, title, venue, and start time. It remains the primary decision engine. High-confidence matches reuse an existing event, and low-confidence results create a new event without calling AI.

Signals include:

- Normalized title similarity
- Same or nearby start time
- Same venue
- Same booking or source URL
- Matching source reference
- Matching image hash

When an existing event matches, incoming values fill only missing fields. Existing non-empty information is never overwritten.

### 11. AI event resolution

Only deterministic confidence strictly between the configured low and high thresholds is ambiguous enough to invoke AI. The resolver receives the incoming event and no more than five minimal D1 candidates, requests schema-constrained JSON, and validates the decision, confidence, and candidate ID. It prefers a new event when uncertain.

Timeouts, provider failures, malformed JSON, and invalid candidate IDs are logged and fall back to the deterministic result; AI resolution never blocks ingestion.

### 12. Existing or new event

A successful pipeline run creates or updates one canonical published event linked to its intake.

The event contains all normalized fields that were detected. Reprocessing the same intake updates the event rather than creating uncontrolled copies.

### 13. Canonical event merge

Event resolution answers: “Does this incoming asset belong to an existing event?” Canonical event merge is a separate deterministic stage that answers: “Which incoming fields may safely enrich the canonical event?”

For an existing event, the repository loads the complete canonical record and passes it with the incoming normalized event to a pure merge service. Missing scalar fields are filled, existing non-empty values are preserved, and materially different scalar values are reported as conflicts without being overwritten. Wines and wine regions are merged as stable, case-insensitive unions that retain existing order. Reprocessing the same asset produces the same canonical result.

Conflicts are returned by the merge service and logged by field name; they are not persisted in D1. A new event initializes its canonical data directly from the normalized incoming event.

Enrichment never returns an event to draft. The repository preserves its original publication timestamp and keeps the event published while filling previously missing canonical fields. Conflicting non-empty values remain protected by the deterministic merge rules.

### 14. Asset linking

Every incoming asset is linked exactly once to the resolved event. New assets are private by default and require an explicit `is_public` decision. Correlated text is always retained privately as a `line_text` asset with its original message ID and text content; the flyer remains a separate private `line_image` asset until reviewed. Multiple text messages, flyers, menus, reminders, social posts, maps, and other material may belong to one canonical event.

### 15. Publication

After technical processing succeeds, the event is stored with `status = 'published'` and a non-null `published_at`. Business metadata completeness and wine-event classification are not publication gates.

### 16. Optional enrichment

Later flyer assets, automated jobs, or human review may enrich missing fields. Enrichment is optional and does not interrupt publication. Operators may still edit fields, mark an event cancelled or sold out, or re-run extraction after a technical failure or model improvement.

Published events become available to public consumers such as the website and LINE event search. Publication does not overwrite the original source, raw extraction, or review history. A slug is assigned when the canonical event is first created and is not rewritten by later merges. The public API schema is unchanged; consumers simply receive nullable values for metadata that was not detected.

## Public delivery pipeline

```text
D1 canonical published events
          +
D1-authorized R2 asset metadata
          |
          v
Read-only Public Event API
          |
          v
silvester235/bangkok-wine-scout frontend
```

The public repository selects only fields required by the frontend. Event lists are bounded and cursor-paginated with stable ordering by event date, start time, and internal ID; the ID remains cursor-only and is not exposed in event resources. Upcoming filtering uses the `Asia/Bangkok` calendar date and includes events occurring today.

Public asset requests accept only an opaque asset ID. D1 first verifies that the asset is explicitly public, has an `image/*` content type and persisted R2 object key, is not `line_text`, and is linked to an explicitly published event; only then may the Worker stream the stored object. Missing R2 metadata is never reconstructed at the public boundary. Source message IDs, intake IDs, OCR artifacts, AI output, and internal confidence values never cross that boundary.

Cross-origin access is granted only when the request origin exactly matches `PUBLIC_SITE_ORIGIN`. Public collection, detail, and asset responses use progressively longer cache lifetimes. Errors are structured JSON and are not assigned public cache headers.

## Processing states

### Intake states

```text
received -> stored -> analysing -> ready_for_review
                    \-> failed
ready_for_review -> ignored
failed -> analysing
```

### Event states

```text
technical processing -> published
published -> sold_out
published -> cancelled
```

Publication is automatic after technical processing succeeds. Later operator-driven state changes remain explicit and validated.

## Reliability rules

- Webhook handlers finish quickly and delegate expensive processing.
- Each stage has a clear input and output contract.
- Intake creation is idempotent for stable source references.
- Original source material is immutable after storage.
- A failed stage preserves enough metadata to retry safely.
- A retry resumes an R2-stored image when no D1 asset link exists yet.
- Reprocessing must not create duplicate events for the same intake.
- Provider-specific retries belong inside provider services.
- Logs include intake and event IDs but never secrets or unnecessary personal data.

## Main components

### Webhook

Receives LINE events, verifies requests, and delegates work. It must not contain event business logic.

### Command router

Routes text commands to dedicated command handlers. Event images and links bypass the text-command path and enter the intake adapter.

### Event intake service

Creates durable intake records and preserves original source material before analysis.

### R2 source storage

Stores original event flyers and future source artifacts. D1 stores object keys, hashes, and metadata rather than binary blobs.

### Extraction service

Coordinates AI and parser providers and returns a shared extraction result. Provider-specific response formats remain inside adapters.

### Normalization and metadata-check services

Convert extracted values into canonical event fields, validate them, and produce review flags and confidence metadata.

### Duplicate service

Finds likely matches using multiple signals and returns candidates for human review.

### Review dashboard

Allows an administrator to inspect source evidence, edit fields, publish, ignore, cancel, mark sold out, or retry processing.

### D1 database

Stores intakes, canonical events, confidence data, duplicate candidates, and processing metadata.

### Public event API

Provides read-only published event lists, slug-based detail, asset summaries, and authorized R2 streaming for the separate website frontend. It cannot mutate publication state and does not expose private source material.

## Architectural boundaries

- LINE-specific code stays inside LINE adapters and services.
- Website-specific code stays inside website adapters and collectors.
- Event business logic is independent of source and provider.
- Original images live in R2, not D1.
- D1 is the system of record for workflow state and canonical event data.
- Only reviewed events may be published.
- AI output is treated as a proposal, never as authoritative data.
- Public consumers read published events, not raw intakes or failed technical processing artifacts.
- Bottle recognition and cellar management are outside the current scope.
# LINE message-batch ingestion

LINE ingestion uses two durable phases. Phase A claims a content-free delivery
receipt, registers the asset, preserves the original image in R2, and establishes
the batch-owned minimal event shell. Phase B closes the bounded collection window
and enriches that same event. OCR, QR, parsing, AI, matching, and notification are
best-effort enrichment and cannot revoke the retained source or shell.

`line_webhook_delivery_receipts` uses the webhook event ID (or message type plus
message ID fallback) to suppress repeated image, text, command, and `/done`
deliveries. Conversation correlation is stored as a SHA-256 hash; message content,
reply tokens, access tokens, and extracted contact data are not stored. An atomic
`acknowledgement_claimed_at` update gives one delivery exclusive ownership of its
LINE reply. Duplicate delivery returns success without another reply or queue job.

Non-command LINE text and image messages are grouped by conversation in durable D1
`line_image_batches` records. Image registration uses
`LINE_IMAGE_BATCH_WINDOW_SECONDS` (15 seconds by default), while text and web
registration use `LINE_MESSAGE_BATCH_WINDOW_SECONDS` (60 seconds by default).
Each accepted message updates the shared batch expiry. `/done` atomically closes
the current collecting batch and queues it immediately. Messages received after
that close belong to a new batch.

Each original image remains a separate R2 asset with one
`line_image_batch_assets` row. Each text message has an immutable
`line_message_batch_texts` row and a private source asset. Batch analysis receives
labeled image and text boundaries, ordering, timestamps, OCR, and content.

One LINE message batch represents at most one event. `minimal_event_id` and
`shell_anchor_asset_id` make the batch the exclusive ownership boundary: one
anchor creates the deterministic shell and every other source is linked to it.
Retries and final enrichment force the same event ID and cannot run an independent
event-creation path. Batch analysis must combine
compatible evidence into zero or one canonical candidate. If it proposes multiple
events, processing falls back to per-asset enrichment, selects the strongest flyer,
and publishes one event with all batch images; it never splits ownership or
publishes several events from one batch.
The operator workflow is to send all material for Event A, wait for completion or
send `/done`, and only then begin sending Event B.

Every candidate still passes through D1 candidate lookup, the deterministic Event
Matcher, optional AI resolution, and Event Merger. The publication guard records
missing title, date, and corroborating metadata as extraction warnings only. A
stored LINE flyer is publishable even when it is unreadable or menu-like. Sparse
identity evidence disables matching so the intake creates a new event instead of
updating an unrelated one. Deterministic suspicious historical dates or conflicting
source dates may still mark the published batch `needs_review`.

If batch AI output is malformed, schema-invalid, contains no events, or assigns no
assets, the processor records the raw response and validation diagnostics and runs
the established single-asset extractor. Complementary fallback fields fill gaps;
they do not replace the richer batch candidate. Arrays are stable unions and
conflicting scalar values emit `candidate_conflict`. Contextual deterministic
parsers have lower precedence, fill only missing fields, retain raw price wording,
and return a warning instead of guessing when prices or websites are ambiguous.
Years, times, course counts, and phone-like digit strings are not accepted as
uncontextual prices.

After a candidate receives warning-only metadata evaluation, every image in the
batch is linked to that event. AI assignments are role hints, not ownership truth.
The deterministic main image is selected from an explicit `main` hint, otherwise
the strongest identity-bearing image, otherwise the first image. Menu-like evidence
is assigned `menu`; uncertain supplementary images use `other`. Text source assets
are linked privately for provenance. A successful batch therefore has no unassigned
assets. A sparse publication receives a successful completion summary with an
extraction-warning sentence, not a rejection message.

Queue delivery is treated as at-least-once. LINE message IDs, asset IDs, and batch
associations are unique. Asset linking is an upsert. Only one consumer can change a
batch from `collecting` to `processing`; a stale delayed message cannot claim it.
Once claimed, the batch is closed and a later image starts a new collecting batch.
The initial delayed expiration job is reinforced when each asset completes. If the
batch is still collecting, completion schedules a check for the exact remaining
expiry interval; if it is already processing behind a pending-asset gate,
completion schedules a continuation with the current CAS token. Duplicate or stale
jobs lose the CAS and cannot publish twice.
Completion and the summary-notification marker are compare-and-set operations.
Asset claims can resume `failed` work and reclaim a stale processing lease; the
persisted attempt counter makes retry history observable. Batch retries stop after
four claims. Valid forward transitions are `collecting -> processing -> completed`
or `needs_review`, with `processing -> failed -> processing` available only within
that bound. Terminal batches never regress to collecting. `/done` and timeout race
on the same compare-and-set transition, so only one queues active processing.

Reply and push failures emit `notification_failed` and do not alter event, asset,
or batch state. Reconciliation starts from `retryable_failed` delivery receipts,
failed/stale asset claims, failed batches below the retry bound, and R2 publication
diagnostics whose D1 shell write is marked retryable. Operators requeue the exact
batch/event; they do not create a replacement event.
