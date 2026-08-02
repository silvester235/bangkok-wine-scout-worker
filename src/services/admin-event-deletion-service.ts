export interface DeleteEventReference {
	table: string;
	column: string;
	count: number;
}

export interface DeleteEventResult {
	eventId: string;
	deleted: boolean;
	eventFound: boolean;
	detachedReferences: {
		lineTextContexts: number;
	};
	cascadeDeletedReferences: {
		eventAssetsBeforeDelete: number;
	};
	preservedHistoricalReferences: {
		batchResultReferences: number;
		batchAssets: number;
		batchTexts: number;
	};
	orphanCheck: {
		passed: boolean;
		remainingReferences: DeleteEventReference[];
	};
}

interface CountRow {
	count: number;
}

function count(result: D1Result<unknown>): number {
	return Number((result.results[0] as CountRow | undefined)?.count ?? 0);
}

/**
 * Deletes one canonical event while preserving the historical ingestion trail.
 *
 * D1 executes `batch()` as a transaction, so the inspection, detachment,
 * deletion, and integrity reads either all commit or all roll back.
 */
export async function deleteEvent(db: D1Database, eventId: string): Promise<DeleteEventResult> {
	if (typeof eventId !== 'string' || eventId.length === 0) {
		throw new TypeError('eventId must be a non-empty string');
	}

	const validBatchResults = `json_each(
		CASE WHEN json_valid(line_image_batches.resulting_event_ids_json)
			THEN line_image_batches.resulting_event_ids_json ELSE '[]' END
	)`;
	const batchReferencesEvent = `EXISTS (
		SELECT 1 FROM ${validBatchResults} AS result WHERE result.value = ?
	)`;

	const results = await db.batch([
		db.prepare('SELECT COUNT(*) AS count FROM events WHERE id = ?').bind(eventId),
		db.prepare('SELECT COUNT(*) AS count FROM line_text_contexts WHERE linked_event_id = ?').bind(eventId),
		db.prepare('SELECT COUNT(*) AS count FROM event_assets WHERE event_id = ?').bind(eventId),
		db.prepare(
			`SELECT COUNT(*) AS count FROM line_image_batches WHERE ${batchReferencesEvent}`,
		).bind(eventId),
		db.prepare(
			`SELECT COUNT(*) AS count
			 FROM line_image_batch_assets
			 JOIN line_image_batches ON line_image_batches.id = line_image_batch_assets.batch_id
			 WHERE ${batchReferencesEvent}
				OR EXISTS (
					SELECT 1 FROM event_assets
					WHERE event_assets.event_id = ?
						AND event_assets.asset_id = line_image_batch_assets.asset_id
				)`,
		).bind(eventId, eventId),
		db.prepare(
			`SELECT COUNT(*) AS count
			 FROM line_message_batch_texts
			 JOIN line_image_batches ON line_image_batches.id = line_message_batch_texts.batch_id
			 WHERE ${batchReferencesEvent}
				OR EXISTS (
					SELECT 1 FROM event_assets
					WHERE event_assets.event_id = ?
						AND (
							event_assets.asset_id = line_message_batch_texts.asset_id
							OR event_assets.source_message_id = line_message_batch_texts.message_id
						)
				)`,
		).bind(eventId, eventId),
		db.prepare(
			`UPDATE line_text_contexts
			 SET linked_event_id = NULL
			 WHERE linked_event_id = ?
				AND EXISTS (SELECT 1 FROM events WHERE id = ?)`,
		).bind(eventId, eventId),
		db.prepare('DELETE FROM events WHERE id = ?').bind(eventId),
		db.prepare('SELECT COUNT(*) AS count FROM event_assets WHERE event_id = ?').bind(eventId),
		db.prepare('SELECT COUNT(*) AS count FROM line_text_contexts WHERE linked_event_id = ?').bind(eventId),
		db.prepare('SELECT COUNT(*) AS count FROM events WHERE id = ?').bind(eventId),
	]);

	const eventFound = count(results[0]) === 1;
	const eventAssetsRemaining = count(results[8]);
	const lineTextContextsRemaining = count(results[9]);
	const remainingReferences: DeleteEventReference[] = [];
	if (eventAssetsRemaining > 0) {
		remainingReferences.push({ table: 'event_assets', column: 'event_id', count: eventAssetsRemaining });
	}
	if (lineTextContextsRemaining > 0) {
		remainingReferences.push({
			table: 'line_text_contexts', column: 'linked_event_id', count: lineTextContextsRemaining,
		});
	}

	const deleted = eventFound && count(results[10]) === 0;
	return {
		eventId,
		deleted,
		eventFound,
		detachedReferences: { lineTextContexts: count(results[1]) },
		cascadeDeletedReferences: { eventAssetsBeforeDelete: count(results[2]) },
		preservedHistoricalReferences: {
			batchResultReferences: count(results[3]),
			batchAssets: count(results[4]),
			batchTexts: count(results[5]),
		},
		orphanCheck: {
			passed: deleted && remainingReferences.length === 0,
			remainingReferences,
		},
	};
}
