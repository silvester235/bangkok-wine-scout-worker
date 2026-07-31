# Architecture

## Product scope

Bangkok Wine Scout collects, analyses, reviews, and publishes wine-event information for Bangkok.

The MVP processes events from two source types:

1. Flyers or images sent through LINE
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

The current implementation covers text commands. Event processing begins with the next milestone: LINE image intake.

## Event ingestion pipeline

```text
LINE image / event link / website discovery
                    |
                    v
             1. Source adapter
                    |
                    v
              2. Intake record
               /           \
              v             v
     R2 source object     D1 metadata
              \             /
               v           v
              3. Extraction
                    |
                    v
             4. Normalization
                    |
                    v
          5. Validation and scoring
                    |
                    v
          6. D1 candidate lookup
                    |
                    v
       7. Deterministic event matching
          /          |          \
         v           v           v
 high-confidence  ambiguous   low-confidence
     match            |          new event
         |             v              |
         |       8. AI resolution     |
         |          /       \         |
         v         v         v        v
       9. Existing event  9. New event
              \             /
               v           v
       10. Canonical event merge
                    |
                    v
             11. Asset linking
                    |
                    v
             12. Human review
             /        |        \
            v         v         v
         Publish     Edit      Ignore
            |
            v
       13. Published event
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

### 2. Intake

The intake service creates an `event_intakes` record before expensive processing begins.

Responsibilities:

- Generate an internal intake ID
- Record source type and source reference
- Preserve the original URL or submitted text
- Store original image bytes in R2 when applicable
- Record MIME type, object key, and optional content hash
- Make repeated delivery idempotent where a stable source reference exists
- Move the intake from `received` to `stored`

A successful LINE acknowledgement means the source was accepted and stored. It does not mean the event was extracted, approved, or published.

### 3. Extraction

The extraction service reads preserved source material and produces a provider-neutral structured proposal.

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

### 4. Normalization

Normalization converts extracted values into canonical event fields without inventing missing information.

Examples:

- Convert Thai and English date expressions to ISO 8601
- Apply `Asia/Bangkok` as the default timezone
- Normalize currency codes to ISO values such as `THB`
- Separate numeric price from original wording
- Normalize URLs and whitespace
- Preserve source wording alongside normalized values where meaning could be lost

Normalization is deterministic and independent of the AI provider.

### 5. Validation and confidence

Validation checks whether the proposal is usable and identifies fields requiring review.

Checks include:

- Required title is present
- Date and time are parseable
- End time is not before start time
- Price values are plausible
- URLs are syntactically valid
- Published dates are not silently inferred from unrelated flyer text

The pipeline records overall confidence and may record field-level confidence with source evidence. Low confidence never causes automatic publication.

### 6. D1 candidate lookup

Before insertion, D1 returns a bounded set of plausible candidates using event date, venue, and title. Exact-date candidates are ranked first; nearby dates may be considered so the deterministic matcher can reject or assess them.

### 7. Deterministic event matching

The pure Event Matcher compares the normalized proposal with D1 candidates using date, title, venue, and start time. It remains the primary decision engine. High-confidence matches reuse an existing event, and low-confidence results create a new event without calling AI.

Signals include:

- Normalized title similarity
- Same or nearby start time
- Same venue
- Same booking or source URL
- Matching source reference
- Matching image hash

When an existing event matches, incoming values fill only missing fields. Existing non-empty information is never overwritten.

### 8. AI event resolution

Only deterministic confidence strictly between the configured low and high thresholds is ambiguous enough to invoke AI. The resolver receives the incoming event and no more than five minimal D1 candidates, requests schema-constrained JSON, and validates the decision, confidence, and candidate ID. It prefers a new event when uncertain.

Timeouts, provider failures, malformed JSON, and invalid candidate IDs are logged and fall back to the deterministic result; AI resolution never blocks ingestion.

### 9. Existing or new event

A successful pipeline run creates or updates one canonical draft event linked to its intake.

The draft contains normalized fields, review flags, confidence data, and duplicate candidates. Reprocessing the same intake updates the draft rather than creating uncontrolled copies.

### 10. Canonical event merge

Event resolution answers: “Does this incoming asset belong to an existing event?” Canonical event merge is a separate deterministic stage that answers: “Which incoming fields may safely enrich the canonical event?”

For an existing event, the repository loads the complete canonical record and passes it with the incoming normalized event to a pure merge service. Missing scalar fields are filled, existing non-empty values are preserved, and materially different scalar values are reported as conflicts without being overwritten. Wines and wine regions are merged as stable, case-insensitive unions that retain existing order. Reprocessing the same asset produces the same canonical result.

Conflicts are returned by the merge service and logged by field name; they are not persisted in D1. A new event initializes its canonical data directly from the normalized incoming event.

### 11. Asset linking

Every incoming asset is linked exactly once to the resolved event. Multiple flyers and supporting assets—such as menus, reminders, social posts, maps, and other material—may belong to one canonical event.

### 12. Human review

The review dashboard presents the original source beside the structured draft.

Allowed decisions:

- Edit fields
- Publish
- Ignore
- Mark a published event as cancelled or sold out
- Re-run extraction after a processing failure or model improvement

AI extraction is advisory. A human review decision is the publication boundary.

### 13. Publication

Publication changes an approved event to `published` and records `published_at`.

Published events become available to public consumers such as the website and LINE event search. Publication does not overwrite the original source, raw extraction, or review history.

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
draft -> needs_review -> published
   |          |
   +----------+-> ignored
published -> sold_out
published -> cancelled
```

State changes must be explicit and validated. Invalid transitions return a conflict rather than silently changing data.

## Reliability rules

- Webhook handlers finish quickly and delegate expensive processing.
- Each stage has a clear input and output contract.
- Intake creation is idempotent for stable source references.
- Original source material is immutable after storage.
- A failed stage preserves enough metadata to retry safely.
- Reprocessing must not create duplicate draft events for the same intake.
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

### Normalization and validation services

Convert extracted values into canonical event fields, validate them, and produce review flags and confidence metadata.

### Duplicate service

Finds likely matches using multiple signals and returns candidates for human review.

### Review dashboard

Allows an administrator to inspect source evidence, edit fields, publish, ignore, cancel, mark sold out, or retry processing.

### D1 database

Stores intakes, canonical events, confidence data, duplicate candidates, and processing metadata.

## Architectural boundaries

- LINE-specific code stays inside LINE adapters and services.
- Website-specific code stays inside website adapters and collectors.
- Event business logic is independent of source and provider.
- Original images live in R2, not D1.
- D1 is the system of record for workflow state and canonical event data.
- Only reviewed events may be published.
- AI output is treated as a proposal, never as authoritative data.
- Public consumers read published events, not raw intakes or unreviewed drafts.
- Bottle recognition and cellar management are outside the current scope.
