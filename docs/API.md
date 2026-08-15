# API Specification

Current application version: `v0.7.0`

## Public Event API

The read-only API is the only supported public data boundary for the separate `silvester235/bangkok-wine-scout` frontend. The frontend does not access D1 or R2 directly.

Only rows satisfying both conditions are public:

```text
status = published
published_at is not null
```

Draft, ignored, rejected, failed, cancelled, or otherwise unpublished events are indistinguishable from missing resources. Public responses never contain intake IDs, source message IDs, raw LINE text, OCR text, AI output, internal confidence, or R2 object keys.

### Response envelopes

Collections:

```json
{
  "data": [],
  "pagination": { "nextCursor": null, "limit": 20 }
}
```

Single resources:

```json
{ "data": {} }
```

Errors:

```json
{
  "error": {
    "code": "INVALID_CURSOR",
    "message": "The supplied cursor is invalid."
  }
}
```

### `GET /api/events`

Returns published events with dated events first in chronological date/time order, followed by undated events in stable order. `date` is `null` when extraction did not detect a date. By default, dated events before today's `Asia/Bangkok` calendar date are excluded; events occurring today and undated published events are included. Explicit `from` or `to` filters select dated events only.

| Parameter | Description |
|---|---|
| `limit` | Page size from 1–50; default 20 |
| `cursor` | Opaque cursor returned by the previous page |
| `from` | Inclusive ISO date (`YYYY-MM-DD`) |
| `to` | Inclusive ISO date (`YYYY-MM-DD`) |
| `venue` | Case-insensitive venue substring |
| `region` | Case-insensitive wine-region substring |
| `wine` | Case-insensitive wine substring |
| `includePast` | `true` to remove the default upcoming-only boundary |

Unknown or malformed parameters return `400` with a structured error. Pagination is cursor-based rather than offset-based and queries are always bounded.

Example:

```json
{
  "data": [
    {
      "slug": "austrian-wine-masterclass-attico-2026-07-31",
      "title": "Austrian Wine Masterclass",
      "date": "2026-07-31",
      "startTime": "18:00",
      "priceTHB": 1290,
      "venue": "Attico",
      "wines": ["Example Riesling 2022"],
      "wineRegions": ["Wachau"],
      "isWineEvent": true,
      "heroAsset": {
        "id": "public-asset-id",
        "type": "line_image",
        "role": "flyer",
        "contentType": "image/jpeg",
        "url": "/api/assets/public-asset-id",
        "alt": ""
      },
      "publishedAt": "2026-07-01T12:00:00.000Z"
    }
  ],
  "pagination": { "nextCursor": null, "limit": 20 }
}
```

Cache policy: `public, max-age=60, stale-while-revalidate=300`.

### `GET|HEAD /api/events/:slug`

Returns one published event by stable public slug. The detail includes the public list fields, contact email and phone when present, and public asset summaries. Unknown and unpublished slugs return the same `404` response.

Cache policy: `public, max-age=300, stale-while-revalidate=3600`.

### `GET|HEAD /api/events/:slug/assets`

Returns explicitly public image assets for one published event. Ordering is `main`, `flyer`, `menu`, `reminder`, `social`, `map`, then `other`, followed by link time and asset ID. New assets are private by default. An asset is returned only when `is_public = 1`, it is not `line_text`, its stored content type is `image/*`, and it has a persisted R2 object key.

### `GET|HEAD /api/assets/:assetId`

Streams a D1-authorized public image asset from R2. Clients provide an asset ID, never an R2 key. The Worker verifies explicit asset publication, image content type, persisted R2 key, and ownership by a published event before reading R2. Responses include content type, ETag, and conditional `If-None-Match` support for single, multiple, weak, and wildcard validators, plus:

```text
Cache-Control: public, max-age=3600, stale-while-revalidate=86400
```

Missing objects, private assets, text assets, and assets belonging to unpublished events return `404`.

Ingestion publishes every technically successful event immediately. Later enrichment fills missing canonical fields while preserving `status = 'published'` and the original `published_at`. Newly linked assets remain private until explicitly approved.

### CORS and methods

`PUBLIC_SITE_ORIGIN` configures the one allowed frontend origin and must be set to the deployed website origin. Matching requests receive explicit CORS headers and `Vary: Origin`; other origins receive no allow-origin header. Missing or invalid configuration simply grants no cross-origin access and does not affect same-origin or unrelated routes. `OPTIONS` preflight returns `204`. Public resources support `GET` and `HEAD`; other methods return structured `405` with `Allow: GET, HEAD, OPTIONS`. Production and integration tests use `https://bangkokwinescout.com`.

## LINE webhook

### `POST /webhook`

Receives LINE Messaging API webhook events. Known commands are routed to the command router. Non-command, non-empty text with a correlation identity is persisted as pending event context and acknowledged with the configured correlation window. Images are queued, preserved in R2, fused with eligible LINE text, extracted, normalized, resolved, merged, and linked as event assets.

Supported commands: `ping`, `help`, `version`, and `about`.

LINE retries are idempotent by message and asset identifiers. A successful intake acknowledgement precedes OCR, extraction, and persistence. Recoverable OCR or extraction failure creates a published fallback using the best deterministic title (or `Wine Event`) with a public flyer; storage, D1, asset-link, binding, download, and malformed-message failures remain retryable technical failures.

## Security boundary

- The public API has no mutation, admin, review, or publication endpoints.
- SQL uses prepared statements and fixed query fragments.
- Public identifiers never grant direct R2-key access.
- Publication follows successful technical processing; metadata warnings do not block it.
- Error responses do not include SQL errors or stack traces.

## Admin event deletion

### Browser admin interface

Open `/admin/events-ui` in a browser. When no valid session is present, the
Worker displays a token login form. A successful `POST /admin/login` redirects
back to the event manager and sets an eight-hour `__Host-` session cookie with
`HttpOnly`, `Secure`, and `SameSite=Strict`. The cookie contains a signed expiry,
not `ADMIN_API_TOKEN`; rotating the token invalidates existing sessions.

The event manager is served directly by the Worker with no external scripts,
styles, fonts, or frontend framework. It supports title/venue search, published
and draft filters, event/created-date sorting, refresh, thumbnails, multi-row
selection, and permanent deletion. Thumbnails use the best event-owned image in
`flyer`, `social`, `menu`, then other-image order and are streamed through the
authenticated `GET /admin/assets/:assetId` route. Missing images render a neutral
placeholder.
Deletion requires typing `DELETE` in a confirmation dialog. Successful removal
updates the displayed rows and event count without reloading the page.

Use the **Log out** button to send `POST /admin/logout`. Logout expires the
session cookie and redirects to the login page. Admin HTML and API responses use
`Cache-Control: no-store`; HTML also receives a restrictive Content Security
Policy, clickjacking protection, MIME-sniffing protection, and no-referrer
policy.

Browser sessions and the existing terminal Bearer token are accepted by all
admin event, bulk-delete, and asset endpoints. The token is never
written to HTML, JavaScript, URLs, logs, or browser storage.

### `GET /admin/events`

Lists all events for development and operational inspection, including drafts and
other unpublished statuses. The response is JSON-only, requires the same
`Authorization: Bearer <ADMIN_API_TOKEN>` credential as permanent deletion, and
is never cacheable. Events are ordered by newest `event_date`, then newest
`created_at`; undated events appear after dated events. Asset counts are computed
in the listing query.

Each event also contains nullable `thumbnailUrl` and `thumbnailAssetType`
properties. The URL is an authenticated, same-origin admin URL and must not be
treated as a public asset URL.

```sh
curl \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  "https://bangkok-wine-scout-worker.example/admin/events"
```

```json
{
  "count": 1,
  "events": [{
    "id": "line-625...",
    "title": "The Great Wines of Valpolicella",
    "slug": "the-great-wines-of-valpolicella-enoteca-bangkok-2026-08-06",
    "eventDate": "2026-08-06",
    "status": "published",
    "publishedAt": "2026-08-03T08:17:14Z",
    "venue": "Enoteca",
    "priceTHB": 2500,
    "assetCount": 3,
    "createdAt": "2026-08-03T08:14:31Z"
  }]
}
```

### `DELETE /admin/events/:eventId`

Permanently deletes an event through the single complete-deletion service. The
endpoint requires `Authorization: Bearer <ADMIN_API_TOKEN>` and returns
`Cache-Control: no-store`. Invalid identifiers return `400`, missing or wrong
credentials return `401`, and a missing event returns a successful idempotent
report with `eventFound: false`.

```sh
curl -X DELETE \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  "https://bangkok-wine-scout-worker.example/admin/events/line-625..."
```

### Review items

The browser admin interface also loads `GET /admin/review-items` into a separate
**Unpublished / Needs review** section. This endpoint returns only V2 agent
submissions whose status is `needs_review`; it does not return or publish
canonical events. Existing extracted title, event date, venue, received/created
timestamps, source, review reason, and an authenticated thumbnail URL are
returned when available. Missing extracted fields are `null`.

`DELETE /admin/review-items/:reviewItemId` permanently removes only a submission
that is still in `needs_review`, its diagnostics and item rows, and its unshared
R2 source/analysis objects. A submission in any other status returns `409` and
no canonical `events` row is deleted. Both endpoints accept the same signed
browser session or Bearer token as the existing event administration routes and
return `Cache-Control: no-store`.

### `POST /admin/events/bulk-delete`

Permanently deletes 1–100 unique event IDs. The endpoint accepts the same Bearer
token or signed browser session as the single-delete endpoint and calls the
central complete-deletion service separately for every selected event. One
failure does not hide the results of other IDs, and failed cleanup remains safe
to retry.

```sh
curl -X POST \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"eventIds":["event-1","event-2"]}' \
  "https://bangkok-wine-scout-worker.example/admin/events/bulk-delete"
```

```json
{
  "success": true,
  "requested": 2,
  "deleted": 2,
  "alreadyMissing": 0,
  "failed": 0,
  "results": [
    { "eventId": "event-1", "success": true, "eventFound": true },
    { "eventId": "event-2", "success": true, "eventFound": true }
  ]
}
```

The response reports database rows and R2 objects deleted or missing. If an R2
operation fails, the event stays unpublished and its database ownership records
are retained; `success` is `false` and the same request can be retried. Unexpected
database failures return a generic `500` without a stack trace.

Set the secret before deployment:

```sh
npx wrangler secret put ADMIN_API_TOKEN
```
