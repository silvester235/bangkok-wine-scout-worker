import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getBangkokLocalDate } from './events';

declare module 'cloudflare:test' {
	interface ProvidedEnv { DB: D1Database; EVENT_INTAKES: R2Bucket }
}

const schema = `
	CREATE TABLE IF NOT EXISTS events (
		id TEXT PRIMARY KEY, intake_id TEXT NOT NULL, asset_id TEXT NOT NULL, title TEXT,
		event_date TEXT, start_time TEXT, price_thb INTEGER, venue TEXT, contact_email TEXT,
		contact_phone TEXT, wines_json TEXT NOT NULL DEFAULT '[]', wine_regions_json TEXT NOT NULL DEFAULT '[]',
		is_wine_event INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'draft', published_at TEXT, slug TEXT
	);
	CREATE TABLE IF NOT EXISTS event_assets (
		event_id TEXT NOT NULL, intake_id TEXT NOT NULL, asset_id TEXT NOT NULL,
		asset_role TEXT NOT NULL DEFAULT 'other', linked_at TEXT NOT NULL,
		source_type TEXT NOT NULL DEFAULT 'line_image', source_message_id TEXT, text_content TEXT,
		is_public INTEGER NOT NULL DEFAULT 0, r2_object_key TEXT, content_type TEXT,
		PRIMARY KEY (event_id, asset_id)
	);
`;

function dateOffset(days: number): string {
	const date = new Date(`${getBangkokLocalDate()}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

async function addEvent(input: {
	id: string;
	date?: string | null;
	startTime?: string | null;
	status?: string;
	publishedAt?: string | null;
	title?: string;
	venue?: string;
	wines?: string[];
	regions?: string[];
}): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO events (
			id, intake_id, asset_id, title, event_date, start_time, price_thb, venue,
			contact_email, contact_phone, wines_json, wine_regions_json, is_wine_event,
			created_at, status, published_at, slug
		) VALUES (?, ?, ?, ?, ?, ?, 1290, ?, 'public@example.com', '+66 2 000 0000', ?, ?, 1, ?, ?, ?, ?)`,
	).bind(
		input.id,
		`intake-${input.id}`,
		`source-${input.id}`,
		input.title ?? `Event ${input.id}`,
		input.date === undefined ? dateOffset(1) : input.date,
		input.startTime === undefined ? '18:00' : input.startTime,
		input.venue ?? 'Attico',
		JSON.stringify(input.wines ?? ['Riesling']),
		JSON.stringify(input.regions ?? ['Wachau']),
		'2026-07-01T00:00:00.000Z',
		input.status ?? 'published',
		input.publishedAt === undefined ? '2026-07-02T00:00:00.000Z' : input.publishedAt,
		`slug-${input.id}`,
	).run();
}

async function addAsset(eventId: string, assetId: string, input: {
	role?: string;
	type?: string;
	isPublic?: boolean;
	contentType?: string | null;
	r2ObjectKey?: string | null;
} = {}): Promise<string> {
	const key = `intakes/intake-${eventId}/assets/${assetId}/original`;
	await env.DB.prepare(
		`INSERT INTO event_assets (
			event_id, intake_id, asset_id, asset_role, linked_at, source_type,
			is_public, r2_object_key, content_type
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		eventId, `intake-${eventId}`, assetId, input.role ?? 'flyer',
		'2026-07-01T00:00:00.000Z', input.type ?? 'line_image', input.isPublic === false ? 0 : 1,
		input.r2ObjectKey === undefined ? key : input.r2ObjectKey,
		input.contentType === undefined ? 'image/jpeg' : input.contentType,
	).run();
	return key;
}

async function json(path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
	const response = await SELF.fetch(`https://api.example.com${path}`, init);
	return { response, body: await response.json() };
}

beforeAll(async () => {
	for (const statement of schema.split(';').map((part) => part.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
});

beforeEach(async () => {
	await env.DB.batch([env.DB.prepare('DELETE FROM event_assets'), env.DB.prepare('DELETE FROM events')]);
});

describe('public event API', () => {
	it('returns only published upcoming events and includes today in stable order', async () => {
		await addEvent({ id: 'past', date: dateOffset(-1) });
		await addEvent({ id: 'today-late', date: dateOffset(0), startTime: '20:00' });
		await addEvent({ id: 'today-early', date: dateOffset(0), startTime: '18:00' });
		await addEvent({ id: 'draft', status: 'draft', publishedAt: null });
		await addEvent({ id: 'not-published-at', publishedAt: null });

		const { body } = await json('/api/events');
		expect(body.data.map((event: { slug: string }) => event.slug)).toEqual(['slug-today-early', 'slug-today-late']);
	});

	it('supports includePast and bounded limit validation', async () => {
		await addEvent({ id: 'past', date: dateOffset(-1) });
		await addEvent({ id: 'future', date: dateOffset(1) });
		expect((await json('/api/events?includePast=true')).body.data).toHaveLength(2);
		expect((await json('/api/events?limit=1')).body.data).toHaveLength(1);
		const invalid = await json('/api/events?limit=51');
		expect(invalid.response.status).toBe(400);
		expect(invalid.body.error.code).toBe('INVALID_LIMIT');
	});

	it('paginates with a stable cursor without duplicates or skipped rows', async () => {
		await addEvent({ id: 'a', date: dateOffset(1), startTime: '18:00' });
		await addEvent({ id: 'b', date: dateOffset(1), startTime: '18:00' });
		await addEvent({ id: 'c', date: dateOffset(1), startTime: '19:00' });
		const first = await json('/api/events?limit=2');
		const second = await json(`/api/events?limit=2&cursor=${encodeURIComponent(first.body.pagination.nextCursor)}`);
		expect([...first.body.data, ...second.body.data].map((event: { slug: string }) => event.slug))
			.toEqual(['slug-a', 'slug-b', 'slug-c']);
		expect(second.body.pagination.nextCursor).toBeNull();
	});

	it('lists undated published events after dated events with a nullable date', async () => {
		await addEvent({ id: 'undated-b', date: null, startTime: null });
		await addEvent({ id: 'dated', date: dateOffset(1), startTime: '18:00' });
		await addEvent({ id: 'undated-a', date: null, startTime: null });

		const { body } = await json('/api/events');

		expect(body.data.map((event: { slug: string }) => event.slug)).toEqual([
			'slug-dated',
			'slug-undated-a',
			'slug-undated-b',
		]);
		expect(body.data[1].date).toBeNull();
	});

	it('paginates stably across the dated-to-undated boundary', async () => {
		await addEvent({ id: 'dated-a', date: dateOffset(1), startTime: '18:00' });
		await addEvent({ id: 'dated-b', date: dateOffset(2), startTime: '18:00' });
		await addEvent({ id: 'undated-a', date: null, startTime: null });
		await addEvent({ id: 'undated-b', date: null, startTime: null });

		const first = await json('/api/events?limit=2');
		const second = await json(`/api/events?limit=2&cursor=${encodeURIComponent(first.body.pagination.nextCursor)}`);

		expect([...first.body.data, ...second.body.data].map((event: { slug: string }) => event.slug)).toEqual([
			'slug-dated-a',
			'slug-dated-b',
			'slug-undated-a',
			'slug-undated-b',
		]);
		expect(second.body.pagination.nextCursor).toBeNull();
	});

	it('keeps explicit date-range filters limited to dated events', async () => {
		await addEvent({ id: 'dated', date: dateOffset(2) });
		await addEvent({ id: 'undated', date: null });

		const { body } = await json(`/api/events?from=${dateOffset(1)}&to=${dateOffset(3)}`);

		expect(body.data.map((event: { slug: string }) => event.slug)).toEqual(['slug-dated']);
	});

	it('rejects an invalid cursor', async () => {
		const { response, body } = await json('/api/events?cursor=not-a-cursor');
		expect(response.status).toBe(400);
		expect(body.error.code).toBe('INVALID_CURSOR');
	});

	it('filters by date range, venue, wine, and region', async () => {
		await addEvent({ id: 'match', date: dateOffset(2), venue: 'The Bamboo Bar', wines: ['Cloudy Bay'], regions: ['Marlborough'] });
		await addEvent({ id: 'other', date: dateOffset(4), venue: 'Attico', wines: ['Penfolds'], regions: ['Barossa'] });
		const path = `/api/events?from=${dateOffset(1)}&to=${dateOffset(3)}&venue=bamboo&wine=cloudy&region=marlborough`;
		expect((await json(path)).body.data.map((event: { slug: string }) => event.slug)).toEqual(['slug-match']);
	});

	it('does not allow a past from date to bypass upcoming-only filtering', async () => {
		await addEvent({ id: 'past', date: dateOffset(-2) });
		await addEvent({ id: 'today', date: dateOffset(0) });
		const { body } = await json(`/api/events?from=${dateOffset(-3)}`);
		expect(body.data.map((event: { slug: string }) => event.slug)).toEqual(['slug-today']);
	});

	it('returns published detail without internal source fields and hides drafts', async () => {
		await addEvent({ id: 'public' });
		await addEvent({ id: 'draft', status: 'draft', publishedAt: null });
		const detail = await json('/api/events/slug-public');
		expect(detail.response.status).toBe(200);
		expect(detail.body.data.contactEmail).toBe('public@example.com');
		expect(detail.body.data).not.toHaveProperty('id');
		expect(detail.body.data).not.toHaveProperty('intakeId');
		expect(detail.body.data).not.toHaveProperty('assetId');
		const head = await SELF.fetch('https://api.example.com/api/events/slug-public', { method: 'HEAD' });
		expect(head.status).toBe(200);
		expect(head.headers.get('cache-control')).toContain('max-age=300');
		expect(await head.text()).toBe('');
		expect((await json('/api/events/slug-draft')).response.status).toBe(404);
		expect((await json('/api/events/unknown')).response.status).toBe(404);
	});

	it('lists public visual assets in role order and excludes text and private assets', async () => {
		await addEvent({ id: 'public' });
		await addAsset('public', 'menu', { role: 'menu' });
		await addAsset('public', 'flyer', { role: 'flyer' });
		await addAsset('public', 'text', { type: 'line_text' });
		await addAsset('public', 'private', { isPublic: false });
		const { body } = await json('/api/events/slug-public/assets');
		expect(body.data.map((asset: { id: string }) => asset.id)).toEqual(['flyer', 'menu']);
	});

	it('excludes assets without stored R2 keys or image content types', async () => {
		await addEvent({ id: 'public' });
		await addAsset('public', 'valid');
		await addAsset('public', 'missing-key', { r2ObjectKey: null });
		await addAsset('public', 'not-image', { contentType: 'application/pdf' });
		const { body } = await json('/api/events/slug-public/assets');

		expect(body.data.map((asset: { id: string }) => asset.id)).toEqual(['valid']);
		expect((await SELF.fetch('https://api.example.com/api/assets/missing-key')).status).toBe(404);
		expect((await SELF.fetch('https://api.example.com/api/assets/not-image')).status).toBe(404);
	});

	it('streams and supports HEAD and conditional requests for a published asset', async () => {
		await addEvent({ id: 'public' });
		const key = await addAsset('public', 'flyer');
		await env.EVENT_INTAKES.put(key, new TextEncoder().encode('image-bytes'), { httpMetadata: { contentType: 'image/jpeg' } });
		const response = await SELF.fetch('https://api.example.com/api/assets/flyer');
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/jpeg');
		expect(response.headers.get('cache-control')).toContain('max-age=3600');
		expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('image-bytes');
		const head = await SELF.fetch('https://api.example.com/api/assets/flyer', { method: 'HEAD' });
		expect(head.status).toBe(200);
		expect(await head.text()).toBe('');
		const etag = response.headers.get('etag')!;
		for (const validator of [etag, `"other", ${etag}`, `W/${etag}`, '*']) {
			const conditional = await SELF.fetch('https://api.example.com/api/assets/flyer', {
				headers: { 'if-none-match': validator },
			});
			expect(conditional.status).toBe(304);
		}
		const nonMatching = await SELF.fetch('https://api.example.com/api/assets/flyer', {
			headers: { 'if-none-match': '"other"' },
		});
		expect(nonMatching.status).toBe(200);
		await nonMatching.arrayBuffer();
	});

	it('hides unknown, private, text, and unpublished assets and never accepts R2 keys', async () => {
		await addEvent({ id: 'draft', status: 'draft', publishedAt: null });
		await addAsset('draft', 'draft-flyer');
		await addEvent({ id: 'public' });
		await addAsset('public', 'private', { isPublic: false });
		await addAsset('public', 'text', { type: 'line_text' });
		for (const path of ['/api/assets/unknown', '/api/assets/draft-flyer', '/api/assets/private', '/api/assets/text', '/api/assets/intakes/x/original']) {
			expect((await SELF.fetch(`https://api.example.com${path}`)).status).toBe(404);
		}
	});

	it('applies configured CORS to success and errors and handles preflight', async () => {
		await addEvent({ id: 'public' });
		const headers = { origin: 'https://frontend.example.com' };
		const success = await SELF.fetch('https://api.example.com/api/events', { headers });
		const error = await SELF.fetch('https://api.example.com/api/events/unknown', { headers });
		const options = await SELF.fetch('https://api.example.com/api/events', { method: 'OPTIONS', headers });
		expect(success.headers.get('access-control-allow-origin')).toBe(headers.origin);
		expect(error.headers.get('access-control-allow-origin')).toBe(headers.origin);
		expect(options.status).toBe(204);
		expect(options.headers.get('access-control-allow-methods')).toContain('HEAD');
		const denied = await SELF.fetch('https://api.example.com/api/events', { headers: { origin: 'https://evil.example' } });
		expect(denied.headers.get('access-control-allow-origin')).toBeNull();
	});

	it('returns structured routing errors and preserves existing non-API routes', async () => {
		const unknown = await json('/api/nope');
		const method = await json('/api/events', { method: 'POST' });
		expect(unknown.response.status).toBe(404);
		expect(unknown.body.error.code).toBe('NOT_FOUND');
		expect(method.response.status).toBe(405);
		expect(method.response.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
		expect((await SELF.fetch('https://api.example.com/health')).status).toBe(200);
	});
});
