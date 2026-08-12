# LINE V2 isolated preview deployment

This runbook prepares a completely separate Cloudflare deployment for manual end-to-end testing. It does not authorize deployment. Every command that can affect Cloudflare explicitly names `wrangler.v2-preview.jsonc` and a preview-only resource.

## Isolation design

The preview uses a separate Wrangler file rather than a named environment inside the production file. This avoids binding inheritance mistakes and makes accidental use of production resources fail closed.

| Resource | Preview value |
| --- | --- |
| Worker | `bangkok-wine-scout-v2-preview` |
| D1 | `bangkok-wine-scout-v2-preview-db` |
| R2 | `bangkok-wine-scout-v2-preview-assets` |
| Workflow | `bangkok-wine-scout-v2-preview-workflow` |
| Workflow class | `WineScoutSubmissionWorkflow` |
| Vision model | `@cf/mistralai/mistral-small-3.1-24b-instruct` |
| V2 route | `POST /api/line/v2/webhook` |
| V1 route in source | `POST /webhook` (unchanged) |

The preview has no Queue binding and no cron trigger. V2 does not call `IMAGE_PROCESSING_QUEUE` or the V1 outbox reconciliation scheduler. Omitting both reduces the chance of preview traffic entering the V1 delivery pipeline. The preview Worker still contains the existing V1 route because both routes share one entry point, but it has no production LINE credentials and all of its storage bindings are preview-only. Configure only the separate LINE test channel to call V2.

`PUBLIC_SITE_ORIGIN` is deliberately empty so LINE notifications cannot link to the production website. Preview events are inspected through the preview Worker's own API.

## Pre-deployment review gate

Do not continue until all of these are true:

- The D1 ID in `wrangler.v2-preview.jsonc` is still the all-zero placeholder or is the ID returned for `bangkok-wine-scout-v2-preview-db`.
- The production D1 ID remains unchanged in `wrangler.jsonc`.
- `EVENT_INTAKES` names only `bangkok-wine-scout-v2-preview-assets` in the preview file.
- The separate LINE test channel—not the production channel—is available.
- The full test suite is green, or every remaining failure has been explicitly accepted.
- The deployment command has been reviewed and explicitly approved.

## Create preview resources

These commands create remote resources. Run them only after the configuration review. They do not migrate or alter production resources.

```bash
npx wrangler d1 create bangkok-wine-scout-v2-preview-db --location apac --config wrangler.v2-preview.jsonc
npx wrangler r2 bucket create bangkok-wine-scout-v2-preview-assets --config wrangler.v2-preview.jsonc
```

Copy the UUID printed by `d1 create` into the preview file only:

```jsonc
"database_id": "<UUID RETURNED FOR bangkok-wine-scout-v2-preview-db>"
```

Never copy the production ID `0fe8aec8-170f-47da-8abb-303cae3d1103`. Verify both preview resources before migrations:

```bash
npx wrangler d1 info bangkok-wine-scout-v2-preview-db --config wrangler.v2-preview.jsonc
npx wrangler r2 bucket info bangkok-wine-scout-v2-preview-assets --config wrangler.v2-preview.jsonc
```

R2 bucket names are account-global, lowercase, and isolated namespaces. Reusing the same object keys cannot overwrite production objects because the preview binding names a different bucket. Do not add a custom domain or public-development URL to the R2 bucket.

## Apply and verify preview migrations

First confirm that the complete ordered migration chain, including V2 and its event-storage dependencies, is present locally:

```bash
ls migrations/*.sql
test -f migrations/0018_agent_submissions_v2.sql
npx wrangler d1 migrations list bangkok-wine-scout-v2-preview-db --remote --config wrangler.v2-preview.jsonc
```

Apply migrations by immutable database name rather than the generic `DB` binding:

```bash
npx wrangler d1 migrations apply bangkok-wine-scout-v2-preview-db --remote --config wrangler.v2-preview.jsonc
```

Verify migration 0018 was recorded:

```bash
npx wrangler d1 execute bangkok-wine-scout-v2-preview-db --remote --config wrangler.v2-preview.jsonc --command "SELECT name FROM d1_migrations WHERE name = '0018_agent_submissions_v2.sql';"
```

Verify the four V2 tables:

```bash
npx wrangler d1 execute bangkok-wine-scout-v2-preview-db --remote --config wrangler.v2-preview.jsonc --command "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('agent_submissions','agent_submission_items','agent_submission_diagnostics','agent_v2_webhook_receipts') ORDER BY name;"
```

The query must return all four rows. Every D1 command above contains the preview database name and `--remote`; none targets production.

## Configure preview-only secrets

Use values from the separate LINE test channel. Do not reuse the V1 channel secret or access token, and do not paste values into shell history or configuration files. Each command prompts interactively:

```bash
npx wrangler secret put LINE_V2_CHANNEL_SECRET --config wrangler.v2-preview.jsonc
npx wrangler secret put LINE_V2_CHANNEL_ACCESS_TOKEN --config wrangler.v2-preview.jsonc
npx wrangler secret put ADMIN_API_TOKEN --config wrangler.v2-preview.jsonc
```

Current Wrangler behavior creates a Worker version and deploys it immediately when `secret put` is used. Treat these as deployment commands: do not run them before the deployment review and approval. `ADMIN_API_TOKEN` should be a new random preview-only value and protects submission diagnostics.

## Verification and deployment commands

The build and dry-run commands do not call Workers AI. AI usage begins only when a deployed preview submission reaches the analysis step.

```bash
npm test
npx tsc --noEmit
npx wrangler types
npx wrangler types /tmp/bangkok-wine-scout-v2-preview-types.d.ts --config wrangler.v2-preview.jsonc
npx wrangler deploy --dry-run --config wrangler.v2-preview.jsonc
```

After the D1 UUID has replaced the placeholder, all tests pass, secrets are configured, and deployment is explicitly approved, the exact deployment command is:

```bash
npx wrangler deploy --config wrangler.v2-preview.jsonc
```

Expected URL format:

```text
https://bangkok-wine-scout-v2-preview.<ACCOUNT_WORKERS_DEV_SUBDOMAIN>.workers.dev/api/line/v2/webhook
```

Set that URL only in the separate LINE test channel. Do not alter the production channel's webhook URL.

## Runtime verification

The Workflow binding uses `WineScoutSubmissionWorkflow` from the same preview Worker. Submission IDs are also Workflow instance IDs. The route first reads the persisted `workflow_instance_id`, creates only when absent, and recovers with `get(id)` if creation races. `/done` and inactivity closure therefore signal the same durable instance, while stable event ID `agent:{submissionId}` keeps persistence retries idempotent.

Final structured Workflow logs contain:

```text
submissionId
workflowInstanceId
model
includedAssetCount
includedImageBytes
decision
confidence
resultEventId
status
```

They do not contain image bytes, base64 data, LINE secrets, or authorization headers. Filter preview Worker logs by `component=agent_submission_v2` and confirm the model is `@cf/mistralai/mistral-small-3.1-24b-instruct`.

Because the preview Workflow receives `DB`, `EVENT_INTAKES`, and `AI` from the preview Worker configuration, it has no binding capability to production D1 or R2.

## Inspect preview results

Published preview events are available from the existing public endpoint backed by preview D1:

```text
GET https://bangkok-wine-scout-v2-preview.<ACCOUNT_WORKERS_DEV_SUBDOMAIN>.workers.dev/api/events?includePast=true
GET https://bangkok-wine-scout-v2-preview.<ACCOUNT_WORKERS_DEV_SUBDOMAIN>.workers.dev/api/events/<slug>
```

Inspect submission state directly in the preview D1 database:

```bash
npx wrangler d1 execute bangkok-wine-scout-v2-preview-db --remote --config wrangler.v2-preview.jsonc --command "SELECT id,status,workflow_instance_id,result_event_id,result_action,error_code FROM agent_submissions ORDER BY created_at DESC LIMIT 20;"
```

No preview event can appear on the production website because both the event API and event writes use the preview D1 binding, and `PUBLIC_SITE_ORIGIN` is empty.

## Manual end-to-end checklist

For every case, record the LINE message IDs, `submissionId`, `workflowInstanceId`, final status, result event ID, relevant structured log, debug response, and event API response.

1. **Problem flyer:** Send the flyer whose phone, address, or booking details were previously missed, then `/done`. Confirm image-only evidence can populate those fields, `fieldEvidence` references `IMAGE_1`, and OCR disagreement is recorded.
2. **Flyer plus menu:** Send flyer, menu, `/done`. Confirm one submission, one event, flyer selected as deterministic main image, menu linked as supplementary, and no duplicate event.
3. **Text plus flyer:** Send explanatory text followed by the flyer and `/done`. Confirm `TEXT_1` and image evidence are combined into one event.
4. **Existing event update:** Resend supplementary material for a preview event. Confirm the same preview event ID is updated and matcher/merger diagnostics are retained.
5. **Conflicting events:** Send two clearly different flyers together. Confirm `needs_review`, `result_event_id IS NULL`, and no event is published.
6. **Menu only:** Send only a menu or wine list. Confirm controlled review/rejection and no new published event.
7. **Duplicate delivery:** Replay an identical signed webhook body. Confirm one submission item, one asset, one Workflow ID, and one event ID.
8. **Inactivity close:** Send material without `/done`. After `AGENT_SUBMISSION_WINDOW_SECONDS`, confirm `closed_at` is set and exactly one Workflow reaches a terminal state.

Useful duplicate checks:

```sql
SELECT source_message_id,COUNT(*) FROM agent_submission_items GROUP BY source_message_id HAVING COUNT(*) > 1;
SELECT workflow_instance_id,COUNT(*) FROM agent_submissions WHERE workflow_instance_id IS NOT NULL GROUP BY workflow_instance_id HAVING COUNT(*) > 1;
SELECT result_event_id,COUNT(*) FROM agent_submissions WHERE result_event_id IS NOT NULL GROUP BY result_event_id HAVING COUNT(*) > 1;
```

All three queries should return no unintended duplicates.

## Cleanup

For individual running instances, terminate only a recorded preview instance ID:

```bash
npx wrangler workflows instances terminate bangkok-wine-scout-v2-preview-workflow <PREVIEW_INSTANCE_ID> --rollback --config wrangler.v2-preview.jsonc
```

For complete teardown after testing, first review every literal name, then run the following interactively. Do not add `--skip-confirmation`, `--force`, or a broad cleanup endpoint.

```bash
npx wrangler workflows delete bangkok-wine-scout-v2-preview-workflow --config wrangler.v2-preview.jsonc
npx wrangler delete bangkok-wine-scout-v2-preview --config wrangler.v2-preview.jsonc
npx wrangler d1 delete bangkok-wine-scout-v2-preview-db --config wrangler.v2-preview.jsonc
```

R2 must be empty before deletion. Use the Cloudflare dashboard's **Empty Bucket** action on exactly `bangkok-wine-scout-v2-preview-assets`, verify the displayed name twice, then run:

```bash
npx wrangler r2 bucket delete bangkok-wine-scout-v2-preview-assets --config wrangler.v2-preview.jsonc
```

Deleting the preview Workflow removes its instances. Deleting the preview D1 removes preview events, submissions, receipts, and diagnostics. Emptying/deleting the preview R2 bucket removes originals and private AI diagnostics. None of these commands names a production resource.

## Current deployment gate

The authorized null-aware acknowledgement-expiration correction is implemented and verified. Type checking, production and preview type generation, and the preview dry-run build pass. The full suite runs 391 tests and all 391 pass. The code-verification gate is clear; real deployment remains blocked until the preview D1 UUID replaces the placeholder, preview-only secrets are available, the separate LINE test channel is ready, and deployment is explicitly approved.
