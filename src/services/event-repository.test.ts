import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedWineEvent } from './event-normalizer';
import { getOptionalAiEventResolutionOptions } from '../config';
import type { WorkerEnv } from '../types/env';
import {
	findCandidateEvents,
	findEventCleanupTargetBySlug,
	findEventIdByAssetId,
	saveWineEvent,
	type AiEventResolutionOptions,
	type StoredWineEventInput,
} from './event-repository';

declare module 'cloudflare:test' {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

const schema = `
	CREATE TABLE IF NOT EXISTS events (
		id TEXT PRIMARY KEY,
		intake_id TEXT NOT NULL,
		asset_id TEXT NOT NULL,
		title TEXT,
		event_date TEXT,
		start_time TEXT,
		price_thb INTEGER,
		venue TEXT,
		contact_email TEXT,
		contact_phone TEXT,
		wines_json TEXT NOT NULL DEFAULT '[]',
		wine_regions_json TEXT NOT NULL DEFAULT '[]',
		is_wine_event INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL DEFAULT 'draft',
		published_at TEXT,
		slug TEXT,
		created_at TEXT NOT NULL
	);
	CREATE UNIQUE INDEX IF NOT EXISTS idx_events_asset_id ON events(asset_id);
	CREATE UNIQUE INDEX IF NOT EXISTS idx_events_slug ON events(slug) WHERE slug IS NOT NULL;
	CREATE TABLE IF NOT EXISTS event_assets (
		event_id TEXT NOT NULL,
		intake_id TEXT NOT NULL,
		asset_id TEXT NOT NULL,
		asset_role TEXT NOT NULL DEFAULT 'other',
		source_type TEXT NOT NULL DEFAULT 'line_image',
		source_message_id TEXT,
		text_content TEXT,
		is_public INTEGER NOT NULL DEFAULT 0,
		r2_object_key TEXT,
		content_type TEXT,
		linked_at TEXT NOT NULL,
		PRIMARY KEY (event_id, asset_id),
		FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
	);
	CREATE UNIQUE INDEX IF NOT EXISTS idx_event_assets_asset_id ON event_assets(asset_id);
	CREATE UNIQUE INDEX IF NOT EXISTS idx_event_assets_source_message_id ON event_assets(source_message_id) WHERE source_message_id IS NOT NULL;
`;

const baseEvent: NormalizedWineEvent = {
	date: '2026-08-15',
	startTime: '19:00',
	priceTHB: 3200,
	venue: 'Waldorf Astoria Bangkok',
	contactEmail: 'events@example.com',
	contactPhone: '+66 2 000 0000',
	wines: ['Château Example'],
	wineRegions: [],
	isWineEvent: true,
};

function input(
	assetId: string,
	overrides: Partial<Omit<StoredWineEventInput, 'event'>> & { event?: Partial<NormalizedWineEvent> } = {},
): StoredWineEventInput {
	return {
		intakeId: `intake-${assetId}`,
		assetId,
		assetRole: 'flyer',
		title: 'California Wine Dinner',
		...overrides,
		event: { ...baseEvent, ...overrides.event },
	};
}

async function insertCandidate(id: string, title: string, venue: string | null = null): Promise<void> {
	const createdAt = '2026-08-01T00:00:00.000Z';
	await env.DB.prepare(
		`INSERT INTO events (
			id, intake_id, asset_id, title, event_date, venue, wines_json,
			wine_regions_json, is_wine_event, status, published_at, slug, created_at
		) VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', 1, 'published', ?, ?, ?)`,
	).bind(id, `intake-${id}`, `asset-${id}`, title, venue, createdAt, `candidate-${id}`, createdAt).run();
}

beforeAll(async () => {
	for (const statement of schema.split(';').map((value) => value.trim()).filter(Boolean)) {
		await env.DB.prepare(statement).run();
	}
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM event_assets'),
		env.DB.prepare('DELETE FROM events'),
	]);
});

describe('D1 event resolution', () => {
	it('finds the cleanup target through the exact production slug lookup path', async () => {
		const slug = 'wine-dinner-by-chef-andrea-montella-centara-grand-at-centralwordl-2026-08-05';
		await insertCandidate('line-625354020655727035:line-message-625354020655727035', 'WINE DINNER BY CHEF ANDREA MONTELLA');
		await env.DB.prepare('UPDATE events SET slug = ? WHERE id = ?').bind(
			slug,
			'line-625354020655727035:line-message-625354020655727035',
		).run();

		const target = await findEventCleanupTargetBySlug(env.DB, slug);

		expect(target).toMatchObject({
			id: 'line-625354020655727035:line-message-625354020655727035',
			slug,
			assets: [],
		});
	});

	it('returns bounded candidates with the exact date first', async () => {
		await saveWineEvent(env.DB, input('nearby', { event: { date: '2026-08-14' } }));
		await saveWineEvent(env.DB, input('exact'));

		const candidates = await findCandidateEvents(env.DB, {
			title: 'California Wine Dinner',
			date: '2026-08-15',
			venue: 'Waldorf Astoria Bangkok',
		});

		expect(candidates.map((candidate) => candidate.id)).toEqual([
			'intake-exact:exact',
			'intake-nearby:nearby',
		]);
	});

	it('finds a normal title candidate without a date', async () => {
		await insertCandidate('normal-title', 'Bordeaux Wine Dinner');

		const candidates = await findCandidateEvents(env.DB, {
			title: 'Bordeaux Wine Dinner', date: null, venue: null,
		});

		expect(candidates.map(({ id }) => id)).toEqual(['normal-title']);
	});

	it.each([
		['incoming title is contained in the stored title', 'Grand Bordeaux Wine Dinner', 'Bordeaux Wine'],
		['stored title is contained in the incoming title', 'Bordeaux Wine', 'Grand Bordeaux Wine Dinner'],
	] as const)('finds a title when the %s', async (_case, storedTitle, incomingTitle) => {
		await insertCandidate('title-substring', storedTitle);

		const candidates = await findCandidateEvents(env.DB, {
			title: incomingTitle, date: null, venue: null,
		});

		expect(candidates.map(({ id }) => id)).toContain('title-substring');
	});

	it('finds a literal venue substring without a date', async () => {
		await insertCandidate('venue-substring', 'Bordeaux Dinner', 'The Grand Ballroom Bangkok');

		const candidates = await findCandidateEvents(env.DB, {
			title: null, date: null, venue: 'Grand Ballroom',
		});

		expect(candidates.map(({ id }) => id)).toEqual(['venue-substring']);
	});

	it.each([
		['%', 'Bordeaux 100% Wine Dinner', 'Bordeaux 100X Wine Dinner'],
		['_', 'Bordeaux_Cru Dinner', 'BordeauxXCru Dinner'],
	] as const)('treats %s in incoming titles as a literal character', async (literal, matching, nonMatching) => {
		await insertCandidate('literal-match', matching);
		await insertCandidate('wildcard-only-match', nonMatching);

		const candidates = await findCandidateEvents(env.DB, {
			title: literal, date: null, venue: null,
		});

		expect(candidates.map(({ id }) => id)).toEqual(['literal-match']);
	});

	it('handles a stored title containing many wildcard characters', async () => {
		await insertCandidate('many-wildcards', `Bordeaux${'%_'.repeat(30_000)}`);

		const candidates = await findCandidateEvents(env.DB, {
			title: 'Bordeaux', date: null, venue: null,
		});

		expect(candidates.map(({ id }) => id)).toContain('many-wildcards');
	});

	it('handles a very long stored title', async () => {
		await insertCandidate('long-stored', `Bordeaux${' wine'.repeat(20_000)}`);

		const candidates = await findCandidateEvents(env.DB, {
			title: 'Bordeaux', date: null, venue: null,
		});

		expect(candidates.map(({ id }) => id)).toContain('long-stored');
	});

	it('handles a very long incoming title', async () => {
		await insertCandidate('long-incoming', 'Bordeaux Wine Dinner');

		const candidates = await findCandidateEvents(env.DB, {
			title: `Bordeaux Wine Dinner${' details'.repeat(20_000)}`, date: null, venue: null,
		});

		expect(candidates.map(({ id }) => id)).toContain('long-incoming');
	});

	it('uses title and venue lookup when the incoming date is null', async () => {
		await insertCandidate('null-date', 'Bordeaux Wine Dinner', 'Siam Hotel Bangkok');

		const candidates = await findCandidateEvents(env.DB, {
			title: 'Bordeaux Wine', date: null, venue: 'Siam Hotel',
		});

		expect(candidates.map(({ id }) => id)).toEqual(['null-date']);
	});

	it('stores and idempotently retries the published Bordeaux flyer with one public asset', async () => {
		const bordeauxFlyer = input('bordeaux-flyer', {
			title: 'Bordeaux Wine Dinner',
			isPublic: true,
			r2ObjectKey: 'intakes/bordeaux/assets/flyer/original',
			contentType: 'image/jpeg',
			event: { date: null, venue: 'Siam Hotel Bangkok', wineRegions: ['Bordeaux'] },
		});

		const first = await saveWineEvent(env.DB, bordeauxFlyer);
		const retry = await saveWineEvent(env.DB, bordeauxFlyer);
		const row = await env.DB.prepare(
			`SELECT e.status, COUNT(ea.asset_id) AS asset_count, MAX(ea.is_public) AS is_public
			FROM events e JOIN event_assets ea ON ea.event_id = e.id
			WHERE e.id = ? GROUP BY e.id, e.status`,
		).bind(first.id).first<{ status: string; asset_count: number; is_public: number }>();

		expect(retry).toEqual({ id: first.id, duplicate: true });
		expect(row).toEqual({ status: 'published', asset_count: 1, is_public: 1 });
		expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM events').first<{ count: number }>())?.count).toBe(1);
	});

	it('reuses an exact duplicate instead of creating a second event', async () => {
		const first = await saveWineEvent(env.DB, input('flyer-1'));
		const duplicate = await saveWineEvent(env.DB, input('flyer-2'));

		expect(duplicate).toEqual({ id: first.id, duplicate: true });
		expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM events').first<{ count: number }>())?.count).toBe(1);
	});

	it.each([
		['menu', 'California Wine Dinner Menu'],
		['reminder', 'Reminder: California Wine Dinner'],
	] as const)('links a %s flyer to its existing event', async (assetRole, title) => {
		const first = await saveWineEvent(env.DB, input('flyer-1'));
		const supplementary = await saveWineEvent(env.DB, input(`${assetRole}-1`, {
			assetRole,
			title,
			event: { date: null, startTime: null, priceTHB: null },
		}));

		expect(supplementary.id).toBe(first.id);
		expect(supplementary.duplicate).toBe(true);
	});

	it('keeps same-venue events separate when their titles differ', async () => {
		await saveWineEvent(env.DB, input('event-1'));
		const other = await saveWineEvent(env.DB, input('event-2', { title: 'Burgundy Masterclass' }));

		expect(other).toEqual({ id: 'intake-event-2:event-2', duplicate: false });
	});

	it('keeps similar-title events separate when their venues differ', async () => {
		await saveWineEvent(env.DB, input('event-1'));
		const other = await saveWineEvent(env.DB, input('event-2', {
			title: 'California Wine Dinner Bangkok',
			event: { venue: 'The Allium Bangkok' },
		}));

		expect(other.duplicate).toBe(false);
	});

	it('creates a new event when lookup has no candidates', async () => {
		const result = await saveWineEvent(env.DB, input('only-event'));

		expect(result).toEqual({ id: 'intake-only-event:only-event', duplicate: false });
	});

	it('backfills a missing slug when a matched draft event is published', async () => {
		const draft = await saveWineEvent(env.DB, input('draft-source'));
		await env.DB.prepare(
			`UPDATE events SET status = 'draft', published_at = NULL, slug = NULL WHERE id = ?`,
		).bind(draft.id).run();

		const published = await saveWineEvent(env.DB, input('publication-source'));
		const row = await env.DB.prepare(
			'SELECT status, published_at, slug FROM events WHERE id = ?',
		).bind(draft.id).first<{ status: string; published_at: string | null; slug: string | null }>();

		expect(published).toEqual({ id: draft.id, duplicate: true });
		expect(row?.status).toBe('published');
		expect(row?.published_at).not.toBeNull();
		expect(row?.slug).toBe('california-wine-dinner-waldorf-astoria-bangkok-2026-08-15');
	});

	it('preserves an existing slug when a matched draft event is published', async () => {
		const draft = await saveWineEvent(env.DB, input('draft-source'));
		await env.DB.prepare(
			`UPDATE events SET status = 'draft', published_at = NULL, slug = ? WHERE id = ?`,
		).bind('legacy-stable-slug', draft.id).run();

		await saveWineEvent(env.DB, input('publication-source'));
		const row = await env.DB.prepare(
			'SELECT status, published_at, slug FROM events WHERE id = ?',
		).bind(draft.id).first<{ status: string; published_at: string | null; slug: string }>();

		expect(row?.status).toBe('published');
		expect(row?.published_at).not.toBeNull();
		expect(row?.slug).toBe('legacy-stable-slug');
	});

	it('continues to create new published events with the existing slug structure', async () => {
		const created = await saveWineEvent(env.DB, input('new-event'));
		const row = await env.DB.prepare(
			'SELECT status, published_at, slug FROM events WHERE id = ?',
		).bind(created.id).first<{ status: string; published_at: string | null; slug: string | null }>();

		expect(created.duplicate).toBe(false);
		expect(row?.status).toBe('published');
		expect(row?.published_at).not.toBeNull();
		expect(row?.slug).toBe('california-wine-dinner-waldorf-astoria-bangkok-2026-08-15');
	});

	it('keeps a backfilled slug and event stable across an idempotent retry', async () => {
		const draft = await saveWineEvent(env.DB, input('draft-source'));
		await env.DB.prepare(
			`UPDATE events SET status = 'draft', published_at = NULL, slug = '' WHERE id = ?`,
		).bind(draft.id).run();
		const publication = input('publication-source');

		await saveWineEvent(env.DB, publication);
		const firstSlug = await env.DB.prepare('SELECT slug FROM events WHERE id = ?')
			.bind(draft.id).first<string>('slug');
		await saveWineEvent(env.DB, publication);
		const retried = await env.DB.prepare('SELECT slug FROM events WHERE id = ?')
			.bind(draft.id).first<string>('slug');
		const counts = await env.DB.prepare(
			`SELECT COUNT(DISTINCT e.id) AS events, COUNT(ea.asset_id) AS assets
			FROM events e LEFT JOIN event_assets ea ON ea.event_id = e.id`,
		).first<{ events: number; assets: number }>();

		expect(retried).toBe(firstSlug);
		expect(firstSlug).toBe('california-wine-dinner-waldorf-astoria-bangkok-2026-08-15');
		expect(counts).toEqual({ events: 1, assets: 2 });
	});

	it('an additional flyer enriches missing fields while preserving existing values', async () => {
		await saveWineEvent(env.DB, input('flyer-1', {
		title: 'California Wine Dinner',
			event: {
				priceTHB: null,
				contactEmail: null,
				contactPhone: '+66 2 111 1111',
				wines: ['Existing detailed wine'],
			},
		}));

		await saveWineEvent(env.DB, input('flyer-2', {
			title: '',
			event: {
				priceTHB: 3200,
				venue: null,
				contactEmail: 'new@example.com',
				contactPhone: '+66 2 999 9999',
				wines: ['Less useful replacement'],
			},
		}));

		const row = await env.DB.prepare(
			'SELECT title, price_thb, venue, contact_email, contact_phone, wines_json FROM events',
		).first<{
			title: string;
			price_thb: number;
			venue: string;
			contact_email: string;
			contact_phone: string;
			wines_json: string;
		}>();

		expect(row).toEqual({
			title: 'California Wine Dinner',
			price_thb: 3200,
			venue: 'Waldorf Astoria Bangkok',
			contact_email: 'new@example.com',
			contact_phone: '+66 2 111 1111',
			wines_json: '["Existing detailed wine","Less useful replacement"]',
		});
	});

	it('a menu adds wines and regions without duplicating canonical entries', async () => {
		const first = await saveWineEvent(env.DB, input('flyer-1', {
			event: {
				wines: ['Château Margaux', 'Cloudy Bay'],
				wineRegions: ['Bordeaux'],
			},
		}));

		const menu = input('menu-1', {
			assetRole: 'menu',
			title: 'California Wine Dinner Menu',
			event: {
				date: null,
				startTime: null,
				priceTHB: null,
				wines: ['cloudy bay', ' Penfolds Bin 389 '],
				wineRegions: [' bordeaux ', 'Napa Valley'],
			},
		});
		await saveWineEvent(env.DB, menu);
		await saveWineEvent(env.DB, menu);

		const row = await env.DB.prepare(
			'SELECT asset_id, wines_json, wine_regions_json FROM events WHERE id = ?',
		).bind(first.id).first<{ asset_id: string; wines_json: string; wine_regions_json: string }>();

		expect(row).toEqual({
			asset_id: 'flyer-1',
			wines_json: '["Château Margaux","Cloudy Bay","Penfolds Bin 389"]',
			wine_regions_json: '["Bordeaux","Napa Valley"]',
		});
	});

	it('does not append list metadata for a suspicious automatic match', async () => {
		const first = await saveWineEvent(env.DB, input('flyer-1', {
			event: { wines: ['Château Margaux'] },
		}));

		const result = await saveWineEvent(env.DB, input('social-1', {
			assetRole: 'social',
			title: 'California Wine Masterclass',
			event: { wines: ['Unrelated Producer Wine'] },
		}));

		const wines = await env.DB.prepare('SELECT wines_json FROM events WHERE id = ?')
			.bind(first.id).first<string>('wines_json');

		expect(result).toEqual({ id: first.id, duplicate: true });
		expect(wines).toBe('["Château Margaux"]');
	});

	it('does not overwrite conflicting canonical data', async () => {
		const first = await saveWineEvent(env.DB, input('flyer-1'));
		await saveWineEvent(env.DB, input('menu-1', {
			assetRole: 'menu',
			title: 'Reminder: California Wine Dinner',
			event: {
				date: null,
				startTime: '20:00',
				priceTHB: 4500,
				contactEmail: 'other@example.com',
				contactPhone: '+66 2 999 9999',
			},
		}));

		const row = await env.DB.prepare(
			`SELECT title, start_time, price_thb, contact_email, contact_phone
			FROM events WHERE id = ?`,
		).bind(first.id).first<{
			title: string;
			start_time: string;
			price_thb: number;
			contact_email: string;
			contact_phone: string;
		}>();

		expect(row).toEqual({
			title: 'California Wine Dinner',
			start_time: '19:00',
			price_thb: 3200,
			contact_email: 'events@example.com',
			contact_phone: '+66 2 000 0000',
		});
	});

	it('links an asset exactly once when processing is repeated', async () => {
		const event = input('flyer-1');
		await saveWineEvent(env.DB, event);
		await saveWineEvent(env.DB, event);

		const link = await env.DB.prepare(
			'SELECT COUNT(*) AS count, MIN(asset_role) AS role FROM event_assets WHERE asset_id = ?',
		).bind('flyer-1').first<{ count: number; role: string }>();

		expect(link).toEqual({ count: 1, role: 'flyer' });
		expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM events').first<{ count: number }>())?.count).toBe(1);
	});

	it('finds whether a stored asset is already linked to an event', async () => {
		const saved = await saveWineEvent(env.DB, input('flyer-1'));

		expect(await findEventIdByAssetId(env.DB, 'flyer-1')).toBe(saved.id);
		expect(await findEventIdByAssetId(env.DB, 'unlinked')).toBeNull();
	});

	it('persists the extraction fallback as a published event with a public flyer', async () => {
		const result = await saveWineEvent(env.DB, input('fallback-flyer', {
			title: 'Wine Event',
			assetRole: 'flyer',
			isPublic: true,
			r2ObjectKey: 'intakes/fallback/assets/flyer/original',
			contentType: 'image/jpeg',
			event: {
				date: null,
				startTime: null,
				priceTHB: null,
				venue: null,
				contactEmail: null,
				contactPhone: null,
				wines: [],
				wineRegions: [],
				isWineEvent: true,
			},
		}));
		const row = await env.DB.prepare(
			`SELECT e.title, e.slug, e.status, e.published_at, e.event_date,
				e.start_time, e.venue, e.price_thb, e.contact_email, e.contact_phone,
				e.wines_json, e.wine_regions_json, ea.asset_role, ea.is_public
			FROM events e JOIN event_assets ea ON ea.event_id = e.id
			WHERE e.id = ?`,
		).bind(result.id).first<Record<string, string | number | null>>();

		expect(row).toMatchObject({
			title: 'Wine Event',
			slug: 'wine-event',
			status: 'published',
			event_date: null,
			start_time: null,
			venue: null,
			price_thb: null,
			contact_email: null,
			contact_phone: null,
			wines_json: '[]',
			wine_regions_json: '[]',
			asset_role: 'flyer',
			is_public: 1,
		});
		expect(row?.published_at).not.toBeNull();
	});

	it('keeps a published event published when enrichment changes a public field', async () => {
		const first = await saveWineEvent(env.DB, input('flyer-1', { event: { priceTHB: null } }));
		await env.DB.prepare(
			`UPDATE events SET status = 'published', published_at = ? WHERE id = ?`,
		).bind('2026-07-01T00:00:00.000Z', first.id).run();

		await saveWineEvent(env.DB, input('flyer-2', { event: { priceTHB: 3200 } }));
		const row = await env.DB.prepare(
			'SELECT status, published_at, price_thb FROM events WHERE id = ?',
		).bind(first.id).first<{ status: string; published_at: string | null; price_thb: number }>();

		expect(row).toEqual({ status: 'published', published_at: '2026-07-01T00:00:00.000Z', price_thb: 3200 });
	});

	it.each([
		['flyer with no date', { date: null }],
		['flyer with no booking URL', {}],
		['flyer with only title', {
			date: null, startTime: null, priceTHB: null, venue: null,
			contactEmail: null, contactPhone: null, wines: [], wineRegions: [],
		}],
		['flyer with only image', {
			date: null, startTime: null, priceTHB: null, venue: null,
			contactEmail: null, contactPhone: null, wines: [], wineRegions: [], isWineEvent: false,
		}],
		['flyer with email but no website', {
			date: null, startTime: null, priceTHB: null, venue: null,
			contactEmail: 'hello@example.com', contactPhone: null, wines: [], wineRegions: [],
		}],
		['flyer with phone number only', {
			date: null, startTime: null, priceTHB: null, venue: null,
			contactEmail: null, contactPhone: '+66 81 234 5678', wines: [], wineRegions: [],
		}],
	] satisfies Array<[string, Partial<NormalizedWineEvent>]>)('publishes a %s', async (_name, event) => {
		const onlyImage = _name === 'flyer with only image';
		const result = await saveWineEvent(env.DB, input(`partial-${_name}`, {
			title: onlyImage ? null : _name === 'flyer with phone number only' ? null : 'Detected title',
			event: { wines: [], wineRegions: [], ...event },
		}));
		const row = await env.DB.prepare(
			`SELECT title, event_date, status, published_at, wines_json, wine_regions_json
			FROM events WHERE id = ?`,
		).bind(result.id).first<{
			title: string | null;
			event_date: string | null;
			status: string;
			published_at: string | null;
			wines_json: string;
			wine_regions_json: string;
		}>();

		expect(row?.status).toBe('published');
		expect(row?.published_at).not.toBeNull();
		expect(row?.wines_json).toBe('[]');
		expect(row?.wine_regions_json).toBe('[]');
		if (onlyImage) {
			expect(row?.title).toBeNull();
			expect(row?.event_date).toBeNull();
		}
	});

	it('keeps a published event published when a merge only links another asset', async () => {
		const first = await saveWineEvent(env.DB, input('flyer-1'));
		const publishedAt = '2026-07-01T00:00:00.000Z';
		await env.DB.prepare(
			`UPDATE events SET status = 'published', published_at = ? WHERE id = ?`,
		).bind(publishedAt, first.id).run();

		await saveWineEvent(env.DB, input('flyer-2'));
		const row = await env.DB.prepare(
			'SELECT status, published_at FROM events WHERE id = ?',
		).bind(first.id).first<{ status: string; published_at: string | null }>();

		expect(row).toEqual({ status: 'published', published_at: publishedAt });
	});

	it('stores new assets privately unless publication is explicit', async () => {
		await saveWineEvent(env.DB, input('private'));
		await saveWineEvent(env.DB, input('public', { isPublic: true }));
		const assets = await env.DB.prepare(
			'SELECT asset_id, is_public FROM event_assets ORDER BY asset_id',
		).all<{ asset_id: string; is_public: number }>();

		expect(assets.results).toEqual([
			{ asset_id: 'private', is_public: 0 },
			{ asset_id: 'public', is_public: 1 },
		]);
	});

	it('refreshes safe asset metadata without clearing existing nullable delivery metadata', async () => {
		await saveWineEvent(env.DB, input('flyer-1', {
			assetRole: 'flyer', sourceType: 'line_image', isPublic: false,
		}));
		await saveWineEvent(env.DB, input('flyer-1', {
			assetRole: 'menu', sourceType: 'other', isPublic: true,
			r2ObjectKey: 'intakes/event/asset/original', contentType: 'image/png',
		}));
		await saveWineEvent(env.DB, input('flyer-1', {
			assetRole: 'reminder', sourceType: 'line_image', isPublic: false,
			r2ObjectKey: undefined, contentType: undefined,
		}));
		const row = await env.DB.prepare(
			`SELECT asset_role, source_type, is_public, r2_object_key, content_type
			FROM event_assets WHERE asset_id = ?`,
		).bind('flyer-1').first<{
			asset_role: string;
			source_type: string;
			is_public: number;
			r2_object_key: string | null;
			content_type: string | null;
		}>();

		expect(row).toEqual({
			asset_role: 'reminder',
			source_type: 'line_image',
			is_public: 0,
			r2_object_key: 'intakes/event/asset/original',
			content_type: 'image/png',
		});
	});

	it('links fused LINE text and image sources to one event idempotently', async () => {
		const fused = input('flyer-1', {
			sourceType: 'line_image',
			sourceMessageId: 'image-message-1',
			relatedAssets: [{
				intakeId: 'intake-flyer-1',
				assetId: 'line-text-text-message-1',
				assetRole: 'other',
				sourceType: 'line_text',
				sourceMessageId: 'text-message-1',
				textContent: 'Wine list: Château Margaux 2018',
				isPublic: true,
			}],
		});
		const first = await saveWineEvent(env.DB, fused);
		const second = await saveWineEvent(env.DB, fused);
		const assets = await env.DB.prepare(
			`SELECT event_id, source_type, source_message_id, text_content, is_public
			FROM event_assets
			WHERE event_id = ?
			ORDER BY source_type`,
		).bind(first.id).all<{
			event_id: string;
			source_type: string;
			source_message_id: string;
			text_content: string | null;
			is_public: number;
		}>();

		expect(second.id).toBe(first.id);
		expect(assets.results).toEqual([
			{
				event_id: first.id,
				source_type: 'line_image',
				source_message_id: 'image-message-1',
				text_content: null,
				is_public: 0,
			},
			{
				event_id: first.id,
				source_type: 'line_text',
				source_message_id: 'text-message-1',
				text_content: 'Wine list: Château Margaux 2018',
				is_public: 0,
			},
		]);
	});
});

describe('AI-assisted event resolution', () => {
	function aiOptions(response: unknown): { options: AiEventResolutionOptions; run: ReturnType<typeof vi.fn> } {
		const run = vi.fn().mockResolvedValue(response);
		return {
			run,
			options: {
				ai: { run } as unknown as Ai,
				highThreshold: 0.85,
				lowThreshold: 0.45,
				resolver: { provider: 'workers_ai', model: 'test-model', timeoutMs: 50 },
			},
		};
	}

	function ambiguousInput(assetId: string): StoredWineEventInput {
		return input(assetId, {
			title: 'California Wine Tasting',
			event: { startTime: '20:00' },
		});
	}

	it('invokes AI for an ambiguous match and accepts MATCH', async () => {
		const existing = await saveWineEvent(env.DB, input('flyer-1'));
		const { options, run } = aiOptions({
			decision: 'MATCH', candidateId: existing.id, confidence: 0.91, reason: 'Same event.',
		});

		const result = await saveWineEvent(env.DB, ambiguousInput('flyer-2'), options);

		expect(run).toHaveBeenCalledOnce();
		expect(result).toEqual({ id: existing.id, duplicate: true });
	});

	it('accepts NEW_EVENT for an ambiguous match', async () => {
		await saveWineEvent(env.DB, input('flyer-1'));
		const { options } = aiOptions({
			decision: 'NEW_EVENT', candidateId: null, confidence: 0.95, reason: 'Different event.',
		});

		const result = await saveWineEvent(env.DB, ambiguousInput('flyer-2'), options);

		expect(result).toEqual({ id: 'intake-flyer-2:flyer-2', duplicate: false });
	});

	it('skips AI for high and low deterministic confidence', async () => {
		await saveWineEvent(env.DB, input('flyer-1'));
		const { options, run } = aiOptions({
			decision: 'NEW_EVENT', candidateId: null, confidence: 1, reason: 'Unused.',
		});

		await saveWineEvent(env.DB, input('exact-copy'), options);
		await saveWineEvent(env.DB, input('different', { title: 'Burgundy Masterclass' }), options);

		expect(run).not.toHaveBeenCalled();
	});

	it.each([
		['invalid JSON', { response: 'not json' }],
		['invalid candidate', { decision: 'MATCH', candidateId: 'missing', confidence: 0.9, reason: 'Match.' }],
	] as const)('falls back to the deterministic result for %s', async (_label, response) => {
		const existing = await saveWineEvent(env.DB, input('flyer-1'));
		const { options } = aiOptions(response);

		const result = await saveWineEvent(env.DB, ambiguousInput('flyer-2'), options);

		expect(result).toEqual({ id: existing.id, duplicate: true });
	});

	it('falls back to the deterministic result when AI times out', async () => {
		const existing = await saveWineEvent(env.DB, input('flyer-1'));
		const run = vi.fn(() => new Promise(() => undefined));
		const options: AiEventResolutionOptions = {
			ai: { run } as unknown as Ai,
			highThreshold: 0.85,
			lowThreshold: 0.45,
			resolver: { provider: 'workers_ai', model: 'test-model', timeoutMs: 1 },
		};

		const result = await saveWineEvent(env.DB, ambiguousInput('flyer-2'), options);

		expect(result).toEqual({ id: existing.id, duplicate: true });
	});

	it.each([
		['invalid thresholds', { HIGH_THRESHOLD: '0.4', LOW_THRESHOLD: '0.5', AI_TIMEOUT_MS: '5000' }],
		['invalid timeout', { HIGH_THRESHOLD: '0.85', LOW_THRESHOLD: '0.45', AI_TIMEOUT_MS: '0' }],
	] as const)('continues deterministic ingestion with %s', async (_label, values) => {
		const configError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const options = getOptionalAiEventResolutionOptions({
			AI: { run: vi.fn() } as unknown as Ai,
			AI_PROVIDER: 'workers_ai',
			AI_MODEL: 'test-model',
			...values,
		} as WorkerEnv);

		const result = await saveWineEvent(env.DB, input('config-fallback'), options);

		expect(options).toBeUndefined();
		expect(result).toEqual({ id: 'intake-config-fallback:config-fallback', duplicate: false });
		expect(configError).toHaveBeenCalledWith(
			'AI EVENT RESOLUTION CONFIG INVALID',
			expect.stringContaining('error'),
		);
		configError.mockRestore();
	});
});
