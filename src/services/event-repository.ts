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
export type EventSourceType = 'line_image' | 'web_image' | 'line_text' | 'web_page' | 'other';

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
	/** Stable, caller-owned identity used by LINE batch publication shells. */
	eventId?: string;
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

export interface AdminEventSummary {
	id: string;
	title: string | null;
	slug: string | null;
	eventDate: string | null;
	status: string;
	publishedAt: string | null;
	venue: string | null;
	priceTHB: number | null;
	assetCount: number;
	createdAt: string;
	thumbnailUrl: string | null;
	thumbnailAssetType: string | null;
}

interface AdminEventRow {
	id: string;
	title: string | null;
	slug: string | null;
	event_date: string | null;
	status: string;
	published_at: string | null;
	venue: string | null;
	price_thb: number | null;
	asset_count: number;
	created_at: string;
	thumbnail_asset_id: string | null;
	thumbnail_asset_type: string | null;
}

export interface AdminImageAsset {
	assetId: string;
	r2ObjectKey: string;
	contentType: string;
}

export async function listAdminEvents(db: D1Database): Promise<AdminEventSummary[]> {
	const result = await db.prepare(
		`SELECT
			e.id,
			e.title,
			e.slug,
			e.event_date,
			e.status,
			e.published_at,
			e.venue,
			e.price_thb,
			COUNT(a.asset_id) AS asset_count,
			e.created_at,
			(SELECT image.asset_id FROM event_assets image
			 WHERE image.event_id = e.id
				AND image.source_type != 'line_text'
				AND image.r2_object_key IS NOT NULL
				AND LOWER(image.content_type) LIKE 'image/%'
			 ORDER BY CASE image.asset_role
				WHEN 'flyer' THEN 0 WHEN 'social' THEN 1 WHEN 'menu' THEN 2 ELSE 3 END,
				image.linked_at, image.asset_id LIMIT 1) AS thumbnail_asset_id,
			(SELECT image.asset_role FROM event_assets image
			 WHERE image.event_id = e.id
				AND image.source_type != 'line_text'
				AND image.r2_object_key IS NOT NULL
				AND LOWER(image.content_type) LIKE 'image/%'
			 ORDER BY CASE image.asset_role
				WHEN 'flyer' THEN 0 WHEN 'social' THEN 1 WHEN 'menu' THEN 2 ELSE 3 END,
				image.linked_at, image.asset_id LIMIT 1) AS thumbnail_asset_type
		 FROM events e
		 LEFT JOIN event_assets a ON a.event_id = e.id
		 GROUP BY e.id
		 ORDER BY e.event_date DESC, e.created_at DESC`,
	).all<AdminEventRow>();

	return (result.results ?? []).map((row) => ({
		id: row.id,
		title: row.title,
		slug: row.slug,
		eventDate: row.event_date,
		status: row.status,
		publishedAt: row.published_at,
		venue: row.venue,
		priceTHB: row.price_thb,
		assetCount: Number(row.asset_count),
		createdAt: row.created_at,
		thumbnailUrl: row.thumbnail_asset_id ? `/admin/assets/${encodeURIComponent(row.thumbnail_asset_id)}` : null,
		thumbnailAssetType: row.thumbnail_asset_type,
	}));
}

export async function getAdminImageAsset(db: D1Database, assetId: string): Promise<AdminImageAsset | null> {
	const row = await db.prepare(
		`SELECT asset_id, r2_object_key, content_type
		 FROM event_assets
		 WHERE asset_id = ?
			AND source_type != 'line_text'
			AND r2_object_key IS NOT NULL
			AND LOWER(content_type) LIKE 'image/%'
		 LIMIT 1`,
	).bind(assetId).first<{ asset_id: string; r2_object_key: string; content_type: string }>();
	return row ? { assetId: row.asset_id, r2ObjectKey: row.r2_object_key, contentType: row.content_type } : null;
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
	organizer: string | null; address: string | null; district: string | null; website_url: string | null;
	booking_url: string | null; booking_instructions: string | null; contact_text: string | null;
	description: string | null; course_count: number | null; price_text: string | null; currency: string | null;
	price_qualifier: string | null; end_time: string | null; timezone: string | null;
	wine_producers_json: string; partners_json: string; merchants_json: string; menu_json: string;
	notes_json: string; source_contact_json: string;
}

export interface StoredCanonicalEvent extends CanonicalEventData {
	status: string;
	publishedAt: string | null;
}

const GENERIC_MATCH_TITLES = new Set(['wine event', 'event', 'wine dinner', 'untitled']);

function hasSufficientMatchingEvidence(incoming: Pick<ExistingEventCandidate, 'title'|'date'|'startTime'|'venue'>): boolean {
	const title = incoming.title?.trim().toLocaleLowerCase('en-US') ?? '';
	const meaningfulTitle = title.length >= 5 && !GENERIC_MATCH_TITLES.has(title);
	const hasDate = Boolean(incoming.date);
	const hasTime = Boolean(incoming.startTime);
	const hasVenue = Boolean(incoming.venue?.trim());
	return (meaningfulTitle && [hasDate, hasTime, hasVenue].some(Boolean))
		|| (hasDate && hasTime && hasVenue);
}

function parseStringArray(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
	} catch {
		return [];
	}
}

export async function getStoredCanonicalEvent(db: D1Database, eventId: string): Promise<StoredCanonicalEvent | null> {
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
				, organizer, address, district, website_url, booking_url, booking_instructions, contact_text
				, description, course_count, price_text, currency, price_qualifier, end_time, timezone
				, wine_producers_json, partners_json, merchants_json, menu_json, notes_json, source_contact_json
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
		organizer: row.organizer, address: row.address, district: row.district, websiteUrl: row.website_url,
		bookingUrl: row.booking_url, bookingInstructions: row.booking_instructions, contactText: row.contact_text,
		description: row.description, courseCount: row.course_count, priceText: row.price_text, currency: row.currency,
		priceQualifier: row.price_qualifier, endTime: row.end_time, timezone: row.timezone,
		wineProducers: parseStringArray(row.wine_producers_json), partners: parseStringArray(row.partners_json),
		merchants: parseStringArray(row.merchants_json), menu: parseStringArray(row.menu_json),
		notes: parseStringArray(row.notes_json), sourceContactInformation: parseStringArray(row.source_contact_json),
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
	const forcedExisting=input.eventId?await getStoredCanonicalEvent(db,input.eventId):null;
	const matchingAllowed=!input.eventId&&hasSufficientMatchingEvidence(incoming);
	const candidates = matchingAllowed?await findCandidateEvents(db, incoming):[];
	const match = matchExistingEvent(incoming, candidates);
	let resolvedEventId = forcedExisting?input.eventId!:match.eventId;
	const createdAt = new Date().toISOString();

	console.log('EVENT RESOLUTION', JSON.stringify({
		candidates: candidates.length,
		matchingAllowed,
		bestMatch: match.eventId,
		confidence: match.confidence,
		reasons: match.reasons,
		decision: match.matched ? 'MATCH' : 'NEW EVENT',
	}));

	const ambiguous = !input.eventId && aiResolution
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

	const id = input.eventId ?? resolvedEventId ?? `${input.intakeId}:${input.assetId}`;

	if (resolvedEventId) {
		const existing = await getStoredCanonicalEvent(db, resolvedEventId);
		if (!existing) throw new Error(`Resolved event not found: ${resolvedEventId}`);

		const merge = mergeEventData(existing, { title: input.title, ...input.event });
		const identityConflictFields = new Set(merge.conflicts.map((conflict) => conflict.field));
		const normalizedTitle = (value: string | null): string => (value ?? '')
			.normalize('NFKC')
			.toLocaleLowerCase('en-US')
			.replace(/[^\p{L}\p{N}]+/gu, ' ')
			.trim()
			.replace(/\s+/g, ' ');
		const supplementaryTitle = (value: string | null): string => normalizedTitle(value)
			.split(' ')
			.filter((token) => token !== 'menu' && token !== 'reminder')
			.join(' ');
		const harmlessSupplementaryTitleConflict = (input.assetRole === 'menu' || input.assetRole === 'reminder')
			&& supplementaryTitle(existing.title) === supplementaryTitle(input.title);
		const suspiciousAutomaticMatch = !input.eventId && (
			identityConflictFields.has('date')
			|| identityConflictFields.has('venue')
			|| (identityConflictFields.has('title') && !harmlessSupplementaryTitleConflict)
		);
		if (suspiciousAutomaticMatch) {
			const listFields = ['wines','wineRegions','wineProducers','partners','merchants','menu','notes','sourceContactInformation'] as const;
			const mergedEvent = merge.event as unknown as Record<string, unknown>;
			for (const field of listFields) mergedEvent[field] = existing[field] ?? [];
			merge.changedFields = merge.changedFields.filter((field) => !listFields.includes(field as typeof listFields[number]));
		}
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
					organizer = ?,
					address = ?,
					district = ?,
					website_url = ?,
					booking_url = ?,
					booking_instructions = ?,
					contact_text = ?,
					description = ?,
					course_count = ?,
					price_text = ?,
					currency = ?,
					price_qualifier = ?,
					end_time = ?,
					timezone = ?,
					wine_producers_json = ?,
					partners_json = ?,
					merchants_json = ?,
					menu_json = ?,
					notes_json = ?,
					source_contact_json = ?,
					slug = ?,
					status = 'published',
					published_at = COALESCE(published_at, ?),
					updated_at = ?
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
				merge.event.organizer ?? null,
				merge.event.address ?? null,
				merge.event.district ?? null,
				merge.event.websiteUrl ?? null,
				merge.event.bookingUrl ?? null,
				merge.event.bookingInstructions ?? null,
				merge.event.contactText ?? null,
				merge.event.description ?? null,
				merge.event.courseCount ?? null,
				merge.event.priceText ?? null,
				merge.event.currency ?? null,
				merge.event.priceQualifier ?? null,
				merge.event.endTime ?? null,
				merge.event.timezone ?? null,
				JSON.stringify(merge.event.wineProducers ?? []),
				JSON.stringify(merge.event.partners ?? []),
				JSON.stringify(merge.event.merchants ?? []),
				JSON.stringify(merge.event.menu ?? []),
				JSON.stringify(merge.event.notes ?? []),
				JSON.stringify(merge.event.sourceContactInformation ?? []),
				slug,
				createdAt,
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
		replaceGeneric: Boolean(input.title && !GENERIC_MATCH_TITLES.has(input.title.trim().toLocaleLowerCase('en-US'))),
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
				organizer,
				address,
				district,
				website_url,
				booking_url,
				booking_instructions,
				contact_text,
				description,
				course_count,
				price_text,
				currency,
				price_qualifier,
				end_time,
				timezone,
				wine_producers_json,
				partners_json,
				merchants_json,
				menu_json,
				notes_json,
				source_contact_json,
				slug,
				status,
				published_at,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)
			ON CONFLICT(asset_id) DO UPDATE SET
				title = CASE
					WHEN (events.title IS NULL OR events.title = '' OR LOWER(events.title) IN ('wine event', 'event', 'untitled'))
						AND excluded.title IS NOT NULL AND excluded.title <> '' THEN excluded.title
					ELSE events.title END,
				event_date = COALESCE(events.event_date, excluded.event_date),
				start_time = COALESCE(events.start_time, excluded.start_time),
				price_thb = COALESCE(events.price_thb, excluded.price_thb),
				venue = COALESCE(events.venue, excluded.venue),
				contact_email = COALESCE(events.contact_email, excluded.contact_email),
				contact_phone = COALESCE(events.contact_phone, excluded.contact_phone),
				wines_json = CASE WHEN events.wines_json = '[]' THEN excluded.wines_json ELSE events.wines_json END,
				wine_regions_json = CASE WHEN events.wine_regions_json = '[]' THEN excluded.wine_regions_json ELSE events.wine_regions_json END,
				is_wine_event = MAX(events.is_wine_event, excluded.is_wine_event),
				organizer = COALESCE(events.organizer, excluded.organizer),
				address = COALESCE(events.address, excluded.address),
				district = COALESCE(events.district, excluded.district),
				website_url = COALESCE(events.website_url, excluded.website_url),
				booking_url = COALESCE(events.booking_url, excluded.booking_url),
				booking_instructions = COALESCE(events.booking_instructions, excluded.booking_instructions),
				contact_text = COALESCE(events.contact_text, excluded.contact_text),
				description = COALESCE(events.description, excluded.description),
				course_count = COALESCE(events.course_count, excluded.course_count),
				price_text = COALESCE(events.price_text, excluded.price_text),
				currency = COALESCE(events.currency, excluded.currency),
				price_qualifier = COALESCE(events.price_qualifier, excluded.price_qualifier),
				end_time = COALESCE(events.end_time, excluded.end_time),
				timezone = COALESCE(events.timezone, excluded.timezone),
				wine_producers_json = CASE WHEN events.wine_producers_json = '[]' THEN excluded.wine_producers_json ELSE events.wine_producers_json END,
				partners_json = CASE WHEN events.partners_json = '[]' THEN excluded.partners_json ELSE events.partners_json END,
				merchants_json = CASE WHEN events.merchants_json = '[]' THEN excluded.merchants_json ELSE events.merchants_json END,
				menu_json = CASE WHEN events.menu_json = '[]' THEN excluded.menu_json ELSE events.menu_json END,
				notes_json = CASE WHEN events.notes_json = '[]' THEN excluded.notes_json ELSE events.notes_json END,
				source_contact_json = CASE WHEN events.source_contact_json = '[]' THEN excluded.source_contact_json ELSE events.source_contact_json END,
				slug = CASE
					WHEN events.slug IS NULL OR events.slug = ''
						OR (LOWER(events.title) IN ('wine event', 'event', 'untitled') AND excluded.title IS NOT NULL AND LOWER(excluded.title) NOT IN ('wine event', 'event', 'untitled'))
						THEN excluded.slug
					ELSE events.slug
				END,
				status = 'published',
				published_at = COALESCE(events.published_at, excluded.published_at),
				updated_at = excluded.updated_at`,
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
			input.event.organizer ?? null,
			input.event.address ?? null,
			input.event.district ?? null,
			input.event.websiteUrl ?? null,
			input.event.bookingUrl ?? null,
			input.event.bookingInstructions ?? null,
			input.event.contactText ?? null,
			input.event.description ?? null,
			input.event.courseCount ?? null,
			input.event.priceText ?? null,
			input.event.currency ?? null,
			input.event.priceQualifier ?? null,
			input.event.endTime ?? null,
			input.event.timezone ?? null,
			JSON.stringify(input.event.wineProducers ?? []),
			JSON.stringify(input.event.partners ?? []),
			JSON.stringify(input.event.merchants ?? []),
			JSON.stringify(input.event.menu ?? []),
			JSON.stringify(input.event.notes ?? []),
			JSON.stringify(input.event.sourceContactInformation ?? []),
			slug,
			createdAt,
			createdAt,
			createdAt,
		)
		.run();

	await linkEventAssets(db, id, input, createdAt);
	return { id, duplicate: false };
}
