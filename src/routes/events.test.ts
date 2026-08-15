import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { saveWineEvent } from '../services/event-repository';
import { getBangkokLocalDate } from './events';

declare module 'cloudflare:test' {
	interface ProvidedEnv { DB: D1Database; EVENT_INTAKES: R2Bucket }
}

const schema = `
	CREATE TABLE IF NOT EXISTS events (
		id TEXT PRIMARY KEY, intake_id TEXT NOT NULL, asset_id TEXT NOT NULL, title TEXT,
		event_date TEXT, start_time TEXT, price_thb INTEGER, venue TEXT, contact_email TEXT,
		contact_phone TEXT, wines_json TEXT NOT NULL DEFAULT '[]', wine_regions_json TEXT NOT NULL DEFAULT '[]',
		organizer TEXT, address TEXT, district TEXT, website_url TEXT, booking_url TEXT,
		booking_instructions TEXT, contact_text TEXT, description TEXT, course_count INTEGER,
		price_text TEXT, currency TEXT, price_qualifier TEXT, end_time TEXT, timezone TEXT,
		wine_producers_json TEXT NOT NULL DEFAULT '[]', partners_json TEXT NOT NULL DEFAULT '[]',
		merchants_json TEXT NOT NULL DEFAULT '[]', menu_json TEXT NOT NULL DEFAULT '[]',
		notes_json TEXT NOT NULL DEFAULT '[]', source_contact_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT,
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
	CREATE UNIQUE INDEX IF NOT EXISTS idx_event_assets_asset_id ON event_assets(asset_id);
	CREATE UNIQUE INDEX IF NOT EXISTS idx_events_asset_id ON events(asset_id);
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
	slug?: string | null;
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
		input.slug === undefined ? `slug-${input.id}` : input.slug,
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
	it('renders the preview event list from published D1 rows with R2-backed image URLs',async()=>{await addEvent({id:'html',title:'Chez Papa Wine Pairing',slug:'chez-papa-wine-pairing'});await addAsset('html','html-flyer',{role:'flyer'});const response=await SELF.fetch('https://preview.example.com/events');const body=await response.text();expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('text/html');expect(body).toContain('Chez Papa Wine Pairing');expect(body).toContain('/events/chez-papa-wine-pairing');expect(body).toContain('/api/assets/html-flyer');});

	it('renders a published event detail and returns HTML 404 for drafts and unknown slugs',async()=>{await addEvent({id:'html-detail',title:'Chapoutier &lt; Dinner',slug:'chapoutier-dinner'});await addAsset('html-detail','detail-flyer',{role:'main'});const response=await SELF.fetch('https://preview.example.com/events/chapoutier-dinner');const body=await response.text();expect(response.status).toBe(200);expect(body).toContain('Chapoutier &amp;lt; Dinner');expect(body).toContain('/api/assets/detail-flyer');await addEvent({id:'html-draft',status:'draft',publishedAt:null,slug:'html-draft'});for(const path of ['/events/html-draft','/events/unknown']){const missing=await SELF.fetch(`https://preview.example.com${path}`);expect(missing.status).toBe(404);expect(missing.headers.get('content-type')).toContain('text/html');}});

	it('adds canonical metadata and valid Event JSON-LD from real D1 values', async () => {
		await addEvent({ id: 'seo', title: 'California Wine Dinner', date: '2026-08-26', startTime: '19:00', venue: 'Waldorf Astoria Bangkok', slug: 'california-wine-dinner-waldorf-astoria-bangkok-2026-08-26' });
		await env.DB.prepare("UPDATE events SET end_time='22:00', description='A five-course pairing dinner', organizer='Wine Host', address='151 Ratchadamri Road', booking_url='https://tickets.example.com/book', currency='THB' WHERE id='seo'").run();
		await addAsset('seo', 'seo-flyer', { role: 'main' });
		const response = await SELF.fetch('https://preview.example.com/events/california-wine-dinner-waldorf-astoria-bangkok-2026-08-26');
		const body = await response.text();
		expect(body).toContain('<link rel="canonical" href="https://bangkokwinescout.com/events/california-wine-dinner-waldorf-astoria-bangkok-2026-08-26">');
		expect(body).not.toContain('workers.dev');
		expect(body).not.toContain('www.bangkokwinescout.com');
		const script = body.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)?.[1];
		expect(script).toBeTruthy();
		const jsonLd = JSON.parse(script!);
		expect(jsonLd).toMatchObject({ '@type': 'Event', name: 'California Wine Dinner', startDate: '2026-08-26T19:00:00+07:00', endDate: '2026-08-26T22:00:00+07:00', description: 'A five-course pairing dinner', location: { '@type': 'Place', name: 'Waldorf Astoria Bangkok', address: '151 Ratchadamri Road' }, organizer: { '@type': 'Organization', name: 'Wine Host' }, offers: { '@type': 'Offer', price: 1290, priceCurrency: 'THB', url: 'https://tickets.example.com/book' } });
		expect(jsonLd.image).toEqual(['https://bangkokwinescout.com/api/assets/seo-flyer']);
	});

	it('omits unavailable optional structured data and safely escapes JSON-LD content', async () => {
		await addEvent({ id: 'sparse-seo', title: 'Safe </script><script>alert(1)</script>', date: null, startTime: null, venue: '', slug: 'safe-event' });
		await env.DB.prepare("UPDATE events SET price_thb=NULL, contact_email=NULL, contact_phone=NULL WHERE id='sparse-seo'").run();
		const body = await (await SELF.fetch('https://preview.example.com/events/safe-event')).text();
		expect(body).not.toContain('</script><script>alert(1)</script>');
		const jsonLd = JSON.parse(body.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)![1]);
		expect(jsonLd).not.toHaveProperty('startDate');
		expect(jsonLd).not.toHaveProperty('location');
		expect(jsonLd).not.toHaveProperty('organizer');
		expect(jsonLd).not.toHaveProperty('offers');
	});

	it('preserves HTML date filtering, including explicit historical ranges, with one list canonical', async () => {
		await addEvent({ id: 'historical-html', title: 'Historical Dinner', date: '2026-07-18' });
		await addEvent({ id: 'future-html', title: 'Future Dinner', date: '2026-09-18' });
		const response = await SELF.fetch('https://preview.example.com/events?from=2026-07-01&to=2026-07-31');
		const body = await response.text();
		expect(response.status).toBe(200);
		expect(body).toContain('Historical Dinner');
		expect(body).not.toContain('Future Dinner');
		expect(body).toContain('<link rel="canonical" href="https://bangkokwinescout.com/events">');
	});

	it('serves informational pages with canonical metadata and community submission wording', async () => {
		const titles = new Set<string>();
		const descriptions = new Set<string>();
		for (const path of ['/about', '/share-an-event', '/legal', '/privacy', '/disclaimer']) {
			const response = await SELF.fetch(`https://preview.example.com${path}`);
			const body = await response.text();
			expect(response.status).toBe(200);
			expect(body).toContain(`<link rel="canonical" href="https://bangkokwinescout.com${path}">`);
			titles.add(body.match(/<title>([^<]+)<\/title>/)![1]);
			descriptions.add(body.match(/<meta name="description" content="([^"]+)">/)![1]);
		}
		expect(titles.size).toBe(5);
		expect(descriptions.size).toBe(5);

		const about = await (await SELF.fetch('https://preview.example.com/about')).text();
		expect(about).toContain('community-driven');
		expect(about).toContain('Anyone may submit a suitable Bangkok wine event');
		expect(about).toContain('or simply someone who discovered an interesting event');

		const share = await (await SELF.fetch('https://preview.example.com/share-an-event')).text();
		expect(share).toContain('You do not need to be the organizer');
	});

	it('serves a public-only sitemap and robots policy on the canonical host', async () => {
		await addEvent({ id: 'past-sitemap', date: '2020-01-01', slug: 'past-wine-event-2020-01-01' });
		await addEvent({ id: 'draft-sitemap', status: 'draft', publishedAt: null, slug: 'draft-event' });
		const sitemap = await SELF.fetch('https://preview.example.com/sitemap.xml');
		const xml = await sitemap.text();
		expect(sitemap.headers.get('content-type')).toContain('application/xml');
		for (const path of ['/', '/events', '/about', '/share-an-event', '/legal', '/privacy', '/disclaimer', '/events/past-wine-event-2020-01-01']) expect(xml).toContain(`https://bangkokwinescout.com${path}`);
		expect(xml).not.toContain('draft-event');
		expect(xml).not.toContain('/api/');
		expect(xml).not.toContain('/admin/');
		const robots = await (await SELF.fetch('https://preview.example.com/robots.txt')).text();
		expect(robots).toContain('Sitemap: https://bangkokwinescout.com/sitemap.xml');
		expect(robots).toContain('Disallow: /api/');
	});

	it('supports HEAD and rejects mutations on preview HTML routes',async()=>{await addEvent({id:'html-head',slug:'html-head'});const head=await SELF.fetch('https://preview.example.com/events/html-head',{method:'HEAD'});expect(head.status).toBe(200);expect(await head.text()).toBe('');const post=await SELF.fetch('https://preview.example.com/events',{method:'POST'});expect(post.status).toBe(405);expect(post.headers.get('allow')).toBe('GET, HEAD');});

	it('returns only published upcoming events and includes today in stable order', async () => {
		await addEvent({ id: 'past', date: dateOffset(-1) });
		await addEvent({ id: 'today-late', date: dateOffset(0), startTime: '20:00' });
		await addEvent({ id: 'today-early', date: dateOffset(0), startTime: '18:00' });
		await addEvent({ id: 'draft', status: 'draft', publishedAt: null });
		await addEvent({ id: 'not-published-at', publishedAt: null });

		const { body } = await json('/api/events');
		expect(body.data.map((event: { slug: string }) => event.slug)).toEqual(['slug-today-early', 'slug-today-late']);
	});

	it('lists a matched draft event after publication backfills its missing slug', async () => {
		const eventDate = dateOffset(1);
		await addEvent({
			id: 'legacy-draft',
			date: eventDate,
			status: 'draft',
			publishedAt: null,
			title: 'Legacy Wine Dinner',
			venue: 'Attico',
			slug: null,
		});

		await saveWineEvent(env.DB, {
			intakeId: 'publication-intake',
			assetId: 'publication-flyer',
			assetRole: 'flyer',
			sourceType: 'line_image',
			isPublic: true,
			title: 'Legacy Wine Dinner',
			event: {
				date: eventDate,
				startTime: '18:00',
				priceTHB: 1290,
				venue: 'Attico',
				contactEmail: 'public@example.com',
				contactPhone: '+66 2 000 0000',
				wines: ['Riesling'],
				wineRegions: ['Wachau'],
				isWineEvent: true,
			},
		});

		const { body } = await json('/api/events');

		expect(body.data.map((event: { slug: string }) => event.slug)).toEqual([
			`legacy-wine-dinner-attico-${eventDate}`,
		]);
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

	it('returns a sparse published fallback event with its flyer image', async () => {
		await saveWineEvent(env.DB, {
			intakeId: 'line-unreadable',
			assetId: 'line-message-unreadable',
			assetRole: 'main',
			sourceType: 'line_image',
			isPublic: true,
			r2ObjectKey: 'intakes/line-unreadable/assets/line-message-unreadable/original',
			contentType: 'image/jpeg',
			title: 'Wine Event',
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
		});

		const { body } = await json('/api/events?limit=20');
		const fallback = body.data.find((event: { title: string }) => event.title === 'Wine Event');

		expect(fallback).toMatchObject({
			date: null,
			startTime: null,
			venue: null,
			priceTHB: null,
			heroAsset: {
				id: 'line-message-unreadable',
				role: 'main',
				url: '/api/assets/line-message-unreadable',
			},
		});
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

	it('includes a past event within an explicit inclusive date range', async () => {
		await addEvent({ id: 'gala', date: '2026-07-18' });
		await addEvent({ id: 'before-range', date: '2026-04-30' });
		await addEvent({ id: 'after-range', date: '2026-08-05' });

		const { body } = await json('/api/events?from=2026-05-01&to=2026-08-04');

		expect(body.data.map((event: { slug: string }) => event.slug)).toEqual(['slug-gala']);
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

	it('returns every persisted Chez Papa enrichment field', async () => {
		await addEvent({ id: 'chez', title: 'Wine Pairing Dinner', date: '2026-08-26', startTime: '18:00', slug: 'wine-pairing-dinner-2026-08-26' });
		await env.DB.prepare(`UPDATE events SET organizer=?, address=?, district=?, website_url=?, booking_instructions=?, contact_phone=?, description=?, course_count=?, price_text=?, currency=?, price_qualifier=?, wine_producers_json=?, merchants_json=?, source_contact_json=? WHERE id='chez'`)
			.bind('Chez Papa French Bistro','Chez Papa Bangkok – Sukhumvit 51','Sukhumvit 51','https://chezpapabangkok.carrd.co/','Book your table','063 832 3605','5 Courses Wine Pairing Experience',5,'THB 1,490++','THB','++','["Chapoutier"]','["Vinum Lector"]','["063 832 3605"]').run();
		const { body } = await json('/api/events/wine-pairing-dinner-2026-08-26');
		expect(body.data).toEqual(expect.objectContaining({organizer:'Chez Papa French Bistro',address:'Chez Papa Bangkok – Sukhumvit 51',district:'Sukhumvit 51',websiteUrl:'https://chezpapabangkok.carrd.co/',bookingInstructions:'Book your table',contactPhone:'063 832 3605',description:'5 Courses Wine Pairing Experience',courseCount:5,priceText:'THB 1,490++',currency:'THB',priceQualifier:'++',wineProducers:['Chapoutier'],merchants:['Vinum Lector'],sourceContactInformation:['063 832 3605']}));
	});

	it('lists public visual assets in role order and excludes text and private assets', async () => {
		await addEvent({ id: 'public' });
		await addAsset('public', 'menu', { role: 'menu' });
		await addAsset('public', 'flyer', { role: 'flyer' });
		await addAsset('public', 'text', { type: 'line_text' });
		await addAsset('public', 'private', { isPublic: false });
		const { body } = await json('/api/events/slug-public/assets');
		expect(body.data.map((asset: { id: string }) => asset.id)).toEqual(['flyer', 'menu']);
		expect(body.data.map((asset: { alt: string }) => asset.alt)).toEqual(['', '']);
	});

	it('returns an empty alt string instead of generating generic text from the event title', async () => {
		await addEvent({ id: 'alt', title: 'Bangkok Burgundy Dinner' });
		await addAsset('alt', 'alt-flyer', { role: 'flyer' });
		const list = await json('/api/events');
		const detail = await json('/api/events/slug-alt');

		expect(list.body.data.find((event: { slug: string }) => event.slug === 'slug-alt').heroAsset.alt).toBe('');
		expect(detail.body.data.heroAsset.alt).toBe('');
		expect(detail.body.data.assets[0].alt).toBe('');
		expect(JSON.stringify(detail.body)).not.toContain('Flyer for Bangkok Burgundy Dinner');
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
		const headers = { origin: 'https://bangkokwinescout.com' };
		const success = await SELF.fetch('https://api.example.com/api/events', { headers });
		const error = await SELF.fetch('https://api.example.com/api/events/unknown', { headers });
		const options = await SELF.fetch('https://api.example.com/api/events', { method: 'OPTIONS', headers });
		expect(success.headers.get('access-control-allow-origin')).toBe(headers.origin);
		expect(error.headers.get('access-control-allow-origin')).toBe(headers.origin);
		expect(options.status).toBe(204);
		expect(options.headers.get('access-control-allow-origin')).toBe(headers.origin);
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
