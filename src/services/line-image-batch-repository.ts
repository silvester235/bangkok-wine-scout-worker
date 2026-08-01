export type LineImageBatchStatus = 'collecting' | 'processing' | 'completed' | 'needs_review' | 'failed';

export interface LineImageBatch {
	id: string;
	conversationKey: string;
	status: LineImageBatchStatus;
	firstReceivedAt: string;
	lastReceivedAt: string;
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

interface BatchRow {
	id: string; conversation_key: string; status: LineImageBatchStatus; first_received_at: string;
	last_received_at: string; processing_at: string | null; completed_at: string | null;
	push_target: string | null; resulting_event_ids_json: string;
}
interface AssetRow {
	batch_id: string; asset_id: string; intake_id: string; line_message_id: string;
	content_type: string; r2_object_key: string; received_at: string; conversation_key: string; ordinal: number;
}

function mapBatch(row: BatchRow): LineImageBatch {
	let ids: string[] = [];
	try { ids = JSON.parse(row.resulting_event_ids_json) as string[]; } catch { /* diagnostics only */ }
	return { id: row.id, conversationKey: row.conversation_key, status: row.status,
		firstReceivedAt: row.first_received_at, lastReceivedAt: row.last_received_at,
		processingAt: row.processing_at, completedAt: row.completed_at, pushTarget: row.push_target,
		resultingEventIds: ids };
}

export async function registerBatchAsset(db: D1Database, input: Omit<LineImageBatchAsset, 'batchId' | 'ordinal'> & { pushTarget?: string }): Promise<{ batch: LineImageBatch; duplicate: boolean }> {
	const duplicate = await db.prepare(`SELECT b.* FROM line_image_batch_assets a JOIN line_image_batches b ON b.id=a.batch_id WHERE a.line_message_id=?`)
		.bind(input.lineMessageId).first<BatchRow>();
	if (duplicate) return { batch: mapBatch(duplicate), duplicate: true };

	for (let attempt = 0; attempt < 3; attempt++) {
		let batch = await db.prepare(`SELECT * FROM line_image_batches WHERE conversation_key=? AND status='collecting' LIMIT 1`)
			.bind(input.conversationKey).first<BatchRow>();
		if (!batch) {
			const id = crypto.randomUUID();
			await db.prepare(`INSERT OR IGNORE INTO line_image_batches (id,conversation_key,status,first_received_at,last_received_at,push_target) VALUES (?,?,'collecting',?,?,?)`)
				.bind(id, input.conversationKey, input.receivedAt, input.receivedAt, input.pushTarget ?? null).run();
			batch = await db.prepare(`SELECT * FROM line_image_batches WHERE conversation_key=? AND status='collecting' LIMIT 1`)
				.bind(input.conversationKey).first<BatchRow>();
		}
		if (!batch) continue;
		const ordinal = await db.prepare(`SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM line_image_batch_assets WHERE batch_id=?`)
			.bind(batch.id).first<{ ordinal: number }>();
		const results = await db.batch([
			db.prepare(`UPDATE line_image_batches SET last_received_at=CASE WHEN last_received_at<? THEN ? ELSE last_received_at END,push_target=COALESCE(push_target,?) WHERE id=? AND status='collecting'`)
				.bind(input.receivedAt, input.receivedAt, input.pushTarget ?? null, batch.id),
			db.prepare(`INSERT OR IGNORE INTO line_image_batch_assets (batch_id,asset_id,intake_id,line_message_id,source_reference,content_type,r2_object_key,received_at,conversation_key,ordinal) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM line_image_batches WHERE id=? AND status='collecting')`)
				.bind(batch.id,input.assetId,input.intakeId,input.lineMessageId,input.lineMessageId,input.contentType,input.r2ObjectKey,input.receivedAt,input.conversationKey,ordinal?.ordinal ?? 1,batch.id),
		]);
		if ((results[1].meta.changes ?? 0) > 0) {
			const updated = await getBatch(db, batch.id);
			if (!updated) throw new Error('Registered LINE batch disappeared.');
			return { batch: updated, duplicate: false };
		}
		const existing = await db.prepare(`SELECT b.* FROM line_image_batch_assets a JOIN line_image_batches b ON b.id=a.batch_id WHERE a.line_message_id=?`)
			.bind(input.lineMessageId).first<BatchRow>();
		if (existing) return { batch: mapBatch(existing), duplicate: true };
	}
	throw new Error('Could not register LINE image in a collecting batch.');
}

export async function getBatch(db: D1Database, id: string): Promise<LineImageBatch | null> {
	const row = await db.prepare('SELECT * FROM line_image_batches WHERE id=?').bind(id).first<BatchRow>();
	return row ? mapBatch(row) : null;
}

export async function listBatchAssets(db: D1Database, batchId: string): Promise<LineImageBatchAsset[]> {
	const rows = await db.prepare('SELECT * FROM line_image_batch_assets WHERE batch_id=? ORDER BY ordinal,received_at,asset_id').bind(batchId).all<AssetRow>();
	return (rows.results ?? []).map((r) => ({ batchId:r.batch_id,assetId:r.asset_id,intakeId:r.intake_id,lineMessageId:r.line_message_id,contentType:r.content_type,r2ObjectKey:r.r2_object_key,receivedAt:r.received_at,conversationKey:r.conversation_key,ordinal:r.ordinal }));
}

export async function claimReadyBatch(db: D1Database, batchId: string, expectedLastReceivedAt: string, readyBefore: string): Promise<LineImageBatch | null> {
	const now = new Date().toISOString();
	const result = await db.prepare(`UPDATE line_image_batches SET status='processing',processing_at=?,attempt_count=attempt_count+1 WHERE id=? AND status='collecting' AND last_received_at=? AND last_received_at<=?`)
		.bind(now,batchId,expectedLastReceivedAt,readyBefore).run();
	return (result.meta.changes ?? 0) === 1 ? getBatch(db,batchId) : null;
}

export async function retryFailedBatch(db:D1Database,batchId:string):Promise<LineImageBatch|null>{
	const result=await db.prepare(`UPDATE line_image_batches SET status='processing',processing_at=?,attempt_count=attempt_count+1 WHERE id=? AND status='failed'`).bind(new Date().toISOString(),batchId).run();
	return (result.meta.changes??0)===1?getBatch(db,batchId):null;
}

export async function completeBatch(db: D1Database, batchId: string, status: 'completed'|'needs_review', eventIds: string[]): Promise<boolean> {
	const result = await db.prepare(`UPDATE line_image_batches SET status=?,completed_at=?,resulting_event_ids_json=?,error=NULL WHERE id=? AND status='processing'`)
		.bind(status,new Date().toISOString(),JSON.stringify(eventIds),batchId).run();
	return (result.meta.changes ?? 0) === 1;
}

export async function failBatch(db: D1Database, batchId: string, error: unknown): Promise<void> {
	await db.prepare(`UPDATE line_image_batches SET status='failed',error=? WHERE id=? AND status='processing'`)
		.bind(error instanceof Error ? error.message : String(error),batchId).run();
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
