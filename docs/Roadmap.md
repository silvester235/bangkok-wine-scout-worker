# Roadmap

The roadmap is intentionally focused on wine events. Bottle analysis, cellar inventory, and personal wine ratings will be considered only after the event product is stable.

Delivery follows the shared event pipeline described in [Architecture.md](Architecture.md). Each phase should leave a usable, testable boundary rather than mixing intake, AI extraction, review, and publication in one implementation step.

## Phase 1 – LINE infrastructure

- [x] Create LINE Official Account
- [x] Deploy webhook on Cloudflare Workers
- [x] Verify LINE webhook requests
- [x] Receive and reply to text messages
- [x] Add command router
- [x] Add `help`, `about`, `version`, and `ping` commands
- [x] Separate webhook, command, and LINE reply responsibilities

## Phase 2 – Durable event intake

Pipeline stages: source adapter and intake.

- [ ] Recognize LINE image events separately from text commands
- [ ] Retrieve original image content from LINE
- [ ] Create an `event_intakes` record before analysis
- [ ] Store original images in Cloudflare R2
- [ ] Store R2 key, MIME type, source reference, and content hash
- [ ] Make repeated LINE delivery idempotent
- [ ] Move intake state from `received` to `stored`
- [ ] Acknowledge successful storage in LINE
- [ ] Return a safe error reply when storage fails
- [ ] Display original submissions in a basic dashboard

Exit criterion: a flyer can be received, preserved, identified by intake ID, and retried without creating uncontrolled duplicates.

## Phase 3 – Extraction and normalization

Pipeline stages: extraction, normalization, validation, and confidence.

- [ ] Define a provider-neutral extraction result type
- [ ] Analyse stored flyers
- [ ] Extract event title
- [ ] Extract date and start time
- [ ] Extract optional end time
- [ ] Extract venue and address
- [ ] Extract organizer
- [ ] Extract price and currency
- [ ] Extract booking link and contact details
- [ ] Store raw extraction output unchanged
- [ ] Normalize dates to ISO 8601 with `Asia/Bangkok`
- [ ] Normalize currency, URLs, and whitespace
- [ ] Preserve original price and source wording
- [ ] Validate required and contradictory fields
- [ ] Calculate overall confidence
- [ ] Add field-level confidence where useful
- [ ] Flag missing or ambiguous information
- [ ] Support retry from `failed` to `analysing`

Exit criterion: one stored intake produces a reproducible structured proposal with raw evidence, normalized fields, validation results, and confidence metadata.

## Phase 4 – Drafts and duplicate candidates

Pipeline stages: duplicate search and canonical draft creation.

- [ ] Create or update one draft event per intake
- [ ] Link drafts to original intakes
- [ ] Compare normalized title, time, venue, and URLs
- [ ] Compare source references and image hashes
- [ ] Store possible duplicate relationships
- [ ] Show duplicate candidates without auto-merging
- [ ] Ensure reprocessing updates the existing draft
- [ ] Move successful intakes to `ready_for_review`

Exit criterion: each successful intake has one reviewable draft and any likely duplicates are visible to the reviewer.

## Phase 5 – Human review and publication

Pipeline stages: review and publication.

- [ ] Create review dashboard
- [ ] Show original flyer beside extracted data
- [ ] Show confidence and validation warnings
- [ ] Show duplicate candidates
- [ ] Add Edit action
- [ ] Add Publish action
- [ ] Add Ignore action
- [ ] Add Re-run extraction action
- [ ] Add Cancelled and Sold Out actions for published events
- [ ] Validate workflow state transitions
- [ ] Record review and publication timestamps
- [ ] Expose only published events to public consumers

Exit criterion: no event can become public without a deliberate human publication decision.

## Phase 6 – Website sources and public consumption

All new sources enter through the same adapter and intake contracts.

- [ ] Feed website discoveries into the shared intake pipeline
- [ ] Preserve page URL and scraped source text
- [ ] Use the same extraction, normalization, validation, and duplicate services
- [ ] Maintain one shared event database
- [ ] Publish approved events to the website
- [ ] Search approved events through LINE
- [ ] Add date, venue, and price filters
- [ ] Add monitoring for failed collectors and stale sources

Exit criterion: LINE and website discoveries produce the same canonical event model and use the same review and publication workflow.

## Cross-cutting work

- [ ] Add D1 migrations for intakes and events
- [ ] Add R2 and D1 bindings to development and production configuration
- [ ] Add structured logs with intake and event IDs
- [ ] Add integration tests for state transitions and retries
- [ ] Document secrets, bindings, and deployment changes
- [ ] Add retention and privacy rules for source material and LINE metadata

## Deferred scope

The following features are explicitly deferred:

- Wine bottle label recognition
- Personal wine collection
- Bottle inventory
- Cellar locations
- Tasting notes and ratings
- Wine recommendations based on owned bottles
