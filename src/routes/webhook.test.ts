import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEnv } from '../types/env';
import type { LineWebhookPayload } from '../types/line';
import { processWebhookEvents } from './webhook';

const { replyToLine, fetchPage } = vi.hoisted(() => ({
	replyToLine: vi.fn().mockResolvedValue(undefined),
	fetchPage: vi.fn().mockImplementation(async(url:string)=>({requestedUrl:url,normalizedUrl:url,finalUrl:url,status:'completed',httpStatus:200,contentType:'text/html',responseBytes:100,redirectCount:0,title:'Event',description:null,canonicalUrl:null,mainImageUrl:null,openGraph:{},jsonLd:[],extractedText:'Wine dinner 5 August 2026 at 19:00',originalReadableTextChars:35,extractedTextLength:35,textReduced:false,errorCode:null,errorMessage:null,fetchedAt:'2026-08-15T10:00:00.000Z'})),
}));
const queueSend=vi.fn().mockResolvedValue(undefined);
const queueSendBatch=vi.fn().mockResolvedValue(undefined);

vi.mock('../services/line', () => ({
	downloadLineMessageContent: vi.fn(),
	pushToLine: vi.fn(),
	replyToLine,
}));
vi.mock('../services/web-page-ingestion-service',async(importOriginal)=>({...await importOriginal<typeof import('../services/web-page-ingestion-service')>(),fetchAndExtractWebPage:fetchPage}));

declare module 'cloudflare:test' {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

beforeAll(async () => {
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS line_text_contexts (
			message_id TEXT PRIMARY KEY,
			conversation_key TEXT NOT NULL,
			text_content TEXT NOT NULL,
			received_at TEXT NOT NULL,
			consumed_at TEXT,
			linked_image_asset_id TEXT UNIQUE,
			linked_event_id TEXT
		)`,
	).run();
	await env.DB.exec(`CREATE TABLE IF NOT EXISTS line_image_batches (id TEXT PRIMARY KEY,conversation_key TEXT NOT NULL,status TEXT NOT NULL,first_received_at TEXT NOT NULL,last_received_at TEXT NOT NULL,created_at TEXT NOT NULL,last_activity_at TEXT NOT NULL,expires_at TEXT NOT NULL,closed_at TEXT,updated_at TEXT NOT NULL,processing_at TEXT,completed_at TEXT,push_target TEXT,resulting_event_ids_json TEXT NOT NULL DEFAULT '[]',error TEXT,attempt_count INTEGER NOT NULL DEFAULT 0,notification_sent_at TEXT);CREATE UNIQUE INDEX IF NOT EXISTS webhook_collecting_conversation ON line_image_batches(conversation_key) WHERE status='collecting';CREATE TABLE IF NOT EXISTS line_message_batch_texts(batch_id TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,webhook_event_id TEXT UNIQUE,asset_id TEXT NOT NULL UNIQUE,text_content TEXT NOT NULL,received_at TEXT NOT NULL,conversation_key TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(batch_id,message_id));CREATE TABLE IF NOT EXISTS line_image_batch_assets(batch_id TEXT NOT NULL,asset_id TEXT NOT NULL UNIQUE,intake_id TEXT NOT NULL,line_message_id TEXT NOT NULL UNIQUE,webhook_event_id TEXT UNIQUE,source_type TEXT NOT NULL DEFAULT 'line_image',source_reference TEXT NOT NULL,content_type TEXT NOT NULL,r2_object_key TEXT NOT NULL,received_at TEXT NOT NULL,conversation_key TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(batch_id,asset_id));CREATE TABLE IF NOT EXISTS line_message_batch_web_sources(batch_id TEXT NOT NULL,message_id TEXT NOT NULL,webhook_event_id TEXT NOT NULL UNIQUE,asset_id TEXT NOT NULL UNIQUE,requested_url TEXT NOT NULL,normalized_url TEXT NOT NULL,final_url TEXT,status TEXT NOT NULL,http_status INTEGER,content_type TEXT,response_bytes INTEGER,redirect_count INTEGER NOT NULL,title TEXT,description TEXT,canonical_url TEXT,main_image_url TEXT,open_graph_json TEXT NOT NULL DEFAULT '{}',json_ld_json TEXT NOT NULL,extracted_text TEXT,original_readable_text_chars INTEGER NOT NULL DEFAULT 0,extracted_text_length INTEGER NOT NULL DEFAULT 0,text_reduced INTEGER NOT NULL DEFAULT 0,error_code TEXT,error_message TEXT,fetched_at TEXT NOT NULL,received_at TEXT NOT NULL,conversation_key TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(batch_id,message_id),UNIQUE(batch_id,normalized_url));`);
	await env.DB.exec(`CREATE TABLE IF NOT EXISTS line_url_ingestion_deliveries(webhook_event_id TEXT PRIMARY KEY,message_id TEXT NOT NULL,normalized_url TEXT NOT NULL,batch_id TEXT,status TEXT NOT NULL,error_code TEXT,received_at TEXT NOT NULL,created_at TEXT NOT NULL);`);
	await env.DB.exec(`CREATE TABLE IF NOT EXISTS line_webhook_delivery_receipts(webhook_event_id TEXT PRIMARY KEY,message_id TEXT NOT NULL,message_type TEXT NOT NULL,conversation_id TEXT,batch_id TEXT,processing_outcome TEXT NOT NULL,processing_claimed_at TEXT NOT NULL,acknowledgement_claimed_at TEXT,delivery_stage TEXT NOT NULL DEFAULT 'registered',registration_completed_at TEXT,dispatch_pending_at TEXT,dispatched_at TEXT,handoff_completed_at TEXT,acknowledgement_outcome TEXT,acknowledgement_updated_at TEXT,last_progress_at TEXT,reconciliation_reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE UNIQUE INDEX IF NOT EXISTS webhook_delivery_message ON line_webhook_delivery_receipts(message_type,message_id);CREATE TABLE IF NOT EXISTS line_delivery_outbox(id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL,batch_id TEXT,asset_id TEXT,operation_type TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,payload_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,available_at TEXT NOT NULL,lease_token TEXT,lease_expires_at TEXT,enqueued_at TEXT,completed_at TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
});

beforeEach(async () => {
	await env.DB.prepare('DELETE FROM line_text_contexts').run();
	await env.DB.prepare('DELETE FROM line_message_batch_texts').run();
	await env.DB.prepare('DELETE FROM line_message_batch_web_sources').run();
	await env.DB.prepare('DELETE FROM line_url_ingestion_deliveries').run();
	await env.DB.prepare('DELETE FROM line_delivery_outbox').run();
	await env.DB.prepare('DELETE FROM line_webhook_delivery_receipts').run();
	await env.DB.prepare('DELETE FROM line_image_batch_assets').run();
	await env.DB.prepare('DELETE FROM line_image_batches').run();
	replyToLine.mockClear();
	queueSend.mockClear();
	queueSendBatch.mockClear();
	fetchPage.mockClear();
});

const testEnv=(windowSeconds='60')=>({...env,IMAGE_PROCESSING_QUEUE:{send:queueSend,sendBatch:queueSendBatch},LINE_MESSAGE_BATCH_WINDOW_SECONDS:windowSeconds}) as unknown as WorkerEnv;

function textWebhook(messageId: string, text: string, timestamp='2026-08-15T10:00:00.000Z'): LineWebhookPayload {
	return {
		events: [{
			type: 'message',
			replyToken: `reply-${messageId}`,
			timestamp: Date.parse(timestamp),
			source: { userId: 'user-1' },
			message: { id: messageId, type: 'text', text },
		}],
	};
}

beforeAll(async()=>{const assetColumns=await env.DB.prepare(`PRAGMA table_info(line_image_batch_assets)`).all<{name:string}>();const assetNames=new Set(assetColumns.results.map((column)=>column.name));for(const [name,definition] of [['status',`TEXT NOT NULL DEFAULT 'pending'`],['error','TEXT'],['processing_started_at','TEXT'],['processed_at','TEXT'],['processing_attempt_count','INTEGER NOT NULL DEFAULT 0']] as const)if(!assetNames.has(name))await env.DB.prepare(`ALTER TABLE line_image_batch_assets ADD COLUMN ${name} ${definition}`).run();const batchColumns=await env.DB.prepare(`PRAGMA table_info(line_image_batches)`).all<{name:string}>();const batchNames=new Set(batchColumns.results.map((column)=>column.name));for(const [name,definition] of [['minimal_event_id','TEXT'],['shell_anchor_asset_id','TEXT'],['shell_created_at','TEXT'],['pending_asset_wait_count','INTEGER NOT NULL DEFAULT 0'],['first_pending_asset_wait_at','TEXT'],['last_pending_asset_wait_at','TEXT'],['pending_asset_wait_deadline_at','TEXT'],['continuation_state',`TEXT NOT NULL DEFAULT 'idle'`],['continuation_claim_token','TEXT'],['continuation_enqueue_error','TEXT'],['reconciliation_required_at','TEXT']] as const)if(!batchNames.has(name))await env.DB.prepare(`ALTER TABLE line_image_batches ADD COLUMN ${name} ${definition}`).run();});

function imageWebhook(ids:string[],timestamp='2026-08-15T10:00:00.000Z'):LineWebhookPayload{return{events:ids.map((id,index)=>({type:'message' as const,replyToken:`reply-${id}`,timestamp:Date.parse(timestamp)+index*145,webhookEventId:`webhook-${id}`,source:{userId:'user-1'},message:{id,type:'image' as const}}))};}

describe('LINE image placeholder registration',()=>{
	it('registers one image without done and schedules its automatic 15-second close',async()=>{await processWebhookEvents(imageWebhook(['flyer']),testEnv('60'));const row=await env.DB.prepare(`SELECT id,status,last_received_at,expires_at FROM line_image_batches`).first<{id:string;status:string;last_received_at:string;expires_at:string}>();expect(row).toMatchObject({status:'collecting',last_received_at:'2026-08-15T10:00:00.000Z',expires_at:'2026-08-15T10:00:15.000Z'});expect(queueSend).toHaveBeenCalledWith(expect.objectContaining({type:'process_image',batchId:row?.id,assetId:'line-message-flyer',idempotencyKey:'webhook-flyer:process-image'}));expect(queueSend).toHaveBeenCalledWith(expect.objectContaining({type:'process_batch',batchId:row?.id,expectedLastReceivedAt:'2026-08-15T10:00:00.000Z'}),{delaySeconds:15})});
	it('registers two images in one collecting batch before either queue job runs',async()=>{await processWebhookEvents(imageWebhook(['flyer','menu']),testEnv());const batches=await env.DB.prepare(`SELECT id,status FROM line_image_batches`).all<{id:string;status:string}>();const assets=await env.DB.prepare(`SELECT batch_id,asset_id,line_message_id,status,ordinal FROM line_image_batch_assets ORDER BY ordinal`).all<{batch_id:string;asset_id:string;line_message_id:string;status:string;ordinal:number}>();expect(batches.results).toHaveLength(1);expect(batches.results[0].status).toBe('collecting');expect(assets.results).toEqual([{batch_id:batches.results[0].id,asset_id:'line-message-flyer',line_message_id:'flyer',status:'pending',ordinal:1},{batch_id:batches.results[0].id,asset_id:'line-message-menu',line_message_id:'menu',status:'pending',ordinal:2}]);expect(queueSend).toHaveBeenCalledTimes(4);});
	it('lets done close the one two-asset batch without creating Batch B',async()=>{const worker=testEnv();await processWebhookEvents(imageWebhook(['flyer','menu']),worker);await processWebhookEvents(textWebhook('done','/done','2026-08-15T10:00:00.300Z'),worker);expect((await env.DB.prepare(`SELECT COUNT(*) count FROM line_image_batches`).first<{count:number}>())?.count).toBe(1);expect(await env.DB.prepare(`SELECT status FROM line_image_batches`).first<{status:string}>()).toEqual({status:'processing'});expect((await env.DB.prepare(`SELECT COUNT(*) count FROM line_image_batch_assets`).first<{count:number}>())?.count).toBe(2);});
	it('suppresses a duplicate image webhook without creating another asset, queue job, or acknowledgement',async()=>{const webhook=imageWebhook(['flyer']);await processWebhookEvents(webhook,testEnv());await processWebhookEvents(webhook,testEnv());expect((await env.DB.prepare(`SELECT COUNT(*) count FROM line_image_batch_assets`).first<{count:number}>())?.count).toBe(1);expect(queueSend).toHaveBeenCalledTimes(2);expect(replyToLine).toHaveBeenCalledTimes(1);});
	it('keeps a placeholder and retryable intent when queue submission fails',async()=>{queueSend.mockRejectedValueOnce(new Error('queue unavailable'));await expect(processWebhookEvents(imageWebhook(['flyer']),testEnv())).resolves.toBeUndefined();expect(await env.DB.prepare(`SELECT status,error FROM line_image_batch_assets`).first<{status:string;error:string}>()).toEqual({status:'pending',error:null});expect(await env.DB.prepare(`SELECT status,attempts FROM line_delivery_outbox WHERE operation_type='enqueue_process_batch'`).first<{status:string;attempts:number}>()).toEqual({status:'retryable',attempts:1});});
});

describe('LINE text webhook acknowledgement', () => {
	it('routes a known command and returns its command response', async () => {
		await processWebhookEvents(textWebhook('command-1', 'ping'), testEnv());

		expect(replyToLine).toHaveBeenCalledWith('reply-command-1', 'pong', undefined);
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM line_text_contexts').first<{ count: number }>()).toEqual({ count: 0 });
	});

	it('stores event text in the active message batch and acknowledges collection', async () => {
		await processWebhookEvents(textWebhook('text-1', 'Wine dinner at 7pm'), testEnv());
		const stored = await env.DB.prepare(
			'SELECT message_id, text_content FROM line_text_contexts WHERE message_id = ?',
		).bind('text-1').first<{ message_id: string; text_content: string }>();

		expect(stored).toEqual({ message_id: 'text-1', text_content: 'Wine dinner at 7pm' });
		expect(replyToLine).toHaveBeenCalledWith(
			'reply-text-1',
			'Event details received – waiting for related images or text.',
			undefined,
		);
	});

	it('closes an active batch with /done and suppresses a duplicate completion job',async()=>{const worker=testEnv();await processWebhookEvents(textWebhook('text-1','Wine dinner 5 August 2026 at 19:00'),worker);queueSend.mockClear();await processWebhookEvents(textWebhook('done-1','/done'),worker);expect(replyToLine).toHaveBeenCalledWith('reply-done-1','Batch closed; enrichment is starting.',undefined);expect(queueSend).toHaveBeenCalledTimes(1);await processWebhookEvents(textWebhook('done-2','/done'),worker);expect(replyToLine).toHaveBeenCalledWith('reply-done-2','The flyer is already published; enrichment is still processing.',undefined);expect(queueSend).toHaveBeenCalledTimes(1)});

	it.each([['exactly at expiry','2026-08-15T10:01:00.000Z'],['after expiry','2026-08-15T10:01:01.000Z']])('lets /done claim a batch %s',async(_label,doneAt)=>{const worker=testEnv();await processWebhookEvents(textWebhook('text-1','https://example.com/event'),worker);queueSend.mockClear();await processWebhookEvents(textWebhook('done-1','/done',doneAt),worker);expect(replyToLine).toHaveBeenCalledWith('reply-done-1','Batch closed; enrichment is starting.',undefined);expect(replyToLine).not.toHaveBeenCalledWith('reply-done-1','No batch is waiting for related messages.',undefined);expect(queueSend).toHaveBeenCalledTimes(1)});

	it('uses the custom message window for persistence and queue scheduling',async()=>{await processWebhookEvents(textWebhook('text-1','https://example.com/event'),testEnv('90'));const row=await env.DB.prepare('SELECT expires_at FROM line_image_batches LIMIT 1').first<{expires_at:string}>();expect(row?.expires_at).toBe('2026-08-15T10:01:30.000Z');expect(queueSend).toHaveBeenCalledWith(expect.anything(),{delaySeconds:90})});

	it('reports no active batch only when the conversation has no batch',async()=>{await processWebhookEvents(textWebhook('done-1','/done'),testEnv());expect(replyToLine).toHaveBeenCalledWith('reply-done-1','No batch is waiting for related messages.',undefined);expect(queueSend).not.toHaveBeenCalled()});

	it('acknowledges a timeout claim that won immediately before /done without another job',async()=>{const worker=testEnv();await processWebhookEvents(textWebhook('text-1','https://example.com/event'),worker);await env.DB.prepare(`UPDATE line_image_batches SET status='processing',processing_at=?,closed_at=? WHERE conversation_key=? AND status='collecting'`).bind('queue-claim','2026-08-15T10:01:00.000Z','user:user-1').run();queueSend.mockClear();await processWebhookEvents(textWebhook('done-1','/done','2026-08-15T10:01:00.000Z'),worker);expect(replyToLine).toHaveBeenCalledWith('reply-done-1','The flyer is already published; enrichment is still processing.',undefined);expect(queueSend).not.toHaveBeenCalled()});

	it('reports an already completed batch without creating a job',async()=>{const worker=testEnv();await processWebhookEvents(textWebhook('text-1','https://example.com/event'),worker);await env.DB.prepare(`UPDATE line_image_batches SET status='completed',completed_at=? WHERE conversation_key=? AND status='collecting'`).bind('2026-08-15T10:00:30.000Z','user:user-1').run();queueSend.mockClear();await processWebhookEvents(textWebhook('done-1','/done','2026-08-15T10:00:40.000Z'),worker);expect(replyToLine).toHaveBeenCalledWith('reply-done-1','This batch has already been processed and published.',undefined);expect(queueSend).not.toHaveBeenCalled()});

	it('keeps a done claim durable when immediate queueing fails',async()=>{const worker=testEnv();await processWebhookEvents(textWebhook('text-1','https://example.com/event'),worker);queueSend.mockReset().mockRejectedValueOnce(new Error('queue unavailable')).mockResolvedValue(undefined);await expect(processWebhookEvents(textWebhook('done-1','/done'),worker)).resolves.toBeUndefined();expect(await env.DB.prepare('SELECT status FROM line_image_batches LIMIT 1').first<{status:string}>()).toEqual({status:'processing'});expect(await env.DB.prepare(`SELECT status FROM line_delivery_outbox WHERE receipt_id='message:text:done-1' AND operation_type='enqueue_process_batch'`).first<{status:string}>()).toEqual({status:'retryable'});await processWebhookEvents(textWebhook('done-1','/done'),worker);expect(replyToLine.mock.calls.filter(([token])=>token==='reply-done-1')).toHaveLength(1)});

	it('does not send the unknown-command response for stored event text', async () => {
		await processWebhookEvents(textWebhook('text-1', 'Wine dinner at 7pm'), testEnv());

		expect(replyToLine).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining('Bangkok Wine Scout received'),
			expect.anything(),
		);
	});

	it('keeps duplicate text delivery idempotent and suppresses the second acknowledgement', async () => {
		const webhook = textWebhook('text-1', 'Wine dinner at 7pm');
		await processWebhookEvents(webhook, testEnv());
		await processWebhookEvents(webhook, testEnv());
		const count = await env.DB.prepare(
			'SELECT COUNT(*) AS count FROM line_text_contexts WHERE message_id = ?',
		).bind('text-1').first<{ count: number }>();

		expect(count?.count).toBe(1);
		expect(replyToLine).toHaveBeenCalledTimes(1);
	});

	it('keeps the same URL webhook delivery idempotent without refetching',async()=>{const webhook=textWebhook('url-1','https://example.com/event');webhook.events![0].webhookEventId='delivery-1';await processWebhookEvents(webhook,testEnv());await processWebhookEvents(webhook,testEnv());expect(fetchPage).toHaveBeenCalledTimes(1);expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM line_message_batch_web_sources').first<{count:number}>())?.count).toBe(1);});

	it('finalizes parser-empty URL-only batches without queueing LLM work',async()=>{fetchPage.mockResolvedValueOnce({requestedUrl:'https://example.com/empty',normalizedUrl:'https://example.com/empty',finalUrl:'https://example.com/empty',status:'failed',httpStatus:202,contentType:'text/html',responseBytes:0,redirectCount:0,title:null,description:null,canonicalUrl:null,mainImageUrl:null,openGraph:{},jsonLd:[],extractedText:null,originalReadableTextChars:0,extractedTextLength:0,textReduced:false,attemptNumber:2,retryPerformed:true,retryReason:'202_empty_or_short_parser_empty',firstStatus:202,secondStatus:202,firstResponseBytes:0,secondResponseBytes:0,firstParserStatus:'empty',secondParserStatus:'empty',errorCode:'TRANSIENT_EMPTY_RESPONSE',errorMessage:'empty',fetchedAt:'2026-08-15T10:00:00.000Z'});await processWebhookEvents(textWebhook('url-failed','https://example.com/empty'),testEnv());expect(queueSend).not.toHaveBeenCalled();expect(await env.DB.prepare('SELECT status FROM line_image_batches LIMIT 1').first<{status:string}>()).toEqual({status:'needs_review'});});

	it('fetches the same URL again in a new batch after a prior parser failure',async()=>{const failed={requestedUrl:'https://example.com/event',normalizedUrl:'https://example.com/event',finalUrl:'https://example.com/event',status:'failed' as const,httpStatus:200,contentType:'text/html',responseBytes:10,redirectCount:0,title:null,description:null,canonicalUrl:null,mainImageUrl:null,openGraph:{},jsonLd:[],extractedText:null,originalReadableTextChars:0,extractedTextLength:0,textReduced:false,attemptNumber:1,retryPerformed:false,retryReason:null,firstStatus:200,secondStatus:null,firstResponseBytes:10,secondResponseBytes:null,firstParserStatus:'empty',secondParserStatus:null,errorCode:'PARSER_EMPTY',errorMessage:'empty',fetchedAt:'2026-08-15T10:00:00.000Z'};fetchPage.mockResolvedValueOnce(failed);await processWebhookEvents(textWebhook('url-failed','https://example.com/event'),testEnv());fetchPage.mockResolvedValueOnce({...failed,status:'completed',title:'Wine Dinner',extractedText:'Wine Dinner 12 August 2026',extractedTextLength:26,errorCode:null,errorMessage:null,firstParserStatus:'useful'});await processWebhookEvents(textWebhook('url-success','https://example.com/event','2026-08-15T10:00:05.000Z'),testEnv());expect(fetchPage).toHaveBeenCalledTimes(2);const rows=await env.DB.prepare('SELECT status FROM line_message_batch_web_sources ORDER BY fetched_at').all<{status:string}>();expect(rows.results.map((row)=>row.status)).toEqual(['failed','completed']);});
});

describe('LINE PDF rejection', () => {
it('rejects PDF file messages with guidance to send images without queueing processing', async () => {
const payload = {
events: [{
type: 'message',
webhookEventId: 'pdf-delivery-1',
replyToken: 'reply-pdf-1',
timestamp: Date.parse('2026-08-15T10:00:00.000Z'),
source: { userId: 'user-1' },
message: {
id: 'pdf-1',
type: 'file',
fileName: 'wine-dinner.pdf',
},
}],
} as LineWebhookPayload;

await processWebhookEvents(payload, testEnv());

expect(replyToLine).toHaveBeenCalledWith(
'reply-pdf-1',
'PDF files aren’t supported yet. Please send the flyer pages as images instead. You can send multiple images — Bangkok Wine Scout will process them together as one event.',
undefined,
);
expect(queueSend).not.toHaveBeenCalled();
});
});
