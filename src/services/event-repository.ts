import type { NormalizedWineEvent } from './event-normalizer';
import { matchExistingEvent, type ExistingEventCandidate } from './event-matcher';
import {
	resolveEventWithAi,
	type AiEventResolverConfig,
	type AiResolutionCandidate,
} from './ai-event-resolver';
import { mergeEventData, type CanonicalEventData } from './event-merger';
import { createUniqueEventSlug } from './event-slug';

export type EventAssetRole = 'main' | 'flyer' | 'menu' | 'reminder' | 'social' | 'map' | 'other';
export type EventSourceType = 'line_image' | 'line_text' | 'other';

export interface EventSourceAssetInput {
	intakeId: string;
	assetId: string;
	assetRole?: EventAssetRole;
	sourceType: EventSourceType;
	sourceMessageId?: string;
	textContent?: string;
	isPublic?: boolean;
	r2ObjectKey?: string;
	contentType?: string;
}

export interface StoredWineEventInput {
	intakeId: string;
	assetId: string;
	assetRole?: EventAssetRole;
	sourceType?: EventSourceType;
	sourceMessageId?: string;
	isPublic?: boolean;
	relatedAssets?: EventSourceAssetInput[];
	r2ObjectKey?: string;
	contentType?: string;
	title: string | null;
	event: NormalizedWineEvent;
}

export interface SaveWineEventResult {
	id: string;
	duplicate: boolean;
}

export interface EventCleanupAsset {
	assetId: string;
	intakeId: string;
	sourceType: EventSourceType;
	sourceMessageId: string | null;
	r2ObjectKey: string | null;
}

export interface EventCleanupTarget {
	id: string;
	slug: string;
	assets: EventCleanupAsset[];
}

export async function countEvents(db: D1Database): Promise<number> {
	const row = await db.prepare('SELECT COUNT(*) AS count FROM events').first<{ count: number }>();
	return row?.count ?? 0;
}

export async function findEventCleanupTargetBySlug(db: D1Database, slug: string): Promise<EventCleanupTarget | null> {
	const event = await db.prepare('SELECT id, slug FROM events WHERE slug = ? LIMIT 1')
		.bind(slug).first<{ id: string; slug: string }>();
	if (!event) return null;
	const rows = await db.prepare(
		`SELECT asset_id, intake_id, source_type, source_message_id, r2_object_key
		 FROM event_assets WHERE event_id = ? ORDER BY linked_at, asset_id`,
	).bind(event.id).all<{ asset_id: string; intake_id: string; source_type: EventSourceType; source_message_id: string | null; r2_object_key: string | null }>();
	return { ...event, assets: (rows.results ?? []).map((row) => ({
		assetId: row.asset_id, intakeId: row.intake_id, sourceType: row.source_type,
		sourceMessageId: row.source_message_id, r2ObjectKey: row.r2_object_key,
	})) };
}

export async function isAssetLinkedToAnotherEvent(db: D1Database, assetId: string, eventId: string): Promise<boolean> {
	return await db.prepare('SELECT 1 AS found FROM event_assets WHERE asset_id = ? AND event_id <> ? LIMIT 1')
		.bind(assetId, eventId).first<{ found: number }>() !== null;
}

export async function deleteEventWithAssetLinks(db: D1Database, eventId: string, assetIds: string[]): Promise<{ eventAssets: number; event: number }> {
	const statements = assetIds.map((assetId) => db.prepare('DELETE FROM event_assets WHERE event_id = ? AND asset_id = ?').bind(eventId, assetId));
	statements.push(db.prepare('DELETE FROM events WHERE id = ?').bind(eventId));
	const results = await db.batch(statements);
	return {
		eventAssets: results.slice(0, -1).reduce((sum, result) => sum + (result.meta.changes ?? 0), 0),
		event: results.at(-1)?.meta.changes ?? 0,
	};
}

export async function findEventIdByAssetId(db: D1Database, assetId: string): Promise<string | null> {
	const row = await db.prepare(
		'SELECT event_id FROM event_assets WHERE asset_id = ? LIMIT 1',
	).bind(assetId).first<{ event_id: string }>();
	return row?.event_id ?? null;
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

interface ExistingEventRow {
	title: string | null;
	event_date: string | null;
	start_time: string | null;
	price_thb: number | null;
	venue: string | null;
	contact_email: string | null;
	contact_phone: string | null;
	wines_json: string;
	wine_regions_json: string;
	is_wine_event: number;
	status: string;
	published_at: string | null;
}

interface StoredCanonicalEvent extends CanonicalEventData {
	status: string;
	publishedAt: string | null;
}

function parseStringArray(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
	} catch {
		return [];
	}
}

async function findEventById(db: D1Database, eventId: string): Promise<StoredCanonicalEvent | null> {
	const row = await db
		.prepare(
			`SELECT
				title,
				event_date,
				start_time,
				price_thb,
				venue,
				contact_email,
				contact_phone,
				wines_json,
				wine_regions_json,
				is_wine_event,
				status,
				published_at
			FROM events
			WHERE id = ?`,
		)
		.bind(eventId)
		.first<ExistingEventRow>();

	if (!row) return null;
	return {
		title: row.title,
		date: row.event_date,
		startTime: row.start_time,
		priceTHB: row.price_thb,
		venue: row.venue,
		contactEmail: row.contact_email,
		contactPhone: row.contact_phone,
		wines: parseStringArray(row.wines_json),
		wineRegions: parseStringArray(row.wine_regions_json),
		isWineEvent: row.is_wine_event === 1,
		status: row.status,
		publishedAt: row.published_at,
	};
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
					(?2 IS NOT NULL AND title IS NOT NULL AND title <> '' AND (
						instr(LOWER(title), LOWER(?2)) > 0
						OR instr(LOWER(?2), LOWER(title)) > 0
					))
					OR (
						?3 IS NOT NULL
						AND venue IS NOT NULL
						AND venue <> ''
						AND instr(LOWER(venue), LOWER(?3)) > 0
					)
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
	asset: EventSourceAssetInput,
	linkedAt: string,
): Promise<void> {
	// Ownership and original-source identity are immutable after first link;
	// retries may only refresh display/publication and delivery metadata.
	await db
		.prepare(
			`INSERT INTO event_assets (
				event_id,
				intake_id,
				asset_id,
				asset_role,
				source_type,
				source_message_id,
				text_content,
				is_public,
				r2_object_key,
				content_type,
				linked_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(asset_id) DO UPDATE SET
				asset_role = excluded.asset_role,
				source_type = excluded.source_type,
				is_public = excluded.is_public,
				r2_object_key = COALESCE(excluded.r2_object_key, event_assets.r2_object_key),
				content_type = COALESCE(excluded.content_type, event_assets.content_type)`,
		)
		.bind(
			eventId,
			asset.intakeId,
			asset.assetId,
			asset.assetRole ?? 'other',
			asset.sourceType,
			asset.sourceMessageId ?? null,
			asset.textContent ?? null,
			asset.sourceType !== 'line_text' && asset.isPublic === true ? 1 : 0,
			asset.r2ObjectKey ?? null,
			asset.contentType ?? null,
			linkedAt,
		)
		.run();
}

async function linkEventAssets(
	db: D1Database,
	eventId: string,
	input: StoredWineEventInput,
	linkedAt: string,
): Promise<void> {
	await linkEventAsset(db, eventId, {
		intakeId: input.intakeId,
		assetId: input.assetId,
		assetRole: input.assetRole,
		sourceType: input.sourceType ?? 'line_image',
		sourceMessageId: input.sourceMessageId,
		isPublic: input.isPublic,
		r2ObjectKey: input.r2ObjectKey,
		contentType: input.contentType,
	}, linkedAt);

	for (const asset of input.relatedAssets ?? []) await linkEventAsset(db, eventId, asset, linkedAt);
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
		const existing = await findEventById(db, resolvedEventId);
		if (!existing) throw new Error(`Resolved event not found: ${resolvedEventId}`);

		const merge = mergeEventData(existing, { title: input.title, ...input.event });
		const slug = await createUniqueEventSlug(db, {
			id,
			title: merge.event.title,
			venue: merge.event.venue,
			date: merge.event.date,
		});
		await db
			.prepare(
				`UPDATE events SET
					title = ?,
					event_date = ?,
					start_time = ?,
					price_thb = ?,
					venue = ?,
					contact_email = ?,
					contact_phone = ?,
					wines_json = ?,
					wine_regions_json = ?,
					is_wine_event = ?,
					slug = ?,
					status = 'published',
					published_at = COALESCE(published_at, ?)
				WHERE id = ?`,
			)
			.bind(
				merge.event.title,
				merge.event.date,
				merge.event.startTime,
				merge.event.priceTHB,
				merge.event.venue,
				merge.event.contactEmail,
				merge.event.contactPhone,
				JSON.stringify(merge.event.wines),
				JSON.stringify(merge.event.wineRegions),
				merge.event.isWineEvent ? 1 : 0,
				slug,
				createdAt,
				id,
			)
			.run();

		console.log('EVENT MERGE', JSON.stringify({
			eventId: id,
			changedFields: merge.changedFields,
			conflictFields: merge.conflicts.map((conflict) => conflict.field),
			published: true,
			assetId: input.assetId,
		}));

		await linkEventAssets(db, id, input, createdAt);
		return { id, duplicate: true };
	}

	const slug = await createUniqueEventSlug(db, {
		id,
		title: input.title,
		venue: input.event.venue,
		date: input.event.date,
	});
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
				wine_regions_json,
				is_wine_event,
				slug,
				status,
				published_at,
				created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)
			ON CONFLICT(asset_id) DO UPDATE SET
				title = excluded.title,
				event_date = excluded.event_date,
				start_time = excluded.start_time,
				price_thb = excluded.price_thb,
				venue = excluded.venue,
				contact_email = excluded.contact_email,
				contact_phone = excluded.contact_phone,
				wines_json = excluded.wines_json,
				wine_regions_json = excluded.wine_regions_json,
				is_wine_event = excluded.is_wine_event,
				slug = CASE
					WHEN events.slug IS NULL OR events.slug = '' THEN excluded.slug
					ELSE events.slug
				END,
				status = 'published',
				published_at = COALESCE(events.published_at, excluded.published_at)`,
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
			JSON.stringify(input.event.wineRegions),
			input.event.isWineEvent ? 1 : 0,
			slug,
			createdAt,
			createdAt,
		)
		.run();

	await linkEventAssets(db, id, input, createdAt);
	return { id, duplicate: false };
}
