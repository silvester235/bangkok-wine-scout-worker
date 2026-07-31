import type { NormalizedWineEvent } from './event-normalizer';
import { matchExistingEvent, type ExistingEventCandidate } from './event-matcher';
import {
	resolveEventWithAi,
	type AiEventResolverConfig,
	type AiResolutionCandidate,
} from './ai-event-resolver';

export type EventAssetRole = 'main' | 'flyer' | 'menu' | 'reminder' | 'social' | 'map' | 'other';

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

export interface AiEventResolutionOptions {
	ai: Ai;
	resolver: AiEventResolverConfig;
	highThreshold: number;
	lowThreshold: number;
}

interface EventResolutionCandidate extends ExistingEventCandidate {
	priceTHB: number | null;
	description: string | null;
}

export async function findCandidateEvents(
	db: D1Database,
	incoming: Pick<ExistingEventCandidate, 'title' | 'date' | 'venue'>,
): Promise<EventResolutionCandidate[]> {
	if (!incoming.date && !incoming.title?.trim() && !incoming.venue?.trim()) return [];

	const result = await db
		.prepare(
			`SELECT
				id,
				title,
				event_date AS date,
				start_time AS startTime,
				venue,
				price_thb AS priceTHB,
				NULL AS description
			FROM events
			WHERE (
				?1 IS NOT NULL
				AND event_date BETWEEN date(?1, '-1 day') AND date(?1, '+1 day')
			) OR (
				?1 IS NULL
				AND (
					(?2 IS NOT NULL AND (
						LOWER(title) LIKE '%' || LOWER(?2) || '%'
						OR LOWER(?2) LIKE '%' || LOWER(title) || '%'
					))
					OR (?3 IS NOT NULL AND LOWER(venue) LIKE '%' || LOWER(?3) || '%')
				)
			)
			ORDER BY
				CASE WHEN event_date = ?1 THEN 0 ELSE 1 END,
				CASE WHEN LOWER(venue) = LOWER(?3) THEN 0 ELSE 1 END,
				CASE WHEN LOWER(title) = LOWER(?2) THEN 0 ELSE 1 END,
				created_at DESC
			LIMIT 15`,
		)
		.bind(incoming.date, incoming.title?.trim() || null, incoming.venue?.trim() || null)
		.all<EventResolutionCandidate>();

	return result.results ?? [];
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
			ON CONFLICT(asset_id) DO UPDATE SET
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

export async function saveWineEvent(
	db: D1Database,
	input: StoredWineEventInput,
	aiResolution?: AiEventResolutionOptions,
): Promise<SaveWineEventResult> {
	const incoming = {
		title: input.title,
		date: input.event.date,
		startTime: input.event.startTime,
		venue: input.event.venue,
	};
	const candidates = await findCandidateEvents(db, incoming);
	const match = matchExistingEvent(incoming, candidates);
	let resolvedEventId = match.eventId;
	const createdAt = new Date().toISOString();

	console.log('EVENT RESOLUTION', JSON.stringify({
		candidates: candidates.length,
		bestMatch: match.eventId,
		confidence: match.confidence,
		reasons: match.reasons,
		decision: match.matched ? 'MATCH' : 'NEW EVENT',
	}));

	const ambiguous = aiResolution
		&& match.confidence > aiResolution.lowThreshold
		&& match.confidence < aiResolution.highThreshold;
	if (ambiguous) {
		try {
			const aiResult = await resolveEventWithAi(
				aiResolution.ai,
				aiResolution.resolver,
				{
					title: input.title,
					venue: input.event.venue,
					date: input.event.date,
					time: input.event.startTime,
					price: input.event.priceTHB,
					description: null,
				},
				candidates.slice(0, 5).map((candidate): AiResolutionCandidate => ({
					id: candidate.id,
					title: candidate.title,
					venue: candidate.venue,
					date: candidate.date,
					time: candidate.startTime,
					price: candidate.priceTHB,
					description: candidate.description,
				})),
			);

			resolvedEventId = aiResult.decision === 'MATCH' ? aiResult.candidateId : null;
			console.log('AI EVENT RESOLUTION', JSON.stringify({
				candidates: Math.min(candidates.length, 5),
				deterministicConfidence: match.confidence,
				decision: aiResult.decision,
				candidateId: aiResult.candidateId,
				confidence: aiResult.confidence,
			}));
		} catch (error) {
			console.error('AI EVENT RESOLUTION FAILED', JSON.stringify({
				deterministicConfidence: match.confidence,
				error: error instanceof Error ? error.message : String(error),
			}));
		}
	}

	const id = resolvedEventId ?? `${input.intakeId}:${input.assetId}`;

	if (resolvedEventId) {
		await db
			.prepare(
				`UPDATE events SET
					title = CASE WHEN NULLIF(TRIM(title), '') IS NULL THEN NULLIF(TRIM(?), '') ELSE title END,
					event_date = COALESCE(event_date, ?),
					start_time = COALESCE(start_time, ?),
					price_thb = COALESCE(price_thb, ?),
					venue = CASE WHEN NULLIF(TRIM(venue), '') IS NULL THEN NULLIF(TRIM(?), '') ELSE venue END,
					contact_email = CASE WHEN NULLIF(TRIM(contact_email), '') IS NULL THEN NULLIF(TRIM(?), '') ELSE contact_email END,
					contact_phone = CASE WHEN NULLIF(TRIM(contact_phone), '') IS NULL THEN NULLIF(TRIM(?), '') ELSE contact_phone END,
					wines_json = CASE WHEN wines_json IS NULL OR wines_json = '[]' THEN ? ELSE wines_json END,
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
