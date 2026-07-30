# ADR-0001: Introduce a Command Router

- Status: Accepted
- Date: 2026-07-31

## Context

The first LINE webhook handled message behaviour directly. As additional commands and event-intake message types are added, keeping all routing and reply logic inside the webhook would make the code difficult to test and maintain.

The application must eventually distinguish between:

- Text commands
- Unknown text messages
- Event flyers and images
- Event links
- Future administrative actions

## Decision

Introduce a central command router for text commands and keep the webhook responsible only for request verification, parsing, and delegation.

Dedicated command handlers implement commands such as:

- `help`
- `about`
- `version`
- `ping`

Image and event-intake routing will use the same principle: identify the message type, then delegate it to a dedicated handler or service.

## Consequences

### Benefits

- Commands are isolated and easier to test.
- The webhook remains small.
- New commands can be added without expanding one large conditional block.
- Event intake can be introduced without mixing it with existing text-command logic.
- LINE reply behaviour can be reused through a dedicated service.

### Trade-offs

- The project contains more files and interfaces.
- Developers must understand the routing boundary.
- Very small features may require a separate handler.

## Scope clarification

The router supports the event-focused Bangkok Wine Scout product. Wine bottle analysis, cellar inventory, and personal tasting features are not part of the current architecture.
