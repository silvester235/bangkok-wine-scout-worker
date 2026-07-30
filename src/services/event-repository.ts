import type { NormalizedWineEvent } from './event-normalizer';

export interface StoredWineEventInput {
	intakeId: string;
	assetId: string;
	title: string | null;
	event: NormalizedWineEvent;
}

export async function saveWineEvent(db: D1Database, input: StoredWineEventInput): Promise<void> {
	const id = `${input.intakeId}:${input.assetId}`;
	const createdAt = new Date().toISOString();

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
}
