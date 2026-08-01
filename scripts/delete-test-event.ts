import { getPlatformProxy } from 'wrangler';
import type { WorkerEnv } from '../src/types/env';
import {
	deleteEventWithAssetLinks,
	findEventCleanupTargetBySlug,
	isAssetLinkedToAnotherEvent,
} from '../src/services/event-repository';
import {
	deleteAssetRecordsAndOrphanedBatches,
	findBatchIdsByAssetIds,
	listBatchAssets,
} from '../src/services/line-image-batch-repository';
import { deleteAssetSpecificLineTextContexts } from '../src/services/line-text-context';
import { deleteR2ObjectsWithExactPrefix, deleteStoredAssetArtifacts } from '../src/services/event-intake';

const SUPPORTED_EVENT_SLUG = 'wine-dinner-by-chef-andrea-montella-tenute-girolamo-2026-08-05';
const TARGET_EVENT_SLUG = 'wine-dinner-by-chef-andrea-montella-tenute-girolamo-2026-08-05';

async function main(): Promise<void> {
	if (process.argv.length !== 2 || TARGET_EVENT_SLUG !== SUPPORTED_EVENT_SLUG) {
		console.log('Unsupported event slug.');
		process.exitCode = 1;
		return;
	}

	const platform = await getPlatformProxy<WorkerEnv>({
		configPath: 'wrangler.jsonc',
		remoteBindings: true,
	});
	try {
		const target = await findEventCleanupTargetBySlug(platform.env.DB, TARGET_EVENT_SLUG);
		if (!target) {
			console.log('Event not found.');
			return;
		}

		const ownedAssets = [];
		for (const asset of target.assets) {
			if (!await isAssetLinkedToAnotherEvent(platform.env.DB, asset.assetId, target.id)) ownedAssets.push(asset);
		}
		const ownedAssetIds = ownedAssets.map((asset) => asset.assetId);
		const candidateBatchIds = await findBatchIdsByAssetIds(platform.env.DB, ownedAssetIds);
		const orphanedBatchIds: string[] = [];
		for (const batchId of candidateBatchIds) {
			const batchAssets = await listBatchAssets(platform.env.DB, batchId);
			if (batchAssets.every((asset) => ownedAssetIds.includes(asset.assetId))) orphanedBatchIds.push(batchId);
		}

		let deletedR2Objects = 0;
		let deletedOcrArtifacts = 0;
		for (const asset of ownedAssets) {
			const deleted = await deleteStoredAssetArtifacts(platform.env.EVENT_INTAKES, asset);
			deletedR2Objects += deleted.objects;
			deletedOcrArtifacts += deleted.ocrArtifacts;
		}
		for (const batchId of orphanedBatchIds) {
			const deleted = await deleteR2ObjectsWithExactPrefix(platform.env.EVENT_INTAKES, `line-batches/${batchId}/`);
			deletedR2Objects += deleted.objects;
		}

		await deleteAssetSpecificLineTextContexts(
			platform.env.DB,
			target.id,
			ownedAssetIds,
			ownedAssets.flatMap((asset) => asset.sourceMessageId ? [asset.sourceMessageId] : []),
		);
		const eventDeletion = await deleteEventWithAssetLinks(platform.env.DB, target.id, target.assets.map((asset) => asset.assetId));
		const assetDeletion = await deleteAssetRecordsAndOrphanedBatches(platform.env.DB, ownedAssetIds, orphanedBatchIds);

		if (eventDeletion.event !== 1) throw new Error('The target event was not deleted.');
		console.log(`Deleted event:\n${TARGET_EVENT_SLUG}\n`);
		console.log(`Deleted event_assets:\n${eventDeletion.eventAssets}\n`);
		console.log(`Deleted assets:\n${ownedAssets.length}\n`);
		console.log(`Deleted OCR artifacts:\n${deletedOcrArtifacts}\n`);
		console.log(`Deleted R2 objects:\n${deletedR2Objects}\n`);
		console.log(`Deleted orphaned batches:\n${assetDeletion.orphanedBatchIds.length}\n`);
		console.log('Done.');
	} finally {
		await platform.dispose();
	}
}

void main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
