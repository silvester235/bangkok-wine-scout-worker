# Database Design

## Scope

The first Cloudflare D1 schema stores wine-event submissions and reviewed event records. It does not contain wines, bottles, cellar inventory, or tasting notes.

Database engine: Cloudflare D1 (SQLite)

## Design goals

- Preserve the original source and extracted data
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
    +---- Original image in R2
    |
    v
Event record
    |
    v
Review and publication status
```

## `event_intakes`

Stores every incoming candidate before it becomes a published event.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | Intake identifier |
| `source_type` | TEXT NOT NULL | `line_image`, `line_text`, or `website` |
| `source_reference` | TEXT | LINE message ID, page URL, or external identifier |
| `source_url` | TEXT | Original public URL when available |
| `line_user_id` | TEXT | LINE user ID for LINE submissions |
| `r2_key` | TEXT | R2 object key for the original image |
| `mime_type` | TEXT | Original image MIME type |
| `status` | TEXT NOT NULL | Processing status |
| `raw_text` | TEXT | Submitted text or scraped source text |
| `raw_extraction_json` | TEXT | Original AI response as JSON |
| `error_message` | TEXT | Processing error, if any |
| `created_at` | TEXT NOT NULL | ISO 8601 UTC timestamp |
| `updated_at` | TEXT NOT NULL | ISO 8601 UTC timestamp |

Suggested intake statuses:

- `received`
- `stored`
- `analysing`
- `ready_for_review`
- `failed`
- `ignored`

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

## Recommended indexes

```sql
CREATE INDEX idx_event_intakes_status
ON event_intakes(status);

CREATE INDEX idx_event_intakes_source_reference
ON event_intakes(source_reference);

CREATE INDEX idx_events_status_starts_at
ON events(status, starts_at);

CREATE INDEX idx_events_venue_name
ON events(venue_name);

CREATE INDEX idx_events_booking_url
ON events(booking_url);
```

## Duplicate detection

Duplicate detection should use several signals rather than one strict unique constraint:

- Similar normalized title
- Same or nearby start time
- Same venue
- Same booking URL
- Same source URL
- Matching image hash, when available

Potential duplicates should be shown during review instead of being deleted automatically.

## Data rules

- Store timestamps in ISO 8601 format.
- Preserve the original price wording in `price_text`.
- Use `price_amount` only when a single reliable numeric price exists.
- Store original images in R2, not as database blobs.
- Keep raw AI output for troubleshooting and later reprocessing.
- Do not publish an event automatically during the MVP.

## Initial migration order

1. Create `event_intakes`
2. Create `events`
3. Add indexes
4. Add `event_field_confidence` only when the review interface needs it
