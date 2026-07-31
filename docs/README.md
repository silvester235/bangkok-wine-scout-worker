# Bangkok Wine Scout Documentation

Bangkok Wine Scout is an AI-supported event aggregator for wine events in Bangkok.

The current project scope is deliberately limited to events. Wine bottle recognition, cellar management, personal ratings, and bottle inventory are out of scope for the current MVP.

## Architectural summary

Every event source enters one shared pipeline:

```text
Source adapter
    -> durable intake and source preservation
    -> extraction
    -> normalization
    -> informational metadata checks
    -> duplicate candidate search
    -> canonical event
    -> publication
    -> optional enrichment
```

LINE and website integrations are source adapters. They share the same downstream event-domain services and canonical event model.

## Documents

| Document | Purpose |
|---|---|
| [Architecture.md](Architecture.md) | Current architecture, pipeline stages, states, and reliability rules |
| [Roadmap.md](Roadmap.md) | Delivery phases aligned with the event pipeline |
| [Database.md](Database.md) | Cloudflare D1 event data model |
| [API.md](API.md) | LINE webhook and public event API contracts |
| [Deployment.md](Deployment.md) | Local development and Cloudflare deployment |
| [Coding-Standards.md](Coding-Standards.md) | Development and architecture rules |
| [Decisions/ADR-0001-Command-Router.md](Decisions/ADR-0001-Command-Router.md) | Command-router decision record |
| [Decisions/ADR-0002-Shared-Event-Pipeline.md](Decisions/ADR-0002-Shared-Event-Pipeline.md) | Shared event-pipeline decision record |

## Current status

Version: `v0.7.0`

Implemented:

- Read-only public API for explicitly published events and visual assets
- Cursor pagination, Bangkok-local upcoming filtering, field filters, CORS, and public caching
- Stable public event slugs and authorized R2 asset streaming
- Publish-by-default ingestion with nullable metadata and later enrichment
- D1-backed correlation of nearby LINE text with subsequent flyer images
- Labeled extraction contexts that preserve LINE text and flyer OCR separately
- Idempotent `line_text` and `line_image` source assets linked to one canonical event
- LINE Official Account integration
- Cloudflare Worker webhook
- LINE signature verification and replies
- Command router
- Commands: `help`, `about`, `version`, `ping`
- Modular route, command, and LINE service boundaries

The ingestion pipeline supports OCR-only flyers and fused LINE-text-plus-flyer submissions. Every flyer whose image storage, extraction, and database write succeed becomes a published event, even when no business metadata was detected. Missing scalar fields remain `NULL`, collection fields remain empty arrays, and enrichment can happen later. The separate `silvester235/bangkok-wine-scout` frontend consumes published data only through the Worker API; it does not access D1 or R2 directly.

The ingestion philosophy is **publish first, enrich later**:

```text
Receive flyer
    ↓
OCR / AI extraction
    ↓
Store image
    ↓
Create event
    ↓
Populate detected fields
    ↓
Publish
```

Metadata enrichment is optional and can happen later. A missing date, time, booking URL, venue, organiser, price, wine list, region, contact, speaker, or description is informational and never blocks publication. Technical failures such as an unreadable asset, failed OCR/extraction, failed R2 operation, or failed D1 write still stop that intake.

## Core rules

- Preserve original source material before analysis
- Keep source-specific code outside event-domain logic
- Store every detected value without inventing missing metadata
- Reprocess an intake without creating uncontrolled duplicates
- Show probable duplicates to a human rather than auto-merging
- Publish every technically successful flyer intake by default
