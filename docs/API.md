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
        "alt": "Flyer for Austrian Wine Masterclass"
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

`PUBLIC_SITE_ORIGIN` configures the one allowed frontend origin and must be set to the deployed website origin. Matching requests receive explicit CORS headers and `Vary: Origin`; other origins receive no allow-origin header. Missing or invalid configuration simply grants no cross-origin access and does not affect same-origin or unrelated routes. `OPTIONS` preflight returns `204`. Public resources support `GET` and `HEAD`; other methods return structured `405` with `Allow: GET, HEAD, OPTIONS`. Tests use `https://frontend.example.com` as the documented development origin.

## LINE webhook

### `POST /webhook`

Receives LINE Messaging API webhook events. Known commands are routed to the command router. Non-command, non-empty text with a correlation identity is persisted as pending event context and acknowledged with the configured correlation window. Images are queued, preserved in R2, fused with eligible LINE text, extracted, normalized, resolved, merged, and linked as event assets.

Supported commands: `ping`, `help`, `version`, and `about`.

LINE retries are idempotent by message and asset identifiers. A successful intake acknowledgement precedes OCR, extraction, and persistence. Recoverable OCR or extraction failure creates a published `Wine Event` fallback with a public flyer; storage, D1, asset-link, binding, download, and malformed-message failures remain retryable technical failures.

## Security boundary

- The public API has no mutation, admin, review, or publication endpoints.
- SQL uses prepared statements and fixed query fragments.
- Public identifiers never grant direct R2-key access.
- Publication follows successful technical processing; metadata warnings do not block it.
- Error responses do not include SQL errors or stack traces.
