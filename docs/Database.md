# Database Design

## Scope

The first Cloudflare D1 schema stores wine-event submissions and reviewed event records. It does not contain wines, bottles, cellar inventory, or tasting notes.

Database engine: Cloudflare D1 (SQLite)

## Design goals

- Preserve the original source and extracted data
- Support multiple source assets for one event submission
- Support human review before publication
- Accept multiple source types through one pipeline
- Make duplicate detection possible
- Keep the first schema small and migration-friendly

## Core entities

```text
Event source
    |
    v
Event intake
    |
    +---- Intake asset: invitation flyer in R2
    +---- Intake asset: menu flyer in R2
    +---- Intake asset: wine-list flyer in R2
    |
    v
Event record
    |
    v
Review and publication status
```

An intake represents one candidate event. An intake may contain one or many source assets. Each asset remains independently addressable and immutable.

## `event_intakes`

Stores every incoming candidate before it becomes a published event.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | Intake identifier |
| `source_type` | TEXT NOT NULL | `line_session`, `line_text`, `website`, or `manual` |
| `source_reference` | TEXT | Session ID, page URL, or external identifier |
| `source_url` | TEXT | Original public URL when available |
| `line_user_id` | TEXT | LINE user ID for LINE submissions |
| `status` | TEXT NOT NULL | Processing status |
| `raw_text` | TEXT | Submitted text or scraped source text |
| `raw_extraction_json` | TEXT | Original combined AI response as JSON |
| `error_message` | TEXT | Processing error, if any |
| `created_at` | TEXT NOT NULL | ISO 8601 UTC timestamp |
| `updated_at` | TEXT NOT NULL | ISO 8601 UTC timestamp |

Suggested intake statuses:

- `collecting`
- `stored`
- `analysing`
- `ready_for_review`
- `failed`
- `ignored`

## `event_intake_assets`

Stores each original flyer, image, page, or other source artifact belonging to an intake.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | Asset identifier |
| `intake_id` | INTEGER NOT NULL | Parent event intake |
| `source_reference` | TEXT NOT NULL | LINE message ID, page URL, or external asset ID |
| `asset_type` | TEXT NOT NULL | `image`, `webpage`, `document`, or `text` |
| `role` | TEXT NOT NULL DEFAULT 'other' | `invitation`, `menu`, `wine_list`, or `other` |
| `r2_key` | TEXT | R2 object key for the immutable original |
| `mime_type` | TEXT | Original MIME type |
| `content_hash` | TEXT | Optional hash for duplicate detection |
| `position` | INTEGER NOT NULL DEFAULT 0 | Display and extraction order |
| `created_at` | TEXT NOT NULL | ISO 8601 UTC timestamp |

The LINE message ID is unique at asset level. Re-delivery of the same LINE message must not create a second asset.

## `events`

Stores the canonical reviewed event record.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | Event identifier |
| `intake_id` | INTEGER | Original intake record |
| `title` | TEXT NOT NULL | Public event title |
| `organizer` | TEXT | Event organiser |
| `venue_name` | TEXT | Venue name |
| `address` | TEXT | Venue address |
| `starts_at` | TEXT | ISO 8601 date and time with offset |
| `ends_at` | TEXT | Optional end date and time |
| `timezone` | TEXT NOT NULL DEFAULT 'Asia/Bangkok' | Event timezone |
| `price_amount` | REAL | Numeric price |
| `price_currency` | TEXT | ISO currency code, normally `THB` |
| `price_text` | TEXT | Original price wording |
| `description` | TEXT | Reviewed description |
| `booking_url` | TEXT | Booking or registration URL |
| `contact_text` | TEXT | Phone, LINE, email, or booking instructions |
| `status` | TEXT NOT NULL | Review/publication status |
| `confidence` | REAL | Overall extraction confidence from 0 to 1 |
| `published_at` | TEXT | Publication timestamp |
| `created_at` | TEXT NOT NULL | ISO 8601 UTC timestamp |
| `updated_at` | TEXT NOT NULL | ISO 8601 UTC timestamp |

Suggested event statuses:

- `draft`
- `needs_review`
- `published`
- `ignored`
- `cancelled`
- `sold_out`

## `event_field_confidence`

Optional table for field-level confidence and review support.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | Row identifier |
| `event_id` | INTEGER NOT NULL | Related event |
| `field_name` | TEXT NOT NULL | Example: `starts_at` |
| `confidence` | REAL NOT NULL | Value from 0 to 1 |
| `source_text` | TEXT | Evidence extracted from the source |
| `asset_id` | INTEGER | Asset containing the evidence |

## Recommended indexes

```sql
CREATE INDEX idx_event_intakes_status
ON event_intakes(status);

CREATE INDEX idx_event_intakes_source_reference
ON event_intakes(source_reference);

CREATE UNIQUE INDEX idx_intake_assets_source_reference
ON event_intake_assets(source_reference);

CREATE INDEX idx_intake_assets_intake_position
ON event_intake_assets(intake_id, position);

CREATE INDEX idx_events_status_starts_at
ON events(status, starts_at);

CREATE INDEX idx_events_venue_name
ON events(venue_name);

CREATE INDEX idx_events_booking_url
ON events(booking_url);
```

## Multi-flyer extraction

Extraction operates on the complete ordered asset set for an intake, not on one image in isolation.

Example:

1. Invitation provides title, date, venue, and price
2. Menu provides courses and description
3. Wine list provides producers, labels, and vintages
4. The extractor combines evidence into one draft event
5. Conflicting values are flagged for human review

The raw extraction must retain asset-level evidence so reviewers can see which flyer supplied each field.

## Duplicate detection

Duplicate detection should use several signals rather than one strict unique constraint:

- Similar normalized title
- Same or nearby start time
- Same venue
- Same booking URL
- Same source URL
- Matching asset hash, when available

Potential duplicates should be shown during review instead of being deleted automatically.

## Data rules

- Store timestamps in ISO 8601 format.
- Preserve the original price wording in `price_text`.
- Use `price_amount` only when a single reliable numeric price exists.
- Store original assets in R2, not as database blobs.
- Never combine multiple flyers into one destructive flattened image.
- Keep raw AI output and asset-level evidence for troubleshooting and reprocessing.
- Do not publish an event automatically during the MVP.

## Initial migration order

1. Create `event_intakes`
2. Create `event_intake_assets`
3. Create `events`
4. Add indexes
5. Add `event_field_confidence` when the review interface needs it
