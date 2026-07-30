# Coding Standards

## General principles

- Keep functions small and focused.
- Prefer clear names over clever abstractions.
- Avoid duplicated logic.
- Use TypeScript strictness and explicit types at system boundaries.
- Validate all external input.
- Log errors with enough context to investigate them without exposing secrets.

## Architecture

- Webhook handlers only verify, parse, and delegate.
- Business logic belongs in commands or services.
- LINE-specific code must not leak into event-domain logic.
- Website and LINE sources must converge on the same event-intake model.
- AI output must pass through human review before publication.
- Original source material must be preserved.

## Commands

- Each command lives in its own module.
- Commands return predictable results.
- Commands do not call external APIs directly when a reusable service exists.

## Services

- Services encapsulate external APIs such as LINE, R2, D1, and AI providers.
- Services expose domain-friendly interfaces.
- Retries and provider-specific error handling belong inside the relevant service.

## Event data

- Use `Asia/Bangkok` as the default event timezone.
- Store timestamps in ISO 8601 format.
- Preserve source wording when normalization may lose information.
- Never invent missing event data.
- Ambiguous fields must be marked for review.

## Security

- Never commit secrets or tokens.
- Verify LINE webhook signatures before processing events.
- Authenticate all non-public dashboard routes.
- Avoid logging access tokens, signatures, full user identifiers, or raw private payloads unnecessarily.

## Commits

Use small, meaningful commits with conventional prefixes where practical:

```text
feat: add LINE image intake
fix: handle missing reply token
docs: focus roadmap on events
refactor: extract R2 storage service
test: cover event date parsing
```

## Documentation

Update documentation whenever a change affects:

- Architecture
- Database schema
- Public or internal API contracts
- Deployment steps
- Secrets or Cloudflare bindings
- Project scope
