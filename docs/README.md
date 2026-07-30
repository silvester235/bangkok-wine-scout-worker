# Bangkok Wine Scout Documentation

Bangkok Wine Scout is an AI-supported event aggregator for wine events in Bangkok.

The current project scope is deliberately limited to events. Wine bottle recognition, cellar management, personal ratings, and bottle inventory are out of scope for the current MVP.

## Documents

| Document | Purpose |
|---|---|
| [Architecture.md](Architecture.md) | Current and planned system architecture |
| [Roadmap.md](Roadmap.md) | Event-focused delivery phases |
| [Database.md](Database.md) | Cloudflare D1 event data model |
| [API.md](API.md) | LINE commands, webhook behaviour, and planned event API |
| [Deployment.md](Deployment.md) | Local development and Cloudflare deployment |
| [Coding-Standards.md](Coding-Standards.md) | Development and architecture rules |
| [Decisions/ADR-0001-Command-Router.md](Decisions/ADR-0001-Command-Router.md) | Command-router decision record |

## Current status

Version: `v0.2.0`

Implemented:

- LINE Official Account integration
- Cloudflare Worker webhook
- LINE signature verification and replies
- Command router
- Commands: `help`, `about`, `version`, `ping`

Next milestone:

- Receive event flyers through LINE
- Store original images in Cloudflare R2
