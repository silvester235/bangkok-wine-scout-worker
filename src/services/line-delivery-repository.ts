export type LineDeliveryOutcome = 'processing'|'registered'|'completed'|'ignored'|'retryable_failed';

export interface LineDeliveryClaim {
	deliveryId:string;
	claimed:boolean;
	duplicate:boolean;
	previousOutcome:LineDeliveryOutcome|null;
	previousStage:string|null;
}

const PROCESSING_LEASE_MS=2*60*1000;

export async function hashConversationIdentity(value:string|null|undefined):Promise<string|null>{
	if(!value)return null;
	const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte)=>byte.toString(16).padStart(2,'0')).join('');
}

export function lineDeliveryId(webhookEventId:string|undefined,messageType:string,messageId:string):string{
	return webhookEventId?.trim()||`message:${messageType}:${messageId}`;
}

export async function claimLineDelivery(db:D1Database,input:{deliveryId:string;messageId:string;messageType:string;conversationId:string|null;now?:string}):Promise<LineDeliveryClaim>{
	const now=input.now??new Date().toISOString();
	const inserted=await db.prepare(`INSERT OR IGNORE INTO line_webhook_delivery_receipts
		(webhook_event_id,message_id,message_type,conversation_id,processing_outcome,processing_claimed_at,delivery_stage,last_progress_at,created_at,updated_at)
		VALUES (?,?,?,?,'processing',?,'registered',?,?,?)`).bind(input.deliveryId,input.messageId,input.messageType,input.conversationId,now,now,now,now).run();
	if((inserted.meta.changes??0)===1)return{deliveryId:input.deliveryId,claimed:true,duplicate:false,previousOutcome:null,previousStage:null};
	const existing=await db.prepare(`SELECT processing_outcome,processing_claimed_at,delivery_stage FROM line_webhook_delivery_receipts
		WHERE webhook_event_id=? OR (message_type=? AND message_id=?) LIMIT 1`).bind(input.deliveryId,input.messageType,input.messageId).first<{processing_outcome:LineDeliveryOutcome;processing_claimed_at:string;delivery_stage:string}>();
	if(!existing)return{deliveryId:input.deliveryId,claimed:false,duplicate:true,previousOutcome:null,previousStage:null};
	const staleBefore=new Date(Date.parse(now)-PROCESSING_LEASE_MS).toISOString();
	const reclaimed=await db.prepare(`UPDATE line_webhook_delivery_receipts SET processing_outcome='processing',processing_claimed_at=?,delivery_stage=CASE WHEN delivery_stage='retryable_failed' THEN 'registered' ELSE delivery_stage END,last_progress_at=?,updated_at=?
		WHERE webhook_event_id=? AND delivery_stage NOT IN ('completed','ignored','permanently_failed') AND (processing_outcome='retryable_failed' OR (processing_outcome='processing' AND processing_claimed_at<=?))`).bind(now,now,now,input.deliveryId,staleBefore).run();
	if((reclaimed.meta.changes??0)===1&&existing.processing_claimed_at<=staleBefore)console.warn({event:'receipt_lease_expired',receiptId:input.deliveryId,batchId:null,assetId:null,stage:existing.delivery_stage,attempt:0,lease:existing.processing_claimed_at,outcome:'reclaimed'});
	return{deliveryId:input.deliveryId,claimed:(reclaimed.meta.changes??0)===1,duplicate:(reclaimed.meta.changes??0)!==1,previousOutcome:existing.processing_outcome,previousStage:existing.delivery_stage};
}

export async function recordLineDeliveryOutcome(db:D1Database,deliveryId:string,outcome:LineDeliveryOutcome,batchId?:string|null):Promise<void>{
	const now=new Date().toISOString();const stage=outcome==='completed'?'completed':outcome==='ignored'?'ignored':outcome==='retryable_failed'?'retryable_failed':outcome==='registered'?'dispatch_pending':'processing';
	await db.prepare(`UPDATE line_webhook_delivery_receipts SET processing_outcome=?,delivery_stage=CASE WHEN delivery_stage IN ('completed','ignored','permanently_failed') THEN delivery_stage ELSE ? END,batch_id=COALESCE(?,batch_id),last_progress_at=?,updated_at=? WHERE webhook_event_id=?`)
		.bind(outcome,stage,batchId??null,now,now,deliveryId).run();
}

export async function claimLineAcknowledgement(db:D1Database,deliveryId:string):Promise<boolean>{
	const now=new Date().toISOString();
	const result=await db.prepare(`UPDATE line_webhook_delivery_receipts SET acknowledgement_claimed_at=?,acknowledgement_outcome='claimed',acknowledgement_updated_at=?,updated_at=?
		WHERE webhook_event_id=? AND acknowledgement_claimed_at IS NULL`).bind(now,now,now,deliveryId).run();
	return(result.meta.changes??0)===1;
}
