# Deployment

## Requirements

- Node.js
- npm
- Cloudflare account
- Wrangler authentication
- LINE Messaging API channel

## Install dependencies

```bash
npm install
```

## Required R2 bucket

The durable LINE image-intake pipeline uses the Wrangler binding `EVENT_INTAKES` and the R2 bucket `bangkok-wine-scout-intakes`.

Create the bucket once before the first deployment:

```bash
npx wrangler r2 bucket create bangkok-wine-scout-intakes
```

The binding is already configured in `wrangler.jsonc`.

Each LINE image is stored below a deterministic prefix derived from the LINE message ID:

```text
intakes/line-{message-id}/original
intakes/line-{message-id}/metadata.json
```

This makes repeated LINE webhook delivery idempotent. The acknowledgement confirms durable storage only; it does not confirm extraction, review, or publication.

## Local development

```bash
npm run dev
```

Local R2 data is managed by Wrangler's local development environment.

## Deploy to Cloudflare Workers

```bash
npm run deploy
```

## Required secrets

Configure secrets with Wrangler. Never commit secret values.

```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET
```

Future phases may add secrets for AI providers and dashboard authentication.

## Current bindings

| Binding | Resource | Purpose |
|---|---|---|
| `EVENT_INTAKES` | R2 bucket `bangkok-wine-scout-intakes` | Original LINE images and durable intake metadata |

## Planned bindings

The next persistence phase will add a D1 database for searchable intake state, extraction results, canonical events, and review workflow data.

## Verification checklist

After deployment:

- Worker deployment completed successfully
- Worker URL is reachable
- LINE webhook verification succeeds
- `ping` returns `pong`
- `help`, `about`, and `version` return expected replies
- Cloudflare logs show no unhandled errors

For image intake:

- Send one image to the LINE account
- LINE replies that the flyer was stored for review
- R2 contains the original object and `metadata.json`
- Send or replay the same LINE message ID
- The existing intake is recognized rather than creating a second prefix
- A failed downstream phase cannot remove the original image

## Rollback

Use Cloudflare deployment history to restore a known working version. Code changes should also be reversible through Git.

## Deployment rules

- Test locally before deployment.
- Keep secrets outside the repository.
- Deploy small, reviewable changes.
- Update documentation when bindings, routes, or secrets change.
# LINE message batching

Set `LINE_MESSAGE_BATCH_WINDOW_SECONDS` and `LINE_IMAGE_BATCH_WINDOW_SECONDS` to
positive integers no greater than 86400. Text/web intake uses the message window
(default `60`); image placeholder registration and its first automatic close use
the image window (default `15`). A later related message can extend the shared
batch using its own configured window.
Queue producers must support per-message `delaySeconds`; no additional queue is
required. Asset completion also ensures an expiration or current-token
continuation job, so a lost or early delayed check cannot strand the batch. Apply
`0007_line_image_batches.sql`, `0008_line_message_batch_texts.sql`,
and `0009_batch_lifecycle.sql` before deploying the Worker. `/done` uses the
same queue but closes and dispatches the batch immediately. If bindings change, run
`npx wrangler types` as required by the project workflow.
