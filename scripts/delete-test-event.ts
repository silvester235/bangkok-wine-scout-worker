import { getPlatformProxy } from 'wrangler';
import type { WorkerEnv } from '../src/types/env';
import { countEvents, findEventCleanupTargetBySlug } from '../src/services/event-repository';
import { deleteEventCompletely } from '../src/services/admin-event-deletion-service';

const SUPPORTED_EVENT_SLUG = 'wine-dinner-by-chef-andrea-montella-centara-grand-at-centralwordl-2026-08-05';
const TARGET_EVENT_SLUG = 'wine-dinner-by-chef-andrea-montella-centara-grand-at-centralwordl-2026-08-05';
const DATABASE_BINDING = 'DB';
const DATABASE_NAME = 'bangkok-wine-scout';
const DATABASE_ID = '0fe8aec8-170f-47da-8abb-303cae3d1103';
const CLEANUP_CONFIG = 'scripts/wrangler.delete-test-event.jsonc';

async function main(): Promise<void> {
	if (process.argv.length !== 2 || TARGET_EVENT_SLUG !== SUPPORTED_EVENT_SLUG) {
		console.log('Unsupported event slug.');
		process.exitCode = 1;
		return;
	}

	const platform = await getPlatformProxy<WorkerEnv>({
		configPath: CLEANUP_CONFIG,
		remoteBindings: true,
	});
	try {
		if (!platform.env.DB || !platform.env.EVENT_INTAKES) {
			throw new Error('Required cleanup bindings were not resolved.');
		}
		console.log(`Resolved database binding: ${DATABASE_BINDING}`);
		console.log('Remote mode active: true');
		console.log(`Resolved database: ${DATABASE_NAME} (${DATABASE_ID})`);
		console.log(`Events count: ${await countEvents(platform.env.DB)}`);
		console.log(`Lookup slug: ${TARGET_EVENT_SLUG}`);

		const target = await findEventCleanupTargetBySlug(platform.env.DB, TARGET_EVENT_SLUG);
		if (!target) {
			console.log('Event not found.');
			return;
		}

		const result = await deleteEventCompletely(target.id, platform.env);
		if (!result.success) throw new Error(`Cleanup is incomplete; retry required for ${result.r2.objectsFailed} R2 object(s).`);
		console.log(`Deleted event:\n${TARGET_EVENT_SLUG}\n`);
		console.log(`Deleted related database rows:\n${result.database.relatedRowsDeleted}\n`);
		console.log(`Deleted R2 objects:\n${result.r2.objectsDeleted}\n`);
		console.log(`Deleted LINE references:\n${result.line.referencesDeleted}\n`);
		console.log('Done.');
	} finally {
		await platform.dispose();
	}
}

void main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
