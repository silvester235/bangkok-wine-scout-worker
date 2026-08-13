import type { WorkerEnv } from '../types/env';

interface ReviewItemRow {
	id: string;
	source: string;
	title: string | null;
	event_date: string | null;
	venue: string | null;
	created_at: string;
	first_received_at: string;
	error_message: string | null;
	thumbnail_asset_id: string | null;
}

interface ReviewAssetRow {
	asset_id: string | null;
	intake_id: string | null;
	r2_object_key: string | null;
}

export interface AdminReviewItem {
	id: string;
	title: string | null;
	eventDate: string | null;
	venue: string | null;
	receivedAt: string;
	createdAt: string;
	reviewReason: string | null;
	source: string;
	thumbnailUrl: string | null;
}

export type DeleteReviewItemResult =
	| { success: true; reviewItemId: string; reviewItemFound: boolean; objectsDeleted: number }
	| { success: false; reviewItemId: string; reason: 'not_review_item' | 'r2_cleanup_failed' };

export async function listAdminReviewItems(db: D1Database): Promise<AdminReviewItem[]> {
	const result = await db.prepare(`
		SELECT s.id, s.source, s.created_at, s.first_received_at, s.error_message,
			CASE WHEN json_valid(d.ai_result_json) THEN json_extract(d.ai_result_json, '$.event.title') END title,
			CASE WHEN json_valid(d.ai_result_json) THEN json_extract(d.ai_result_json, '$.event.date') END event_date,
			CASE WHEN json_valid(d.ai_result_json) THEN json_extract(d.ai_result_json, '$.event.venueName') END venue,
			(SELECT i.asset_id FROM agent_submission_items i
			 WHERE i.submission_id = s.id AND i.item_type = 'image'
				AND i.asset_id IS NOT NULL AND i.r2_object_key IS NOT NULL
			 ORDER BY i.ordinal LIMIT 1) thumbnail_asset_id
		FROM agent_submissions s
		LEFT JOIN agent_submission_diagnostics d ON d.submission_id = s.id
		WHERE s.status = 'needs_review'
		ORDER BY s.created_at DESC, s.id DESC
	`).all<ReviewItemRow>();
	return (result.results ?? []).map((row) => ({
		id: row.id,
		title: row.title,
		eventDate: row.event_date,
		venue: row.venue,
		receivedAt: row.first_received_at,
		createdAt: row.created_at,
		reviewReason: row.error_message,
		source: row.source,
		thumbnailUrl: row.thumbnail_asset_id ? `/admin/assets/${encodeURIComponent(row.thumbnail_asset_id)}` : null,
	}));
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

export async function deleteAdminReviewItem(reviewItemId: string, env: WorkerEnv): Promise<DeleteReviewItemResult> {
	const submission = await env.DB.prepare('SELECT status FROM agent_submissions WHERE id = ? LIMIT 1')
		.bind(reviewItemId).first<{ status: string }>();
	if (!submission) return { success: true, reviewItemId, reviewItemFound: false, objectsDeleted: 0 };
	if (submission.status !== 'needs_review') return { success: false, reviewItemId, reason: 'not_review_item' };

	const assetResult = await env.DB.prepare(`
		SELECT i.asset_id, i.intake_id, i.r2_object_key
		FROM agent_submission_items i
		WHERE i.submission_id = ? AND NOT EXISTS (
			SELECT 1 FROM event_assets e
			WHERE (i.asset_id IS NOT NULL AND e.asset_id = i.asset_id)
				OR (i.r2_object_key IS NOT NULL AND e.r2_object_key = i.r2_object_key)
		)
	`).bind(reviewItemId).all<ReviewAssetRow>();
	const keys = new Set<string>(await listKeys(env.EVENT_INTAKES, `agent-submissions/${reviewItemId}/`));
	for (const asset of assetResult.results ?? []) {
		if (asset.r2_object_key) keys.add(asset.r2_object_key);
		if (asset.intake_id && asset.asset_id) {
			for (const key of await listKeys(env.EVENT_INTAKES, `intakes/${asset.intake_id}/assets/${asset.asset_id}/`)) keys.add(key);
		}
	}
	try {
		const values = [...keys];
		for (let offset = 0; offset < values.length; offset += 1000) await env.EVENT_INTAKES.delete(values.slice(offset, offset + 1000));
	} catch (error) {
		console.error(JSON.stringify({ event: 'admin_review_item_r2_delete_failed', reviewItemId, error: error instanceof Error ? error.message : String(error) }));
		return { success: false, reviewItemId, reason: 'r2_cleanup_failed' };
	}

	const results = await env.DB.batch([
		env.DB.prepare("UPDATE agent_v2_webhook_receipts SET submission_id = NULL WHERE submission_id = ? AND EXISTS (SELECT 1 FROM agent_submissions WHERE id = ? AND status = 'needs_review')").bind(reviewItemId, reviewItemId),
		env.DB.prepare("DELETE FROM agent_submission_diagnostics WHERE submission_id = ? AND EXISTS (SELECT 1 FROM agent_submissions WHERE id = ? AND status = 'needs_review')").bind(reviewItemId, reviewItemId),
		env.DB.prepare("DELETE FROM agent_submission_items WHERE submission_id = ? AND EXISTS (SELECT 1 FROM agent_submissions WHERE id = ? AND status = 'needs_review')").bind(reviewItemId, reviewItemId),
		env.DB.prepare("DELETE FROM agent_submissions WHERE id = ? AND status = 'needs_review'").bind(reviewItemId),
	]);
	if ((results[3].meta.changes ?? 0) !== 1) return { success: false, reviewItemId, reason: 'not_review_item' };
	return { success: true, reviewItemId, reviewItemFound: true, objectsDeleted: keys.size };
}
