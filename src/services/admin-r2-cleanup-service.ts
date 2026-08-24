import type { WorkerEnv } from '../types/env';

const DEFAULT_MIN_AGE_DAYS = 14;
const MAX_MIN_AGE_DAYS = 3650;

interface AssetReferenceRow {
	asset_id: string;
}

interface IntakeAssetIdentity {
	intakeId: string;
	assetId: string;
	prefix: string;
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
	return {
		intakeId: match[1],
		assetId: match[2],
		prefix: `intakes/${match[1]}/assets/${match[2]}/`,
	};
}

async function protectedAssetIds(db: D1Database): Promise<Set<string>> {
	const result = await db.prepare(`
		SELECT asset_id FROM event_assets
		UNION
		SELECT asset_id FROM agent_submission_items
		 WHERE asset_id IS NOT NULL
		   AND submission_id IN (
			SELECT id FROM agent_submissions
			WHERE status IN ('pending', 'processing', 'needs_review')
		   )
		UNION
		SELECT asset_id FROM line_image_batch_assets
		 WHERE batch_id IN (
			SELECT id FROM line_image_batches
			WHERE status IN ('collecting', 'processing')
		 )
		UNION
		SELECT asset_id FROM line_delivery_outbox
		 WHERE asset_id IS NOT NULL
		   AND status NOT IN ('completed', 'failed', 'needs_reconciliation')
	`).all<AssetReferenceRow>();
	return new Set((result.results ?? []).map((row) => row.asset_id));
}

function uploadedAtMillis(object: R2Object): number {
	const value = object.uploaded instanceof Date ? object.uploaded.getTime() : new Date(object.uploaded).getTime();
	return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

export async function inspectR2CleanupCandidates(
	env: WorkerEnv,
	options: { minAgeDays?: number; now?: Date } = {},
): Promise<R2CleanupDryRunResult> {
	const minAgeDays = clampMinAgeDays(options.minAgeDays);
	const now = options.now ?? new Date();
	const cutoffMs = now.getTime() - minAgeDays * 24 * 60 * 60 * 1000;
	const cutoff = new Date(cutoffMs).toISOString();
	const [objects, protectedIds] = await Promise.all([
		listAllObjects(env.EVENT_INTAKES),
		protectedAssetIds(env.DB),
	]);

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

	const candidates: R2CleanupCandidate[] = [];
	let protectedAssets = 0;
	for (const { identity, objects: assetObjects } of grouped.values()) {
		if (protectedIds.has(identity.assetId)) {
			protectedAssets++;
			continue;
		}
		const timestamps = assetObjects.map(uploadedAtMillis);
		const newestMs = Math.max(...timestamps);
		if (!Number.isFinite(newestMs) || newestMs >= cutoffMs) continue;
		const oldestMs = Math.min(...timestamps);
		candidates.push({
			intakeId: identity.intakeId,
			assetId: identity.assetId,
			prefix: identity.prefix,
			objectCount: assetObjects.length,
			byteSize: assetObjects.reduce((sum, object) => sum + object.size, 0),
			oldestUploadedAt: Number.isFinite(oldestMs) ? new Date(oldestMs).toISOString() : null,
			newestUploadedAt: Number.isFinite(newestMs) ? new Date(newestMs).toISOString() : null,
			keys: assetObjects.map((object) => object.key).sort(),
		});
	}

	candidates.sort((a, b) => (a.newestUploadedAt ?? '').localeCompare(b.newestUploadedAt ?? '') || a.assetId.localeCompare(b.assetId));
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
		candidates,
	};
}
