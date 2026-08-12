export type EnrichmentStatus = 'pending' | 'processing' | 'complete' | 'partial' | 'failed' | 'retryable' | 'permanently_failed';

export async function initializeEventEnrichment(
	db: D1Database,
	input: { assetId: string; eventId: string; intakeId: string },
): Promise<void> {
	const now = new Date().toISOString();
	await db.prepare(
		`INSERT INTO event_enrichment_state (asset_id,event_id,intake_id,status,ocr_status,extraction_status,qr_status,attempt_count,created_at,updated_at)
		 VALUES (?, ?, ?, 'pending', 'processing', 'pending', 'pending', 0, ?, ?)
		 ON CONFLICT(asset_id) DO UPDATE SET event_id=excluded.event_id, intake_id=excluded.intake_id, updated_at=excluded.updated_at`,
	).bind(input.assetId, input.eventId, input.intakeId, now, now).run();
}

export async function recordAssetEnrichment(
	db: D1Database,
	input: {
		assetId: string;
		status?: EnrichmentStatus;
		ocrStatus?: 'pending' | 'processing' | 'complete' | 'failed';
		extractionStatus?: 'pending' | 'processing' | 'complete' | 'partial' | 'failed';
		qrStatus?: 'pending' | 'processing' | 'complete' | 'not_available' | 'failed';
		model?: string | null;
		errorCode?: string | null;
		incrementAttempt?: boolean;
		nextRetryAt?: string | null;
	},
): Promise<void> {
	const now = new Date().toISOString();
	await db.prepare(
		`UPDATE event_enrichment_state SET
		 status=COALESCE(?,status), ocr_status=COALESCE(?,ocr_status), extraction_status=COALESCE(?,extraction_status),
		 qr_status=COALESCE(?,qr_status), model=COALESCE(?,model), last_error_code=?,
		 attempt_count=attempt_count+?, last_attempted_at=CASE WHEN ?=1 THEN ? ELSE last_attempted_at END,
		 next_retry_at=?, updated_at=? WHERE asset_id=?`,
	).bind(input.status ?? null, input.ocrStatus ?? null, input.extractionStatus ?? null, input.qrStatus ?? null,
		input.model ?? null, input.errorCode ?? null, input.incrementAttempt ? 1 : 0, input.incrementAttempt ? 1 : 0, now,
		input.nextRetryAt ?? null, now, input.assetId).run();
}
