export type LineImageBatchStatus = 'collecting' | 'processing' | 'completed' | 'needs_review' | 'failed';

export interface LineImageBatch {
	id: string;
	conversationKey: string;
	status: LineImageBatchStatus;
	firstReceivedAt: string;
	lastReceivedAt: string;
	createdAt: string;
	lastActivityAt: string;
	expiresAt: string;
	closedAt: string | null;
	processingAt: string | null;
	completedAt: string | null;
	pushTarget: string | null;
	resultingEventIds: string[];
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

interface BatchRow {
	id: string; conversation_key: string; status: LineImageBatchStatus; first_received_at: string;
	last_received_at: string; processing_at: string | null; completed_at: string | null;
	push_target: string | null; resulting_event_ids_json: string;
	created_at: string; last_activity_at: string; expires_at: string; closed_at: string | null;
}
interface AssetRow {
	batch_id: string; asset_id: string; intake_id: string; line_message_id: string;
	content_type: string; r2_object_key: string; received_at: string; conversation_key: string; ordinal: number;
}
interface TextRow { batch_id:string; message_id:string; asset_id:string; text_content:string; received_at:string; conversation_key:string; ordinal:number }

function mapBatch(row: BatchRow): LineImageBatch {
	let ids: string[] = [];
	try { ids = JSON.parse(row.resulting_event_ids_json) as string[]; } catch { /* diagnostics only */ }
	return { id: row.id, conversationKey: row.conversation_key, status: row.status,
		firstReceivedAt: row.first_received_at, lastReceivedAt: row.last_received_at,
		createdAt: row.created_at, lastActivityAt: row.last_activity_at, expiresAt: row.expires_at, closedAt: row.closed_at,
		processingAt: row.processing_at, completedAt: row.completed_at, pushTarget: row.push_target,
		resultingEventIds: ids };
}

const expiresAt = (at: string, batchWindowSeconds: number) => new Date(Date.parse(at) + batchWindowSeconds * 1000).toISOString();

export interface BatchRegistrationResult { batch: LineImageBatch; duplicate: boolean; expiredBatchId?: string }

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

export async function registerBatchAsset(db: D1Database, input: Omit<LineImageBatchAsset, 'batchId' | 'ordinal'> & { pushTarget?: string; webhookEventId?: string }, batchWindowSeconds = 60): Promise<BatchRegistrationResult> {
	const duplicate = await db.prepare(`SELECT b.* FROM line_image_batch_assets a JOIN line_image_batches b ON b.id=a.batch_id WHERE a.line_message_id=? OR a.webhook_event_id=? LIMIT 1`)
		.bind(input.lineMessageId,input.webhookEventId??input.lineMessageId).first<BatchRow>();
	if (duplicate) return { batch: mapBatch(duplicate), duplicate: true };

	const expiredBatchId=await expireActiveBatch(db,input.conversationKey,input.receivedAt);
	for (let attempt = 0; attempt < 3; attempt++) {
		let batch = await db.prepare(`SELECT * FROM line_image_batches WHERE conversation_key=? AND status='collecting' AND expires_at>? LIMIT 1`)
			.bind(input.conversationKey,input.receivedAt).first<BatchRow>();
		if (!batch) {
			const id = crypto.randomUUID();
			await db.prepare(`INSERT OR IGNORE INTO line_image_batches (id,conversation_key,status,first_received_at,last_received_at,created_at,last_activity_at,expires_at,updated_at,push_target) VALUES (?,?,'collecting',?,?,?,?,?,?,?)`)
				.bind(id,input.conversationKey,input.receivedAt,input.receivedAt,input.receivedAt,input.receivedAt,expiresAt(input.receivedAt,batchWindowSeconds),input.receivedAt,input.pushTarget??null).run();
			batch = await db.prepare(`SELECT * FROM line_image_batches WHERE conversation_key=? AND status='collecting' AND expires_at>? LIMIT 1`).bind(input.conversationKey,input.receivedAt).first<BatchRow>();
		}
		if (!batch) continue;
		const ordinal = await db.prepare(`SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM line_image_batch_assets WHERE batch_id=?`)
			.bind(batch.id).first<{ ordinal: number }>();
		const results = await db.batch([
			db.prepare(`UPDATE line_image_batches SET last_received_at=?,last_activity_at=?,expires_at=?,updated_at=?,push_target=COALESCE(push_target,?) WHERE id=? AND status='collecting' AND expires_at>?`)
				.bind(input.receivedAt,input.receivedAt,expiresAt(input.receivedAt,batchWindowSeconds),input.receivedAt,input.pushTarget??null,batch.id,input.receivedAt),
			db.prepare(`INSERT OR IGNORE INTO line_image_batch_assets (batch_id,asset_id,intake_id,line_message_id,webhook_event_id,source_reference,content_type,r2_object_key,received_at,conversation_key,ordinal) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM line_image_batches WHERE id=? AND status='collecting' AND expires_at>?)`)
				.bind(batch.id,input.assetId,input.intakeId,input.lineMessageId,input.webhookEventId??input.lineMessageId,input.lineMessageId,input.contentType,input.r2ObjectKey,input.receivedAt,input.conversationKey,ordinal?.ordinal??1,batch.id,input.receivedAt),
		]);
		if ((results[1].meta.changes ?? 0) > 0) {
			const updated = await getBatch(db, batch.id);
			if (!updated) throw new Error('Registered LINE batch disappeared.');
			return { batch: updated, duplicate: false, expiredBatchId };
		}
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

export async function getBatch(db: D1Database, id: string): Promise<LineImageBatch | null> {
	const row = await db.prepare('SELECT * FROM line_image_batches WHERE id=?').bind(id).first<BatchRow>();
	return row ? mapBatch(row) : null;
}

export async function listBatchAssets(db: D1Database, batchId: string): Promise<LineImageBatchAsset[]> {
	const rows = await db.prepare('SELECT * FROM line_image_batch_assets WHERE batch_id=? ORDER BY ordinal,received_at,asset_id').bind(batchId).all<AssetRow>();
	return (rows.results ?? []).map((r) => ({ batchId:r.batch_id,assetId:r.asset_id,intakeId:r.intake_id,lineMessageId:r.line_message_id,contentType:r.content_type,r2ObjectKey:r.r2_object_key,receivedAt:r.received_at,conversationKey:r.conversation_key,ordinal:r.ordinal }));
}

export async function listBatchTexts(db:D1Database,batchId:string):Promise<LineMessageBatchText[]>{const rows=await db.prepare('SELECT * FROM line_message_batch_texts WHERE batch_id=? ORDER BY ordinal,received_at,message_id').bind(batchId).all<TextRow>();return(rows.results??[]).map((row)=>({batchId:row.batch_id,messageId:row.message_id,assetId:row.asset_id,text:row.text_content,receivedAt:row.received_at,conversationKey:row.conversation_key,ordinal:row.ordinal}));}

export async function claimBatchForDone(db:D1Database,conversationKey:string,now=new Date().toISOString()):Promise<DoneClaimResult>{
	const token=`done:${crypto.randomUUID()}`;
	const claimed=await db.prepare(`UPDATE line_image_batches SET status='processing',processing_at=?,closed_at=COALESCE(closed_at,?),updated_at=?,attempt_count=attempt_count+1 WHERE id=(SELECT id FROM line_image_batches WHERE conversation_key=? AND status='collecting' ORDER BY last_received_at DESC LIMIT 1) AND status='collecting' RETURNING *`).bind(token,now,now,conversationKey).first<BatchRow>();
	if(claimed){const batch=mapBatch(claimed);return{outcome:'claimed',batch,previousStatus:'collecting',claimReason:batch.expiresAt<=now?'expired':'done'};}
	const latest=await db.prepare(`SELECT * FROM line_image_batches WHERE conversation_key=? ORDER BY last_received_at DESC LIMIT 1`).bind(conversationKey).first<BatchRow>();
	if(!latest)return{outcome:'not_found'};
	const batch=mapBatch(latest);
	return batch.status==='processing'?{outcome:'already_processing',batch}:{outcome:'already_completed',batch};
}

export async function releaseDoneClaim(db:D1Database,batchId:string,token:string,now=new Date().toISOString()):Promise<boolean>{
	const result=await db.prepare(`UPDATE line_image_batches SET status='collecting',processing_at=NULL,closed_at=NULL,updated_at=?,attempt_count=CASE WHEN attempt_count>0 THEN attempt_count-1 ELSE 0 END WHERE id=? AND status='processing' AND processing_at=?`).bind(now,batchId,token).run();
	return(result.meta.changes??0)===1;
}

export async function closeCollectingBatch(db:D1Database,conversationKey:string,now=new Date().toISOString()):Promise<LineImageBatch|null>{const token=`done:${crypto.randomUUID()}`;const result=await db.prepare(`UPDATE line_image_batches SET status='processing',processing_at=?,closed_at=?,updated_at=?,attempt_count=attempt_count+1 WHERE id=(SELECT id FROM line_image_batches WHERE conversation_key=? AND status='collecting' AND expires_at>? LIMIT 1) AND status='collecting' AND expires_at>? RETURNING *`).bind(token,now,now,conversationKey,now,now).first<BatchRow>();return result?mapBatch(result):null;}

export async function claimClosedBatch(db:D1Database,batchId:string,token:string):Promise<LineImageBatch|null>{const result=await db.prepare(`UPDATE line_image_batches SET processing_at=? WHERE id=? AND status='processing' AND processing_at=?`).bind(new Date().toISOString(),batchId,token).run();return(result.meta.changes??0)===1?getBatch(db,batchId):null;}

export async function claimReadyBatch(db: D1Database, batchId: string, expectedLastReceivedAt: string, readyBefore: string): Promise<LineImageBatch | null> {
	const now = new Date().toISOString();
	const result = await db.prepare(`UPDATE line_image_batches SET status='processing',processing_at=?,closed_at=?,updated_at=?,attempt_count=attempt_count+1 WHERE id=? AND status='collecting' AND last_received_at=? AND expires_at<=?`)
		.bind(now,now,now,batchId,expectedLastReceivedAt,now).run();
	return (result.meta.changes ?? 0) === 1 ? getBatch(db,batchId) : null;
}

export async function retryFailedBatch(db:D1Database,batchId:string):Promise<LineImageBatch|null>{
	const now=new Date().toISOString();const result=await db.prepare(`UPDATE line_image_batches SET status='processing',processing_at=?,updated_at=?,attempt_count=attempt_count+1 WHERE id=? AND status='failed'`).bind(now,now,batchId).run();
	return (result.meta.changes??0)===1?getBatch(db,batchId):null;
}

export async function completeBatch(db: D1Database, batchId: string, status: 'completed'|'needs_review', eventIds: string[]): Promise<boolean> {
	const now=new Date().toISOString();const result = await db.prepare(`UPDATE line_image_batches SET status=?,completed_at=?,updated_at=?,resulting_event_ids_json=?,error=NULL WHERE id=? AND status='processing'`)
		.bind(status,now,now,JSON.stringify(eventIds),batchId).run();
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
