# Roadmap

The roadmap is intentionally focused on wine events. Bottle analysis, cellar inventory, and personal wine ratings will be considered only after the event product is stable.

## Phase 1 – LINE infrastructure

- [x] Create LINE Official Account
- [x] Deploy webhook on Cloudflare Workers
- [x] Verify LINE webhook requests
- [x] Receive and reply to text messages
- [x] Add command router
- [x] Add `help`, `about`, `version`, and `ping` commands

## Phase 2 – Event intake

- [ ] Receive event flyers and images through LINE
- [ ] Retrieve image content from LINE
- [ ] Store original images in Cloudflare R2
- [ ] Create intake metadata
- [ ] Acknowledge successful receipt in LINE
- [ ] Display original submissions in a basic dashboard

## Phase 3 – AI event extraction

- [ ] Analyse flyers
- [ ] Extract event title
- [ ] Extract date and time
- [ ] Extract venue and address
- [ ] Extract organiser
- [ ] Extract price and currency
- [ ] Extract booking link and contact details
- [ ] Store raw extraction output
- [ ] Calculate field-level and overall confidence
- [ ] Flag missing or ambiguous information

## Phase 4 – Review workflow

- [ ] Create review dashboard
- [ ] Show original flyer beside extracted data
- [ ] Add Edit action
- [ ] Add Publish action
- [ ] Add Ignore action
- [ ] Store reviewed events in Cloudflare D1
- [ ] Record review timestamps and status changes

## Phase 5 – Integration

- [ ] Feed website discoveries into the same intake pipeline
- [ ] Detect duplicate events
- [ ] Maintain one shared event database
- [ ] Publish approved events to the website
- [ ] Search approved events through LINE
- [ ] Add date, venue, and price filters

## Deferred scope

The following features are explicitly deferred:

- Wine bottle label recognition
- Personal wine collection
- Bottle inventory
- Cellar locations
- Tasting notes and ratings
- Wine recommendations based on owned bottles
