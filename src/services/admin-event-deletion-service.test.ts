import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteEventCompletely } from './admin-event-deletion-service';
import type { WorkerEnv } from '../types/env';

declare module 'cloudflare:test' {
	interface ProvidedEnv { DB: D1Database; EVENT_INTAKES: R2Bucket; ADMIN_API_TOKEN: string }
}

const schema = `
	CREATE TABLE IF NOT EXISTS events (
		id TEXT PRIMARY KEY, status TEXT NOT NULL, published_at TEXT, slug TEXT
	);
	CREATE TABLE IF NOT EXISTS event_assets (
		event_id TEXT NOT NULL, intake_id TEXT NOT NULL, asset_id TEXT NOT NULL,
		asset_role TEXT NOT NULL, linked_at TEXT NOT NULL, source_type TEXT NOT NULL,
		source_message_id TEXT, text_content TEXT, is_public INTEGER NOT NULL DEFAULT 0,
		r2_object_key TEXT, content_type TEXT, PRIMARY KEY(event_id, asset_id),
		FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
	);
	CREATE TABLE IF NOT EXISTS line_text_contexts (
		message_id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, text_content TEXT NOT NULL,
		received_at TEXT NOT NULL, consumed_at TEXT, linked_image_asset_id TEXT, linked_event_id TEXT
	);
	CREATE TABLE IF NOT EXISTS line_image_batches (
		id TEXT PRIMARY KEY, resulting_event_ids_json TEXT NOT NULL DEFAULT '[]', minimal_event_id TEXT
	);
	CREATE TABLE IF NOT EXISTS line_image_batch_assets (
		batch_id TEXT NOT NULL, asset_id TEXT NOT NULL, intake_id TEXT NOT NULL,
		line_message_id TEXT NOT NULL, r2_object_key TEXT NOT NULL
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
	CREATE TABLE IF NOT EXISTS line_webhook_delivery_receipts (
		webhook_event_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, batch_id TEXT
	);
	CREATE TABLE IF NOT EXISTS line_delivery_outbox (
		id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, batch_id TEXT, asset_id TEXT,
		FOREIGN KEY(receipt_id) REFERENCES line_webhook_delivery_receipts(webhook_event_id),
		FOREIGN KEY(batch_id) REFERENCES line_image_batches(id)
	);
	CREATE TABLE IF NOT EXISTS event_enrichment_state (
		asset_id TEXT PRIMARY KEY,event_id TEXT,intake_id TEXT NOT NULL,status TEXT,last_error_code TEXT,
		FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE SET NULL
	);
	CREATE TABLE IF NOT EXISTS agent_submissions (
		id TEXT PRIMARY KEY,result_event_id TEXT,result_action TEXT,updated_at TEXT NOT NULL
	);
`;
const workerEnv = env as unknown as WorkerEnv;

async function insertEvent(id: string, published = true): Promise<void> {
	await env.DB.prepare('INSERT INTO events(id,status,published_at,slug) VALUES (?,?,?,?)')
		.bind(id, published ? 'published' : 'draft', published ? '2026-08-03T00:00:00Z' : null, `slug-${id}`).run();
}

async function insertAsset(eventId: string, assetId: string, messageId = `message-${assetId}`): Promise<string> {
	const intakeId = `intake-${assetId}`;
	const key = `intakes/${intakeId}/assets/${assetId}/original`;
	await env.DB.prepare(`INSERT INTO event_assets(
		event_id,intake_id,asset_id,asset_role,linked_at,source_type,source_message_id,r2_object_key,content_type
	) VALUES (?, ?, ?, 'flyer', '2026-08-03T00:00:00Z', 'line_image', ?, ?, 'image/jpeg')`)
		.bind(eventId, intakeId, assetId, messageId, key).run();
	await env.EVENT_INTAKES.put(key, new Uint8Array([1, 2, 3]));
	await env.EVENT_INTAKES.put(`intakes/${intakeId}/assets/${assetId}/ocr.json`, '{}');
	return key;
}

beforeAll(async () => {
	for (const statement of schema.split(';').map((part) => part.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
});

beforeEach(async () => {
	await env.DB.batch([
		'line_delivery_outbox','line_webhook_delivery_receipts','line_url_ingestion_deliveries', 'line_message_batch_web_sources', 'line_message_batch_texts',
		'line_image_batch_assets', 'line_image_batches', 'line_text_contexts', 'event_assets', 'events',
		'event_enrichment_state','agent_submissions',
	].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
});

describe('complete event deletion', () => {
	it('deletes a published event, multiple assets, derived R2 files, and is idempotent', async () => {
		await insertEvent('event-1');
		const firstKey = await insertAsset('event-1', 'flyer');
		const secondKey = await insertAsset('event-1', 'menu');

		const result = await deleteEventCompletely('event-1', workerEnv);

		expect(result.success).toBe(true);
		expect(result.unpublished).toBe(true);
		expect(result.database.eventDeleted).toBe(true);
		expect(result.database.rowsDeleted.eventAssets).toBe(2);
		expect(result.r2.objectsDeleted).toBe(4);
		expect(await env.EVENT_INTAKES.head(firstKey)).toBeNull();
		expect(await env.EVENT_INTAKES.head(secondKey)).toBeNull();
		expect(await env.DB.prepare('SELECT id FROM events WHERE id=?').bind('event-1').first()).toBeNull();

		const repeated = await deleteEventCompletely('event-1', workerEnv);
		expect(repeated).toMatchObject({ success: true, eventFound: false, unpublished: false });
	});

	it('deletes LINE references and an exclusively owned batch', async () => {
		await insertEvent('event-1');
		await insertAsset('event-1', 'flyer', 'message-1');
		await env.DB.batch([
			env.DB.prepare("INSERT INTO line_text_contexts VALUES ('context','user:1','text','2026-08-03',NULL,'flyer','event-1')"),
			env.DB.prepare("INSERT INTO line_image_batches(id,resulting_event_ids_json) VALUES ('batch-1','[\"event-1\"]')"),
			env.DB.prepare("INSERT INTO line_image_batch_assets VALUES ('batch-1','flyer','intake-flyer','message-1','intakes/intake-flyer/assets/flyer/original')"),
		]);
		await env.EVENT_INTAKES.put('line-batches/batch-1/analysis.json', '{}');

		const result = await deleteEventCompletely('event-1', workerEnv);

		expect(result.line.referencesDeleted).toBe(2);
		expect(result.line.originalLineMessageDeleted).toBe(false);
		expect(result.database.rowsDeleted.lineBatches).toBe(1);
		expect(await env.EVENT_INTAKES.head('line-batches/batch-1/analysis.json')).toBeNull();
	});

	it('permanently deletes the production-shaped colon event despite historical outbox failures and supports retry',async()=>{
		const eventId='line-batch:063b3c07-162b-4dbb-9743-742986eb99a7',batchId='063b3c07-162b-4dbb-9743-742986eb99a7',assetId='line-message-625717238523756630',messageId='625717238523756630',receiptId='01KZ4M00MGK35GHTK89KXCSR1W';
		await insertEvent(eventId,false);await insertAsset(eventId,assetId,messageId);
		await env.DB.batch([
			env.DB.prepare('INSERT INTO line_image_batches(id,resulting_event_ids_json,minimal_event_id) VALUES(?,?,?)').bind(batchId,JSON.stringify([eventId]),eventId),
			env.DB.prepare('INSERT INTO line_image_batch_assets(batch_id,asset_id,intake_id,line_message_id,r2_object_key) VALUES(?,?,?,?,?)').bind(batchId,assetId,`intake-${assetId}`,messageId,`intakes/intake-${assetId}/assets/${assetId}/original`),
			env.DB.prepare('INSERT INTO line_webhook_delivery_receipts(webhook_event_id,message_id,batch_id) VALUES(?,?,?)').bind(receiptId,messageId,batchId),
			env.DB.prepare('INSERT INTO line_delivery_outbox(id,receipt_id,batch_id,asset_id) VALUES(?,?,?,?)').bind('failed-ack',receiptId,batchId,assetId),
			env.DB.prepare('INSERT INTO event_enrichment_state(asset_id,event_id,intake_id,status,last_error_code) VALUES(?,?,?,?,?)').bind(assetId,eventId,`intake-${assetId}`,'partial','unrelated_historical_failure'),
			env.DB.prepare('INSERT INTO agent_submissions(id,result_event_id,result_action,updated_at) VALUES(?,?,?,?)').bind('submission-1',eventId,'published','2026-08-03'),
		]);
		const result=await deleteEventCompletely(eventId,workerEnv);expect(result.success).toBe(true);expect(result.database.rowsDeleted).toMatchObject({lineDeliveryOutbox:1,lineWebhookDeliveryReceipts:1,eventEnrichmentState:1,agentSubmissionEventReferences:1,lineBatches:1,events:1});
		expect(await env.DB.prepare('SELECT result_event_id,result_action FROM agent_submissions WHERE id=?').bind('submission-1').first()).toMatchObject({result_event_id:null,result_action:'event_deleted'});
		expect(await deleteEventCompletely(eventId,workerEnv)).toMatchObject({success:true,eventFound:false});
		const endpoint=await SELF.fetch(`https://example.com/admin/events/${encodeURIComponent(eventId)}`,{method:'DELETE',headers:{authorization:`Bearer ${env.ADMIN_API_TOKEN}`}});expect(endpoint.status).toBe(200);expect(await endpoint.json()).toMatchObject({success:true,eventFound:false,eventId});
	});

	it('preserves a shared batch while removing only the target event relation', async () => {
		await insertEvent('event-1');
		await insertEvent('event-2');
		await insertAsset('event-1', 'flyer-1');
		await insertAsset('event-2', 'flyer-2');
		await env.DB.batch([
			env.DB.prepare("INSERT INTO line_image_batches(id,resulting_event_ids_json) VALUES ('batch-shared','[\"event-1\",\"event-2\"]')"),
			env.DB.prepare("INSERT INTO line_image_batch_assets VALUES ('batch-shared','flyer-1','intake-flyer-1','message-flyer-1','key-1')"),
			env.DB.prepare("INSERT INTO line_image_batch_assets VALUES ('batch-shared','flyer-2','intake-flyer-2','message-flyer-2','key-2')"),
		]);
		await env.EVENT_INTAKES.put('line-batches/batch-shared/analysis.json', '{}');

		await deleteEventCompletely('event-1', workerEnv);

		expect(await env.DB.prepare('SELECT id FROM events WHERE id=?').bind('event-2').first()).not.toBeNull();
		expect(await env.DB.prepare("SELECT resulting_event_ids_json FROM line_image_batches WHERE id='batch-shared'").first('resulting_event_ids_json')).toBe('["event-2"]');
		expect(await env.DB.prepare("SELECT asset_id FROM line_image_batch_assets WHERE batch_id='batch-shared'").first('asset_id')).toBe('flyer-2');
		expect(await env.EVENT_INTAKES.head('line-batches/batch-shared/analysis.json')).not.toBeNull();
	});

	it('handles already-unpublished events and already-missing R2 objects', async () => {
		await insertEvent('event-1', false);
		const key = await insertAsset('event-1', 'flyer');
		await env.EVENT_INTAKES.delete(key);

		const result = await deleteEventCompletely('event-1', workerEnv);

		expect(result.success).toBe(true);
		expect(result.r2.objectsMissing).toBe(1);
		expect(result.database.eventDeleted).toBe(true);
	});

	it('keeps an event unpublished and retryable after a partial R2 failure', async () => {
		await insertEvent('event-1');
		const failedKey = await insertAsset('event-1', 'flyer');
		await insertAsset('event-1', 'menu');
		const failingBucket = {
			head: env.EVENT_INTAKES.head.bind(env.EVENT_INTAKES),
			get: env.EVENT_INTAKES.get.bind(env.EVENT_INTAKES),
			list: env.EVENT_INTAKES.list.bind(env.EVENT_INTAKES),
			delete: async (key: string | string[]) => {
				if (Array.isArray(key) || key === failedKey) throw new Error('simulated R2 failure');
				return env.EVENT_INTAKES.delete(key);
			},
		} as unknown as R2Bucket;
		const result = await deleteEventCompletely('event-1', {
			...workerEnv, EVENT_INTAKES: failingBucket,
		});

		expect(result).toMatchObject({ success: false, unpublished: true, database: { eventDeleted: false } });
		expect(result.r2.objectsFailed).toBe(1);
		expect(result.r2.failedKeys).toEqual([failedKey]);
		expect(await env.DB.prepare('SELECT status FROM events WHERE id=?').bind('event-1').first('status')).toBe('draft');
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM event_assets WHERE event_id=?').bind('event-1').first('count')).toBe(2);
	});

	it('rejects an unauthenticated endpoint request and accepts a valid Bearer token', async () => {
		const unauthorized = await SELF.fetch('https://example.com/admin/events/missing', { method: 'DELETE' });
		expect(unauthorized.status).toBe(401);
		const authorized = await SELF.fetch('https://example.com/admin/events/missing', {
			method: 'DELETE', headers: { authorization: `Bearer ${env.ADMIN_API_TOKEN}` },
		});
		expect(authorized.status).toBe(200);
		expect(await authorized.json()).toMatchObject({ success: true, eventFound: false });
	});
});
