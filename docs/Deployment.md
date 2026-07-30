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

## Local development

```bash
npm run dev
```

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

## Future bindings

Phase 2 and later will require Cloudflare bindings for:

- R2 bucket for original event images
- D1 database for event and intake records

Bindings must be defined in the Wrangler configuration and documented when introduced.

## Verification checklist

After deployment:

- Worker deployment completed successfully
- Worker URL is reachable
- LINE webhook verification succeeds
- `ping` returns `pong`
- `help`, `about`, and `version` return expected replies
- Cloudflare logs show no unhandled errors

After image intake is implemented:

- LINE image receives an acknowledgement
- Original image exists in R2
- Intake record exists in D1
- Failed analysis does not lose the original image

## Rollback

Use Cloudflare deployment history to restore a known working version. Code changes should also be reversible through Git.

## Deployment rules

- Test locally before deployment.
- Keep secrets outside the repository.
- Deploy small, reviewable changes.
- Update documentation when bindings, routes, or secrets change.
