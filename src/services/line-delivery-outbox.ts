import type { BatchProcessingMessage } from './line-image-batch-processing';
import type { ImageProcessingMessage } from '../routes/webhook';
import type { WorkerEnv } from '../types/env';
import { replyToLine } from './line';

export type DeliveryOutboxOperation =
	| 'enqueue_process_image'
	| 'enqueue_process_batch'
	| 'send_image_acknowledgement'
	| 'send_text_acknowledgement'
	| 'reconciliation_check';
export type DeliveryOutboxStatus = 'pending'|'leased'|'retryable'|'enqueued'|'completed'|'uncertain'|'unavailable'|'exhausted';

interface OutboxRow {
	id:string; receipt_id:string; batch_id:string|null; asset_id:string|null;
	operation_type:DeliveryOutboxOperation; idempotency_key:string; payload_json:string;
	status:DeliveryOutboxStatus; attempts:number; available_at:string;
	lease_token:string|null; lease_expires_at:string|null; created_at:string; updated_at:string;
}

interface ImageIntentPayload {
	batchId:string; assetId:string; sourceMessageId:string; messageId:string;
	lineUserId?:string; pushTarget?:string; conversationKey?:string; receivedAt:string;
	webhookEventId?:string;
}
interface BatchIntentPayload { batchId:string; expectedLastReceivedAt:string; delaySeconds?:number; closedProcessingToken?:string }
interface AcknowledgementIntentPayload { text:string }

const OUTBOX_LEASE_MS=45_000;
const OUTBOX_MAX_ATTEMPTS=6;
const OUTBOX_SCAN_LIMIT=25;
const ACKNOWLEDGEMENT_TOKEN_WINDOW_MS=55_000;
const RETRY_DELAYS_SECONDS=[15,30,60,120,240,300] as const;

const nowIso=()=>new Date().toISOString();
const intentId=(key:string)=>`line-outbox:${key}`;
export const imageIntentKey=(receiptId:string)=>`${receiptId}:process-image`;
export const batchIntentKey=(batchId:string,expectedLastReceivedAt:string,closedProcessingToken?:string)=>`batch:${batchId}:process:${closedProcessingToken??expectedLastReceivedAt}`;
export const acknowledgementIntentKey=(receiptId:string)=>`${receiptId}:acknowledgement`;

function safeError(error:unknown):string {
	const value=error instanceof Error?error.message:String(error);
	return value.replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,500);
}

function intentStatement(db:D1Database,input:{receiptId:string;batchId?:string|null;assetId?:string|null;operationType:DeliveryOutboxOperation;key:string;payload:unknown;availableAt?:string;now:string}) {
	return db.prepare(`INSERT OR IGNORE INTO line_delivery_outbox
		(id,receipt_id,batch_id,asset_id,operation_type,idempotency_key,payload_json,status,attempts,available_at,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,'pending',0,?,?,?)`)
		.bind(intentId(input.key),input.receiptId,input.batchId??null,input.assetId??null,input.operationType,input.key,JSON.stringify(input.payload),input.availableAt??input.now,input.now,input.now);
}

export async function ensureImageDeliveryIntents(db:D1Database,input:{
	receiptId:string; batchId:string; assetId:string; message:ImageIntentPayload;
	batchExpectedLastReceivedAt:string; batchDelaySeconds:number; acknowledgementText:string; now?:string;
}):Promise<void>{
	const now=input.now??nowIso();
	const results=await db.batch([
		db.prepare(`UPDATE line_webhook_delivery_receipts SET batch_id=?,processing_outcome='registered',delivery_stage='dispatch_pending',
			registration_completed_at=COALESCE(registration_completed_at,?),dispatch_pending_at=COALESCE(dispatch_pending_at,?),
			last_progress_at=?,updated_at=?,reconciliation_reason=NULL WHERE webhook_event_id=? AND delivery_stage NOT IN ('completed','permanently_failed','ignored')`)
			.bind(input.batchId,now,now,now,now,input.receiptId),
		intentStatement(db,{receiptId:input.receiptId,batchId:input.batchId,assetId:input.assetId,operationType:'enqueue_process_image',key:imageIntentKey(input.receiptId),payload:input.message,now}),
		intentStatement(db,{receiptId:input.receiptId,batchId:input.batchId,operationType:'enqueue_process_batch',key:batchIntentKey(input.batchId,input.batchExpectedLastReceivedAt),payload:{batchId:input.batchId,expectedLastReceivedAt:input.batchExpectedLastReceivedAt,delaySeconds:input.batchDelaySeconds} satisfies BatchIntentPayload,now}),
		intentStatement(db,{receiptId:input.receiptId,batchId:input.batchId,assetId:input.assetId,operationType:'send_image_acknowledgement',key:acknowledgementIntentKey(input.receiptId),payload:{text:input.acknowledgementText} satisfies AcknowledgementIntentPayload,now}),
	]);
	for(const [index,result] of results.entries())if(index>0&&(result.meta.changes??0)===1)console.log({event:'outbox_intent_created',receiptId:input.receiptId,batchId:input.batchId,assetId:index===1?input.assetId:null,stage:'dispatch_pending',attempt:0,lease:null,outcome:['receipt','enqueue_process_image','enqueue_process_batch','send_image_acknowledgement'][index]});
}

export async function ensureBatchDeliveryIntent(db:D1Database,input:{receiptId:string;batchId:string;expectedLastReceivedAt:string;delaySeconds?:number;closedProcessingToken?:string;acknowledgementText?:string;now?:string}):Promise<void>{
	const now=input.now??nowIso();
	const statements=[
		db.prepare(`UPDATE line_webhook_delivery_receipts SET batch_id=?,processing_outcome='registered',delivery_stage='dispatch_pending',registration_completed_at=COALESCE(registration_completed_at,?),dispatch_pending_at=COALESCE(dispatch_pending_at,?),last_progress_at=?,updated_at=? WHERE webhook_event_id=? AND delivery_stage NOT IN ('completed','permanently_failed','ignored')`).bind(input.batchId,now,now,now,now,input.receiptId),
		intentStatement(db,{receiptId:input.receiptId,batchId:input.batchId,operationType:'enqueue_process_batch',key:batchIntentKey(input.batchId,input.expectedLastReceivedAt,input.closedProcessingToken),payload:{batchId:input.batchId,expectedLastReceivedAt:input.expectedLastReceivedAt,delaySeconds:input.delaySeconds,closedProcessingToken:input.closedProcessingToken} satisfies BatchIntentPayload,now}),
	];
	if(input.acknowledgementText)statements.push(intentStatement(db,{receiptId:input.receiptId,batchId:input.batchId,operationType:'send_text_acknowledgement',key:acknowledgementIntentKey(input.receiptId),payload:{text:input.acknowledgementText} satisfies AcknowledgementIntentPayload,now}));
	const results=await db.batch(statements);
	for(const [index,result] of results.entries())if(index>0&&(result.meta.changes??0)===1)console.log({event:'outbox_intent_created',receiptId:input.receiptId,batchId:input.batchId,assetId:null,stage:'dispatch_pending',attempt:0,lease:null,outcome:index===1?'enqueue_process_batch':'send_text_acknowledgement'});
}

async function claimOutbox(db:D1Database,id:string,now:string):Promise<OutboxRow|null>{
	const token=crypto.randomUUID();
	const leaseExpiresAt=new Date(Date.parse(now)+OUTBOX_LEASE_MS).toISOString();
	return db.prepare(`UPDATE line_delivery_outbox SET status='leased',attempts=attempts+1,lease_token=?,lease_expires_at=?,updated_at=?
		WHERE id=? AND attempts<? AND available_at<=? AND (status IN ('pending','retryable') OR (status='leased' AND lease_expires_at<=?))
		RETURNING *`).bind(token,leaseExpiresAt,now,id,OUTBOX_MAX_ATTEMPTS,now,now).first<OutboxRow>();
}

async function refreshReceiptHandoff(db:D1Database,receiptId:string,now:string):Promise<void>{
	const pending=await db.prepare(`SELECT COUNT(*) count FROM line_delivery_outbox WHERE receipt_id=? AND operation_type IN ('enqueue_process_image','enqueue_process_batch') AND status NOT IN ('enqueued','completed')`).bind(receiptId).first<{count:number}>();
	if((pending?.count??0)>0)return;
	const changed=await db.prepare(`UPDATE line_webhook_delivery_receipts SET delivery_stage=CASE WHEN delivery_stage='completed' THEN delivery_stage ELSE 'dispatched' END,dispatched_at=COALESCE(dispatched_at,?),handoff_completed_at=COALESCE(handoff_completed_at,?),last_progress_at=?,updated_at=? WHERE webhook_event_id=? AND delivery_stage NOT IN ('needs_reconciliation','permanently_failed','ignored')`).bind(now,now,now,now,receiptId).run();
	if((changed.meta.changes??0)>0)console.log({event:'handoff_completed',receiptId,stage:'dispatched',attempt:null,lease:null,outcome:'mandatory_jobs_enqueued'});
}

async function markEnqueued(db:D1Database,row:OutboxRow,now:string):Promise<void>{
	await db.prepare(`UPDATE line_delivery_outbox SET status='enqueued',enqueued_at=COALESCE(enqueued_at,?),lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND status='leased' AND lease_token=?`).bind(now,now,row.id,row.lease_token).run();
	console.log({event:'outbox_enqueued',receiptId:row.receipt_id,batchId:row.batch_id,assetId:row.asset_id,stage:row.operation_type,attempt:row.attempts,lease:row.lease_token,outcome:'enqueued'});
	await refreshReceiptHandoff(db,row.receipt_id,now);
}

async function markRetry(db:D1Database,row:OutboxRow,error:unknown,now:string):Promise<void>{
	const reason=safeError(error);
	if(row.attempts>=OUTBOX_MAX_ATTEMPTS){
		await db.batch([
			db.prepare(`UPDATE line_delivery_outbox SET status='exhausted',lease_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=? AND status='leased' AND lease_token=?`).bind(reason,now,row.id,row.lease_token),
			db.prepare(`UPDATE line_webhook_delivery_receipts SET delivery_stage='needs_reconciliation',processing_outcome='retryable_failed',reconciliation_reason=?,last_progress_at=?,updated_at=? WHERE webhook_event_id=? AND delivery_stage NOT IN ('completed','permanently_failed','ignored')`).bind(`outbox_retry_exhausted:${row.operation_type}:${reason}`,now,now,row.receipt_id),
		]);
		console.error({event:'outbox_retry_exhausted',receiptId:row.receipt_id,batchId:row.batch_id,assetId:row.asset_id,stage:row.operation_type,attempt:row.attempts,lease:row.lease_token,outcome:'needs_reconciliation',error:reason});
		return;
	}
	const delay=RETRY_DELAYS_SECONDS[Math.min(row.attempts-1,RETRY_DELAYS_SECONDS.length-1)];
	const availableAt=new Date(Date.parse(now)+delay*1000).toISOString();
	await db.prepare(`UPDATE line_delivery_outbox SET status='retryable',available_at=?,lease_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=? AND status='leased' AND lease_token=?`).bind(availableAt,reason,now,row.id,row.lease_token).run();
	console.error({event:'outbox_retry_scheduled',receiptId:row.receipt_id,batchId:row.batch_id,assetId:row.asset_id,stage:row.operation_type,attempt:row.attempts,lease:row.lease_token,outcome:'retryable',availableAt,error:reason});
}

async function dispatchClaimed(row:OutboxRow,env:WorkerEnv,replyTokens:ReadonlyMap<string,string>,now:string):Promise<void>{
	console.log({event:'outbox_claimed',receiptId:row.receipt_id,batchId:row.batch_id,assetId:row.asset_id,stage:row.operation_type,attempt:row.attempts,lease:row.lease_token,outcome:'claimed'});
	try{
		if(row.operation_type==='enqueue_process_image'){
			const payload=JSON.parse(row.payload_json) as ImageIntentPayload;
			await env.IMAGE_PROCESSING_QUEUE.send({...payload,type:'process_image',outboxId:row.id,idempotencyKey:row.idempotency_key} satisfies ImageProcessingMessage);
			await markEnqueued(env.DB,row,now);return;
		}
		if(row.operation_type==='enqueue_process_batch'){
			const payload=JSON.parse(row.payload_json) as BatchIntentPayload;
			const message={type:'process_batch',batchId:payload.batchId,expectedLastReceivedAt:payload.expectedLastReceivedAt,closedProcessingToken:payload.closedProcessingToken,outboxId:row.id,idempotencyKey:row.idempotency_key} satisfies BatchProcessingMessage;
			await env.IMAGE_PROCESSING_QUEUE.send(message,payload.delaySeconds===undefined?undefined:{delaySeconds:payload.delaySeconds});
			await markEnqueued(env.DB,row,now);return;
		}
		if(row.operation_type==='reconciliation_check'){
			await env.DB.prepare(`UPDATE line_delivery_outbox SET status='completed',completed_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_token=?`).bind(now,now,row.id,row.lease_token).run();return;
		}
		const token=replyTokens.get(row.receipt_id);
		if(!token){
			if(Date.parse(now)-Date.parse(row.created_at)<ACKNOWLEDGEMENT_TOKEN_WINDOW_MS){
				await env.DB.prepare(`UPDATE line_delivery_outbox SET status='pending',available_at=?,attempts=attempts-1,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_token=?`).bind(new Date(Date.parse(now)+5_000).toISOString(),now,row.id,row.lease_token).run();
				return;
			}
			await env.DB.batch([
				env.DB.prepare(`UPDATE line_delivery_outbox SET status='unavailable',completed_at=?,lease_token=NULL,lease_expires_at=NULL,last_error='reply_token_expired_or_unavailable',updated_at=? WHERE id=? AND lease_token=?`).bind(now,now,row.id,row.lease_token),
				env.DB.prepare(`UPDATE line_webhook_delivery_receipts SET acknowledgement_outcome='expired',acknowledgement_updated_at=?,updated_at=? WHERE webhook_event_id=? AND (acknowledgement_outcome IS NULL OR acknowledgement_outcome NOT IN ('sent','uncertain'))`).bind(now,now,row.receipt_id),
			]);
			console.warn({event:'acknowledgement_expired',receiptId:row.receipt_id,batchId:row.batch_id,assetId:row.asset_id,stage:row.operation_type,attempt:row.attempts,lease:row.lease_token,outcome:'expired'});return;
		}
		const claimed=await env.DB.prepare(`UPDATE line_webhook_delivery_receipts SET acknowledgement_claimed_at=COALESCE(acknowledgement_claimed_at,?),acknowledgement_outcome='claimed',acknowledgement_updated_at=?,updated_at=? WHERE webhook_event_id=? AND acknowledgement_claimed_at IS NULL`).bind(now,now,now,row.receipt_id).run();
		if((claimed.meta.changes??0)!==1){
			await env.DB.prepare(`UPDATE line_delivery_outbox SET status='uncertain',completed_at=?,lease_token=NULL,lease_expires_at=NULL,last_error='acknowledgement_already_claimed',updated_at=? WHERE id=? AND lease_token=?`).bind(now,now,row.id,row.lease_token).run();return;
		}
		console.log({event:'acknowledgement_claimed',receiptId:row.receipt_id,batchId:row.batch_id,stage:row.operation_type,attempt:row.attempts,lease:row.lease_token,outcome:'claimed'});
		const payload=JSON.parse(row.payload_json) as AcknowledgementIntentPayload;
		try{
			await replyToLine(token,payload.text,env.LINE_CHANNEL_ACCESS_TOKEN);
			await env.DB.batch([
				env.DB.prepare(`UPDATE line_delivery_outbox SET status='completed',completed_at=?,lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND lease_token=?`).bind(now,now,row.id,row.lease_token),
				env.DB.prepare(`UPDATE line_webhook_delivery_receipts SET acknowledgement_outcome='sent',acknowledgement_updated_at=?,updated_at=? WHERE webhook_event_id=?`).bind(now,now,row.receipt_id),
			]);
			console.log({event:'notification_sent',receiptId:row.receipt_id,batchId:row.batch_id,stage:row.operation_type,attempt:row.attempts,lease:row.lease_token,outcome:'sent',channel:'reply'});
		}catch(error){
			const reason=safeError(error);
			await env.DB.batch([
				env.DB.prepare(`UPDATE line_delivery_outbox SET status='uncertain',completed_at=?,lease_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=? AND lease_token=?`).bind(now,reason,now,row.id,row.lease_token),
				env.DB.prepare(`UPDATE line_webhook_delivery_receipts SET acknowledgement_outcome='uncertain',acknowledgement_updated_at=?,updated_at=? WHERE webhook_event_id=?`).bind(now,now,row.receipt_id),
			]);
			console.error({event:'notification_failed',receiptId:row.receipt_id,batchId:row.batch_id,stage:row.operation_type,attempt:row.attempts,lease:row.lease_token,outcome:'uncertain',channel:'reply',error:reason});
		}
	}catch(error){await markRetry(env.DB,row,error,now);}
}

export async function dispatchDeliveryOutbox(env:WorkerEnv,options:{receiptId?:string;replyTokens?:ReadonlyMap<string,string>;limit?:number;now?:string}={}):Promise<{scanned:number;claimed:number}>{
	const now=options.now??nowIso();
	const limit=Math.max(1,Math.min(options.limit??OUTBOX_SCAN_LIMIT,OUTBOX_SCAN_LIMIT));
	const clause=options.receiptId?'AND receipt_id=?':'';
	const statement=env.DB.prepare(`SELECT id,receipt_id,batch_id,asset_id,operation_type,status,attempts,lease_token FROM line_delivery_outbox WHERE attempts<? AND available_at<=? AND (status IN ('pending','retryable') OR (status='leased' AND lease_expires_at<=?)) ${clause} ORDER BY created_at,id LIMIT ?`);
	const rows=options.receiptId?await statement.bind(OUTBOX_MAX_ATTEMPTS,now,now,options.receiptId,limit).all<Pick<OutboxRow,'id'|'receipt_id'|'batch_id'|'asset_id'|'operation_type'|'status'|'attempts'|'lease_token'>>():await statement.bind(OUTBOX_MAX_ATTEMPTS,now,now,limit).all<Pick<OutboxRow,'id'|'receipt_id'|'batch_id'|'asset_id'|'operation_type'|'status'|'attempts'|'lease_token'>>();
	let claimed=0;
	for(const candidate of rows.results??[]){if(candidate.status==='leased')console.warn({event:'outbox_enqueue_uncertain',receiptId:candidate.receipt_id,batchId:candidate.batch_id,assetId:candidate.asset_id,stage:candidate.operation_type,attempt:candidate.attempts,lease:candidate.lease_token,outcome:'expired_lease_reclaimed'});const row=await claimOutbox(env.DB,candidate.id,now);if(!row)continue;claimed++;await dispatchClaimed(row,env,options.replyTokens??new Map(),now);}
	return{scanned:rows.results?.length??0,claimed};
}

export async function completeDeliveryOutboxIntent(db:D1Database,outboxId:string|undefined,outcome:'completed'|'needs_reconciliation'='completed',reason?:string):Promise<void>{
	if(!outboxId)return;
	const now=nowIso();
	const row=await db.prepare(`SELECT receipt_id,batch_id,asset_id,operation_type FROM line_delivery_outbox WHERE id=?`).bind(outboxId).first<{receipt_id:string;batch_id:string|null;asset_id:string|null;operation_type:string}>();
	if(!row)return;
	if(outcome==='completed')await db.prepare(`UPDATE line_delivery_outbox SET status='completed',completed_at=COALESCE(completed_at,?),lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND status IN ('enqueued','leased','retryable','pending')`).bind(now,now,outboxId).run();
	else await db.batch([
		db.prepare(`UPDATE line_delivery_outbox SET status='exhausted',completed_at=COALESCE(completed_at,?),lease_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=?`).bind(now,reason??'queue_processing_exhausted',now,outboxId),
		db.prepare(`UPDATE line_webhook_delivery_receipts SET delivery_stage='needs_reconciliation',processing_outcome='retryable_failed',reconciliation_reason=?,last_progress_at=?,updated_at=? WHERE webhook_event_id=? AND delivery_stage NOT IN ('completed','permanently_failed','ignored')`).bind(reason??'queue_processing_exhausted',now,now,row.receipt_id),
	]);
	if(outcome==='completed'){
		const remaining=await db.prepare(`SELECT COUNT(*) count FROM line_delivery_outbox WHERE receipt_id=? AND operation_type IN ('enqueue_process_image','enqueue_process_batch') AND status<>'completed'`).bind(row.receipt_id).first<{count:number}>();
		if((remaining?.count??0)===0)await db.prepare(`UPDATE line_webhook_delivery_receipts SET delivery_stage='completed',processing_outcome='completed',last_progress_at=?,updated_at=? WHERE webhook_event_id=? AND delivery_stage NOT IN ('needs_reconciliation','permanently_failed','ignored')`).bind(now,now,row.receipt_id).run();
	}
}

export async function recoverIncompleteDeliveries(env:WorkerEnv,options:{limit?:number;now?:string}={}):Promise<{scanned:number;recovered:number;failed:number}>{
	const now=options.now??nowIso();const limit=Math.max(1,Math.min(options.limit??OUTBOX_SCAN_LIMIT,OUTBOX_SCAN_LIMIT));
	console.log({event:'reconciliation_scan_started',stage:'scan',attempt:0,lease:null,outcome:'started',limit});
	const receipts=await env.DB.prepare(`SELECT webhook_event_id,message_id,message_type,conversation_id,batch_id,delivery_stage,processing_claimed_at,created_at FROM line_webhook_delivery_receipts WHERE delivery_stage IN ('registered','dispatch_pending','retryable_failed','processing') ORDER BY COALESCE(last_progress_at,updated_at),created_at LIMIT ?`).bind(limit).all<{webhook_event_id:string;message_id:string;message_type:string;conversation_id:string|null;batch_id:string|null;delivery_stage:string;processing_claimed_at:string;created_at:string}>();
	let recovered=0,failed=0;
	for(const receipt of receipts.results??[]){
		try{
			console.warn({event:'delivery_incomplete_detected',receiptId:receipt.webhook_event_id,batchId:receipt.batch_id,assetId:null,stage:receipt.delivery_stage,attempt:0,lease:receipt.processing_claimed_at,outcome:'recovery_started'});
			if(receipt.message_type==='image'){
				const asset=await env.DB.prepare(`SELECT a.batch_id,a.asset_id,a.line_message_id,a.received_at,a.conversation_key,a.status,a.processing_attempt_count,b.last_received_at,b.expires_at,b.push_target FROM line_image_batch_assets a JOIN line_image_batches b ON b.id=a.batch_id WHERE a.line_message_id=? OR a.webhook_event_id=? LIMIT 1`).bind(receipt.message_id,receipt.webhook_event_id).first<{batch_id:string;asset_id:string;line_message_id:string;received_at:string;conversation_key:string;status:string;processing_attempt_count:number;last_received_at:string;expires_at:string;push_target:string|null}>();
				if(!asset)continue;
				const delay=Math.max(0,Math.ceil((Date.parse(asset.expires_at)-Date.parse(asset.received_at))/1000));
				await ensureImageDeliveryIntents(env.DB,{receiptId:receipt.webhook_event_id,batchId:asset.batch_id,assetId:asset.asset_id,message:{batchId:asset.batch_id,assetId:asset.asset_id,sourceMessageId:asset.line_message_id,messageId:asset.line_message_id,receivedAt:asset.received_at,webhookEventId:receipt.webhook_event_id},batchExpectedLastReceivedAt:asset.last_received_at,batchDelaySeconds:delay,acknowledgementText:'Image received. Processing has started; related images or details sent now will be grouped with it.',now});
				console.log({event:receipt.batch_id===asset.batch_id?'delivery_stage_resumed':'receipt_batch_repaired',receiptId:receipt.webhook_event_id,batchId:asset.batch_id,assetId:asset.asset_id,stage:'dispatch_pending',attempt:asset.processing_attempt_count,lease:null,outcome:'recovered'});
				console.log({event:'reconciliation_item_recovered',receiptId:receipt.webhook_event_id,batchId:asset.batch_id,assetId:asset.asset_id,stage:'dispatch_pending',attempt:asset.processing_attempt_count,lease:null,outcome:'recovered'});
				recovered++;continue;
			}
			const text=await env.DB.prepare(`SELECT t.batch_id,b.last_received_at,b.expires_at FROM line_message_batch_texts t JOIN line_image_batches b ON b.id=t.batch_id WHERE t.message_id=? OR t.webhook_event_id=? LIMIT 1`).bind(receipt.message_id,receipt.webhook_event_id).first<{batch_id:string;last_received_at:string;expires_at:string}>();
			if(text){const delay=Math.max(0,Math.ceil((Date.parse(text.expires_at)-Date.parse(now))/1000));await ensureBatchDeliveryIntent(env.DB,{receiptId:receipt.webhook_event_id,batchId:text.batch_id,expectedLastReceivedAt:text.last_received_at,delaySeconds:delay,now});recovered++;console.log({event:'reconciliation_item_recovered',receiptId:receipt.webhook_event_id,batchId:text.batch_id,assetId:null,stage:'dispatch_pending',attempt:0,lease:null,outcome:'recovered'});}
			else if(receipt.message_type==='text'&&receipt.conversation_id){
				const candidates=await env.DB.prepare(`SELECT id,conversation_key,last_received_at,processing_at,status FROM line_image_batches WHERE status='processing' AND processing_at IS NOT NULL AND updated_at>=? AND updated_at<=? ORDER BY updated_at DESC LIMIT 10`).bind(new Date(Date.parse(receipt.created_at)-120_000).toISOString(),new Date(Date.parse(receipt.created_at)+120_000).toISOString()).all<{id:string;conversation_key:string;last_received_at:string;processing_at:string;status:string}>();
				const matching=[] as typeof candidates.results;
				for(const candidate of candidates.results??[]){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(candidate.conversation_key));const hash=[...new Uint8Array(digest)].map((byte)=>byte.toString(16).padStart(2,'0')).join('');if(hash===receipt.conversation_id)matching.push(candidate);}
				if(matching.length===1){const batch=matching[0];await ensureBatchDeliveryIntent(env.DB,{receiptId:receipt.webhook_event_id,batchId:batch.id,expectedLastReceivedAt:batch.last_received_at,closedProcessingToken:batch.processing_at,now});recovered++;console.log({event:'receipt_batch_repaired',receiptId:receipt.webhook_event_id,batchId:batch.id,assetId:null,stage:'dispatch_pending',attempt:0,lease:batch.processing_at,outcome:'done_intent_recovered'});}
				else if(Date.parse(now)-Date.parse(receipt.created_at)>10*60_000){await env.DB.prepare(`UPDATE line_webhook_delivery_receipts SET delivery_stage='needs_reconciliation',processing_outcome='retryable_failed',reconciliation_reason=?,last_progress_at=?,updated_at=? WHERE webhook_event_id=? AND delivery_stage IN ('registered','processing','retryable_failed')`).bind(matching.length>1?'ambiguous_batch_recovery_candidates':'delivery_context_unrecoverable_without_redelivery',now,now,receipt.webhook_event_id).run();failed++;console.error({event:'reconciliation_item_failed',receiptId:receipt.webhook_event_id,batchId:null,assetId:null,stage:receipt.delivery_stage,attempt:0,lease:null,outcome:'needs_reconciliation',error:matching.length>1?'ambiguous_batch_recovery_candidates':'delivery_context_unrecoverable_without_redelivery'});}
			}
		}catch(error){failed++;console.error({event:'reconciliation_item_failed',receiptId:receipt.webhook_event_id,batchId:receipt.batch_id,assetId:null,stage:receipt.delivery_stage,attempt:0,lease:null,outcome:'retryable',error:safeError(error)});}
	}
	return{scanned:receipts.results?.length??0,recovered,failed};
}

export async function runDeliveryReconciliation(env:WorkerEnv,options:{limit?:number;now?:string}={}):Promise<void>{
	await recoverIncompleteDeliveries(env,options);
	await dispatchDeliveryOutbox(env,{limit:options.limit,now:options.now});
}
