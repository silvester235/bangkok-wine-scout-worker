import type { WorkerEnv } from '../types/env';

interface EventRow {
	id: string;
	intake_id: string;
	asset_id: string;
	title: string | null;
	event_date: string | null;
	start_time: string | null;
	price_thb: number | null;
	venue: string | null;
	contact_email: string | null;
	contact_phone: string | null;
	wines_json: string;
	is_wine_event: number;
	created_at: string;
}

function parseWines(value: string): unknown[] {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export async function handleEvents(env: WorkerEnv): Promise<Response> {
	const result = await env.DB.prepare(
		`SELECT
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
		FROM events
		ORDER BY created_at DESC`,
	).all<EventRow>();
	
	const events = (result.results ?? []).map((row) => ({
		id: row.id,
		intakeId: row.intake_id,
		assetId: row.asset_id,
		title: row.title,
		date: row.event_date,
		startTime: row.start_time,
		priceTHB: row.price_thb,
		venue: row.venue,
		contactEmail: row.contact_email,
		contactPhone: row.contact_phone,
		wines: parseWines(row.wines_json),
		isWineEvent: row.is_wine_event === 1,
		createdAt: row.created_at,
	}));

	return Response.json({
		count: events.length,
		events,
	});
}
