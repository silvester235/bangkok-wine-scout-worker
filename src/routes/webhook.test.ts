import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEnv } from '../types/env';
import type { LineWebhookPayload } from '../types/line';
import { processWebhookEvents } from './webhook';

const { replyToLine } = vi.hoisted(() => ({
	replyToLine: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/line', () => ({
	downloadLineMessageContent: vi.fn(),
	pushToLine: vi.fn(),
	replyToLine,
}));

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
	replyToLine.mockClear();
});

function textWebhook(messageId: string, text: string): LineWebhookPayload {
	return {
		events: [{
			type: 'message',
			replyToken: `reply-${messageId}`,
			timestamp: Date.parse('2026-08-15T10:00:00.000Z'),
			source: { userId: 'user-1' },
			message: { id: messageId, type: 'text', text },
		}],
	};
}

describe('LINE text webhook acknowledgement', () => {
	it('routes a known command and returns its command response', async () => {
		await processWebhookEvents(textWebhook('command-1', 'ping'), env as WorkerEnv);

		expect(replyToLine).toHaveBeenCalledWith('reply-command-1', 'pong', undefined);
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM line_text_contexts').first<{ count: number }>()).toEqual({ count: 0 });
	});

	it('stores event text and acknowledges the default correlation window', async () => {
		await processWebhookEvents(textWebhook('text-1', 'Wine dinner at 7pm'), env as WorkerEnv);
		const stored = await env.DB.prepare(
			'SELECT message_id, text_content FROM line_text_contexts WHERE message_id = ?',
		).bind('text-1').first<{ message_id: string; text_content: string }>();

		expect(stored).toEqual({ message_id: 'text-1', text_content: 'Wine dinner at 7pm' });
		expect(replyToLine).toHaveBeenCalledWith(
			'reply-text-1',
			'Event details received. Send the related flyer image within 10 minutes.',
			undefined,
		);
	});

	it('does not send the unknown-command response for stored event text', async () => {
		await processWebhookEvents(textWebhook('text-1', 'Wine dinner at 7pm'), env as WorkerEnv);

		expect(replyToLine).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining('Bangkok Wine Scout received'),
			expect.anything(),
		);
	});

	it('keeps duplicate text delivery idempotent while acknowledging the retry', async () => {
		const webhook = textWebhook('text-1', 'Wine dinner at 7pm');
		await processWebhookEvents(webhook, env as WorkerEnv);
		await processWebhookEvents(webhook, env as WorkerEnv);
		const count = await env.DB.prepare(
			'SELECT COUNT(*) AS count FROM line_text_contexts WHERE message_id = ?',
		).bind('text-1').first<{ count: number }>();

		expect(count?.count).toBe(1);
		expect(replyToLine).toHaveBeenCalledTimes(2);
	});
});
