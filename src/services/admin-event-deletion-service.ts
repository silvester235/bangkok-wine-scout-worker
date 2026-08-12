import type { WorkerEnv } from '../types/env';

const LINE_NOTE = 'Original messages in LINE cannot be deleted through the Messaging API.';

interface EventAssetRow {
	asset_id: string;
	intake_id: string;
	source_message_id: string | null;
	r2_object_key: string | null;
}

interface BatchSourceRow {
	batch_id: string;
	kind: 'asset' | 'text' | 'web';
	asset_id: string;
	message_id: string | null;
	r2_object_key: string | null;
}

interface BatchRow {
	id: string;
	resulting_event_ids_json: string;
}

export interface DeleteEventResult {
	success: boolean;
	eventId: string;
	eventFound: boolean;
	unpublished: boolean;
	database: {
		eventDeleted: boolean;
		relatedRowsDeleted: number;
		rowsDeleted: Record<string, number>;
	};
	r2: {
		objectsFound: number;
		objectsDeleted: number;
		objectsMissing: number;
		objectsFailed: number;
		failedKeys: string[];
	};
	line: {
		referencesDeleted: number;
		originalLineMessageDeleted: false;
		note: string;
	};
	cacheInvalidated: boolean;
}

export interface DeleteVerificationFailure {table:string;purpose:string;remaining:number;identifiers:string[];}
export class EventDeleteVerificationError extends Error {
	constructor(public readonly eventId:string,public readonly remainingRecords:DeleteVerificationFailure[]){super('Event database cleanup failed its integrity check.');this.name='EventDeleteVerificationError';}
}

function logStage(eventId:string,stage:string,fields:Record<string,unknown>={}):void{console.log(JSON.stringify({event:'event_delete_stage',stage,eventId,...fields}));}

function changes(result: D1Result<unknown>): number {
	return result.meta.changes ?? 0;
}

function parseEventIds(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
	} catch {
		return [];
	}
}

async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor });
		keys.push(...page.objects.map((object) => object.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return keys;
}

async function collectR2Keys(bucket: R2Bucket, assets: EventAssetRow[], exclusiveBatchIds: string[]): Promise<string[]> {
	const keys = new Set<string>();
	for (const asset of assets) {
		if (asset.r2_object_key) keys.add(asset.r2_object_key);
		const prefix = `intakes/${asset.intake_id}/assets/${asset.asset_id}/`;
		for (const key of await listKeys(bucket, prefix)) keys.add(key);

		const metadata = await bucket.get(`${prefix}metadata.json`);
		if (metadata) {
			try {
				const value = await metadata.json<{ contentHash?: { value?: string } }>();
				if (value.contentHash?.value) {
					const hashKey = `image-hashes/sha256/${value.contentHash.value}.json`;
					const index = await bucket.get(hashKey);
					if (index) {
						const owner = await index.json<{ assetId?: string; intakeId?: string }>();
						if (owner.assetId === asset.asset_id && owner.intakeId === asset.intake_id) keys.add(hashKey);
					}
				}
			} catch { /* An unverified shared hash index must be preserved. */ }
		}
	}
	for (const batchId of exclusiveBatchIds) {
		for (const key of await listKeys(bucket, `line-batches/${batchId}/`)) keys.add(key);
	}
	return [...keys];
}

async function deleteR2Keys(bucket: R2Bucket, keys: string[],eventId:string): Promise<DeleteEventResult['r2']> {
	const existing: string[] = [];
	let objectsMissing = 0;
	const failedKeys: string[] = [];
	for (const key of keys) {
		try {
			if (await bucket.head(key)){existing.push(key);logStage(eventId,'r2_head',{purpose:'confirm_object_before_delete',r2Key:key,exists:true});}
			else{objectsMissing++;logStage(eventId,'r2_head',{purpose:'confirm_object_before_delete',r2Key:key,exists:false});}
		} catch(error) {
			failedKeys.push(key);
			logStage(eventId,'r2_head_failed',{purpose:'confirm_object_before_delete',r2Key:key,error:error instanceof Error?error.message:String(error)});
		}
	}

	let objectsDeleted = 0;
	for (let offset = 0; offset < existing.length; offset += 1000) {
		const chunk = existing.slice(offset, offset + 1000);
		try {
			await bucket.delete(chunk);
			objectsDeleted += chunk.length;
			for(const key of chunk)logStage(eventId,'r2_delete',{purpose:'delete_event_owned_object',r2Key:key,deleted:true});
		} catch(error) {
			logStage(eventId,'r2_batch_delete_failed',{purpose:'delete_event_owned_objects',affectedRowCount:0,objectCount:chunk.length,error:error instanceof Error?error.message:String(error)});
			// A batch error is retried one key at a time so the report is useful and
			// a later idempotent request can finish only the remaining objects.
			for (const key of chunk) {
				try {
					await bucket.delete(key);
					objectsDeleted++;
					logStage(eventId,'r2_delete',{purpose:'delete_event_owned_object',r2Key:key,deleted:true});
				} catch(error) {
					failedKeys.push(key);
					logStage(eventId,'r2_delete_failed',{purpose:'delete_event_owned_object',r2Key:key,error:error instanceof Error?error.message:String(error)});
				}
			}
		}
	}
	return {
		objectsFound: existing.length,
		objectsDeleted,
		objectsMissing,
		objectsFailed: failedKeys.length,
		failedKeys,
	};
}

function sourceBelongsToEvent(source: BatchSourceRow, assets: EventAssetRow[]): boolean {
	return assets.some((asset) => asset.asset_id === source.asset_id
		|| (source.message_id !== null && asset.source_message_id === source.message_id));
}

/**
 * Permanently removes a canonical event and all event-owned data. The event is
 * unpublished before R2 cleanup, and all database cleanup is a single D1 batch.
 */
export async function deleteEventCompletely(eventId: string, env: WorkerEnv): Promise<DeleteEventResult> {
	const startedAt = Date.now();
	console.log(JSON.stringify({ event: 'event_delete_started', eventId }));
	try {
		const event = await env.DB.prepare('SELECT id, status, published_at FROM events WHERE id = ? LIMIT 1')
			.bind(eventId).first<{ id: string; status: string; published_at: string | null }>();
		if (!event) {
			const result: DeleteEventResult = {
				success: true, eventId, eventFound: false, unpublished: false,
				database: { eventDeleted: false, relatedRowsDeleted: 0, rowsDeleted: {} },
				r2: { objectsFound: 0, objectsDeleted: 0, objectsMissing: 0, objectsFailed: 0, failedKeys: [] },
				line: { referencesDeleted: 0, originalLineMessageDeleted: false, note: LINE_NOTE },
				cacheInvalidated: true,
			};
			console.log(JSON.stringify({ event: 'event_delete_completed', eventId, eventFound: false, durationMs: Date.now() - startedAt }));
			return result;
		}

		const assetResult = await env.DB.prepare(
			`SELECT asset_id, intake_id, source_message_id, r2_object_key
			 FROM event_assets WHERE event_id = ? ORDER BY linked_at, asset_id`,
		).bind(eventId).all<EventAssetRow>();
		const assets = assetResult.results ?? [];
		logStage(eventId,'database_snapshot',{purpose:'collect_event_assets',affectedRowCount:assets.length});
		const batchResult = await env.DB.prepare(
			`SELECT DISTINCT b.id, b.resulting_event_ids_json
			 FROM line_image_batches b
			 LEFT JOIN line_image_batch_assets a ON a.batch_id = b.id
			 LEFT JOIN line_message_batch_texts t ON t.batch_id = b.id
			 LEFT JOIN line_message_batch_web_sources w ON w.batch_id = b.id
			 WHERE EXISTS (
				SELECT 1 FROM json_each(CASE WHEN json_valid(b.resulting_event_ids_json)
					THEN b.resulting_event_ids_json ELSE '[]' END) WHERE value = ?1
			 ) OR a.asset_id IN (SELECT asset_id FROM event_assets WHERE event_id = ?1)
			   OR t.asset_id IN (SELECT asset_id FROM event_assets WHERE event_id = ?1)
			   OR t.message_id IN (SELECT source_message_id FROM event_assets WHERE event_id = ?1)
			   OR w.asset_id IN (SELECT asset_id FROM event_assets WHERE event_id = ?1)
			   OR w.message_id IN (SELECT source_message_id FROM event_assets WHERE event_id = ?1)`,
		).bind(eventId).all<BatchRow>();
		const batches = batchResult.results ?? [];
		const batchIds = batches.map((batch) => batch.id);
		const sources: BatchSourceRow[] = [];
		for (const batchId of batchIds) {
			const rows = await env.DB.prepare(
				`SELECT batch_id, 'asset' AS kind, asset_id, line_message_id AS message_id, r2_object_key
				 FROM line_image_batch_assets WHERE batch_id = ?1
				 UNION ALL SELECT batch_id, 'text', asset_id, message_id, NULL
				 FROM line_message_batch_texts WHERE batch_id = ?1
				 UNION ALL SELECT batch_id, 'web', asset_id, message_id, NULL
				 FROM line_message_batch_web_sources WHERE batch_id = ?1`,
			).bind(batchId).all<BatchSourceRow>();
			sources.push(...(rows.results ?? []));
		}
		const exclusiveBatchIds = batches.filter((batch) => {
			const otherEventIds = parseEventIds(batch.resulting_event_ids_json).filter((id) => id !== eventId);
			const batchSources = sources.filter((source) => source.batch_id === batch.id);
			return otherEventIds.length === 0 && batchSources.every((source) => sourceBelongsToEvent(source, assets));
		}).map((batch) => batch.id);
		logStage(eventId,'database_snapshot',{purpose:'resolve_related_batches',relatedBatchCount:batchIds.length,exclusiveBatchCount:exclusiveBatchIds.length,batchIds});

		await env.DB.prepare(
			`UPDATE events SET status = 'draft', published_at = NULL WHERE id = ?`,
		).bind(eventId).run();
		const visibility = await env.DB.prepare(
			`SELECT 1 AS visible FROM events WHERE id = ? AND status = 'published' AND published_at IS NOT NULL`,
		).bind(eventId).first<{ visible: number }>();
		if (visibility) throw new Error('Event remained publicly visible after unpublish.');
		console.log(JSON.stringify({ event: 'event_delete_unpublished', eventId, wasPublished: event.status === 'published' && event.published_at !== null }));

		const r2Keys = await collectR2Keys(env.EVENT_INTAKES, assets, exclusiveBatchIds);
		const r2 = await deleteR2Keys(env.EVENT_INTAKES, r2Keys,eventId);
		console.log(JSON.stringify({ event: 'event_delete_r2_cleanup', eventId, ...r2 }));
		if (r2.objectsFailed > 0) {
			const result: DeleteEventResult = {
				success: false,
				eventId,
				eventFound: true,
				unpublished: true,
				database: { eventDeleted: false, relatedRowsDeleted: 0, rowsDeleted: {} },
				r2,
				line: { referencesDeleted: 0, originalLineMessageDeleted: false, note: LINE_NOTE },
				cacheInvalidated: true,
			};
			console.log(JSON.stringify({ event: 'event_delete_completed', eventId, success: false, retryable: true, durationMs: Date.now() - startedAt }));
			return result;
		}

		const deleteEmptyBatchStatement = exclusiveBatchIds.length === 0
			? env.DB.prepare('DELETE FROM line_image_batches WHERE 0')
			: env.DB.prepare(`DELETE FROM line_image_batches WHERE id IN (${exclusiveBatchIds.map(() => '?').join(',')})
				AND NOT EXISTS (SELECT 1 FROM line_image_batch_assets WHERE batch_id = line_image_batches.id)
				AND NOT EXISTS (SELECT 1 FROM line_message_batch_texts WHERE batch_id = line_image_batches.id)
				AND NOT EXISTS (SELECT 1 FROM line_message_batch_web_sources WHERE batch_id = line_image_batches.id)
				AND json_array_length(CASE WHEN json_valid(resulting_event_ids_json) THEN resulting_event_ids_json ELSE '[]' END) = 0`)
				.bind(...exclusiveBatchIds);
		const placeholders=(values:unknown[])=>values.length?values.map(()=>'?').join(','):'NULL';
		const assetIds=assets.map(asset=>asset.asset_id);const messageIds=assets.flatMap(asset=>asset.source_message_id?[asset.source_message_id]:[]);
		const sqlBatch = await env.DB.batch([
			env.DB.prepare(`DELETE FROM line_url_ingestion_deliveries WHERE batch_id IN (
				SELECT DISTINCT w.batch_id FROM line_message_batch_web_sources w
				JOIN event_assets e ON e.asset_id = w.asset_id OR e.source_message_id = w.message_id
				WHERE e.event_id = ?
			) AND webhook_event_id IN (
				SELECT w.webhook_event_id FROM line_message_batch_web_sources w
				JOIN event_assets e ON e.asset_id = w.asset_id OR e.source_message_id = w.message_id
				WHERE e.event_id = ?
			)`).bind(eventId, eventId),
			exclusiveBatchIds.length?env.DB.prepare(`DELETE FROM line_delivery_outbox WHERE batch_id IN (${placeholders(exclusiveBatchIds)}) OR asset_id IN (${placeholders(assetIds)})`).bind(...exclusiveBatchIds,...assetIds):env.DB.prepare(`DELETE FROM line_delivery_outbox WHERE asset_id IN (${placeholders(assetIds)})`).bind(...assetIds),
			exclusiveBatchIds.length?env.DB.prepare(`DELETE FROM line_webhook_delivery_receipts WHERE batch_id IN (${placeholders(exclusiveBatchIds)})`).bind(...exclusiveBatchIds):env.DB.prepare('DELETE FROM line_webhook_delivery_receipts WHERE 0'),
			env.DB.prepare(`DELETE FROM line_text_contexts WHERE linked_event_id = ?
				OR linked_image_asset_id IN (SELECT asset_id FROM event_assets WHERE event_id = ?)
				OR message_id IN (SELECT source_message_id FROM event_assets WHERE event_id = ?)`)
				.bind(eventId, eventId, eventId),
			env.DB.prepare(`DELETE FROM line_image_batch_assets
				WHERE asset_id IN (SELECT asset_id FROM event_assets WHERE event_id = ?)`)
				.bind(eventId),
			env.DB.prepare(`DELETE FROM line_message_batch_texts WHERE asset_id IN (
				SELECT asset_id FROM event_assets WHERE event_id = ?
			) OR message_id IN (SELECT source_message_id FROM event_assets WHERE event_id = ?)`)
				.bind(eventId, eventId),
			env.DB.prepare(`DELETE FROM line_message_batch_web_sources WHERE asset_id IN (
				SELECT asset_id FROM event_assets WHERE event_id = ?
			) OR message_id IN (SELECT source_message_id FROM event_assets WHERE event_id = ?)`)
				.bind(eventId, eventId),
			env.DB.prepare(`DELETE FROM event_enrichment_state WHERE event_id=? OR asset_id IN (${placeholders(assetIds)})`).bind(eventId,...assetIds),
			env.DB.prepare(`UPDATE agent_submissions SET result_event_id=NULL,result_action=CASE WHEN result_event_id=? THEN 'event_deleted' ELSE result_action END,updated_at=? WHERE result_event_id=?`).bind(eventId,new Date().toISOString(),eventId),
			env.DB.prepare(`UPDATE line_image_batches SET resulting_event_ids_json = COALESCE((
				SELECT json_group_array(value) FROM json_each(CASE WHEN json_valid(resulting_event_ids_json)
					THEN resulting_event_ids_json ELSE '[]' END) WHERE value <> ?
			), '[]'),minimal_event_id=CASE WHEN minimal_event_id=? THEN NULL ELSE minimal_event_id END WHERE minimal_event_id=? OR EXISTS (
				SELECT 1 FROM json_each(CASE WHEN json_valid(resulting_event_ids_json)
					THEN resulting_event_ids_json ELSE '[]' END) WHERE value = ?
			)`).bind(eventId,eventId,eventId,eventId),
			deleteEmptyBatchStatement,
			env.DB.prepare('DELETE FROM events WHERE id = ?').bind(eventId),
			env.DB.prepare('SELECT COUNT(*) AS count FROM events WHERE id = ?').bind(eventId),
			env.DB.prepare('SELECT COUNT(*) AS count FROM event_assets WHERE event_id = ?').bind(eventId),
			env.DB.prepare(`SELECT COUNT(*) AS count FROM line_text_contexts WHERE linked_event_id=? OR linked_image_asset_id IN (${placeholders(assetIds)}) OR message_id IN (${placeholders(messageIds)})`).bind(eventId,...assetIds,...messageIds),
			env.DB.prepare(`SELECT COUNT(*) AS count FROM event_enrichment_state WHERE event_id=? OR asset_id IN (${placeholders(assetIds)})`).bind(eventId,...assetIds),
			env.DB.prepare('SELECT COUNT(*) AS count FROM agent_submissions WHERE result_event_id=?').bind(eventId),
			env.DB.prepare(`SELECT COUNT(*) AS count FROM line_image_batches WHERE minimal_event_id=? OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(resulting_event_ids_json) THEN resulting_event_ids_json ELSE '[]' END) WHERE value=?)`).bind(eventId,eventId),
			env.DB.prepare(`SELECT COUNT(*) AS count FROM line_image_batch_assets WHERE asset_id IN (${placeholders(assetIds)}) OR line_message_id IN (${placeholders(messageIds)})`).bind(...assetIds,...messageIds),
			env.DB.prepare(`SELECT COUNT(*) AS count FROM line_message_batch_texts WHERE asset_id IN (${placeholders(assetIds)}) OR message_id IN (${placeholders(messageIds)})`).bind(...assetIds,...messageIds),
			env.DB.prepare(`SELECT COUNT(*) AS count FROM line_message_batch_web_sources WHERE asset_id IN (${placeholders(assetIds)}) OR message_id IN (${placeholders(messageIds)})`).bind(...assetIds,...messageIds),
			exclusiveBatchIds.length?env.DB.prepare(`SELECT COUNT(*) AS count FROM line_delivery_outbox WHERE batch_id IN (${placeholders(exclusiveBatchIds)}) OR asset_id IN (${placeholders(assetIds)})`).bind(...exclusiveBatchIds,...assetIds):env.DB.prepare(`SELECT COUNT(*) AS count FROM line_delivery_outbox WHERE asset_id IN (${placeholders(assetIds)})`).bind(...assetIds),
		]);
		// D1/SQLite may include ON DELETE CASCADE effects in the change count.
		const eventDeleted = changes(sqlBatch[11]) > 0;
		const verificationPurposes=['events','event_assets','line_text_contexts','event_enrichment_state','agent_submissions','line_image_batches','line_image_batch_assets','line_message_batch_texts','line_message_batch_web_sources','line_delivery_outbox'];
		const remainingRecords=sqlBatch.slice(12).map((result,index)=>({table:verificationPurposes[index],purpose:`verify_no_${verificationPurposes[index]}_references`,remaining:Number((result.results[0] as {count?:number}|undefined)?.count??0),identifiers:index===5?batchIds:index>=6&&index<=8?[...assetIds,...messageIds]:index===9?[...exclusiveBatchIds,...assetIds]:[eventId]})).filter(item=>item.remaining>0);
		for(const verification of sqlBatch.slice(12).map((result,index)=>({table:verificationPurposes[index],remaining:Number((result.results[0] as {count?:number}|undefined)?.count??0)})))logStage(eventId,'database_verification',{purpose:`verify_no_${verification.table}_references`,beforeCount:verification.table==='events'?1:undefined,afterCount:verification.remaining});
		if (!eventDeleted || remainingRecords.length){if(!eventDeleted)remainingRecords.unshift({table:'events',purpose:'verify_event_delete_affected_row',remaining:1,identifiers:[eventId]});throw new EventDeleteVerificationError(eventId,remainingRecords);}
		const rowsDeleted = {
			lineUrlIngestionDeliveries: changes(sqlBatch[0]),
			lineDeliveryOutbox:changes(sqlBatch[1]),lineWebhookDeliveryReceipts:changes(sqlBatch[2]),
			lineTextContexts: changes(sqlBatch[3]),
			lineBatchAssets: changes(sqlBatch[4]),
			lineBatchTexts: changes(sqlBatch[5]),
			lineBatchWebSources: changes(sqlBatch[6]),eventEnrichmentState:changes(sqlBatch[7]),agentSubmissionEventReferences:changes(sqlBatch[8]),
			lineBatchEventReferences: changes(sqlBatch[9]),
			lineBatches: changes(sqlBatch[10]),
			eventAssets: assets.length,
			events: eventDeleted?1:0,
		};
		const relatedRowsDeleted = Object.entries(rowsDeleted)
			.filter(([name]) => name !== 'events').reduce((sum, [, value]) => sum + value, 0);
		for(const [purpose,affectedRowCount] of Object.entries(rowsDeleted))logStage(eventId,'database_cleanup',{purpose:`delete_${purpose}`,affectedRowCount});
		const lineReferences = rowsDeleted.lineUrlIngestionDeliveries + rowsDeleted.lineTextContexts
			+ rowsDeleted.lineBatchAssets + rowsDeleted.lineBatchTexts + rowsDeleted.lineBatchWebSources;
		console.log(JSON.stringify({ event: 'event_delete_database_cleanup', eventId, rowsDeleted }));
		console.log(JSON.stringify({ event: 'event_delete_cache_invalidated', eventId, mechanism: 'direct_d1_reads' }));
		const result: DeleteEventResult = {
			success: r2.objectsFailed === 0,
			eventId,
			eventFound: true,
			unpublished: true,
			database: { eventDeleted: true, relatedRowsDeleted, rowsDeleted },
			r2,
			line: { referencesDeleted: lineReferences, originalLineMessageDeleted: false, note: LINE_NOTE },
			cacheInvalidated: true,
		};
		console.log(JSON.stringify({ event: 'event_delete_completed', eventId, success: result.success, durationMs: Date.now() - startedAt }));
		return result;
	} catch (error) {
		console.error(JSON.stringify({ event: 'event_delete_failed', eventId, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }));
		throw error;
	}
}
