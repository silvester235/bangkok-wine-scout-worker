import { inspectR2CleanupCandidates, type R2CleanupCandidate } from './admin-r2-cleanup-service';
import type { WorkerEnv } from '../types/env';

const ACTIVE_AGENT_STATUSES = ['collecting', 'queued', 'processing', 'needs_review'];
const ACTIVE_BATCH_STATUSES = ['collecting', 'processing', 'needs_review'];
const ACTIVE_OUTBOX_STATUSES = ['pending', 'leased', 'retryable', 'enqueued', 'uncertain'];

export interface R2CleanupDeleteResult {
	success: boolean;
	minAgeDays: number;
	requestedAssets: number;
	deletedAssets: number;
	skippedAssets: number;
	objectsDeleted: number;
	objectsMissing: number;
	objectsFailed: number;
	bytesScheduledForDeletion: number;
	failedKeys: string[];
	results: Array<{ assetId: string; intakeId: string; deleted: boolean; reasons: string[]; keys: string[] }>;
}

async function hasCurrentProtection(db: D1Database, candidate: R2CleanupCandidate): Promise<string[]> {
	const reasons: string[] = [];
	const assetId = candidate.assetId;

	const eventReference = await db.prepare(
		`SELECT event_id FROM event_assets WHERE asset_id = ?1 OR r2_object_key LIKE ?2 LIMIT 1`,
	).bind(assetId, `${candidate.prefix}%`).first<{ event_id: string }>();
	if (eventReference) reasons.push(`referenced_by_event:${eventReference.event_id}`);

	const submission = await db.prepare(
		`SELECT s.status, s.result_event_id FROM agent_submission_items i
		 JOIN agent_submissions s ON s.id = i.submission_id
		 WHERE i.asset_id = ? LIMIT 1`,
	).bind(assetId).first<{ status: string; result_event_id: string | null }>();
	if (submission) {
		if (ACTIVE_AGENT_STATUSES.includes(submission.status)) reasons.push(`active_agent_submission:${submission.status}`);
		if (submission.result_event_id) reasons.push(`agent_submission_has_result_event:${submission.result_event_id}`);
		if (submission.status === 'published') reasons.push('agent_submission_published');
	}

	const batch = await db.prepare(
		`SELECT b.status, b.resulting_event_ids_json FROM line_image_batch_assets a
		 JOIN line_image_batches b ON b.id = a.batch_id WHERE a.asset_id = ? LIMIT 1`,
	).bind(assetId).first<{ status: string; resulting_event_ids_json: string }>();
	if (batch) {
		if (ACTIVE_BATCH_STATUSES.includes(batch.status)) reasons.push(`active_or_review_line_batch:${batch.status}`);
		try {
			const ids = JSON.parse(batch.resulting_event_ids_json) as unknown;
			if (Array.isArray(ids) && ids.some((id) => typeof id === 'string' && id.length > 0)) reasons.push('line_batch_has_result_event');
		} catch {
			reasons.push('line_batch_result_event_state_unreadable');
		}
	}

	const outbox = await db.prepare(
		`SELECT status FROM line_delivery_outbox WHERE asset_id = ? AND status IN ('pending','leased','retryable','enqueued','uncertain') LIMIT 1`,
	).bind(assetId).first<{ status: string }>();
	if (outbox && ACTIVE_OUTBOX_STATUSES.includes(outbox.status)) reasons.push(`active_delivery_outbox:${outbox.status}`);
	return reasons;
}

async function listPrefixKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor });
		keys.push(...page.objects.map((object) => object.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return keys;
}

async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<{ deleted: number; missing: number; failedKeys: string[] }> {
	const existing: string[] = [];
	let missing = 0;
	const failedKeys: string[] = [];
	for (const key of keys) {
		try {
			if (await bucket.head(key)) existing.push(key);
			else missing++;
		} catch {
			failedKeys.push(key);
		}
	}
	let deleted = 0;
	for (let offset = 0; offset < existing.length; offset += 1000) {
		const chunk = existing.slice(offset, offset + 1000);
		try {
			await bucket.delete(chunk);
			deleted += chunk.length;
		} catch {
			for (const key of chunk) {
				try { await bucket.delete(key); deleted++; }
				catch { failedKeys.push(key); }
			}
		}
	}
	return { deleted, missing, failedKeys: [...new Set(failedKeys)] };
}

export async function deleteSafeR2CleanupCandidates(
	env: WorkerEnv,
	options: { minAgeDays?: number; assetIds?: string[] } = {},
): Promise<R2CleanupDeleteResult> {
	const scan = await inspectR2CleanupCandidates(env, { minAgeDays: options.minAgeDays });
	const requested = options.assetIds?.length ? new Set(options.assetIds) : null;
	const targets = scan.candidates.filter((candidate) => candidate.safety.safeToDelete && (!requested || requested.has(candidate.assetId)));
	const unknownRequested = requested
		? [...requested].filter((assetId) => !scan.candidates.some((candidate) => candidate.assetId === assetId && candidate.safety.safeToDelete))
		: [];

	const result: R2CleanupDeleteResult = {
		success: true,
		minAgeDays: scan.minAgeDays,
		requestedAssets: requested?.size ?? targets.length,
		deletedAssets: 0,
		skippedAssets: unknownRequested.length,
		objectsDeleted: 0,
		objectsMissing: 0,
		objectsFailed: 0,
		bytesScheduledForDeletion: 0,
		failedKeys: [],
		results: unknownRequested.map((assetId) => ({ assetId, intakeId: '', deleted: false, reasons: ['not_currently_safe_to_delete'], keys: [] })),
	};

	for (const candidate of targets) {
		const firstReasons = await hasCurrentProtection(env.DB, candidate);
		if (firstReasons.length > 0) {
			result.skippedAssets++;
			result.results.push({ assetId: candidate.assetId, intakeId: candidate.intakeId, deleted: false, reasons: firstReasons, keys: [] });
			continue;
		}

		const keys = await listPrefixKeys(env.EVENT_INTAKES, candidate.prefix);
		if (candidate.safety.hashIndexKey && candidate.safety.hashIndexOwnedByCandidate) keys.push(candidate.safety.hashIndexKey);

		// Revalidate immediately before the destructive R2 call.
		const finalReasons = await hasCurrentProtection(env.DB, candidate);
		if (finalReasons.length > 0) {
			result.skippedAssets++;
			result.results.push({ assetId: candidate.assetId, intakeId: candidate.intakeId, deleted: false, reasons: finalReasons, keys: [] });
			continue;
		}

		result.bytesScheduledForDeletion += candidate.byteSize;
		const uniqueKeys = [...new Set(keys)];
		const deletion = await deleteKeys(env.EVENT_INTAKES, uniqueKeys);
		result.objectsDeleted += deletion.deleted;
		result.objectsMissing += deletion.missing;
		result.objectsFailed += deletion.failedKeys.length;
		result.failedKeys.push(...deletion.failedKeys);
		const deleted = deletion.failedKeys.length === 0;
		if (deleted) result.deletedAssets++;
		else result.success = false;
		result.results.push({
			assetId: candidate.assetId,
			intakeId: candidate.intakeId,
			deleted,
			reasons: deleted ? [] : ['r2_delete_failed'],
			keys: uniqueKeys,
		});
	}

	result.failedKeys = [...new Set(result.failedKeys)];
	return result;
}
