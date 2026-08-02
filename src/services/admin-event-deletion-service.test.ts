import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteEvent } from './admin-event-deletion-service';

declare module 'cloudflare:test' {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY)'),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS event_assets (
			event_id TEXT NOT NULL, intake_id TEXT NOT NULL, asset_id TEXT NOT NULL,
			asset_role TEXT NOT NULL, linked_at TEXT NOT NULL, source_type TEXT NOT NULL,
			source_message_id TEXT, PRIMARY KEY (event_id, asset_id),
			FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
		)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS line_text_contexts (
			message_id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, text_content TEXT NOT NULL,
			received_at TEXT NOT NULL, linked_event_id TEXT
		)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS line_image_batches (
			id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, status TEXT NOT NULL,
			first_received_at TEXT NOT NULL, last_received_at TEXT NOT NULL, created_at TEXT NOT NULL,
			last_activity_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			resulting_event_ids_json TEXT NOT NULL DEFAULT '[]'
		)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS line_image_batch_assets (
			batch_id TEXT NOT NULL, asset_id TEXT NOT NULL, intake_id TEXT NOT NULL,
			line_message_id TEXT NOT NULL, source_reference TEXT NOT NULL, content_type TEXT NOT NULL,
			r2_object_key TEXT NOT NULL, received_at TEXT NOT NULL, conversation_key TEXT NOT NULL,
			ordinal INTEGER NOT NULL, PRIMARY KEY (batch_id, asset_id)
		)`),
		env.DB.prepare(`CREATE TABLE IF NOT EXISTS line_message_batch_texts (
			batch_id TEXT NOT NULL, message_id TEXT NOT NULL, asset_id TEXT NOT NULL,
			text_content TEXT NOT NULL, received_at TEXT NOT NULL, conversation_key TEXT NOT NULL,
			ordinal INTEGER NOT NULL, PRIMARY KEY (batch_id, message_id)
		)`),
	]);
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM line_text_contexts'),
		env.DB.prepare('DELETE FROM line_image_batch_assets'),
		env.DB.prepare('DELETE FROM line_message_batch_texts'),
		env.DB.prepare('DELETE FROM line_image_batches'),
		env.DB.prepare('DELETE FROM event_assets'),
		env.DB.prepare('DELETE FROM events'),
	]);
});

async function insertEvent(eventId: string): Promise<void> {
	await env.DB.prepare('INSERT INTO events (id) VALUES (?)').bind(eventId).run();
}

describe('admin event deletion service', () => {
	it('atomically detaches unsafe references, cascades assets, and preserves ingestion history', async () => {
		await insertEvent('event-1');
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO event_assets (
					event_id, intake_id, asset_id, asset_role, linked_at, source_type, source_message_id
				) VALUES (?, 'intake-1', 'asset-1', 'main', '2026-08-03T00:00:00.000Z', 'line_image', 'message-1')`,
			).bind('event-1'),
			env.DB.prepare(
				`INSERT INTO line_text_contexts
				 (message_id, conversation_key, text_content, received_at, linked_event_id)
				 VALUES ('context-1', 'user:1', 'context', '2026-08-03T00:00:00.000Z', 'event-1')`,
			),
			env.DB.prepare(
				`INSERT INTO line_image_batches (
					id, conversation_key, status, first_received_at, last_received_at,
					created_at, last_activity_at, expires_at, updated_at, resulting_event_ids_json
				) VALUES (
					'batch-1', 'user:1', 'completed', '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z',
					'2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z', '2026-08-03T00:01:00.000Z',
					'2026-08-03T00:00:00.000Z', '["event-1"]'
				)`,
			),
			env.DB.prepare(
				`INSERT INTO line_image_batch_assets (
					batch_id, asset_id, intake_id, line_message_id, source_reference,
					content_type, r2_object_key, received_at, conversation_key, ordinal
				) VALUES (
					'batch-1', 'asset-1', 'intake-1', 'message-1', 'message-1',
					'image/jpeg', 'objects/asset-1', '2026-08-03T00:00:00.000Z', 'user:1', 1
				)`,
			),
			env.DB.prepare(
				`INSERT INTO line_message_batch_texts (
					batch_id, message_id, asset_id, text_content, received_at, conversation_key, ordinal
				) VALUES (
					'batch-1', 'message-1', 'text-asset-1', 'text', '2026-08-03T00:00:00.000Z', 'user:1', 2
				)`,
			),
		]);

		const result = await deleteEvent(env.DB, 'event-1');

		expect(result).toEqual({
			eventId: 'event-1', deleted: true, eventFound: true,
			detachedReferences: { lineTextContexts: 1 },
			cascadeDeletedReferences: { eventAssetsBeforeDelete: 1 },
			preservedHistoricalReferences: { batchResultReferences: 1, batchAssets: 1, batchTexts: 1 },
			orphanCheck: { passed: true, remainingReferences: [] },
		});
		expect(await env.DB.prepare('SELECT linked_event_id FROM line_text_contexts').first('linked_event_id')).toBeNull();
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM line_image_batches').first<number>('count')).toBe(1);
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM line_image_batch_assets').first<number>('count')).toBe(1);
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM line_message_batch_texts').first<number>('count')).toBe(1);
	});

	it('returns a non-deletion report without changing similarly named references when the event is absent', async () => {
		await env.DB.prepare(
			`INSERT INTO line_text_contexts
			 (message_id, conversation_key, text_content, received_at, linked_event_id)
			 VALUES ('context-1', 'user:1', 'context', '2026-08-03T00:00:00.000Z', 'missing')`,
		).run();

		const result = await deleteEvent(env.DB, 'missing');

		expect(result.deleted).toBe(false);
		expect(result.eventFound).toBe(false);
		expect(result.detachedReferences.lineTextContexts).toBe(1);
		expect(result.orphanCheck).toEqual({
			passed: false,
			remainingReferences: [{ table: 'line_text_contexts', column: 'linked_event_id', count: 1 }],
		});
		expect(await env.DB.prepare('SELECT linked_event_id FROM line_text_contexts').first('linked_event_id')).toBe('missing');
	});

	it('rejects an empty event id', async () => {
		await expect(deleteEvent(env.DB, '')).rejects.toThrow('eventId must be a non-empty string');
	});
});
