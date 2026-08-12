import { env } from 'cloudflare:test';
import { beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { queueEventReprocess } from './event-reprocess-service';

declare module 'cloudflare:test' { interface ProvidedEnv { DB:D1Database } }

beforeAll(async()=>{for(const sql of `
CREATE TABLE IF NOT EXISTS reprocess_events(id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS reprocess_event_assets(event_id TEXT,asset_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS reprocess_batches(id TEXT PRIMARY KEY,last_received_at TEXT,created_at TEXT,first_received_at TEXT,status TEXT,processing_at TEXT,completed_at TEXT,error TEXT,attempt_count INTEGER,notification_sent_at TEXT,resulting_event_ids_json TEXT,updated_at TEXT,pending_asset_wait_count INTEGER NOT NULL DEFAULT 0,first_pending_asset_wait_at TEXT,last_pending_asset_wait_at TEXT,pending_asset_wait_deadline_at TEXT,continuation_state TEXT NOT NULL DEFAULT 'idle',continuation_claim_token TEXT,continuation_enqueue_error TEXT,reconciliation_required_at TEXT);
CREATE TABLE IF NOT EXISTS reprocess_batch_assets(batch_id TEXT,asset_id TEXT);
CREATE TABLE IF NOT EXISTS reprocess_enrichment(asset_id TEXT PRIMARY KEY,event_id TEXT,status TEXT,extraction_status TEXT,attempt_count INTEGER,next_retry_at TEXT,last_error_code TEXT,updated_at TEXT);
`.split(';').map((value)=>value.trim()).filter(Boolean))await env.DB.prepare(sql).run();});

beforeEach(async()=>{await env.DB.batch(['reprocess_enrichment','reprocess_batch_assets','reprocess_batches','reprocess_event_assets','reprocess_events'].map((table)=>env.DB.prepare(`DELETE FROM ${table}`)));});

describe('manual event reprocessing',()=>{
	it('returns null when the event has no replayable LINE batch',async()=>{const queue={send:vi.fn()};const db={prepare:(sql:string)=>env.DB.prepare(sql.replaceAll('events','reprocess_events').replaceAll('event_assets','reprocess_event_assets').replaceAll('line_image_batches','reprocess_batches').replaceAll('line_image_batch_assets','reprocess_batch_assets').replaceAll('event_enrichment_state','reprocess_enrichment')),batch:env.DB.batch.bind(env.DB)} as unknown as D1Database;expect(await queueEventReprocess('missing',{DB:db,IMAGE_PROCESSING_QUEUE:queue as never})).toBeNull();});
	it('resets state and queues the original batch without deleting the published event',async()=>{await env.DB.batch([
		env.DB.prepare("INSERT INTO reprocess_events VALUES ('event-1')"),env.DB.prepare("INSERT INTO reprocess_event_assets VALUES ('event-1','flyer')"),
		env.DB.prepare("INSERT INTO reprocess_batches(id,last_received_at,created_at,first_received_at,status,processing_at,completed_at,error,attempt_count,notification_sent_at,resulting_event_ids_json,updated_at) VALUES ('batch-1','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z','completed','lease','done','old',3,'sent','[\"event-1\"]','old')"),
		env.DB.prepare("INSERT INTO reprocess_batch_assets VALUES ('batch-1','flyer')"),env.DB.prepare("INSERT INTO reprocess_enrichment VALUES ('flyer','event-1','permanently_failed','failed',4,NULL,'AI','old')"),
	]);const queue={send:vi.fn().mockResolvedValue(undefined)};const db={prepare:(sql:string)=>env.DB.prepare(sql.replaceAll('events','reprocess_events').replaceAll('event_assets','reprocess_event_assets').replaceAll('line_image_batches','reprocess_batches').replaceAll('line_image_batch_assets','reprocess_batch_assets').replaceAll('event_enrichment_state','reprocess_enrichment')),batch:env.DB.batch.bind(env.DB)} as unknown as D1Database;
		expect(await queueEventReprocess('event-1',{DB:db,IMAGE_PROCESSING_QUEUE:queue as never})).toEqual({batchId:'batch-1'});expect(queue.send).toHaveBeenCalledWith({type:'process_batch',batchId:'batch-1',expectedLastReceivedAt:'2026-08-01T00:00:00Z'});
		expect(await env.DB.prepare("SELECT status FROM reprocess_batches WHERE id='batch-1'").first('status')).toBe('failed');expect(await env.DB.prepare("SELECT status FROM reprocess_enrichment WHERE asset_id='flyer'").first('status')).toBe('retryable');expect(await env.DB.prepare("SELECT COUNT(*) FROM reprocess_events").first('COUNT(*)')).toBe(1);
	});
});
