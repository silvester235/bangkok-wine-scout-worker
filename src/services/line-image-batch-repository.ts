export type LineImageBatchStatus = 'collecting' | 'processing' | 'completed' | 'needs_review' | 'failed';

export interface LineImageBatch {
	id: string;
	conversationKey: string;
	status: LineImageBatchStatus;
	firstReceivedAt: string;
	lastReceivedAt: string;
	createdAt: string;
	updatedAt: string;
	lastActivityAt: string;
	expiresAt: string;
	closedAt: string | null;
	processingAt: string | null;
	completedAt: string | null;
	pushTarget: string | null;
	resultingEventIds: string[];
	minimalEventId: string | null;
	shellAnchorAssetId: string | null;
	shellCreatedAt: string | null;
	pendingAssetWaitCount: number;
	firstPendingAssetWaitAt: string | null;
	lastPendingAssetWaitAt: string | null;
	pendingAssetWaitDeadlineAt: string | null;
	continuationState: string;
	continuationClaimToken: string | null;
	continuationEnqueueError: string | null;
	reconciliationRequiredAt: string | null;
}

export interface LineImageBatchAsset {
	batchId: string;
	assetId: string;
	intakeId: string;
	lineMessageId: string;
	contentType: string;
	r2ObjectKey: string;
	receivedAt: string;
	conversationKey: string;
	ordinal: number;
	sourceType?: 'line_image'|'web_image';
	status: 'pending'|'processing'|'completed'|'failed';
	error: string | null;
	processingStartedAt: string | null;
	processedAt: string | null;
	processingAttemptCount: number;
}

export interface LineMessageBatchText {
	batchId: string;
	messageId: string;
	assetId: string;
	text: string;
	receivedAt: string;
	conversationKey: string;
	ordinal: number;
}

export interface LineMessageBatchWebSource {
	batchId:string; messageId:string; webhookEventId:string; assetId:string; requestedUrl:string; normalizedUrl:string;
	finalUrl:string|null; status:'completed'|'unsupported'|'failed'; httpStatus:number|null; contentType:string|null;
	responseBytes:number|null; redirectCount:number; title:string|null; description:string|null; canonicalUrl:string|null;
	mainImageUrl:string|null; openGraph:Record<string,string>; jsonLd:unknown[]; extractedText:string|null;
	originalReadableTextChars:number; extractedTextLength:number; textReduced:boolean; errorCode:string|null; errorMessage:string|null;
	fetchedAt:string; receivedAt:string; conversationKey:string; ordinal:number;
}

interface BatchRow {
	id: string; conversation_key: string; status: LineImageBatchStatus; first_received_at: string;
	last_received_at: string; processing_at: string | null; completed_at: string | null;
	push_target: string | null; resulting_event_ids_json: string;
	minimal_event_id: string | null; shell_anchor_asset_id: string | null; shell_created_at: string | null;
	created_at: string; updated_at: string; last_activity_at: string; expires_at: string; closed_at: string | null;
	pending_asset_wait_count: number; first_pending_asset_wait_at: string | null; last_pending_asset_wait_at: string | null;
	pending_asset_wait_deadline_at: string | null; continuation_state: string; continuation_claim_token: string | null;
	continuation_enqueue_error: string | null; reconciliation_required_at: string | null;
}
interface AssetRow {
	batch_id: string; asset_id: string; intake_id: string; line_message_id: string;
	content_type: string; r2_object_key: string; received_at: string; conversation_key: string; ordinal: number;
	source_type: 'line_image'|'web_image';
	status: 'pending'|'processing'|'completed'|'failed'; error: string|null;
	processing_started_at: string|null; processed_at: string|null;
	processing_attempt_count: number;
}
interface TextRow { batch_id:string; message_id:string; asset_id:string; text_content:string; received_at:string; conversation_key:string; ordinal:number }
interface WebRow { batch_id:string;message_id:string;webhook_event_id:string;asset_id:string;requested_url:string;normalized_url:string;final_url:string|null;status:'completed'|'unsupported'|'failed';http_status:number|null;content_type:string|null;response_bytes:number|null;redirect_count:number;title:string|null;description:string|null;canonical_url:string|null;main_image_url:string|null;open_graph_json:string;json_ld_json:string;extracted_text:string|null;original_readable_text_chars:number;extracted_text_length:number;text_reduced:number;error_code:string|null;error_message:string|null;fetched_at:string;received_at:string;conversation_key:string;ordinal:number }

function mapBatch(row: BatchRow): LineImageBatch {
	let ids: string[] = [];
	try { ids = JSON.parse(row.resulting_event_ids_json) as string[]; } catch { /* diagnostics only */ }
	return { id: row.id, conversationKey: row.conversation_key, status: row.status,
		firstReceivedAt: row.first_received_at, lastReceivedAt: row.last_received_at,
		createdAt: row.created_at, updatedAt: row.updated_at, lastActivityAt: row.last_activity_at, expiresAt: row.expires_at, closedAt: row.closed_at,
		processingAt: row.processing_at, completedAt: row.completed_at, pushTarget: row.push_target,
		resultingEventIds: ids, minimalEventId:row.minimal_event_id, shellAnchorAssetId:row.shell_anchor_asset_id,
		shellCreatedAt:row.shell_created_at, pendingAssetWaitCount:row.pending_asset_wait_count??0,
		firstPendingAssetWaitAt:row.first_pending_asset_wait_at??null,lastPendingAssetWaitAt:row.last_pending_asset_wait_at??null,
		pendingAssetWaitDeadlineAt:row.pending_asset_wait_deadline_at??null,continuationState:row.continuation_state??'idle',
		continuationClaimToken:row.continuation_claim_token??null,continuationEnqueueError:row.continuation_enqueue_error??null,
		reconciliationRequiredAt:row.reconciliation_required_at??null };
}

const expiresAt = (at: string, batchWindowSeconds: number) => new Date(Date.parse(at) + batchWindowSeconds * 1000).toISOString();

export interface BatchRegistrationResult {
	batch: LineImageBatch;
	duplicate: boolean;
	expiredBatchId?: string;
	action?: 'create'|'append';
	assetCountAfterAppend?: number;
	newBatchReason?: string;
}

export interface UrlIngestionDelivery { webhookEventId:string; messageId:string; normalizedUrl:string; batchId:string|null; status:'completed'|'unsupported'|'failed'; errorCode:string|null }

export async function findUrlIngestionDelivery(db:D1Database,webhookEventId:string):Promise<UrlIngestionDelivery|null>{const row=await db.prepare(`SELECT webhook_event_id,message_id,normalized_url,batch_id,status,error_code FROM line_url_ingestion_deliveries WHERE webhook_event_id=?`).bind(webhookEventId).first<{webhook_event_id:string;message_id:string;normalized_url:string;batch_id:string|null;status:'completed'|'unsupported'|'failed';error_code:string|null}>();return row?{webhookEventId:row.webhook_event_id,messageId:row.message_id,normalizedUrl:row.normalized_url,batchId:row.batch_id,status:row.status,errorCode:row.error_code}:null;}

export async function recordUrlIngestionDelivery(db:D1Database,input:UrlIngestionDelivery&{receivedAt:string}):Promise<void>{await db.prepare(`INSERT OR IGNORE INTO line_url_ingestion_deliveries (webhook_event_id,message_id,normalized_url,batch_id,status,error_code,received_at,created_at) VALUES (?,?,?,?,?,?,?,?)`).bind(input.webhookEventId,input.messageId,input.normalizedUrl,input.batchId,input.status,input.errorCode,input.receivedAt,new Date().toISOString()).run();}

export async function findPriorWebSourceOutcome(db:D1Database,normalizedUrl:string):Promise<'successful'|'failed'|null>{const row=await db.prepare(`SELECT status,title,description,extracted_text,json_ld_json FROM line_message_batch_web_sources WHERE normalized_url=? ORDER BY fetched_at DESC LIMIT 1`).bind(normalizedUrl).first<{status:string;title:string|null;description:string|null;extracted_text:string|null;json_ld_json:string}>();if(!row)return null;return row.status==='completed'&&(row.title||row.description||row.extracted_text||row.json_ld_json!=='[]')?'successful':'failed';}

export async function finalizeUselessWebBatch(db:D1Database,batchId:string):Promise<boolean>{const now=new Date().toISOString();const result=await db.prepare(`UPDATE line_image_batches SET status='needs_review',closed_at=?,completed_at=?,updated_at=?,error='web ingestion produced no useful content' WHERE id=? AND status='collecting' AND NOT EXISTS (SELECT 1 FROM line_image_batch_assets WHERE batch_id=?) AND NOT EXISTS (SELECT 1 FROM line_message_batch_texts WHERE batch_id=?) AND NOT EXISTS (SELECT 1 FROM line_message_batch_web_sources WHERE batch_id=? AND status='completed' AND (title IS NOT NULL OR description IS NOT NULL OR extracted_text IS NOT NULL OR json_ld_json<>'[]'))`).bind(now,now,now,batchId,batchId,batchId,batchId).run();return(result.meta.changes??0)===1;}

export type DoneClaimResult =
	| { outcome:'claimed'; batch:LineImageBatch; previousStatus:'collecting'; claimReason:'done'|'expired' }
	| { outcome:'already_processing'; batch:LineImageBatch }
	| { outcome:'already_completed'; batch:LineImageBatch }
	| { outcome:'not_found' };

async function expireActiveBatch(db:D1Database,conversationKey:string,now:string):Promise<string|undefined>{
	const result=await db.prepare(`UPDATE line_image_batches SET status='processing',processing_at=?,closed_at=?,updated_at=?,attempt_count=attempt_count+1 WHERE id=(SELECT id FROM line_image_batches WHERE conversation_key=? AND status='collecting' AND expires_at<=? LIMIT 1) AND status='collecting' AND expires_at<=? RETURNING id`).bind(now,now,now,conversationKey,now,now).first<{id:string}>();
	return result?.id;
}

export async function expireActiveBatchForIncoming(db:D1Database,conversationKey:string,now:string):Promise<LineImageBatch|null>{
	const id=await expireActiveBatch(db,conversationKey,now); return id?getBatch(db,id):null;
}

export async function registerBatchAsset(db: D1Database, input: Omit<LineImageBatchAsset, 'batchId'|'ordinal'|'status'|'error'|'processingStartedAt'|'processedAt'|'processingAttemptCount'> & { pushTarget?: string; webhookEventId?: string }, batchWindowSeconds = 60): Promise<BatchRegistrationResult> {
	const duplicate = await db.prepare(`SELECT b.* FROM line_image_batch_assets a JOIN line_image_batches b ON b.id=a.batch_id WHERE a.line_message_id=? OR a.webhook_event_id=? LIMIT 1`)
		.bind(input.lineMessageId,input.webhookEventId??input.lineMessageId).first<BatchRow>();
	if (duplicate) return { batch: mapBatch(duplicate), duplicate: true };

	const expiredBatchId=await expireActiveBatch(db,input.conversationKey,input.receivedAt);
	for (let attempt = 0; attempt < 3; attempt++) {
		let batch = await db.prepare(`SELECT * FROM line_image_batches WHERE conversation_key=? AND status='collecting' AND expires_at>? LIMIT 1`)
			.bind(input.conversationKey,input.receivedAt).first<BatchRow>();
		let action: 'create'|'append' = 'append';
		let newBatchReason: string|undefined;
		if (!batch) {
			action='create';
			newBatchReason=expiredBatchId?'active_collecting_batch_expired':'no_nonexpired_collecting_batch_found';
			const id = crypto.randomUUID();
			const created=await db.prepare(`INSERT OR IGNORE INTO line_image_batches (id,conversation_key,status,first_received_at,last_received_at,created_at,last_activity_at,expires_at,updated_at,push_target) VALUES (?,?,'collecting',?,?,?,?,?,?,?)`)
				.bind(id,input.conversationKey,input.receivedAt,input.receivedAt,input.receivedAt,input.receivedAt,expiresAt(input.receivedAt,batchWindowSeconds),input.receivedAt,input.pushTarget??null).run();
			if((created.meta.changes??0)>0)console.log({event:'line_batch_new_batch_reason',webhookEventId:input.webhookEventId??input.lineMessageId,messageId:input.lineMessageId,conversationKey:input.conversationKey,batchId:id,attempt,reason:newBatchReason,expiredBatchId:expiredBatchId??null,receivedAt:input.receivedAt});
			else{action='append';newBatchReason=undefined;console.log({event:'line_batch_append_retry',webhookEventId:input.webhookEventId??input.lineMessageId,messageId:input.lineMessageId,conversationKey:input.conversationKey,attempt,reason:'concurrent_request_created_collecting_batch'});}
			batch = await db.prepare(`SELECT * FROM line_image_batches WHERE conversation_key=? AND status='collecting' AND expires_at>? LIMIT 1`).bind(input.conversationKey,input.receivedAt).first<BatchRow>();
		}
		if (!batch) continue;
		const ordinal = await db.prepare(`SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM line_image_batch_assets WHERE batch_id=?`).bind(batch.id).first<{ ordinal: number }>();
		const results = await db.batch([
			db.prepare(`UPDATE line_image_batches SET last_received_at=?,last_activity_at=?,expires_at=?,updated_at=?,push_target=COALESCE(push_target,?) WHERE id=? AND status='collecting' AND expires_at>?`)
				.bind(input.receivedAt,input.receivedAt,expiresAt(input.receivedAt,batchWindowSeconds),input.receivedAt,input.pushTarget??null,batch.id,input.receivedAt),
			db.prepare(`INSERT OR IGNORE INTO line_image_batch_assets (batch_id,asset_id,intake_id,line_message_id,webhook_event_id,source_type,source_reference,content_type,r2_object_key,received_at,conversation_key,ordinal,status) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'pending' WHERE EXISTS (SELECT 1 FROM line_image_batches WHERE id=? AND status='collecting' AND expires_at>?)`)
				.bind(batch.id,input.assetId,input.intakeId,input.lineMessageId,input.webhookEventId??input.lineMessageId,input.sourceType??'line_image',input.lineMessageId,input.contentType,input.r2ObjectKey,input.receivedAt,input.conversationKey,ordinal?.ordinal??1,batch.id,input.receivedAt),
		]);
		if ((results[1].meta.changes ?? 0) > 0) {
			const updated = await getBatch(db, batch.id);
			if (!updated) throw new Error('Registered LINE batch disappeared.');
			const count=await db.prepare('SELECT COUNT(*) AS count FROM line_image_batch_assets WHERE batch_id=?').bind(batch.id).first<{count:number}>();
			return { batch: updated, duplicate: false, expiredBatchId, action, assetCountAfterAppend:count?.count??0, newBatchReason };
		}
		console.log({event:'line_batch_append_failed',webhookEventId:input.webhookEventId??input.lineMessageId,messageId:input.lineMessageId,conversationKey:input.conversationKey,batchId:batch.id,attempt,reason:'batch_not_collecting_or_expired_before_atomic_insert',batchStatusAtLookup:batch.status,batchExpiresAtAtLookup:batch.expires_at,receivedAt:input.receivedAt});
		const existing = await db.prepare(`SELECT b.* FROM line_image_batch_assets a JOIN line_image_batches b ON b.id=a.batch_id WHERE a.line_message_id=? OR a.webhook_event_id=? LIMIT 1`)
			.bind(input.lineMessageId,input.webhookEventId??input.lineMessageId).first<BatchRow>();
		if (existing) return { batch: mapBatch(existing), duplicate: true };
	}
	throw new Error('Could not register LINE image in a collecting batch.');
}

export async function registerBatchText(db:D1Database,input:Omit<LineMessageBatchText,'batchId'|'assetId'|'ordinal'> & {pushTarget?:string;webhookEventId?:string},batchWindowSeconds=60):Promise<BatchRegistrationResult>{
	const duplicate=await db.prepare(`SELECT b.* FROM line_message_batch_texts t JOIN line_image_batches b ON b.id=t.batch_id WHERE t.message_id=? OR t.webhook_event_id=? LIMIT 1`).bind(input.messageId,input.webhookEventId??input.messageId).first<BatchRow>();
	if(duplicate)return{batch:mapBatch(duplicate),duplicate:true};
	const expiredBatchId=await expireActiveBatch(db,input.conversationKey,input.receivedAt);
	for(let attempt=0;attempt<3;attempt++){
		let batch=await db.prepare(`SELECT * FROM line_image_batches WHERE conversation_key=? AND status='collecting' AND expires_at>? LIMIT 1`).bind(input.conversationKey,input.receivedAt).first<BatchRow>();
		if(!batch){const id=crypto.randomUUID();await db.prepare(`INSERT OR IGNORE INTO line_image_batches (id,conversation_key,status,first_received_at,last_received_at,created_at,last_activity_at,expires_at,updated_at,push_target) VALUES (?,?,'collecting',?,?,?,?,?,?,?)`).bind(id,input.conversationKey,input.receivedAt,input.receivedAt,input.receivedAt,input.receivedAt,expiresAt(input.receivedAt,batchWindowSeconds),input.receivedAt,input.pushTarget??null).run();batch=await db.prepare(`SELECT * FROM line_image_batches WHERE conversation_key=? AND status='collecting' AND expires_at>? LIMIT 1`).bind(input.conversationKey,input.receivedAt).first<BatchRow>();}
		if(!batch)continue;
		const ordinal=await db.prepare(`SELECT (SELECT COUNT(*) FROM line_image_batch_assets WHERE batch_id=?1)+(SELECT COUNT(*) FROM line_message_batch_texts WHERE batch_id=?1)+1 AS ordinal`).bind(batch.id).first<{ordinal:number}>();
		const results=await db.batch([
			db.prepare(`UPDATE line_image_batches SET last_received_at=?,last_activity_at=?,expires_at=?,updated_at=?,push_target=COALESCE(push_target,?) WHERE id=? AND status='collecting' AND expires_at>?`).bind(input.receivedAt,input.receivedAt,expiresAt(input.receivedAt,batchWindowSeconds),input.receivedAt,input.pushTarget??null,batch.id,input.receivedAt),
			db.prepare(`INSERT OR IGNORE INTO line_message_batch_texts (batch_id,message_id,webhook_event_id,asset_id,text_content,received_at,conversation_key,ordinal) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM line_image_batches WHERE id=? AND status='collecting' AND expires_at>?)`).bind(batch.id,input.messageId,input.webhookEventId??input.messageId,`line-text-${input.messageId}`,input.text,input.receivedAt,input.conversationKey,ordinal?.ordinal??1,batch.id,input.receivedAt),
		]);
		if((results[1].meta.changes??0)>0){const updated=await getBatch(db,batch.id);if(!updated)throw new Error('Registered LINE message batch disappeared.');return{batch:updated,duplicate:false,expiredBatchId};}
		const existing=await db.prepare(`SELECT b.* FROM line_message_batch_texts t JOIN line_image_batches b ON b.id=t.batch_id WHERE t.message_id=? OR t.webhook_event_id=? LIMIT 1`).bind(input.messageId,input.webhookEventId??input.messageId).first<BatchRow>();if(existing)return{batch:mapBatch(existing),duplicate:true};
	}
	throw new Error('Could not register LINE text in a collecting batch.');
}

export async function registerBatchWebSource(db:D1Database,input:Omit<LineMessageBatchWebSource,'batchId'|'assetId'|'ordinal'|'webhookEventId'> & {pushTarget?:string;webhookEventId?:string},batchWindowSeconds=60):Promise<BatchRegistrationResult>{
	const deliveryId=input.webhookEventId??input.messageId;
	const duplicate=await db.prepare(`SELECT b.* FROM line_message_batch_web_sources w JOIN line_image_batches b ON b.id=w.batch_id WHERE w.webhook_event_id=? LIMIT 1`).bind(deliveryId).first<BatchRow>();
	if(duplicate)return{batch:mapBatch(duplicate),duplicate:true};
	const expiredBatchId=await expireActiveBatch(db,input.conversationKey,input.receivedAt);
	for(let attempt=0;attempt<3;attempt++){
		let batch=await db.prepare(`SELECT * FROM line_image_batches WHERE conversation_key=? AND status='collecting' AND expires_at>? LIMIT 1`).bind(input.conversationKey,input.receivedAt).first<BatchRow>();
		if(!batch){const id=crypto.randomUUID();await db.prepare(`INSERT OR IGNORE INTO line_image_batches (id,conversation_key,status,first_received_at,last_received_at,created_at,last_activity_at,expires_at,updated_at,push_target) VALUES (?,?,'collecting',?,?,?,?,?,?,?)`).bind(id,input.conversationKey,input.receivedAt,input.receivedAt,input.receivedAt,input.receivedAt,expiresAt(input.receivedAt,batchWindowSeconds),input.receivedAt,input.pushTarget??null).run();batch=await db.prepare(`SELECT * FROM line_image_batches WHERE conversation_key=? AND status='collecting' AND expires_at>? LIMIT 1`).bind(input.conversationKey,input.receivedAt).first<BatchRow>();}
		if(!batch)continue;
		const sameUrl=await db.prepare(`SELECT status,extracted_text,title,description,json_ld_json FROM line_message_batch_web_sources WHERE batch_id=? AND normalized_url=? LIMIT 1`).bind(batch.id,input.normalizedUrl).first<{status:string;extracted_text:string|null;title:string|null;description:string|null;json_ld_json:string}>();
		if(sameUrl){
			if(sameUrl.status==='completed'&&(sameUrl.extracted_text||sameUrl.title||sameUrl.description||sameUrl.json_ld_json!=='[]'))return{batch:mapBatch(batch),duplicate:true,expiredBatchId};
			const replaced=await db.prepare(`UPDATE line_message_batch_web_sources SET status=?,http_status=?,content_type=?,response_bytes=?,redirect_count=?,title=?,description=?,canonical_url=?,main_image_url=?,open_graph_json=?,json_ld_json=?,extracted_text=?,original_readable_text_chars=?,extracted_text_length=?,text_reduced=?,error_code=?,error_message=?,fetched_at=?,received_at=? WHERE batch_id=? AND normalized_url=? AND status<>'completed'`).bind(input.status,input.httpStatus,input.contentType,input.responseBytes,input.redirectCount,input.title,input.description,input.canonicalUrl,input.mainImageUrl,JSON.stringify(input.openGraph),JSON.stringify(input.jsonLd),input.extractedText,input.originalReadableTextChars,input.extractedTextLength,input.textReduced?1:0,input.errorCode,input.errorMessage,input.fetchedAt,input.receivedAt,batch.id,input.normalizedUrl).run();
			if((replaced.meta.changes??0)>0){await db.prepare(`UPDATE line_image_batches SET last_received_at=?,last_activity_at=?,expires_at=?,updated_at=? WHERE id=? AND status='collecting'`).bind(input.receivedAt,input.receivedAt,expiresAt(input.receivedAt,batchWindowSeconds),input.receivedAt,batch.id).run();return{batch:(await getBatch(db,batch.id))!,duplicate:false,expiredBatchId};}
		}
		const ordinal=await db.prepare(`SELECT (SELECT COUNT(*) FROM line_image_batch_assets WHERE batch_id=?1)+(SELECT COUNT(*) FROM line_message_batch_texts WHERE batch_id=?1)+(SELECT COUNT(*) FROM line_message_batch_web_sources WHERE batch_id=?1)+1 AS ordinal`).bind(batch.id).first<{ordinal:number}>();
		const assetId=`line-web-${input.messageId}`;
		const results=await db.batch([
			db.prepare(`UPDATE line_image_batches SET last_received_at=?,last_activity_at=?,expires_at=?,updated_at=?,push_target=COALESCE(push_target,?) WHERE id=? AND status='collecting' AND expires_at>?`).bind(input.receivedAt,input.receivedAt,expiresAt(input.receivedAt,batchWindowSeconds),input.receivedAt,input.pushTarget??null,batch.id,input.receivedAt),
			db.prepare(`INSERT OR IGNORE INTO line_message_batch_web_sources (batch_id,message_id,webhook_event_id,asset_id,requested_url,normalized_url,final_url,status,http_status,content_type,response_bytes,redirect_count,title,description,canonical_url,main_image_url,open_graph_json,json_ld_json,extracted_text,original_readable_text_chars,extracted_text_length,text_reduced,error_code,error_message,fetched_at,received_at,conversation_key,ordinal) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM line_image_batches WHERE id=? AND status='collecting' AND expires_at>?)`).bind(batch.id,input.messageId,deliveryId,assetId,input.requestedUrl,input.normalizedUrl,input.finalUrl,input.status,input.httpStatus,input.contentType,input.responseBytes,input.redirectCount,input.title,input.description,input.canonicalUrl,input.mainImageUrl,JSON.stringify(input.openGraph),JSON.stringify(input.jsonLd),input.extractedText,input.originalReadableTextChars,input.extractedTextLength,input.textReduced?1:0,input.errorCode,input.errorMessage,input.fetchedAt,input.receivedAt,input.conversationKey,ordinal?.ordinal??1,batch.id,input.receivedAt),
		]);
		if((results[1].meta.changes??0)>0){const updated=await getBatch(db,batch.id);if(!updated)throw new Error('Registered LINE web source batch disappeared.');return{batch:updated,duplicate:false,expiredBatchId};}
		const existing=await db.prepare(`SELECT b.* FROM line_message_batch_web_sources w JOIN line_image_batches b ON b.id=w.batch_id WHERE w.webhook_event_id=? LIMIT 1`).bind(deliveryId).first<BatchRow>();if(existing)return{batch:mapBatch(existing),duplicate:true};
	}
	throw new Error('Could not register LINE web source in a collecting batch.');
}

export async function getBatch(db: D1Database, id: string): Promise<LineImageBatch | null> {
	const row = await db.prepare('SELECT * FROM line_image_batches WHERE id=?').bind(id).first<BatchRow>();
	return row ? mapBatch(row) : null;
}

export async function listBatchAssets(db: D1Database, batchId: string): Promise<LineImageBatchAsset[]> {
	const rows = await db.prepare('SELECT * FROM line_image_batch_assets WHERE batch_id=? ORDER BY ordinal,received_at,asset_id').bind(batchId).all<AssetRow>();
	return (rows.results ?? []).map((r) => ({ batchId:r.batch_id,assetId:r.asset_id,intakeId:r.intake_id,lineMessageId:r.line_message_id,contentType:r.content_type,r2ObjectKey:r.r2_object_key,receivedAt:r.received_at,conversationKey:r.conversation_key,ordinal:r.ordinal,sourceType:r.source_type,status:r.status,error:r.error,processingStartedAt:r.processing_started_at,processedAt:r.processed_at,processingAttemptCount:r.processing_attempt_count }));
}

export async function claimBatchAssetProcessing(db:D1Database,batchId:string,assetId:string):Promise<'claimed'|'claimed_terminal'|'completed'|'attempt_limit'|'failed'|'busy'|'missing'>{
	const now=new Date().toISOString();
	const staleBefore=new Date(Date.parse(now)-2*60*1000).toISOString();
	const result=await db.prepare(`UPDATE line_image_batch_assets SET status='processing',processing_started_at=?,processed_at=NULL,error=NULL,processing_attempt_count=processing_attempt_count+1 WHERE batch_id=? AND asset_id=? AND processing_attempt_count<4 AND (status IN ('pending','failed') OR (status='processing' AND processing_started_at<=?))`).bind(now,batchId,assetId,staleBefore).run();
	if((result.meta.changes??0)===1){const batch=await db.prepare(`SELECT status FROM line_image_batches WHERE id=?`).bind(batchId).first<{status:LineImageBatchStatus}>();return batch&&['needs_review','failed','completed'].includes(batch.status)?'claimed_terminal':'claimed';}
	const row=await db.prepare(`SELECT status,processing_attempt_count FROM line_image_batch_assets WHERE batch_id=? AND asset_id=?`).bind(batchId,assetId).first<{status:'pending'|'processing'|'completed'|'failed';processing_attempt_count:number}>();
	if(row&&row.processing_attempt_count>=4&&row.status!=='completed')return'attempt_limit';
	return row?.status==='processing'||row?.status==='pending'?'busy':row?.status??'missing';
}

export interface BatchEventShellClaim { eventId:string; anchorAssetId:string; isAnchor:boolean; shellCreatedAt:string|null }

/** The batch row is the single source of truth for the publication shell identity. */
export async function claimBatchEventShell(db:D1Database,batchId:string,assetId:string):Promise<BatchEventShellClaim|null>{
	let legacy:{event_id:string;asset_id:string}|null=null;
	try{legacy=await db.prepare(`SELECT ea.event_id,ba.asset_id FROM line_image_batch_assets ba JOIN event_assets ea ON ea.asset_id=ba.asset_id WHERE ba.batch_id=? ORDER BY CASE WHEN ba.asset_id=? THEN 0 ELSE 1 END,ba.ordinal LIMIT 1`)
		.bind(batchId,assetId).first<{event_id:string;asset_id:string}>();}catch{/* Pre-event fixtures have no legacy shell table. */}
	const eventId=legacy?.event_id??`line-batch:${batchId}`;
	const anchorAssetId=legacy?.asset_id??assetId;
	await db.prepare(`UPDATE line_image_batches SET minimal_event_id=COALESCE(minimal_event_id,?),shell_anchor_asset_id=COALESCE(shell_anchor_asset_id,?),updated_at=? WHERE id=? AND status IN ('collecting','processing')`)
		.bind(eventId,anchorAssetId,new Date().toISOString(),batchId).run();
	const row=await db.prepare(`SELECT status,minimal_event_id,shell_anchor_asset_id,shell_created_at FROM line_image_batches WHERE id=?`).bind(batchId).first<{status:LineImageBatchStatus;minimal_event_id:string|null;shell_anchor_asset_id:string|null;shell_created_at:string|null}>();
	if(!row)throw new Error(`Batch ${batchId} was not found while claiming its event shell.`);
	if(!['collecting','processing'].includes(row.status))return null;
	if(!row.minimal_event_id||!row.shell_anchor_asset_id)throw new Error(`Batch ${batchId} did not retain its event shell claim.`);
	return{eventId:row.minimal_event_id,anchorAssetId:row.shell_anchor_asset_id,isAnchor:row.shell_anchor_asset_id===assetId,shellCreatedAt:row.shell_created_at};
}

export async function markBatchEventShellCreated(db:D1Database,batchId:string,eventId:string):Promise<boolean>{
	const result=await db.prepare(`UPDATE line_image_batches SET shell_created_at=COALESCE(shell_created_at,?),updated_at=? WHERE id=? AND minimal_event_id=?`).bind(new Date().toISOString(),new Date().toISOString(),batchId,eventId).run();
	return(result.meta.changes??0)===1;
}

export async function completeBatchAssetProcessing(db:D1Database,batchId:string,assetId:string,input:{intakeId:string;contentType:string;r2ObjectKey:string}):Promise<boolean>{
	const now=new Date().toISOString();const result=await db.prepare(`UPDATE line_image_batch_assets SET status='completed',intake_id=?,content_type=?,r2_object_key=?,processed_at=?,error=NULL WHERE batch_id=? AND asset_id=? AND status IN ('processing','failed')`).bind(input.intakeId,input.contentType,input.r2ObjectKey,now,batchId,assetId).run();return(result.meta.changes??0)===1;
}

export async function failBatchAssetProcessing(db:D1Database,batchId:string,assetId:string,error:unknown):Promise<boolean>{
	const now=new Date().toISOString();const reason=error instanceof Error?error.message:String(error);const result=await db.prepare(`UPDATE line_image_batch_assets SET status='failed',processed_at=?,error=? WHERE batch_id=? AND asset_id=? AND status IN ('pending','processing')`).bind(now,reason,batchId,assetId).run();return(result.meta.changes??0)===1;
}

export async function getBatchAssetCounts(db:D1Database,batchId:string):Promise<{assetCount:number;pendingAssetCount:number;failedAssetCount:number}>{const row=await db.prepare(`SELECT COUNT(*) asset_count,SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) pending_count,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed_count FROM line_image_batch_assets WHERE batch_id=?`).bind(batchId).first<{asset_count:number;pending_count:number|null;failed_count:number|null}>();return{assetCount:row?.asset_count??0,pendingAssetCount:row?.pending_count??0,failedAssetCount:row?.failed_count??0};}

export const MAX_PENDING_ASSET_CONTINUATIONS=3;
export const PENDING_ASSET_CONTINUATION_DELAYS_SECONDS=[10,20,40] as const;
export const PENDING_ASSET_WAIT_DEADLINE_MS=10*60*1000;

export type PendingAssetContinuationOutcome='schedule'|'already_claimed'|'asset_ready'|'limit_reached'|'deadline_reached'|'batch_terminal'|'invalid_state';
export interface PendingAssetContinuationClaim {
	outcome:PendingAssetContinuationOutcome;
	count:number;
	maximumCount:number;
	firstWaitAt:string|null;
	deadlineAt:string|null;
	nextDelaySeconds:number|null;
	continuationToken:string|null;
	resultingState:string;
	assetCount:number;
	pendingAssetCount:number;
	invalidTimestampFields:string[];
}

interface PendingContinuationRow extends BatchRow { asset_count:number;pending_count:number;earliest_pending_received_at:string|null }

function timestampMs(value:string|null|undefined):number|null{if(!value)return null;const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;}
function timestampIso(value:number):string{return new Date(value).toISOString();}

async function readPendingContinuationRow(db:D1Database,batchId:string):Promise<PendingContinuationRow|null>{
	return db.prepare(`SELECT b.*,(SELECT COUNT(*) FROM line_image_batch_assets a WHERE a.batch_id=b.id) asset_count,(SELECT COUNT(*) FROM line_image_batch_assets a WHERE a.batch_id=b.id AND a.status IN ('pending','processing')) pending_count,(SELECT MIN(received_at) FROM line_image_batch_assets a WHERE a.batch_id=b.id AND a.status IN ('pending','processing')) earliest_pending_received_at FROM line_image_batches b WHERE b.id=?`).bind(batchId).first<PendingContinuationRow>();
}

async function updateEnrichmentForReconciliation(db:D1Database,batchId:string,reason:string,now:string):Promise<void>{
	try{await db.prepare(`UPDATE event_enrichment_state SET status='retryable',extraction_status='failed',last_error_code=?,next_retry_at=NULL,updated_at=? WHERE asset_id IN (SELECT asset_id FROM line_image_batch_assets WHERE batch_id=?)`).bind(reason,now,batchId).run();}catch{/* Migration fixtures may not include enrichment state. */}
}

async function markUnresolvedAssetsForReconciliation(db:D1Database,batchId:string,reason:string,now:string):Promise<void>{
	await db.prepare(`UPDATE line_image_batch_assets SET status='failed',error=?,processed_at=COALESCE(processed_at,?) WHERE batch_id=? AND status='pending'`).bind(reason,now,batchId).run();
	await updateEnrichmentForReconciliation(db,batchId,reason,now);
}

export async function markBatchForReconciliation(db:D1Database,batchId:string,currentToken:string|null,reason:string,continuationState:string,now=new Date().toISOString()):Promise<boolean>{
	const tokenClause=currentToken===null?'processing_at IS NULL':'processing_at=?';
	const statement=db.prepare(`UPDATE line_image_batches SET status='needs_review',completed_at=COALESCE(completed_at,?),updated_at=?,error=?,continuation_state=?,continuation_claim_token=NULL,reconciliation_required_at=COALESCE(reconciliation_required_at,?),processing_at=NULL WHERE id=? AND status='processing' AND ${tokenClause}`);
	const result=currentToken===null?await statement.bind(now,now,reason,continuationState,now,batchId).run():await statement.bind(now,now,reason,continuationState,now,batchId,currentToken).run();
	if((result.meta.changes??0)!==1)return false;
	await markUnresolvedAssetsForReconciliation(db,batchId,reason,now);
	return true;
}

export async function claimPendingAssetContinuation(db:D1Database,batchId:string,currentToken:string,now=new Date().toISOString()):Promise<PendingAssetContinuationClaim>{
	const row=await readPendingContinuationRow(db,batchId);
	const base=(outcome:PendingAssetContinuationOutcome,overrides:Partial<PendingAssetContinuationClaim>={}):PendingAssetContinuationClaim=>({outcome,count:row?.pending_asset_wait_count??0,maximumCount:MAX_PENDING_ASSET_CONTINUATIONS,firstWaitAt:row?.first_pending_asset_wait_at??null,deadlineAt:row?.pending_asset_wait_deadline_at??null,nextDelaySeconds:null,continuationToken:null,resultingState:row?.continuation_state??'missing',assetCount:row?.asset_count??0,pendingAssetCount:row?.pending_count??0,invalidTimestampFields:[],...overrides});
	if(!row)return base('invalid_state');
	if(['completed','needs_review','failed'].includes(row.status))return base('batch_terminal');
	if(row.status!=='processing')return base('invalid_state');
	if(row.processing_at!==currentToken)return base('already_claimed');
	if(row.asset_count===0){await markBatchForReconciliation(db,batchId,currentToken,'batch has no image assets and requires reconciliation','no_assets',now);return base('invalid_state',{resultingState:'no_assets'});}
	if(row.pending_count===0){await db.prepare(`UPDATE line_image_batches SET continuation_state='asset_ready',continuation_claim_token=NULL,updated_at=? WHERE id=? AND status='processing' AND processing_at=?`).bind(now,batchId,currentToken).run();return base('asset_ready',{resultingState:'asset_ready'});}
	const nowMs=timestampMs(now)??Date.now();
	const invalidTimestampFields:string[]=[];
	const storedFirstMs=timestampMs(row.first_pending_asset_wait_at);if(row.first_pending_asset_wait_at&&!storedFirstMs)invalidTimestampFields.push('first_pending_asset_wait_at');
	const storedDeadlineMs=timestampMs(row.pending_asset_wait_deadline_at);if(row.pending_asset_wait_deadline_at&&!storedDeadlineMs)invalidTimestampFields.push('pending_asset_wait_deadline_at');
	const receiptMs=timestampMs(row.earliest_pending_received_at);if(row.earliest_pending_received_at&&!receiptMs)invalidTimestampFields.push('asset_received_at');
	if(!timestampMs(row.last_received_at))invalidTimestampFields.push('last_received_at');
	const firstWaitAt=storedFirstMs?timestampIso(storedFirstMs):timestampIso(nowMs);
	const deadlineBase=storedFirstMs??(receiptMs!==null?Math.min(receiptMs,nowMs):nowMs);
	const deadlineAt=timestampIso(storedDeadlineMs??deadlineBase+PENDING_ASSET_WAIT_DEADLINE_MS);
	if((storedDeadlineMs??deadlineBase+PENDING_ASSET_WAIT_DEADLINE_MS)<=nowMs){const changed=await markBatchForReconciliation(db,batchId,currentToken,'pending asset wait deadline reached','deadline_reached',timestampIso(nowMs));return base(changed?'deadline_reached':'already_claimed',{firstWaitAt,deadlineAt,resultingState:changed?'deadline_reached':row.continuation_state,invalidTimestampFields});}
	if(row.pending_asset_wait_count>=MAX_PENDING_ASSET_CONTINUATIONS){const changed=await markBatchForReconciliation(db,batchId,currentToken,'pending asset continuation limit reached','limit_reached',timestampIso(nowMs));return base(changed?'limit_reached':'already_claimed',{firstWaitAt,deadlineAt,resultingState:changed?'limit_reached':row.continuation_state,invalidTimestampFields});}
	const nextCount=row.pending_asset_wait_count+1;const nextDelaySeconds=PENDING_ASSET_CONTINUATION_DELAYS_SECONDS[nextCount-1];const token=`pending:${nextCount}:${crypto.randomUUID()}`;
	const updated=await db.prepare(`UPDATE line_image_batches SET pending_asset_wait_count=pending_asset_wait_count+1,first_pending_asset_wait_at=COALESCE(first_pending_asset_wait_at,?),last_pending_asset_wait_at=?,pending_asset_wait_deadline_at=?,continuation_state='scheduled',continuation_claim_token=?,continuation_enqueue_error=NULL,processing_at=?,updated_at=? WHERE id=? AND status='processing' AND processing_at=? AND pending_asset_wait_count=? AND EXISTS (SELECT 1 FROM line_image_batch_assets WHERE batch_id=? AND status IN ('pending','processing')) RETURNING pending_asset_wait_count`).bind(firstWaitAt,timestampIso(nowMs),deadlineAt,token,token,timestampIso(nowMs),batchId,currentToken,row.pending_asset_wait_count,batchId).first<{pending_asset_wait_count:number}>();
	if(!updated){const latest=await readPendingContinuationRow(db,batchId);if(!latest||latest.status!=='processing')return base(latest&&['completed','needs_review','failed'].includes(latest.status)?'batch_terminal':'invalid_state');if(latest.pending_count===0)return base('asset_ready',{resultingState:'asset_ready'});return base('already_claimed',{count:latest.pending_asset_wait_count,resultingState:latest.continuation_state});}
	return base('schedule',{count:updated.pending_asset_wait_count,firstWaitAt,deadlineAt,nextDelaySeconds,continuationToken:token,resultingState:'scheduled',invalidTimestampFields});
}

export async function markContinuationEnqueueFailed(db:D1Database,batchId:string,continuationToken:string,error:unknown,now=new Date().toISOString()):Promise<boolean>{
	const reason=`continuation enqueue failed: ${error instanceof Error?error.message:String(error)}`;
	const result=await db.prepare(`UPDATE line_image_batches SET status='needs_review',completed_at=COALESCE(completed_at,?),updated_at=?,error=?,continuation_state='enqueue_failed',continuation_enqueue_error=?,continuation_claim_token=NULL,reconciliation_required_at=COALESCE(reconciliation_required_at,?),processing_at=NULL WHERE id=? AND status='processing' AND processing_at=? AND continuation_state='scheduled'`).bind(now,now,reason,reason,now,batchId,continuationToken).run();
	if((result.meta.changes??0)!==1)return false;
	await markUnresolvedAssetsForReconciliation(db,batchId,reason,now);return true;
}

export async function markAssetAttemptLimitForReconciliation(db:D1Database,batchId:string,assetId:string,now=new Date().toISOString()):Promise<void>{
	const reason='asset processing attempt limit reached';
	await db.prepare(`UPDATE line_image_batch_assets SET status='failed',error=?,processed_at=COALESCE(processed_at,?) WHERE batch_id=? AND asset_id=? AND status<>'completed'`).bind(reason,now,batchId,assetId).run();
	await db.prepare(`UPDATE line_image_batches SET reconciliation_required_at=COALESCE(reconciliation_required_at,?),continuation_state=CASE WHEN status IN ('completed','needs_review','failed') THEN continuation_state ELSE 'asset_attempt_limit' END,error=COALESCE(error,?),updated_at=? WHERE id=?`).bind(now,reason,now,batchId).run();
	await updateEnrichmentForReconciliation(db,batchId,reason,now);
}

export async function markQueueRetryExhaustedForReconciliation(db:D1Database,batchId:string,reason:string,now=new Date().toISOString()):Promise<void>{
	await db.prepare(`UPDATE line_image_batches SET status=CASE WHEN status='completed' THEN status ELSE 'needs_review' END,completed_at=CASE WHEN status='completed' THEN completed_at ELSE COALESCE(completed_at,?) END,processing_at=NULL,error=CASE WHEN status='completed' THEN error ELSE ? END,continuation_state=CASE WHEN status='completed' THEN continuation_state ELSE 'queue_retry_exhausted' END,continuation_claim_token=NULL,reconciliation_required_at=CASE WHEN status='completed' THEN reconciliation_required_at ELSE COALESCE(reconciliation_required_at,?) END,updated_at=? WHERE id=?`).bind(now,reason,now,now,batchId).run();
	await markUnresolvedAssetsForReconciliation(db,batchId,reason,now);
}

export async function listBatchTexts(db:D1Database,batchId:string):Promise<LineMessageBatchText[]>{const rows=await db.prepare('SELECT * FROM line_message_batch_texts WHERE batch_id=? ORDER BY ordinal,received_at,message_id').bind(batchId).all<TextRow>();return(rows.results??[]).map((row)=>({batchId:row.batch_id,messageId:row.message_id,assetId:row.asset_id,text:row.text_content,receivedAt:row.received_at,conversationKey:row.conversation_key,ordinal:row.ordinal}));}

export async function listBatchWebSources(db:D1Database,batchId:string):Promise<LineMessageBatchWebSource[]>{const rows=await db.prepare('SELECT * FROM line_message_batch_web_sources WHERE batch_id=? ORDER BY ordinal,received_at,message_id').bind(batchId).all<WebRow>();return(rows.results??[]).map((row)=>({batchId:row.batch_id,messageId:row.message_id,webhookEventId:row.webhook_event_id,assetId:row.asset_id,requestedUrl:row.requested_url,normalizedUrl:row.normalized_url,finalUrl:row.final_url,status:row.status,httpStatus:row.http_status,contentType:row.content_type,responseBytes:row.response_bytes,redirectCount:row.redirect_count,title:row.title,description:row.description,canonicalUrl:row.canonical_url,mainImageUrl:row.main_image_url,openGraph:JSON.parse(row.open_graph_json||'{}') as Record<string,string>,jsonLd:JSON.parse(row.json_ld_json) as unknown[],extractedText:row.extracted_text,originalReadableTextChars:row.original_readable_text_chars,extractedTextLength:row.extracted_text_length,textReduced:row.text_reduced===1,errorCode:row.error_code,errorMessage:row.error_message,fetchedAt:row.fetched_at,receivedAt:row.received_at,conversationKey:row.conversation_key,ordinal:row.ordinal}));}

export async function claimBatchForDone(db:D1Database,conversationKey:string,now=new Date().toISOString()):Promise<DoneClaimResult>{
	const token=`done:${crypto.randomUUID()}`;
	const claimed=await db.prepare(`UPDATE line_image_batches SET status='processing',processing_at=?,closed_at=COALESCE(closed_at,?),updated_at=?,attempt_count=attempt_count+1 WHERE id=(SELECT id FROM line_image_batches WHERE conversation_key=? AND status='collecting' ORDER BY CASE WHEN expires_at>? THEN 0 ELSE 1 END,MAX(last_received_at,updated_at) DESC,last_received_at DESC,id DESC LIMIT 1) AND status='collecting' RETURNING *`).bind(token,now,now,conversationKey,now).first<BatchRow>();
	if(claimed){const batch=mapBatch(claimed);return{outcome:'claimed',batch,previousStatus:'collecting',claimReason:batch.expiresAt<=now?'expired':'done'};}
	// A losing duplicate /done must report the active processing batch. Terminal
	// history is consulted only when no collecting/processing batch exists.
	const active=await db.prepare(`SELECT * FROM line_image_batches WHERE conversation_key=? AND status IN ('collecting','processing') ORDER BY CASE status WHEN 'collecting' THEN 0 ELSE 1 END,MAX(last_received_at,updated_at) DESC,last_received_at DESC,id DESC LIMIT 1`).bind(conversationKey).first<BatchRow>();
	if(active){const batch=mapBatch(active);return batch.status==='processing'?{outcome:'already_processing',batch}:claimBatchForDone(db,conversationKey,now);}
	const latest=await db.prepare(`SELECT * FROM line_image_batches WHERE conversation_key=? AND status IN ('completed','needs_review','failed') ORDER BY MAX(last_received_at,updated_at) DESC,last_received_at DESC,id DESC LIMIT 1`).bind(conversationKey).first<BatchRow>();
	if(!latest)return{outcome:'not_found'};
	const batch=mapBatch(latest);
	return{outcome:'already_completed',batch};
}

export async function releaseDoneClaim(db:D1Database,batchId:string,token:string,now=new Date().toISOString()):Promise<boolean>{
	const result=await db.prepare(`UPDATE line_image_batches SET status='collecting',processing_at=NULL,closed_at=NULL,updated_at=?,attempt_count=CASE WHEN attempt_count>0 THEN attempt_count-1 ELSE 0 END WHERE id=? AND status='processing' AND processing_at=?`).bind(now,batchId,token).run();
	return(result.meta.changes??0)===1;
}

export async function closeCollectingBatch(db:D1Database,conversationKey:string,now=new Date().toISOString()):Promise<LineImageBatch|null>{const token=`done:${crypto.randomUUID()}`;const result=await db.prepare(`UPDATE line_image_batches SET status='processing',processing_at=?,closed_at=?,updated_at=?,attempt_count=attempt_count+1 WHERE id=(SELECT id FROM line_image_batches WHERE conversation_key=? AND status='collecting' AND expires_at>? LIMIT 1) AND status='collecting' AND expires_at>? RETURNING *`).bind(token,now,now,conversationKey,now,now).first<BatchRow>();return result?mapBatch(result):null;}

export async function claimClosedBatch(db:D1Database,batchId:string,token:string,continuationAttempt?:number):Promise<LineImageBatch|null>{
	const claimToken=`claimed:${crypto.randomUUID()}`;
	const result=continuationAttempt===undefined
		?await db.prepare(`UPDATE line_image_batches SET processing_at=?,updated_at=? WHERE id=? AND status='processing' AND processing_at=?`).bind(claimToken,new Date().toISOString(),batchId,token).run()
		:await db.prepare(`UPDATE line_image_batches SET processing_at=?,continuation_state='claimed',continuation_claim_token=NULL,updated_at=? WHERE id=? AND status='processing' AND processing_at=? AND continuation_state='scheduled' AND pending_asset_wait_count=?`).bind(claimToken,new Date().toISOString(),batchId,token,continuationAttempt).run();
	return(result.meta.changes??0)===1?getBatch(db,batchId):null;
}

export async function claimReadyBatch(db: D1Database, batchId: string, expectedLastReceivedAt: string, readyBefore: string): Promise<LineImageBatch | null> {
	const now = new Date().toISOString();
	const result = await db.prepare(`UPDATE line_image_batches SET status='processing',processing_at=?,closed_at=?,updated_at=?,attempt_count=attempt_count+1 WHERE id=? AND status='collecting' AND last_received_at=? AND expires_at<=?`)
		.bind(now,now,now,batchId,expectedLastReceivedAt,now).run();
	return (result.meta.changes ?? 0) === 1 ? getBatch(db,batchId) : null;
}

export async function retryFailedBatch(db:D1Database,batchId:string):Promise<LineImageBatch|null>{
	const now=new Date().toISOString();const result=await db.prepare(`UPDATE line_image_batches SET status='processing',processing_at=?,updated_at=?,attempt_count=attempt_count+1 WHERE id=? AND status='failed' AND attempt_count<4`).bind(now,now,batchId).run();
	return (result.meta.changes??0)===1?getBatch(db,batchId):null;
}

export async function completeBatch(db: D1Database, batchId: string, status: 'completed'|'needs_review', eventIds: string[]): Promise<boolean> {
	const now=new Date().toISOString();const result = await db.prepare(`UPDATE line_image_batches SET status=?,completed_at=?,updated_at=?,resulting_event_ids_json=?,error=NULL,processing_at=NULL,continuation_state=?,continuation_claim_token=NULL,continuation_enqueue_error=NULL WHERE id=? AND status='processing'`)
		.bind(status,now,now,JSON.stringify(eventIds),status,batchId).run();
	return (result.meta.changes ?? 0) === 1;
}

export async function failBatch(db: D1Database, batchId: string, error: unknown): Promise<void> {
	await db.prepare(`UPDATE line_image_batches SET status='failed',error=?,updated_at=? WHERE id=? AND status='processing'`)
		.bind(error instanceof Error ? error.message : String(error),new Date().toISOString(),batchId).run();
}

export async function markBatchNotificationSent(db: D1Database, batchId: string): Promise<boolean> {
	const result=await db.prepare(`UPDATE line_image_batches SET notification_sent_at=? WHERE id=? AND notification_sent_at IS NULL`).bind(new Date().toISOString(),batchId).run();
	return (result.meta.changes ?? 0)===1;
}

export async function findBatchIdsByAssetIds(db: D1Database, assetIds: string[]): Promise<string[]> {
	const ids = new Set<string>();
	for (const assetId of assetIds) {
		const row = await db.prepare('SELECT batch_id FROM line_image_batch_assets WHERE asset_id = ? LIMIT 1')
			.bind(assetId).first<{ batch_id: string }>();
		if (row) ids.add(row.batch_id);
	}
	return [...ids];
}

export async function deleteAssetRecordsAndOrphanedBatches(
	db: D1Database,
	assetIds: string[],
	candidateBatchIds: string[],
): Promise<{ assets: number; orphanedBatchIds: string[] }> {
	let assets = 0;
	for (const assetId of assetIds) {
		const result = await db.prepare('DELETE FROM line_image_batch_assets WHERE asset_id = ?').bind(assetId).run();
		assets += result.meta.changes ?? 0;
	}
	const orphanedBatchIds: string[] = [];
	for (const batchId of candidateBatchIds) {
		const result = await db.prepare(
			'DELETE FROM line_image_batches WHERE id = ? AND NOT EXISTS (SELECT 1 FROM line_image_batch_assets WHERE batch_id = ?)',
		).bind(batchId, batchId).run();
		if ((result.meta.changes ?? 0) > 0) orphanedBatchIds.push(batchId);
	}
	return { assets, orphanedBatchIds };
}
