# Architecture

## Product scope

Bangkok Wine Scout collects, analyses, reviews, and publishes wine-event information for Bangkok.

The MVP processes events from two source types:

1. Flyers or images sent through LINE
2. Event pages discovered on websites

Both source types will eventually use the same event-processing pipeline.

## Current architecture

```text
LINE user
   |
   v
LINE Messaging API
   |
   v
Cloudflare Worker webhook
   |
   v
Command router
   |-- help
   |-- about
   |-- version
   `-- ping
   |
   v
LINE reply service
```

## Target event pipeline

```text
LINE flyer / website event
          |
          v
    Intake service
          |
          +--------> Cloudflare R2 (original image)
          |
          v
    AI extraction
          |
          v
   Draft event record
          |
          v
    Review dashboard
     |      |      |
  Publish  Edit  Ignore
          |
          v
      Cloudflare D1
          |
          v
      Website / LINE
```

## Main components

### Webhook

Receives LINE events, verifies requests, and delegates work. It must not contain business logic.

### Command router

Routes text commands to dedicated command handlers.

### Event intake service

Accepts flyers, images, event links, and future website discoveries. It creates an intake record before analysis begins.

### R2 image storage

Stores the original event flyer or image. D1 stores only the R2 object key and metadata.

### AI extraction service

Extracts structured event information such as title, date, time, venue, price, organiser, description, and booking link. It also records confidence information and the original AI output for review.

### Review dashboard

Allows an administrator to publish, edit, or ignore proposed events.

### D1 database

Stores event records, source information, review status, and processing metadata.

## Architectural boundaries

- LINE-specific code stays inside LINE adapters and services.
- Event business logic is independent of LINE and website sources.
- Original images live in R2, not D1.
- Only reviewed events may be published.
- AI output is treated as a proposal, never as authoritative data.
- Bottle recognition and cellar management are outside the current scope.
