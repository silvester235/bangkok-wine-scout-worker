# ADR-0003: Allow Multiple Assets per Event Intake

- Status: Accepted
- Date: 2026-07-31

## Context

A wine event may be described by several separate flyers or documents. A typical submission can contain an invitation, a menu, and a wine list. These files describe one event and must be analysed together.

LINE delivers these images as separate message events and does not provide a dependable shared album identifier for grouping them into one business event.

## Decision

Model an event submission as an `event_intake` containing one or more `event_intake_assets`.

Each asset:

- keeps its own LINE message ID or source reference
- is stored independently and immutably in R2
- has its own MIME type, role, ordering, and optional content hash
- remains idempotent at asset level

The extraction stage reads the complete ordered asset collection and produces one canonical event draft. Asset-level evidence is retained for review.

LINE multi-image grouping will use an explicit durable submission session rather than silently grouping messages with a timing heuristic. The intended interaction is:

1. Start a new event submission
2. Send one or more flyers
3. Finish the submission
4. Analyse all collected assets together

## Consequences

- One intake can represent invitation, menu, wine list, and supporting material.
- Re-delivery of one LINE image does not duplicate the asset.
- A single image remains a valid one-asset intake.
- Extraction and review interfaces must support multiple source assets.
- A durable session store, expected to use D1 or a Durable Object, is required before automatic LINE grouping is enabled.
- Time-window-only grouping is rejected because unrelated events could be merged accidentally.
