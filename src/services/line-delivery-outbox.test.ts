import { env } from 'cloudflare:test';
import { beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import type { WorkerEnv } from '../types/env';
import { hashConversationIdentity } from './line-delivery-repository';

const replyToLine=vi.hoisted(()=>vi.fn().mockResolvedValue(undefined));
vi.mock('./line',()=>({replyToLine,downloadLineMessageContent:vi.fn(),pushToLine:vi.fn()}));

import { dispatchDeliveryOutbox,ensureBatchDeliveryIntent,ensureImageDeliveryIntents,recoverIncompleteDeliveries } from './line-delivery-outbox';

declare module 'cloudflare:test' { interface ProvidedEnv { DB:D1Database } }

beforeAll(async()=>{
	const schema=[
		`CREATE TABLE IF NOT EXISTS line_webhook_delivery_receipts(
			webhook_event_id TEXT PRIMARY KEY,message_id TEXT NOT NULL,message_type TEXT NOT NULL,conversation_id TEXT,batch_id TEXT,
			processing_outcome TEXT NOT NULL,processing_claimed_at TEXT NOT NULL,acknowledgement_claimed_at TEXT,
			delivery_stage TEXT NOT NULL DEFAULT 'registered',registration_completed_at TEXT,dispatch_pending_at TEXT,dispatched_at TEXT,handoff_completed_at TEXT,
			acknowledgement_outcome TEXT,acknowledgement_updated_at TEXT,last_progress_at TEXT,reconciliation_reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS outbox_test_receipt_message ON line_webhook_delivery_receipts(message_type,message_id)`,
		`CREATE TABLE IF NOT EXISTS line_image_batches(
			id TEXT PRIMARY KEY,conversation_key TEXT NOT NULL,status TEXT NOT NULL,first_received_at TEXT NOT NULL,last_received_at TEXT NOT NULL,
			created_at TEXT NOT NULL,last_activity_at TEXT NOT NULL,expires_at TEXT NOT NULL,closed_at TEXT,updated_at TEXT NOT NULL,processing_at TEXT,
			completed_at TEXT,push_target TEXT,resulting_event_ids_json TEXT NOT NULL DEFAULT '[]',error TEXT,attempt_count INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS line_image_batch_assets(
			batch_id TEXT NOT NULL,asset_id TEXT NOT NULL UNIQUE,intake_id TEXT NOT NULL,line_message_id TEXT NOT NULL UNIQUE,webhook_event_id TEXT UNIQUE,
			source_type TEXT NOT NULL DEFAULT 'line_image',source_reference TEXT NOT NULL,content_type TEXT NOT NULL,r2_object_key TEXT NOT NULL,
			received_at TEXT NOT NULL,conversation_key TEXT NOT NULL,ordinal INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT,
			processing_started_at TEXT,processed_at TEXT,processing_attempt_count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(batch_id,asset_id)
		)`,
		`CREATE TABLE IF NOT EXISTS line_message_batch_texts(batch_id TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,webhook_event_id TEXT UNIQUE,asset_id TEXT NOT NULL UNIQUE,text_content TEXT NOT NULL,received_at TEXT NOT NULL,conversation_key TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(batch_id,message_id))`,
		`CREATE TABLE IF NOT EXISTS line_delivery_outbox(
			id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL,batch_id TEXT,asset_id TEXT,operation_type TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,
			payload_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,available_at TEXT NOT NULL,
			lease_token TEXT,lease_expires_at TEXT,enqueued_at TEXT,completed_at TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
		)`,
	];
	for(const statement of schema)await env.DB.prepare(statement).run();
});

const created='2026-08-04T03:10:00.000Z';
const send=vi.fn().mockResolvedValue(undefined);
const worker=()=>({...env,IMAGE_PROCESSING_QUEUE:{send},LINE_CHANNEL_ACCESS_TOKEN:'test-token'} as unknown as WorkerEnv);

async function receipt(id='receipt-1',messageId='message-1',type='image',conversationId:string|null=null,at=created){
	await env.DB.prepare(`INSERT INTO line_webhook_delivery_receipts(webhook_event_id,message_id,message_type,conversation_id,batch_id,processing_outcome,processing_claimed_at,delivery_stage,last_progress_at,created_at,updated_at) VALUES (?,?,?,?,NULL,'processing',?,'registered',?,?,?)`).bind(id,messageId,type,conversationId,at,at,at,at).run();
}
async function batch(id='batch-1',status='collecting',processingAt:string|null=null,conversationKey='user:user-1'){
	await env.DB.prepare(`INSERT INTO line_image_batches(id,conversation_key,status,first_received_at,last_received_at,created_at,last_activity_at,expires_at,updated_at,processing_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id,conversationKey,status,created,created,created,created,'2026-08-04T03:10:15.000Z',created,processingAt).run();
}
async function asset(batchId='batch-1',messageId='message-1',receiptId='receipt-1'){
	await env.DB.prepare(`INSERT INTO line_image_batch_assets(batch_id,asset_id,intake_id,line_message_id,webhook_event_id,source_reference,content_type,r2_object_key,received_at,conversation_key,ordinal,status) VALUES (?,?,?,?,?,?,?,?,?,?,1,'pending')`).bind(batchId,`line-message-${messageId}`,`line-${messageId}`,messageId,receiptId,messageId,'application/octet-stream',`intakes/line-${messageId}/assets/line-message-${messageId}/original`,created,'user:user-1').run();
}
async function imageIntents(id='receipt-1',messageId='message-1',batchId='batch-1'){
	await ensureImageDeliveryIntents(env.DB,{receiptId:id,batchId,assetId:`line-message-${messageId}`,message:{batchId,assetId:`line-message-${messageId}`,sourceMessageId:messageId,messageId,receivedAt:created,webhookEventId:id},batchExpectedLastReceivedAt:created,batchDelaySeconds:15,acknowledgementText:'Image received.' ,now:created});
}
async function acknowledgementIntent(receiptId='receipt-1'){
	await env.DB.prepare(`INSERT INTO line_delivery_outbox(id,receipt_id,operation_type,idempotency_key,payload_json,status,attempts,available_at,created_at,updated_at) VALUES(?,?, 'send_image_acknowledgement',?,?,'pending',0,?,?,?)`).bind(`ack-${receiptId}`,receiptId,`${receiptId}:acknowledgement`,JSON.stringify({text:'Image received.'}),created,created,created).run();
}

beforeEach(async()=>{
	await env.DB.prepare('DELETE FROM line_delivery_outbox').run();await env.DB.prepare('DELETE FROM line_message_batch_texts').run();await env.DB.prepare('DELETE FROM line_image_batch_assets').run();await env.DB.prepare('DELETE FROM line_image_batches').run();await env.DB.prepare('DELETE FROM line_webhook_delivery_receipts').run();
	send.mockReset().mockResolvedValue(undefined);replyToLine.mockReset().mockResolvedValue(undefined);
});

describe('durable LINE delivery outbox',()=>{
	it('creates one durable intent per operation and dispatches each at most once',async()=>{
		await receipt();await batch();await asset();await imageIntents();await imageIntents();
		expect((await env.DB.prepare('SELECT COUNT(*) count FROM line_delivery_outbox').first<{count:number}>())?.count).toBe(3);
		await dispatchDeliveryOutbox(worker(),{receiptId:'receipt-1',replyTokens:new Map([['receipt-1','reply-token']]),now:created});
		expect(send).toHaveBeenCalledTimes(2);expect(replyToLine).toHaveBeenCalledOnce();
		expect(await env.DB.prepare(`SELECT delivery_stage,acknowledgement_outcome FROM line_webhook_delivery_receipts`).first()).toEqual({delivery_stage:'dispatched',acknowledgement_outcome:'sent'});
		await dispatchDeliveryOutbox(worker(),{receiptId:'receipt-1',replyTokens:new Map([['receipt-1','reply-token']]),now:created});
		expect(send).toHaveBeenCalledTimes(2);expect(replyToLine).toHaveBeenCalledOnce();
	});

	it('resumes after receipt-only, batch-only, and placeholder-before-association stages',async()=>{
		await receipt();await batch();await asset();
		const result=await recoverIncompleteDeliveries(worker(),{now:'2026-08-04T03:10:10.000Z'});
		expect(result).toEqual({scanned:1,recovered:1,failed:0});
		expect(await env.DB.prepare(`SELECT batch_id,delivery_stage FROM line_webhook_delivery_receipts`).first()).toEqual({batch_id:'batch-1',delivery_stage:'dispatch_pending'});
		expect((await env.DB.prepare(`SELECT COUNT(*) count FROM line_delivery_outbox`).first<{count:number}>())?.count).toBe(3);
	});

	it('leaves a failed queue submission retryable without failing the asset',async()=>{
		await receipt();await batch();await asset();await imageIntents();send.mockRejectedValue(new Error('queue unavailable'));
		await dispatchDeliveryOutbox(worker(),{receiptId:'receipt-1',replyTokens:new Map([['receipt-1','reply-token']]),now:created});
		const rows=await env.DB.prepare(`SELECT status FROM line_delivery_outbox WHERE operation_type LIKE 'enqueue_%' ORDER BY operation_type`).all<{status:string}>();
		expect(rows.results).toEqual([{status:'retryable'},{status:'retryable'}]);
		expect(await env.DB.prepare(`SELECT status,processing_attempt_count FROM line_image_batch_assets`).first()).toEqual({status:'pending',processing_attempt_count:0});
	});

	it('treats acknowledgement failure after ownership claim as uncertain and never sends twice',async()=>{
		await receipt();await batch();await asset();await imageIntents();replyToLine.mockRejectedValue(new Error('connection reset'));
		await dispatchDeliveryOutbox(worker(),{receiptId:'receipt-1',replyTokens:new Map([['receipt-1','reply-token']]),now:created});
		expect(await env.DB.prepare(`SELECT acknowledgement_outcome FROM line_webhook_delivery_receipts`).first()).toEqual({acknowledgement_outcome:'uncertain'});
		await env.DB.prepare(`UPDATE line_delivery_outbox SET status='pending',available_at=? WHERE operation_type='send_image_acknowledgement'`).bind(created).run();
		await dispatchDeliveryOutbox(worker(),{receiptId:'receipt-1',replyTokens:new Map([['receipt-1','reply-token']]),now:created});
		expect(replyToLine).toHaveBeenCalledOnce();
	});

	it('re-dispatches an expired uncertain queue lease using the same idempotency key',async()=>{
		await receipt();await batch();await ensureBatchDeliveryIntent(env.DB,{receiptId:'receipt-1',batchId:'batch-1',expectedLastReceivedAt:created,now:created});
		await env.DB.prepare(`UPDATE line_delivery_outbox SET status='leased',attempts=1,lease_token='dead-worker',lease_expires_at='2026-08-04T03:09:59.000Z'`).run();
		await dispatchDeliveryOutbox(worker(),{receiptId:'receipt-1',now:created});
		expect(send).toHaveBeenCalledWith(expect.objectContaining({idempotencyKey:`batch:batch-1:process:${created}`} ),undefined);
		expect(await env.DB.prepare(`SELECT status,attempts FROM line_delivery_outbox`).first()).toEqual({status:'enqueued',attempts:2});
	});

	it('exhausts outbox retries finitely and marks the receipt for reconciliation',async()=>{
		await receipt();await batch();await ensureBatchDeliveryIntent(env.DB,{receiptId:'receipt-1',batchId:'batch-1',expectedLastReceivedAt:created,now:created});
		await env.DB.prepare(`UPDATE line_delivery_outbox SET status='retryable',attempts=5,available_at=?`).bind(created).run();send.mockRejectedValue(new Error('queue unavailable'));
		await dispatchDeliveryOutbox(worker(),{receiptId:'receipt-1',now:created});
		expect(await env.DB.prepare(`SELECT status,attempts FROM line_delivery_outbox`).first()).toEqual({status:'exhausted',attempts:6});
		expect(await env.DB.prepare(`SELECT delivery_stage,reconciliation_reason FROM line_webhook_delivery_receipts`).first<{delivery_stage:string;reconciliation_reason:string}>()).toEqual({delivery_stage:'needs_reconciliation',reconciliation_reason:expect.stringContaining('outbox_retry_exhausted')});
	});

	it('expires a NULL acknowledgement idempotently without persisting or logging a reply token or changing unrelated receipt state',async()=>{
		const token='never-log-or-persist-this-reply-token';const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);const log=vi.spyOn(console,'log').mockImplementation(()=>undefined);const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);
		try{
			await receipt('receipt-1','message-1','image','conversation-hash');await env.DB.prepare(`UPDATE line_webhook_delivery_receipts SET batch_id='batch-1',processing_outcome='registered',delivery_stage='dispatch_pending',reconciliation_reason='preserve-me' WHERE webhook_event_id='receipt-1'`).run();await acknowledgementIntent();
			await dispatchDeliveryOutbox(worker(),{receiptId:'receipt-1',now:'2026-08-04T03:11:00.000Z'});
			expect(replyToLine).not.toHaveBeenCalled();
			expect(await env.DB.prepare(`SELECT acknowledgement_outcome,acknowledgement_claimed_at,processing_outcome,delivery_stage,batch_id,conversation_id,reconciliation_reason FROM line_webhook_delivery_receipts`).first()).toEqual({acknowledgement_outcome:'expired',acknowledgement_claimed_at:null,processing_outcome:'registered',delivery_stage:'dispatch_pending',batch_id:'batch-1',conversation_id:'conversation-hash',reconciliation_reason:'preserve-me'});
			expect(await env.DB.prepare(`SELECT status,payload_json FROM line_delivery_outbox`).first()).toEqual({status:'unavailable',payload_json:JSON.stringify({text:'Image received.'})});
			await dispatchDeliveryOutbox(worker(),{receiptId:'receipt-1',now:'2026-08-04T03:12:00.000Z'});
			expect(await env.DB.prepare(`SELECT acknowledgement_outcome,processing_outcome,delivery_stage,reconciliation_reason FROM line_webhook_delivery_receipts`).first()).toEqual({acknowledgement_outcome:'expired',processing_outcome:'registered',delivery_stage:'dispatch_pending',reconciliation_reason:'preserve-me'});
			expect(JSON.stringify([...warn.mock.calls,...log.mock.calls,...error.mock.calls])).not.toContain(token);
		}finally{warn.mockRestore();log.mockRestore();error.mockRestore();}
	});

	it.each(['sent','uncertain'] as const)('does not replace a protected %s acknowledgement outcome during expiration',async(outcome)=>{
		await receipt();await env.DB.prepare(`UPDATE line_webhook_delivery_receipts SET acknowledgement_outcome=? WHERE webhook_event_id='receipt-1'`).bind(outcome).run();await acknowledgementIntent();
		await dispatchDeliveryOutbox(worker(),{receiptId:'receipt-1',now:'2026-08-04T03:11:00.000Z'});
		expect(await env.DB.prepare(`SELECT acknowledgement_outcome FROM line_webhook_delivery_receipts`).first()).toEqual({acknowledgement_outcome:outcome});expect(replyToLine).not.toHaveBeenCalled();
	});

	it('recovers ordinary text and a uniquely owned /done batch',async()=>{
		await receipt('text-receipt','text-message','text');await batch('text-batch');
		await env.DB.prepare(`INSERT INTO line_message_batch_texts(batch_id,message_id,webhook_event_id,asset_id,text_content,received_at,conversation_key,ordinal) VALUES ('text-batch','text-message','text-receipt','line-text-text-message','details',?,'user:user-1',1)`).bind(created).run();
		const conversationHash=await hashConversationIdentity('user:user-2');await receipt('done-receipt','done-message','text',conversationHash);await batch('done-batch','processing','done:claim','user:user-2');
		const result=await recoverIncompleteDeliveries(worker(),{now:'2026-08-04T03:10:10.000Z'});expect(result.recovered).toBe(2);
		expect(await env.DB.prepare(`SELECT batch_id FROM line_webhook_delivery_receipts WHERE webhook_event_id='done-receipt'`).first()).toEqual({batch_id:'done-batch'});
		expect((await env.DB.prepare(`SELECT COUNT(*) count FROM line_delivery_outbox WHERE operation_type='enqueue_process_batch'`).first<{count:number}>())?.count).toBe(2);
	});
});
