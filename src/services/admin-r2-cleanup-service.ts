import type { WorkerEnv } from '../types/env';

const DEFAULT_MIN_AGE_DAYS = 14;
const MAX_MIN_AGE_DAYS = 3650;
const ACTIVE_AGENT_STATUSES = new Set(['collecting', 'queued', 'processing', 'needs_review']);
const ACTIVE_BATCH_STATUSES = new Set(['collecting', 'processing', 'needs_review']);
const ACTIVE_OUTBOX_STATUSES = new Set(['pending', 'leased', 'retryable', 'enqueued', 'uncertain']);

interface AssetReferenceRow { asset_id: string; }
interface EventReferenceRow { asset_id: string; event_id: string; }
interface SubmissionReferenceRow {
	asset_id: string;
	submission_id: string;
	status: string;
	result_event_id: string | null;
}
interface BatchReferenceRow {
	asset_id: string;
	batch_id: string;
	status: string;
	resulting_event_ids_json: string;
}
interface OutboxReferenceRow { asset_id: string; status: string; }

interface IntakeAssetIdentity {
	intakeId: string;
	assetId: string;
	prefix: string;
}

export type R2CleanupPipeline = 'v1_line' | 'v2_agent' | 'text_or_web' | 'unknown';

export interface R2CleanupSafety {
	safeToDelete: boolean;
	reasons: string[];
	pipeline: R2CleanupPipeline;
	eventIds: string[];
	submission: { id: string; status: string; resultEventId: string | null } | null;
	batch: { id: string; status: string; resultingEventIds: string[] } | null;
	activeOutboxStatuses: string[];
	hashIndexKey: string | null;
	hashIndexOwnedByCandidate: boolean;
}

export interface R2CleanupCandidate {
	intakeId: string;
	assetId: string;
	prefix: string;
	objectCount: number;
	byteSize: number;
	oldestUploadedAt: string | null;
	newestUploadedAt: string | null;
	keys: string[];
	safety: R2CleanupSafety;
}

export interface R2CleanupDryRunResult {
	dryRun: true;
	minAgeDays: number;
	cutoff: string;
	scannedObjects: number;
	scannedBytes: number;
	intakeAssetPrefixes: number;
	protectedAssets: number;
	candidateAssets: number;
	candidateObjects: number;
	candidateBytes: number;
	safeToDeleteAssets: number;
	safeToDeleteObjects: number;
	safeToDeleteBytes: number;
	candidates: R2CleanupCandidate[];
}

function clampMinAgeDays(value: number | undefined): number {
	if (value === undefined) return DEFAULT_MIN_AGE_DAYS;
	if (!Number.isInteger(value) || value < 1 || value > MAX_MIN_AGE_DAYS) {
		throw new Error(`minAgeDays must be an integer from 1 to ${MAX_MIN_AGE_DAYS}.`);
	}
	return value;
}

async function listAllObjects(bucket: R2Bucket): Promise<R2Object[]> {
	const objects: R2Object[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ cursor });
		objects.push(...page.objects);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return objects;
}

function parseIntakeAssetKey(key: string): IntakeAssetIdentity | null {
	const match = /^intakes\/([^/]+)\/assets\/([^/]+)\//.exec(key);
	if (!match) return null;
	return { intakeId: match[1], assetId: match[2], prefix: `intakes/${match[1]}/assets/${match[2]}/` };
}

function parseEventIds(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
	} catch {
		return [];
	}
}

async function protectedAssetIds(db: D1Database): Promise<Set<string>> {
	const result = await db.prepare(`
		SELECT asset_id FROM event_assets
		UNION
		SELECT asset_id FROM agent_submission_items
		 WHERE asset_id IS NOT NULL
		   AND submission_id IN (
			SELECT id FROM agent_submissions
			WHERE status IN ('collecting', 'queued', 'processing', 'needs_review')
		   )
		UNION
		SELECT asset_id FROM line_image_batch_assets
		 WHERE batch_id IN (
			SELECT id FROM line_image_batches
			WHERE status IN ('collecting', 'processing', 'needs_review')
		 )
		UNION
		SELECT asset_id FROM line_delivery_outbox
		 WHERE asset_id IS NOT NULL
		   AND status IN ('pending', 'leased', 'retryable', 'enqueued', 'uncertain')
	`).all<AssetReferenceRow>();
	return new Set((result.results ?? []).map((row) => row.asset_id));
}

function uploadedAtMillis(object: R2Object): number {
	const value = object.uploaded instanceof Date ? object.uploaded.getTime() : new Date(object.uploaded).getTime();
	return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function pipelineFor(identity: IntakeAssetIdentity): R2CleanupPipeline {
	if (identity.intakeId.startsWith('agent-line-')) return 'v2_agent';
	if (identity.intakeId.startsWith('line-text-') || identity.intakeId.startsWith('line-web-')) return 'text_or_web';
	if (identity.intakeId.startsWith('line-')) return 'v1_line';
	return 'unknown';
}

function placeholders(count: number): string { return Array.from({ length: count }, () => '?').join(','); }

async function loadReferenceMaps(db: D1Database, assetIds: string[]): Promise<{
	events: Map<string, string[]>;
	submissions: Map<string, SubmissionReferenceRow>;
	batches: Map<string, BatchReferenceRow>;
	outbox: Map<string, string[]>;
}> {
	const events = new Map<string, string[]>();
	const submissions = new Map<string, SubmissionReferenceRow>();
	const batches = new Map<string, BatchReferenceRow>();
	const outbox = new Map<string, string[]>();
	if (assetIds.length === 0) return { events, submissions, batches, outbox };
	const slots = placeholders(assetIds.length);
	const [eventResult, submissionResult, batchResult, outboxResult] = await Promise.all([
		db.prepare(`SELECT asset_id, event_id FROM event_assets WHERE asset_id IN (${slots})`).bind(...assetIds).all<EventReferenceRow>(),
		db.prepare(`SELECT i.asset_id, s.id AS submission_id, s.status, s.result_event_id
			FROM agent_submission_items i JOIN agent_submissions s ON s.id = i.submission_id
			WHERE i.asset_id IN (${slots})`).bind(...assetIds).all<SubmissionReferenceRow>(),
		db.prepare(`SELECT a.asset_id, b.id AS batch_id, b.status, b.resulting_event_ids_json
			FROM line_image_batch_assets a JOIN line_image_batches b ON b.id = a.batch_id
			WHERE a.asset_id IN (${slots})`).bind(...assetIds).all<BatchReferenceRow>(),
		db.prepare(`SELECT asset_id, status FROM line_delivery_outbox
			WHERE asset_id IN (${slots})`).bind(...assetIds).all<OutboxReferenceRow>(),
	]);
	for (const row of eventResult.results ?? []) events.set(row.asset_id, [...(events.get(row.asset_id) ?? []), row.event_id]);
	for (const row of submissionResult.results ?? []) submissions.set(row.asset_id, row);
	for (const row of batchResult.results ?? []) batches.set(row.asset_id, row);
	for (const row of outboxResult.results ?? []) outbox.set(row.asset_id, [...(outbox.get(row.asset_id) ?? []), row.status]);
	return { events, submissions, batches, outbox };
}

async function resolveHashIndex(bucket: R2Bucket, identity: IntakeAssetIdentity): Promise<{ key: string | null; owned: boolean }> {
	const metadata = await bucket.get(`${identity.prefix}metadata.json`);
	if (!metadata) return { key: null, owned: false };
	try {
		const value = await metadata.json<{ contentHash?: { value?: string } }>();
		const hash = value.contentHash?.value;
		if (!hash) return { key: null, owned: false };
		const key = `image-hashes/sha256/${hash}.json`;
		const index = await bucket.get(key);
		if (!index) return { key, owned: false };
		const owner = await index.json<{ assetId?: string; intakeId?: string }>();
		return { key, owned: owner.assetId === identity.assetId && owner.intakeId === identity.intakeId };
	} catch {
		return { key: null, owned: false };
	}
}

export function classifyCleanupSafety(input: {
	pipeline: R2CleanupPipeline;
	eventIds?: string[];
	submission?: { id: string; status: string; resultEventId: string | null } | null;
	batch?: { id: string; status: string; resultingEventIds: string[] } | null;
	outboxStatuses?: string[];
	hashIndexKey?: string | null;
	hashIndexOwnedByCandidate?: boolean;
}): R2CleanupSafety {
	const eventIds = input.eventIds ?? [];
	const submission = input.submission ?? null;
	const batch = input.batch ?? null;
	const activeOutboxStatuses = (input.outboxStatuses ?? []).filter((status) => ACTIVE_OUTBOX_STATUSES.has(status));
	const reasons: string[] = [];
	if (eventIds.length > 0) reasons.push('referenced_by_event');
	if (submission && ACTIVE_AGENT_STATUSES.has(submission.status)) reasons.push(`active_agent_submission:${submission.status}`);
	if (submission?.resultEventId) reasons.push('agent_submission_has_result_event');
	if (submission?.status === 'published') reasons.push('agent_submission_published');
	if (batch && ACTIVE_BATCH_STATUSES.has(batch.status)) reasons.push(`active_or_review_line_batch:${batch.status}`);
	if (batch && batch.resultingEventIds.length > 0) reasons.push('line_batch_has_result_event');
	if (activeOutboxStatuses.length > 0) reasons.push('active_delivery_outbox');
	return {
		safeToDelete: reasons.length === 0,
		reasons,
		pipeline: input.pipeline,
		eventIds,
		submission,
		batch,
		activeOutboxStatuses,
		hashIndexKey: input.hashIndexKey ?? null,
		hashIndexOwnedByCandidate: input.hashIndexOwnedByCandidate ?? false,
	};
}

export async function inspectR2CleanupCandidates(
	env: WorkerEnv,
	options: { minAgeDays?: number; now?: Date } = {},
): Promise<R2CleanupDryRunResult> {
	const minAgeDays = clampMinAgeDays(options.minAgeDays);
	const now = options.now ?? new Date();
	const cutoffMs = now.getTime() - minAgeDays * 24 * 60 * 60 * 1000;
	const cutoff = new Date(cutoffMs).toISOString();
	const [objects, protectedIds] = await Promise.all([listAllObjects(env.EVENT_INTAKES), protectedAssetIds(env.DB)]);

	const grouped = new Map<string, { identity: IntakeAssetIdentity; objects: R2Object[] }>();
	let scannedBytes = 0;
	for (const object of objects) {
		scannedBytes += object.size;
		const identity = parseIntakeAssetKey(object.key);
		if (!identity) continue;
		const existing = grouped.get(identity.prefix);
		if (existing) existing.objects.push(object);
		else grouped.set(identity.prefix, { identity, objects: [object] });
	}

	const prelim: Array<{ identity: IntakeAssetIdentity; assetObjects: R2Object[]; oldestMs: number; newestMs: number }> = [];
	let protectedAssets = 0;
	for (const { identity, objects: assetObjects } of grouped.values()) {
		if (protectedIds.has(identity.assetId)) { protectedAssets++; continue; }
		const timestamps = assetObjects.map(uploadedAtMillis);
		const newestMs = Math.max(...timestamps);
		if (!Number.isFinite(newestMs) || newestMs >= cutoffMs) continue;
		prelim.push({ identity, assetObjects, oldestMs: Math.min(...timestamps), newestMs });
	}

	const references = await loadReferenceMaps(env.DB, prelim.map(({ identity }) => identity.assetId));
	const candidates: R2CleanupCandidate[] = [];
	for (const { identity, assetObjects, oldestMs, newestMs } of prelim) {
		const submissionRow = references.submissions.get(identity.assetId);
		const batchRow = references.batches.get(identity.assetId);
		const hash = await resolveHashIndex(env.EVENT_INTAKES, identity);
		const safety = classifyCleanupSafety({
			pipeline: pipelineFor(identity),
			eventIds: references.events.get(identity.assetId) ?? [],
			submission: submissionRow ? { id: submissionRow.submission_id, status: submissionRow.status, resultEventId: submissionRow.result_event_id } : null,
			batch: batchRow ? { id: batchRow.batch_id, status: batchRow.status, resultingEventIds: parseEventIds(batchRow.resulting_event_ids_json) } : null,
			outboxStatuses: references.outbox.get(identity.assetId) ?? [],
			hashIndexKey: hash.key,
			hashIndexOwnedByCandidate: hash.owned,
		});
		candidates.push({
			intakeId: identity.intakeId,
			assetId: identity.assetId,
			prefix: identity.prefix,
			objectCount: assetObjects.length,
			byteSize: assetObjects.reduce((sum, object) => sum + object.size, 0),
			oldestUploadedAt: Number.isFinite(oldestMs) ? new Date(oldestMs).toISOString() : null,
			newestUploadedAt: Number.isFinite(newestMs) ? new Date(newestMs).toISOString() : null,
			keys: assetObjects.map((object) => object.key).sort(),
			safety,
		});
	}

	candidates.sort((a, b) => (a.newestUploadedAt ?? '').localeCompare(b.newestUploadedAt ?? '') || a.assetId.localeCompare(b.assetId));
	const safe = candidates.filter((candidate) => candidate.safety.safeToDelete);
	return {
		dryRun: true,
		minAgeDays,
		cutoff,
		scannedObjects: objects.length,
		scannedBytes,
		intakeAssetPrefixes: grouped.size,
		protectedAssets,
		candidateAssets: candidates.length,
		candidateObjects: candidates.reduce((sum, candidate) => sum + candidate.objectCount, 0),
		candidateBytes: candidates.reduce((sum, candidate) => sum + candidate.byteSize, 0),
		safeToDeleteAssets: safe.length,
		safeToDeleteObjects: safe.reduce((sum, candidate) => sum + candidate.objectCount, 0),
		safeToDeleteBytes: safe.reduce((sum, candidate) => sum + candidate.byteSize, 0),
		candidates,
	};
}
