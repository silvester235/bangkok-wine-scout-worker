import type { BatchProcessingMessage } from './line-image-batch-processing';

export async function queueEventReprocess(eventId: string, env: { DB: D1Database; IMAGE_PROCESSING_QUEUE: Queue }): Promise<{ batchId: string } | null> {
	const batch = await env.DB.prepare(
		`SELECT b.id, b.last_received_at
		 FROM line_image_batches b
		 JOIN line_image_batch_assets ba ON ba.batch_id=b.id
		 JOIN event_assets ea ON ea.asset_id=ba.asset_id
		 WHERE ea.event_id=?
		 ORDER BY COALESCE(b.created_at,b.first_received_at) DESC LIMIT 1`,
	).bind(eventId).first<{ id: string; last_received_at: string }>();
	if (!batch) return null;
	const now = new Date().toISOString();
	await env.DB.batch([
		env.DB.prepare(`UPDATE line_image_batches SET status='failed', processing_at=NULL, completed_at=NULL, error=NULL,
			 attempt_count=0, notification_sent_at=NULL, resulting_event_ids_json='[]', pending_asset_wait_count=0,
			 first_pending_asset_wait_at=NULL, last_pending_asset_wait_at=NULL, pending_asset_wait_deadline_at=NULL,
			 continuation_state='manual_reprocess', continuation_claim_token=NULL, continuation_enqueue_error=NULL,
			 reconciliation_required_at=NULL, updated_at=? WHERE id=?`).bind(now,batch.id),
		env.DB.prepare(`UPDATE event_enrichment_state SET status='retryable', extraction_status='pending', attempt_count=0,
		 next_retry_at=?, last_error_code=NULL, updated_at=? WHERE event_id=?`).bind(now,now,eventId),
	]);
	await env.IMAGE_PROCESSING_QUEUE.send({type:'process_batch',batchId:batch.id,expectedLastReceivedAt:batch.last_received_at} satisfies BatchProcessingMessage);
	return { batchId: batch.id };
}
