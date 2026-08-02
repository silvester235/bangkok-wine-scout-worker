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
	await env.DB.exec(`CREATE TABLE IF NOT EXISTS line_image_batches (id TEXT PRIMARY KEY,conversation_key TEXT NOT NULL,status TEXT NOT NULL,first_received_at TEXT NOT NULL,last_received_at TEXT NOT NULL,created_at TEXT NOT NULL,last_activity_at TEXT NOT NULL,expires_at TEXT NOT NULL,closed_at TEXT,updated_at TEXT NOT NULL,processing_at TEXT,completed_at TEXT,push_target TEXT,resulting_event_ids_json TEXT NOT NULL DEFAULT '[]',error TEXT,attempt_count INTEGER NOT NULL DEFAULT 0,notification_sent_at TEXT);CREATE UNIQUE INDEX IF NOT EXISTS webhook_collecting_conversation ON line_image_batches(conversation_key) WHERE status='collecting';CREATE TABLE IF NOT EXISTS line_message_batch_texts(batch_id TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,webhook_event_id TEXT UNIQUE,asset_id TEXT NOT NULL UNIQUE,text_content TEXT NOT NULL,received_at TEXT NOT NULL,conversation_key TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(batch_id,message_id));CREATE TABLE IF NOT EXISTS line_image_batch_assets(batch_id TEXT NOT NULL,asset_id TEXT NOT NULL UNIQUE,intake_id TEXT NOT NULL,line_message_id TEXT NOT NULL UNIQUE,webhook_event_id TEXT UNIQUE,source_type TEXT NOT NULL DEFAULT 'line_image',source_reference TEXT NOT NULL,content_type TEXT NOT NULL,r2_object_key TEXT NOT NULL,received_at TEXT NOT NULL,conversation_key TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(batch_id,asset_id));`);
});

beforeEach(async () => {
	await env.DB.prepare('DELETE FROM line_text_contexts').run();
	await env.DB.prepare('DELETE FROM line_message_batch_texts').run();
	await env.DB.prepare('DELETE FROM line_image_batch_assets').run();
	await env.DB.prepare('DELETE FROM line_image_batches').run();
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

	it('stores event text in the active message batch and acknowledges collection', async () => {
		await processWebhookEvents(textWebhook('text-1', 'Wine dinner at 7pm'), env as WorkerEnv);
		const stored = await env.DB.prepare(
			'SELECT message_id, text_content FROM line_text_contexts WHERE message_id = ?',
		).bind('text-1').first<{ message_id: string; text_content: string }>();

		expect(stored).toEqual({ message_id: 'text-1', text_content: 'Wine dinner at 7pm' });
		expect(replyToLine).toHaveBeenCalledWith(
			'reply-text-1',
			'Event details received – waiting for related images or text.',
			undefined,
		);
	});

	it('closes an active batch with /done and handles repeated completion safely',async()=>{await processWebhookEvents(textWebhook('text-1','Wine dinner 5 August 2026 at 19:00'),env as WorkerEnv);await processWebhookEvents(textWebhook('done-1','/done'),env as WorkerEnv);expect(replyToLine).toHaveBeenCalledWith('reply-done-1','Batch closed – processing now.',undefined);await processWebhookEvents(textWebhook('done-2','/done'),env as WorkerEnv);expect(replyToLine).toHaveBeenCalledWith('reply-done-2','No active batch to close.',undefined);});

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
