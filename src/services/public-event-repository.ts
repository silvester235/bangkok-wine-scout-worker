export interface PublicEventCursor {
	date: string | null;
	startTime: string;
	id: string;
}

export interface PublicEventListOptions {
	limit: number;
	from?: string;
	to?: string;
	venue?: string;
	region?: string;
	wine?: string;
	includePast: boolean;
	todayBangkok: string;
	cursor?: PublicEventCursor;
}

export interface PublicAssetSummary {
	id: string;
	role: string;
	type: string;
	contentType: string | null;
	url: string;
	alt: string;
}

export interface PublicEventSummary {
	slug: string;
	title: string | null;
	date: string | null;
	startTime: string | null;
	endTime: string | null;
	timezone: string | null;
	priceTHB: number | null;
	priceText: string | null;
	currency: string | null;
	priceQualifier: string | null;
	venue: string | null;
	organizer: string | null;
	address: string | null;
	district: string | null;
	websiteUrl: string | null;
	bookingUrl: string | null;
	bookingInstructions: string | null;
	contactText: string | null;
	description: string | null;
	courseCount: number | null;
	wines: string[];
	wineRegions: string[];
	wineProducers: string[];
	partners: string[];
	merchants: string[];
	menu: string[];
	notes: string[];
	sourceContactInformation: string[];
	isWineEvent: boolean;
	heroAsset: PublicAssetSummary | null;
	publishedAt: string;
}

export interface PublicEventDetail extends PublicEventSummary {
	contactEmail: string | null;
	contactPhone: string | null;
	assets: PublicAssetSummary[];
}

interface PublicEventRow {
	id: string;
	slug: string;
	title: string | null;
	event_date: string | null;
	start_time: string | null;
	end_time: string | null;
	timezone: string | null;
	price_thb: number | null;
	price_text: string | null;
	currency: string | null;
	price_qualifier: string | null;
	venue: string | null;
	organizer: string | null;
	address: string | null;
	district: string | null;
	website_url: string | null;
	booking_url: string | null;
	booking_instructions: string | null;
	contact_text: string | null;
	description: string | null;
	course_count: number | null;
	contact_email: string | null;
	contact_phone: string | null;
	wines_json: string;
	wine_regions_json: string;
	wine_producers_json: string;
	partners_json: string;
	merchants_json: string;
	menu_json: string;
	notes_json: string;
	source_contact_json: string;
	is_wine_event: number;
	published_at: string;
	hero_asset_id: string | null;
	hero_asset_role: string | null;
	hero_source_type: string | null;
	hero_content_type: string | null;
}

interface PublicAssetRow {
	asset_id: string;
	asset_role: string;
	source_type: string;
	content_type: string | null;
}

export interface PublicAssetRecord extends PublicAssetSummary {
	r2ObjectKey: string;
}

function parseStringArray(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
	} catch {
		return [];
	}
}

function assetUrl(assetId: string): string {
	return `/api/assets/${encodeURIComponent(assetId)}`;
}

function mapAsset(row: PublicAssetRow): PublicAssetSummary {
	return {
		id: row.asset_id,
		role: row.asset_role,
		type: row.source_type,
		contentType: row.content_type,
		url: assetUrl(row.asset_id),
		alt: '',
	};
}

function mapEvent(row: PublicEventRow): PublicEventSummary {
	const heroAsset = row.hero_asset_id ? mapAsset({
		asset_id: row.hero_asset_id,
		asset_role: row.hero_asset_role ?? 'other',
		source_type: row.hero_source_type ?? 'line_image',
		content_type: row.hero_content_type,
	}) : null;
	return {
		slug: row.slug,
		title: row.title,
		date: row.event_date,
		startTime: row.start_time,
		endTime: row.end_time,
		timezone: row.timezone,
		priceTHB: row.price_thb,
		priceText: row.price_text,
		currency: row.currency,
		priceQualifier: row.price_qualifier,
		venue: row.venue,
		organizer: row.organizer,
		address: row.address,
		district: row.district,
		websiteUrl: row.website_url,
		bookingUrl: row.booking_url,
		bookingInstructions: row.booking_instructions,
		contactText: row.contact_text,
		description: row.description,
		courseCount: row.course_count,
		wines: parseStringArray(row.wines_json),
		wineRegions: parseStringArray(row.wine_regions_json),
		wineProducers: parseStringArray(row.wine_producers_json),
		partners: parseStringArray(row.partners_json),
		merchants: parseStringArray(row.merchants_json),
		menu: parseStringArray(row.menu_json),
		notes: parseStringArray(row.notes_json),
		sourceContactInformation: parseStringArray(row.source_contact_json),
		isWineEvent: row.is_wine_event === 1,
		heroAsset,
		publishedAt: row.published_at,
	};
}

const PUBLIC_ASSET_CONDITION = `ea.is_public = 1
	AND ea.source_type != 'line_text'
	AND ea.r2_object_key IS NOT NULL
	AND LOWER(ea.content_type) LIKE 'image/%'`;

const PUBLIC_EVENT_COLUMNS = `
	e.id,
	e.slug,
	e.title,
	e.event_date,
	e.start_time,
	e.end_time,
	e.timezone,
	e.price_thb,
	e.price_text,
	e.currency,
	e.price_qualifier,
	e.venue,
	e.organizer,
	e.address,
	e.district,
	e.website_url,
	e.booking_url,
	e.booking_instructions,
	e.contact_text,
	e.description,
	e.course_count,
	e.contact_email,
	e.contact_phone,
	e.wines_json,
	e.wine_regions_json,
	e.wine_producers_json,
	e.partners_json,
	e.merchants_json,
	e.menu_json,
	e.notes_json,
	e.source_contact_json,
	e.is_wine_event,
	e.published_at,
	(SELECT ea.asset_id FROM event_assets ea
		WHERE ea.event_id = e.id AND ${PUBLIC_ASSET_CONDITION}
		ORDER BY CASE ea.asset_role
			WHEN 'main' THEN 0 WHEN 'flyer' THEN 1 WHEN 'menu' THEN 2
			WHEN 'reminder' THEN 3 WHEN 'social' THEN 4 WHEN 'map' THEN 5 ELSE 6 END,
			ea.linked_at, ea.asset_id LIMIT 1) AS hero_asset_id,
	(SELECT ea.asset_role FROM event_assets ea
		WHERE ea.event_id = e.id AND ${PUBLIC_ASSET_CONDITION}
		ORDER BY CASE ea.asset_role
			WHEN 'main' THEN 0 WHEN 'flyer' THEN 1 WHEN 'menu' THEN 2
			WHEN 'reminder' THEN 3 WHEN 'social' THEN 4 WHEN 'map' THEN 5 ELSE 6 END,
			ea.linked_at, ea.asset_id LIMIT 1) AS hero_asset_role,
	(SELECT ea.source_type FROM event_assets ea
		WHERE ea.event_id = e.id AND ${PUBLIC_ASSET_CONDITION}
		ORDER BY CASE ea.asset_role
			WHEN 'main' THEN 0 WHEN 'flyer' THEN 1 WHEN 'menu' THEN 2
			WHEN 'reminder' THEN 3 WHEN 'social' THEN 4 WHEN 'map' THEN 5 ELSE 6 END,
			ea.linked_at, ea.asset_id LIMIT 1) AS hero_source_type,
	(SELECT ea.content_type FROM event_assets ea
		WHERE ea.event_id = e.id AND ${PUBLIC_ASSET_CONDITION}
		ORDER BY CASE ea.asset_role
			WHEN 'main' THEN 0 WHEN 'flyer' THEN 1 WHEN 'menu' THEN 2
			WHEN 'reminder' THEN 3 WHEN 'social' THEN 4 WHEN 'map' THEN 5 ELSE 6 END,
			ea.linked_at, ea.asset_id LIMIT 1) AS hero_content_type`;

const PUBLIC_EVENT_CONDITION = `e.status = 'published'
	AND e.published_at IS NOT NULL
	AND e.slug IS NOT NULL`;

export async function listPublishedEvents(
	db: D1Database,
	options: PublicEventListOptions,
): Promise<{ events: PublicEventSummary[]; nextCursor: PublicEventCursor | null }> {
	const conditions = [PUBLIC_EVENT_CONDITION];
	const bindings: Array<string | number | null> = [];
	if (options.from) {
		conditions.push('e.event_date >= ?');
		bindings.push(options.from);
	} else if (!options.to && !options.includePast) {
		conditions.push('(e.event_date IS NULL OR e.event_date >= ?)');
		bindings.push(options.todayBangkok);
	}
	if (options.to) {
		conditions.push('e.event_date <= ?');
		bindings.push(options.to);
	}
	if (options.venue) {
		conditions.push(`LOWER(e.venue) LIKE '%' || LOWER(?) || '%'`);
		bindings.push(options.venue);
	}
	if (options.wine) {
		conditions.push(`EXISTS (SELECT 1 FROM json_each(e.wines_json) WHERE LOWER(CAST(value AS TEXT)) LIKE '%' || LOWER(?) || '%')`);
		bindings.push(options.wine);
	}
	if (options.region) {
		conditions.push(`EXISTS (SELECT 1 FROM json_each(e.wine_regions_json) WHERE LOWER(CAST(value AS TEXT)) LIKE '%' || LOWER(?) || '%')`);
		bindings.push(options.region);
	}
	if (options.cursor) {
		conditions.push(`(
			CASE WHEN e.event_date IS NULL THEN 1 ELSE 0 END > ? OR
			(CASE WHEN e.event_date IS NULL THEN 1 ELSE 0 END = ? AND (
				COALESCE(e.event_date, '') > COALESCE(?, '') OR
				(COALESCE(e.event_date, '') = COALESCE(?, '') AND COALESCE(e.start_time, '') > ?) OR
				(COALESCE(e.event_date, '') = COALESCE(?, '') AND COALESCE(e.start_time, '') = ? AND e.id > ?)
			))
		)`);
		const undated = options.cursor.date === null ? 1 : 0;
		bindings.push(
			undated,
			undated,
			options.cursor.date,
			options.cursor.date,
			options.cursor.startTime,
			options.cursor.date,
			options.cursor.startTime,
			options.cursor.id,
		);
	}
	bindings.push(options.limit + 1);

	const result = await db.prepare(
		`SELECT ${PUBLIC_EVENT_COLUMNS}
		FROM events e
		WHERE ${conditions.join('\n AND ')}
		ORDER BY
			CASE WHEN e.event_date IS NULL THEN 1 ELSE 0 END,
			e.event_date,
			COALESCE(e.start_time, ''),
			e.id
		LIMIT ?`,
	).bind(...bindings).all<PublicEventRow>();
	const rows = result.results ?? [];
	const hasMore = rows.length > options.limit;
	const page = rows.slice(0, options.limit);
	const last = hasMore ? page.at(-1) : null;
	return {
		events: page.map(mapEvent),
		nextCursor: last ? { date: last.event_date, startTime: last.start_time ?? '', id: last.id } : null,
	};
}

export async function getPublishedEventBySlug(db: D1Database, slug: string): Promise<PublicEventDetail | null> {
	const row = await db.prepare(
		`SELECT ${PUBLIC_EVENT_COLUMNS}
		FROM events e
		WHERE ${PUBLIC_EVENT_CONDITION} AND e.slug = ?
		LIMIT 1`,
	).bind(slug).first<PublicEventRow>();
	if (!row) return null;
	return { ...mapEvent(row), contactEmail: row.contact_email, contactPhone: row.contact_phone, assets: await listPublicEventAssets(db, row.id) };
}

export async function listPublishedEventSlugs(db: D1Database): Promise<string[]> {
	const result = await db.prepare(
		`SELECT e.slug
		FROM events e
		WHERE ${PUBLIC_EVENT_CONDITION}
		ORDER BY e.slug`,
	).all<{ slug: string }>();
	return (result.results ?? []).map((row) => row.slug);
}

export async function listPublicEventAssets(
	db: D1Database,
	eventId: string,
): Promise<PublicAssetSummary[]> {
	const result = await db.prepare(
		`SELECT ea.asset_id, ea.asset_role, ea.source_type, ea.content_type
		FROM event_assets ea
		JOIN events e ON e.id = ea.event_id
		WHERE ea.event_id = ?
			AND ${PUBLIC_EVENT_CONDITION}
			AND ${PUBLIC_ASSET_CONDITION}
		ORDER BY CASE ea.asset_role
			WHEN 'main' THEN 0 WHEN 'flyer' THEN 1 WHEN 'menu' THEN 2
			WHEN 'reminder' THEN 3 WHEN 'social' THEN 4 WHEN 'map' THEN 5 ELSE 6 END,
			ea.linked_at, ea.asset_id`,
	).bind(eventId).all<PublicAssetRow>();
	return (result.results ?? []).map(mapAsset);
}

export async function getPublicAsset(db: D1Database, assetId: string): Promise<PublicAssetRecord | null> {
	const row = await db.prepare(
		`SELECT
			ea.asset_id,
			ea.asset_role,
			ea.source_type,
			ea.content_type,
			ea.r2_object_key
		FROM event_assets ea
		JOIN events e ON e.id = ea.event_id
		WHERE ea.asset_id = ?
			AND ${PUBLIC_EVENT_CONDITION}
			AND ${PUBLIC_ASSET_CONDITION}
		LIMIT 1`,
	).bind(assetId).first<PublicAssetRow & { r2_object_key: string }>();
	if (!row) return null;
	return {
		...mapAsset(row),
		r2ObjectKey: row.r2_object_key,
	};
}
