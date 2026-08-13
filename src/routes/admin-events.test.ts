import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

declare module 'cloudflare:test' {
	interface ProvidedEnv { DB: D1Database; EVENT_INTAKES: R2Bucket; ADMIN_API_TOKEN: string }
}

const schema = `
	CREATE TABLE IF NOT EXISTS events (
		id TEXT PRIMARY KEY,
		title TEXT,
		slug TEXT,
		event_date TEXT,
		status TEXT NOT NULL,
		published_at TEXT,
		venue TEXT,
		price_thb INTEGER,
		created_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS event_assets (
		event_id TEXT NOT NULL,
		intake_id TEXT NOT NULL,
		asset_id TEXT NOT NULL,
		asset_role TEXT NOT NULL DEFAULT 'other',
		linked_at TEXT NOT NULL,
		source_type TEXT NOT NULL,
		source_message_id TEXT,
		text_content TEXT,
		is_public INTEGER NOT NULL DEFAULT 0,
		r2_object_key TEXT,
		content_type TEXT,
		PRIMARY KEY (event_id, asset_id)
	);
	CREATE TABLE IF NOT EXISTS line_text_contexts (
		message_id TEXT PRIMARY KEY, linked_image_asset_id TEXT, linked_event_id TEXT
	);
	CREATE TABLE IF NOT EXISTS line_image_batches (
		id TEXT PRIMARY KEY, resulting_event_ids_json TEXT NOT NULL DEFAULT '[]', minimal_event_id TEXT
	);
	CREATE TABLE IF NOT EXISTS line_image_batch_assets (
		batch_id TEXT NOT NULL, asset_id TEXT NOT NULL, line_message_id TEXT NOT NULL,
		r2_object_key TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS line_message_batch_texts (
		batch_id TEXT NOT NULL, message_id TEXT NOT NULL, asset_id TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS line_message_batch_web_sources (
		batch_id TEXT NOT NULL, message_id TEXT NOT NULL, webhook_event_id TEXT NOT NULL,
		asset_id TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS line_url_ingestion_deliveries (
		webhook_event_id TEXT PRIMARY KEY, batch_id TEXT
	);
	CREATE TABLE IF NOT EXISTS line_webhook_delivery_receipts(webhook_event_id TEXT PRIMARY KEY,message_id TEXT NOT NULL,batch_id TEXT);
	CREATE TABLE IF NOT EXISTS line_delivery_outbox(id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL,batch_id TEXT,asset_id TEXT);
	CREATE TABLE IF NOT EXISTS event_enrichment_state(asset_id TEXT PRIMARY KEY,event_id TEXT,intake_id TEXT NOT NULL,status TEXT,last_error_code TEXT);
	CREATE TABLE IF NOT EXISTS agent_submissions(
		id TEXT PRIMARY KEY,source TEXT NOT NULL,conversation_key TEXT NOT NULL,status TEXT NOT NULL,
		first_received_at TEXT NOT NULL,last_received_at TEXT NOT NULL,result_event_id TEXT,result_action TEXT,
		error_message TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS agent_submission_items(
		id TEXT PRIMARY KEY,submission_id TEXT NOT NULL,source_message_id TEXT NOT NULL,item_type TEXT NOT NULL,
		asset_id TEXT,intake_id TEXT,r2_object_key TEXT,ordinal INTEGER NOT NULL,received_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS agent_submission_diagnostics(
		submission_id TEXT PRIMARY KEY,ai_result_json TEXT,updated_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS agent_v2_webhook_receipts(
		webhook_event_id TEXT PRIMARY KEY,submission_id TEXT
	);
`;

interface AdminListBody {
	count: number;
	events: Array<{
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
	}>;
}

interface ReviewListBody {
	count: number;
	reviewItems: Array<{
		id: string; title: string | null; eventDate: string | null; venue: string | null;
		receivedAt: string; createdAt: string; reviewReason: string | null; source: string;
		thumbnailUrl: string | null;
	}>;
}

async function insertEvent(input: {
	id: string;
	eventDate: string | null;
	createdAt: string;
	status?: string;
}): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO events (
			id, title, slug, event_date, status, published_at, venue, price_thb, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		input.id,
		`Title ${input.id}`,
		`slug-${input.id}`,
		input.eventDate,
		input.status ?? 'published',
		input.status === 'draft' ? null : '2026-08-03T08:17:14Z',
		'Enoteca',
		2500,
		input.createdAt,
	).run();
}

async function authorizedList(): Promise<Response> {
	return SELF.fetch('https://example.com/admin/events', {
		headers: { authorization: `Bearer ${env.ADMIN_API_TOKEN}` },
	});
}

async function insertReviewItem(id: string, input: {
	status?: string; title?: string | null; reason?: string | null; eventDate?: string | null; venue?: string | null;
} = {}): Promise<void> {
	const createdAt = '2026-08-13T04:05:06.000Z';
	await env.DB.batch([
		env.DB.prepare(`INSERT INTO agent_submissions(
			id,source,conversation_key,status,first_received_at,last_received_at,result_event_id,result_action,error_message,created_at,updated_at
		) VALUES (?,'line_v2','user:test',?,'2026-08-13T04:00:00.000Z',?,NULL,NULL,?,?,?)`)
			.bind(id, input.status ?? 'needs_review', createdAt, input.reason ?? 'meaningful title is required', createdAt, createdAt),
		env.DB.prepare('INSERT INTO agent_submission_diagnostics(submission_id,ai_result_json,updated_at) VALUES(?,?,?)')
			.bind(id, JSON.stringify({ event: { title: input.title ?? null, date: input.eventDate ?? null, venueName: input.venue ?? null } }), createdAt),
	]);
}

async function login(token = env.ADMIN_API_TOKEN): Promise<string> {
	const response = await SELF.fetch('https://example.com/admin/login', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ token }),
		redirect: 'manual',
	});
	expect(response.status).toBe(303);
	return response.headers.get('set-cookie')!;
}

beforeAll(async () => {
	for (const statement of schema.split(';').map((part) => part.trim()).filter(Boolean)) {
		await env.DB.prepare(statement).run();
	}
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM agent_v2_webhook_receipts'),
		env.DB.prepare('DELETE FROM agent_submission_diagnostics'),
		env.DB.prepare('DELETE FROM agent_submission_items'),
		env.DB.prepare('DELETE FROM line_delivery_outbox'),
		env.DB.prepare('DELETE FROM line_webhook_delivery_receipts'),
		env.DB.prepare('DELETE FROM line_url_ingestion_deliveries'),
		env.DB.prepare('DELETE FROM line_message_batch_web_sources'),
		env.DB.prepare('DELETE FROM line_message_batch_texts'),
		env.DB.prepare('DELETE FROM line_image_batch_assets'),
		env.DB.prepare('DELETE FROM line_image_batches'),
		env.DB.prepare('DELETE FROM line_text_contexts'),
		env.DB.prepare('DELETE FROM event_assets'),
		env.DB.prepare('DELETE FROM event_enrichment_state'),
		env.DB.prepare('DELETE FROM agent_submissions'),
		env.DB.prepare('DELETE FROM events'),
	]);
});

describe('review item admin API', () => {
	it('returns only needs-review submissions with missing fields and the stored reason intact', async () => {
		await insertReviewItem('review-missing-title');
		await insertReviewItem('already-published', { status: 'published', title: 'Published submission' });

		const unauthorized = await SELF.fetch('https://example.com/admin/review-items');
		expect(unauthorized.status).toBe(401);
		const response = await SELF.fetch('https://example.com/admin/review-items', {
			headers: { authorization: `Bearer ${env.ADMIN_API_TOKEN}` },
		});
		const body = await response.json<ReviewListBody>();

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(body.count).toBe(1);
		expect(body.reviewItems[0]).toEqual({
			id: 'review-missing-title', title: null, eventDate: null, venue: null,
			receivedAt: '2026-08-13T04:00:00.000Z', createdAt: '2026-08-13T04:05:06.000Z',
			reviewReason: 'meaningful title is required', source: 'line_v2', thumbnailUrl: null,
		});
	});

	it('deletes the persisted review submission and owned files without affecting published events', async () => {
		await insertEvent({ id: 'published-event', eventDate: '2026-08-20', createdAt: '2026-08-13T00:00:00Z' });
		await insertReviewItem('delete-review', { title: 'Incomplete tasting' });
		await env.DB.batch([
			env.DB.prepare("INSERT INTO agent_submission_items(id,submission_id,source_message_id,item_type,asset_id,intake_id,r2_object_key,ordinal,received_at) VALUES('review-item','delete-review','line-message','image','review-asset','review-intake','intakes/review-intake/assets/review-asset/original',1,'2026-08-13')"),
			env.DB.prepare("INSERT INTO agent_v2_webhook_receipts(webhook_event_id,submission_id) VALUES('receipt','delete-review')"),
		]);
		await env.EVENT_INTAKES.put('intakes/review-intake/assets/review-asset/original', new Uint8Array([1]));
		await env.EVENT_INTAKES.put('intakes/review-intake/assets/review-asset/ocr.json', '{}');
		await env.EVENT_INTAKES.put('agent-submissions/delete-review/ai-result.json', '{}');

		const response = await SELF.fetch('https://example.com/admin/review-items/delete-review', {
			method: 'DELETE', headers: { authorization: `Bearer ${env.ADMIN_API_TOKEN}` },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ success: true, reviewItemFound: true, reviewItemId: 'delete-review' });
		expect(await env.DB.prepare("SELECT id FROM agent_submissions WHERE id='delete-review'").first()).toBeNull();
		expect(await env.DB.prepare("SELECT id FROM agent_submission_items WHERE submission_id='delete-review'").first()).toBeNull();
		expect(await env.DB.prepare("SELECT submission_id FROM agent_v2_webhook_receipts WHERE webhook_event_id='receipt'").first('submission_id')).toBeNull();
		expect(await env.EVENT_INTAKES.head('intakes/review-intake/assets/review-asset/original')).toBeNull();
		expect(await env.EVENT_INTAKES.head('agent-submissions/delete-review/ai-result.json')).toBeNull();
		expect(await env.DB.prepare("SELECT status FROM events WHERE id='published-event'").first('status')).toBe('published');
		expect((await (await authorizedList()).json<AdminListBody>()).events.map((event) => event.id)).toEqual(['published-event']);
	});

	it('refuses to delete a non-review submission even when its id resembles an event id', async () => {
		await insertEvent({ id: 'protected', eventDate: '2026-08-20', createdAt: '2026-08-13T00:00:00Z' });
		await insertReviewItem('protected', { status: 'published', title: 'Protected' });
		const response = await SELF.fetch('https://example.com/admin/review-items/protected', {
			method: 'DELETE', headers: { authorization: `Bearer ${env.ADMIN_API_TOKEN}` },
		});
		expect(response.status).toBe(409);
		expect(await env.DB.prepare("SELECT status FROM events WHERE id='protected'").first('status')).toBe('published');
		expect(await env.DB.prepare("SELECT status FROM agent_submissions WHERE id='protected'").first('status')).toBe('published');
	});
});

describe('GET /admin/events', () => {
	it('rejects an unauthorized request', async () => {
		const response = await SELF.fetch('https://example.com/admin/events');
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: { code: 'UNAUTHORIZED', message: 'Valid administrator credentials are required.' },
		});
	});

	it('returns an empty authorized result', async () => {
		const response = await authorizedList();
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({ events: [], count: 0 });
	});

	it('returns all fields and correct aggregate asset counts', async () => {
		await insertEvent({ id: 'event-1', eventDate: '2026-08-06', createdAt: '2026-08-03T08:14:31Z' });
		await env.DB.batch([
			env.DB.prepare("INSERT INTO event_assets(event_id,intake_id,asset_id,linked_at,source_type) VALUES ('event-1','intake-1','flyer','2026-08-03','line_image')"),
			env.DB.prepare("INSERT INTO event_assets(event_id,intake_id,asset_id,linked_at,source_type) VALUES ('event-1','intake-1','menu','2026-08-03','line_image')"),
		]);

		const response = await authorizedList();
		const body = await response.json<AdminListBody>();

		expect(response.status).toBe(200);
		expect(body.count).toBe(1);
		expect(body.events[0]).toEqual({
			id: 'event-1',
			title: 'Title event-1',
			slug: 'slug-event-1',
			eventDate: '2026-08-06',
			status: 'published',
			publishedAt: '2026-08-03T08:17:14Z',
			venue: 'Enoteca',
			priceTHB: 2500,
			assetCount: 2,
			createdAt: '2026-08-03T08:14:31Z',
			thumbnailUrl: null,
			thumbnailAssetType: null,
		});
	});

	it('orders multiple events by newest event date, then newest creation time', async () => {
		await insertEvent({ id: 'older-date', eventDate: '2026-08-05', createdAt: '2026-08-03T10:00:00Z' });
		await insertEvent({ id: 'same-date-older', eventDate: '2026-08-06', createdAt: '2026-08-03T08:00:00Z' });
		await insertEvent({ id: 'same-date-newer', eventDate: '2026-08-06', createdAt: '2026-08-03T09:00:00Z', status: 'draft' });
		await insertEvent({ id: 'undated', eventDate: null, createdAt: '2026-08-03T11:00:00Z' });

		const body = await (await authorizedList()).json<AdminListBody>();

		expect(body.count).toBe(4);
		expect(body.events.map((event) => event.id)).toEqual([
			'same-date-newer', 'same-date-older', 'older-date', 'undated',
		]);
		expect(body.events[0].status).toBe('draft');
		expect(body.events[0].publishedAt).toBeNull();
		expect(body.events[3].assetCount).toBe(0);
	});

	it('selects the highest-priority usable image and serves it only to administrators', async () => {
		await insertEvent({ id: 'event-image', eventDate: '2026-08-06', createdAt: '2026-08-03T09:00:00Z' });
		await env.DB.batch([
			env.DB.prepare("INSERT INTO event_assets(event_id,intake_id,asset_id,asset_role,linked_at,source_type,r2_object_key,content_type) VALUES ('event-image','intake','menu','menu','2026-08-03','line_image','images/menu','image/jpeg')"),
			env.DB.prepare("INSERT INTO event_assets(event_id,intake_id,asset_id,asset_role,linked_at,source_type,r2_object_key,content_type) VALUES ('event-image','intake','social','social','2026-08-03','line_image','images/social','image/jpeg')"),
			env.DB.prepare("INSERT INTO event_assets(event_id,intake_id,asset_id,asset_role,linked_at,source_type,r2_object_key,content_type) VALUES ('event-image','intake','flyer','flyer','2026-08-03','line_image','images/flyer','image/jpeg')"),
		]);
		await env.EVENT_INTAKES.put('images/flyer', new TextEncoder().encode('flyer-image'), {
			httpMetadata: { contentType: 'image/jpeg' },
		});

		const body = await (await authorizedList()).json<AdminListBody>();
		expect(body.events[0].thumbnailUrl).toBe('/admin/assets/flyer');
		expect(body.events[0].thumbnailAssetType).toBe('flyer');
		expect((await SELF.fetch('https://example.com/admin/assets/flyer')).status).toBe(401);

		const cookie = await login();
		const image = await SELF.fetch('https://example.com/admin/assets/flyer', { headers: { cookie } });
		expect(image.status).toBe(200);
		expect(image.headers.get('content-type')).toBe('image/jpeg');
		expect(new TextDecoder().decode(await image.arrayBuffer())).toBe('flyer-image');
	});
});

describe('admin browser session', () => {
	it('renders a login page without exposing the configured token', async () => {
		const response = await SELF.fetch('https://example.com/admin/events-ui');
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(html).toContain('Bangkok Wine Scout Admin');
		expect(html).toContain('action="/admin/login"');
		expect(html).not.toContain(env.ADMIN_API_TOKEN);
	});

	it('rejects an invalid token without echoing it', async () => {
		const response = await SELF.fetch('https://example.com/admin/login', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token: 'wrong-secret-value' }),
		});
		const html = await response.text();
		expect(response.status).toBe(401);
		expect(html).toContain('Invalid admin token');
		expect(html).not.toContain('wrong-secret-value');
		expect(response.headers.get('set-cookie')).toBeNull();
	});

	it('creates a secure signed session cookie for a valid token', async () => {
		const cookie = await login();
		expect(cookie).toContain('__Host-bws_admin_session=');
		expect(cookie).toContain('Max-Age=28800');
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('Secure');
		expect(cookie).toContain('SameSite=Strict');
		expect(cookie).not.toContain(env.ADMIN_API_TOKEN);
	});

	it('renders the management page for a valid session without embedding the token', async () => {
		const cookie = await login();
		const response = await SELF.fetch('https://example.com/admin/events-ui', { headers: { cookie } });
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(html).toContain('Operations');
		expect(html).toContain('Bangkok Wine Scout Admin');
		expect(html).toContain('events in the catalogue');
		expect(html).toContain('aria-current="page">Events</a>');
		expect(html).toContain('Delete permanently');
		expect(html).toContain('Search title or venue');
		expect(html).toContain('Unpublished / Needs review');
		expect(html).toContain('(missing title)');
		expect(html).toContain('item.reviewReason');
		expect(html).toContain("fetch('/admin/review-items/'");
		expect(html).toContain("state.events=state.events.filter");
		expect(html).not.toContain('V2 Submissions');
		expect(html).not.toContain('agent-submissions');
		expect(html).not.toContain(env.ADMIN_API_TOKEN);
	});

	it('does not expose the obsolete V2 submissions UI or API routes', async () => {
		const cookie = await login();
		for (const path of [
			'/admin/agent-submissions',
			'/admin/agent-submissions/submission-1',
			'/admin/api/agent-submissions',
			'/admin/api/agent-submissions/submission-1',
		]) {
			expect((await SELF.fetch(`https://example.com${path}`, { headers: { cookie } })).status).toBe(404);
		}
	});

	it('uses the session cookie for listing and permanent deletion while Bearer auth still works', async () => {
		await insertEvent({ id: 'delete-me', eventDate: '2026-08-06', createdAt: '2026-08-03T09:00:00Z' });
		const cookie = await login();
		const sessionList = await SELF.fetch('https://example.com/admin/events', { headers: { cookie } });
		expect(sessionList.status).toBe(200);
		expect((await sessionList.json<AdminListBody>()).events.map((event) => event.id)).toContain('delete-me');

		const deletion = await SELF.fetch('https://example.com/admin/events/delete-me', {
			method: 'DELETE', headers: { cookie },
		});
		expect(deletion.status).toBe(200);
		expect(await deletion.json()).toMatchObject({ success: true, eventFound: true });

		const after = await SELF.fetch('https://example.com/admin/events', { headers: { cookie } });
		expect((await after.json<AdminListBody>()).events).toHaveLength(0);
		expect((await authorizedList()).status).toBe(200);
	});

	it('clears the session cookie on logout', async () => {
		const response = await SELF.fetch('https://example.com/admin/logout', {
			method: 'POST', redirect: 'manual',
		});
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/admin/events-ui');
		expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
	});

	it('bulk deletes unique selected events through the centralized deletion workflow', async () => {
		await insertEvent({ id: 'bulk-1', eventDate: '2026-08-06', createdAt: '2026-08-03T09:00:00Z' });
		await insertEvent({ id: 'bulk-2', eventDate: '2026-08-07', createdAt: '2026-08-03T10:00:00Z' });
		const cookie = await login();
		const response = await SELF.fetch('https://example.com/admin/events/bulk-delete', {
			method: 'POST', headers: { cookie, 'content-type': 'application/json' },
			body: JSON.stringify({ eventIds: ['bulk-1', 'bulk-2', 'bulk-1', 'already-missing'] }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true, requested: 3, deleted: 2, alreadyMissing: 1, failed: 0,
		});
		expect((await SELF.fetch('https://example.com/admin/events/bulk-delete', {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ eventIds: ['x'] }),
		})).status).toBe(401);
		expect((await SELF.fetch('https://example.com/admin/events', { headers: { cookie } }).then((result) => result.json<AdminListBody>()))).toMatchObject({ count: 0 });
	});
});
