# ADR-0002: Use a Shared Event Pipeline

- Status: Accepted
- Date: 2026-07-31

## Context

Bangkok Wine Scout will receive event candidates from more than one source, initially LINE flyers and website event pages.

A source-by-source implementation would duplicate extraction, normalization, validation, duplicate detection, review, and publication logic. It would also make it difficult to preserve original evidence, retry failed processing, and guarantee that AI output cannot publish directly.

The system needs a durable workflow that supports asynchronous or repeated processing, human review, and future source adapters without coupling the event domain to LINE, a website collector, or one AI provider.

## Decision

Use one shared event pipeline with the following ordered responsibilities:

1. Source adapter
2. Durable intake and source preservation
3. Extraction
4. Normalization
5. Validation and confidence scoring
6. Duplicate candidate search
7. Canonical draft creation
8. Human review
9. Publication

All source adapters create the same intake contract. All successful intakes produce or update one canonical draft event. Publication requires an explicit human decision.

Cloudflare services have distinct roles:

- Workers receive requests and coordinate pipeline stages
- R2 stores immutable original images and source artifacts
- D1 stores workflow state, canonical event data, confidence, and processing metadata

Provider-specific AI responses remain inside extraction adapters. Downstream stages consume provider-neutral domain types.

## State model

Intakes progress through explicit states such as:

```text
received -> stored -> analysing -> ready_for_review
                    \-> failed
ready_for_review -> ignored
failed -> analysing
```

Events progress through explicit states such as:

```text
draft -> needs_review -> published
   |          |
   +----------+-> ignored
published -> sold_out
published -> cancelled
```

Invalid transitions must fail visibly rather than silently changing state.

## Consequences

### Positive

- LINE and website sources share the same business logic
- Original evidence is preserved before analysis
- Failed stages can be retried safely
- AI providers can change without changing the event domain
- Duplicate detection is consistent across sources
- Review and publication rules are enforced in one place
- Future source adapters can be added with limited impact

### Negative

- More domain types and service boundaries are required early
- Workflow states and transitions require tests
- R2 and D1 must be coordinated carefully
- Reprocessing and idempotency rules add implementation complexity

## Implementation rules

- Webhook and collector handlers remain thin
- Stable source references are used for idempotent intake creation
- Original source objects are not overwritten after storage
- Raw extraction output is retained
- Normalization is deterministic and provider-independent
- Duplicate matches are review candidates, not automatic deletions
- Reprocessing one intake updates its draft rather than creating uncontrolled copies
- Public consumers can read published events only
- Logs correlate work by intake and event ID without exposing secrets

## Rejected alternatives

### Separate pipelines for LINE and websites

Rejected because extraction, validation, duplicate detection, and review behaviour would diverge and be duplicated.

### AI extraction writes directly to published events

Rejected because source material is ambiguous and AI output requires human verification.

### Store original images in D1

Rejected because binary source artifacts belong in R2; D1 stores references and metadata.

### Automatically merge probable duplicates

Rejected for the MVP because similarity signals can be wrong. Human review remains the safe decision point.
