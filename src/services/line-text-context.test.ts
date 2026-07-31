import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	buildLineConversationKey,
	claimLineTextContext,
	markLineTextContextLinked,
	storePendingLineText,
} from './line-text-context';

declare module 'cloudflare:test' {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

beforeAll(async () => {
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS line_text_contexts (
			message_id TEXT PRIMARY KEY,
			conversation_key TEXT NOT NULL,
			text_content TEXT NOT NULL,
			received_at TEXT NOT NULL,
			consumed_at TEXT,
			linked_image_asset_id TEXT UNIQUE,
			linked_event_id TEXT
		)`,
	).run();
});

beforeEach(async () => {
	await env.DB.prepare('DELETE FROM line_text_contexts').run();
});

async function store(messageId: string, conversationKey: string, receivedAt: string): Promise<void> {
	await storePendingLineText(env.DB, {
		messageId,
		conversationKey,
		text: `Text for ${messageId}`,
		receivedAt,
	});
}

describe('LINE text context correlation', () => {
	it('builds conservative user, group, and room keys', () => {
		expect(buildLineConversationKey({ userId: 'u1' })).toBe('user:u1');
		expect(buildLineConversationKey({ groupId: 'g1', userId: 'u1' })).toBe('group:g1:user:u1');
		expect(buildLineConversationKey({ roomId: 'r1', userId: 'u1' })).toBe('room:r1:user:u1');
		expect(buildLineConversationKey(undefined)).toBeNull();
	});

	it('correlates the newest eligible text followed by an image in the same conversation', async () => {
		await store('text-1', 'user:u1', '2026-08-15T10:00:00.000Z');
		await store('text-2', 'user:u1', '2026-08-15T10:05:00.000Z');

		const claimed = await claimLineTextContext(env.DB, {
			conversationKey: 'user:u1',
			imageAssetId: 'image-1',
			imageReceivedAt: '2026-08-15T10:06:00.000Z',
			windowSeconds: 600,
		});

		expect(claimed?.messageId).toBe('text-2');
	});

	it('does not correlate text from another conversation', async () => {
		await store('text-1', 'user:u2', '2026-08-15T10:00:00.000Z');

		expect(await claimLineTextContext(env.DB, {
			conversationKey: 'user:u1',
			imageAssetId: 'image-1',
			imageReceivedAt: '2026-08-15T10:01:00.000Z',
			windowSeconds: 600,
		})).toBeNull();
	});

	it('ignores expired text', async () => {
		await store('text-1', 'user:u1', '2026-08-15T09:00:00.000Z');

		expect(await claimLineTextContext(env.DB, {
			conversationKey: 'user:u1',
			imageAssetId: 'image-1',
			imageReceivedAt: '2026-08-15T10:00:01.000Z',
			windowSeconds: 600,
		})).toBeNull();
	});

	it('does not reuse consumed text for another image', async () => {
		await store('text-1', 'user:u1', '2026-08-15T10:00:00.000Z');
		await claimLineTextContext(env.DB, {
			conversationKey: 'user:u1', imageAssetId: 'image-1', imageReceivedAt: '2026-08-15T10:01:00.000Z', windowSeconds: 600,
		});

		expect(await claimLineTextContext(env.DB, {
			conversationKey: 'user:u1', imageAssetId: 'image-2', imageReceivedAt: '2026-08-15T10:02:00.000Z', windowSeconds: 600,
		})).toBeNull();
	});

	it('returns the same claim for repeated image processing and persists the event link', async () => {
		await store('text-1', 'user:u1', '2026-08-15T10:00:00.000Z');
		const input = {
			conversationKey: 'user:u1', imageAssetId: 'image-1', imageReceivedAt: '2026-08-15T10:01:00.000Z', windowSeconds: 600,
		};
		const first = await claimLineTextContext(env.DB, input);
		await markLineTextContextLinked(env.DB, 'text-1', 'event-1');
		const repeated = await claimLineTextContext(env.DB, input);

		expect(repeated?.messageId).toBe(first?.messageId);
		expect(repeated?.linkedEventId).toBe('event-1');
	});

	it('stores duplicate webhook delivery idempotently without replacing original text', async () => {
		const first = await storePendingLineText(env.DB, {
			messageId: 'text-1', conversationKey: 'user:u1', text: 'Original', receivedAt: '2026-08-15T10:00:00.000Z',
		});
		const duplicate = await storePendingLineText(env.DB, {
			messageId: 'text-1', conversationKey: 'user:u1', text: 'Changed', receivedAt: '2026-08-15T10:01:00.000Z',
		});
		const row = await env.DB.prepare(
			'SELECT text_content FROM line_text_contexts WHERE message_id = ?',
		).bind('text-1').first<{ text_content: string }>();

		expect(first).toBe(true);
		expect(duplicate).toBe(false);
		expect(row?.text_content).toBe('Original');
	});
});
