# API Specification

## Scope

The current public integration is the LINE webhook. A separate REST API is planned for the dashboard and event publication workflow.

Current application version: `v0.5.0`

## LINE webhook

### `POST /webhook`

Receives LINE Messaging API webhook events.

Responsibilities:

1. Verify the LINE signature
2. Parse webhook events
3. Route text commands
4. Reply through the LINE Messaging API
5. In Phase 2, route image messages to the event-intake pipeline

### Supported text commands

#### `ping`

Health check.

Expected reply:

```text
pong
```

#### `help`

Displays available commands.

#### `version`

Displays the current application version.

#### `about`

Displays a short project description.

Unknown commands should receive a helpful response rather than failing silently.

## Planned LINE image flow

When a user sends an image:

1. Read the LINE message ID
2. Download the image through the LINE content API
3. Store the original bytes in R2
4. Create an `event_intakes` record
5. Reply that the flyer was received
6. Queue or start AI extraction

A successful receipt reply confirms storage, not publication.

## Planned dashboard API

The exact route structure may change when the dashboard is implemented. The proposed contract is:

### `GET /api/intakes`

Returns event submissions, filterable by status.

Query examples:

```text
/api/intakes?status=ready_for_review
/api/intakes?status=failed
```

### `GET /api/intakes/{id}`

Returns one intake, its source metadata, original image reference, raw extraction, and associated draft event.

### `POST /api/intakes/{id}/analyse`

Starts or repeats event extraction for one intake.

### `GET /api/events`

Returns events. Public consumers should receive only published events by default.

Suggested query parameters:

- `status`
- `from`
- `to`
- `venue`
- `q`

### `GET /api/events/{id}`

Returns one event.

### `PATCH /api/events/{id}`

Updates reviewed event fields.

### `POST /api/events/{id}/publish`

Marks a reviewed event as published and records `published_at`.

### `POST /api/events/{id}/ignore`

Marks an event and its intake as ignored.

### `POST /api/events/{id}/cancel`

Marks a previously published event as cancelled.

## Example event response

```json
{
  "id": 42,
  "title": "California Wine Dinner",
  "organizer": "Example Organizer",
  "venueName": "Example Hotel Bangkok",
  "address": "Bangkok, Thailand",
  "startsAt": "2026-08-15T19:00:00+07:00",
  "endsAt": null,
  "timezone": "Asia/Bangkok",
  "priceAmount": 3200,
  "priceCurrency": "THB",
  "priceText": "THB 3,200 net per person",
  "bookingUrl": "https://example.com/event",
  "status": "published",
  "confidence": 0.94
}
```

## HTTP responses

| Status | Meaning |
|---|---|
| `200` | Successful read or update |
| `201` | Resource created |
| `202` | Analysis accepted for processing |
| `400` | Invalid request |
| `401` | Missing or invalid authentication |
| `404` | Resource not found |
| `409` | Conflicting state or possible duplicate |
| `422` | Valid request with unusable event data |
| `500` | Unexpected server error |

## Authentication

- LINE webhooks use LINE signature verification.
- Dashboard routes must not be public without authentication.
- Public event-reading endpoints may be introduced later.

## API design rules

- Webhook handlers remain thin.
- Source-specific payloads are converted into shared internal event types.
- AI extraction never publishes directly.
- Errors use a consistent JSON structure.
- Breaking API changes require explicit versioning.
