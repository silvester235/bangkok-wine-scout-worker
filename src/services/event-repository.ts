import type { NormalizedWineEvent } from './event-normalizer';

export type EventAssetRole = 'main' | 'menu' | 'map' | 'social' | 'other';

export interface StoredWineEventInput {
	intakeId: string;
	assetId: string;
	assetRole?: EventAssetRole;
	title: string | null;
	event: NormalizedWineEvent;
}

export interface SaveWineEventResult {
	id: string;
	duplicate: boolean;
}

interface ExistingEventRow {
	id: string;
}

function canonicalText(value: string | null): string | null {
	if (!value) return null;
	const normalized = value
		.normalize('NFC')
		.toLocaleLowerCase('en-US')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.replace(/\s+/g, ' ');
	return normalized || null;
}

async function findDuplicateEvent(db: D1Database, input: StoredWineEventInput): Promise<ExistingEventRow | null> {
	const canonicalTitle = canonicalText(input.title);
	if (!canonicalTitle || !input.event.date) return null;

	const candidates = await db
		.prepare(
			`SELECT id, title, venue
			FROM events
			WHERE event_date = ?
			ORDER BY created_at DESC`,
		)
		.bind(input.event.date)
		.all<{ id: string; title: string | null; venue: string | null }>();

	const canonicalVenue = canonicalText(input.event.venue);
	for (const candidate of candidates.results ?? []) {
		if (canonicalText(candidate.title) !== canonicalTitle) continue;

		const candidateVenue = canonicalText(candidate.venue);
		// A matching title and date is sufficient when one version has no venue.
		// When both venues exist, they must also match to avoid merging distinct events.
		if (canonicalVenue && candidateVenue && canonicalVenue !== candidateVenue) continue;

		return { id: candidate.id };
	}

	return null;
}

async function linkEventAsset(
	db: D1Database,
	eventId: string,
	input: StoredWineEventInput,
	linkedAt: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO event_assets (
				event_id,
				intake_id,
				asset_id,
				asset_role,
				linked_at
			) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(event_id, asset_id) DO UPDATE SET
				asset_role = excluded.asset_role`,
		)
		.bind(
			eventId,
			input.intakeId,
			input.assetId,
			input.assetRole ?? 'other',
			linkedAt,
		)
		.run();
}

export async function saveWineEvent(db: D1Database, input: StoredWineEventInput): Promise<SaveWineEventResult> {
	const existing = await findDuplicateEvent(db, input);
	const id = existing?.id ?? `${input.intakeId}:${input.assetId}`;
	const createdAt = new Date().toISOString();

	if (existing) {
		await db
			.prepare(
				`UPDATE events SET
					title = COALESCE(?, title),
					event_date = COALESCE(?, event_date),
					start_time = COALESCE(?, start_time),
					price_thb = COALESCE(?, price_thb),
					venue = COALESCE(?, venue),
					contact_email = COALESCE(?, contact_email),
					contact_phone = COALESCE(?, contact_phone),
					wines_json = CASE WHEN ? <> '[]' THEN ? ELSE wines_json END,
					is_wine_event = CASE WHEN ? = 1 THEN 1 ELSE is_wine_event END
				WHERE id = ?`,
			)
			.bind(
				input.title,
				input.event.date,
				input.event.startTime,
				input.event.priceTHB,
				input.event.venue,
				input.event.contactEmail,
				input.event.contactPhone,
				JSON.stringify(input.event.wines),
				JSON.stringify(input.event.wines),
				input.event.isWineEvent ? 1 : 0,
				id,
			)
			.run();

		await linkEventAsset(db, id, input, createdAt);
		return { id, duplicate: true };
	}

	await db
		.prepare(
			`INSERT INTO events (
				id,
				intake_id,
				asset_id,
				title,
				event_date,
				start_time,
				price_thb,
				venue,
				contact_email,
				contact_phone,
				wines_json,
				is_wine_event,
				created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(asset_id) DO UPDATE SET
				title = excluded.title,
				event_date = excluded.event_date,
				start_time = excluded.start_time,
				price_thb = excluded.price_thb,
				venue = excluded.venue,
				contact_email = excluded.contact_email,
				contact_phone = excluded.contact_phone,
				wines_json = excluded.wines_json,
				is_wine_event = excluded.is_wine_event`,
		)
		.bind(
			id,
			input.intakeId,
			input.assetId,
			input.title,
			input.event.date,
			input.event.startTime,
			input.event.priceTHB,
			input.event.venue,
			input.event.contactEmail,
			input.event.contactPhone,
			JSON.stringify(input.event.wines),
			input.event.isWineEvent ? 1 : 0,
			createdAt,
		)
		.run();

	await linkEventAsset(db, id, input, createdAt);
	return { id, duplicate: false };
}
