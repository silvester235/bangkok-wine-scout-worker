import type { LineEventSource } from '../types/line';

export interface PendingLineTextInput {
	messageId: string;
	conversationKey: string;
	text: string;
	receivedAt: string;
}

export interface ClaimedLineTextContext {
	messageId: string;
	assetId: string;
	text: string;
	receivedAt: string;
	consumedAt: string;
	linkedEventId: string | null;
}

interface LineTextContextRow {
	message_id: string;
	text_content: string;
	received_at: string;
	consumed_at: string;
	linked_event_id: string | null;
}

function toClaimedContext(row: LineTextContextRow): ClaimedLineTextContext {
	return {
		messageId: row.message_id,
		assetId: `line-text-${row.message_id}`,
		text: row.text_content,
		receivedAt: row.received_at,
		consumedAt: row.consumed_at,
		linkedEventId: row.linked_event_id,
	};
}

export function buildLineConversationKey(source: LineEventSource | undefined): string | null {
	if (!source) return null;
	if (source.groupId) return `group:${source.groupId}:user:${source.userId ?? 'unknown'}`;
	if (source.roomId) return `room:${source.roomId}:user:${source.userId ?? 'unknown'}`;
	if (source.userId) return `user:${source.userId}`;
	return null;
}

export async function storePendingLineText(db: D1Database, input: PendingLineTextInput): Promise<boolean> {
	const result = await db
		.prepare(
			`INSERT INTO line_text_contexts (
				message_id,
				conversation_key,
				text_content,
				received_at
			) VALUES (?, ?, ?, ?)
			ON CONFLICT(message_id) DO NOTHING`,
		)
		.bind(input.messageId, input.conversationKey, input.text, input.receivedAt)
		.run();

	return result.meta.changes > 0;
}

export async function claimLineTextContext(
	db: D1Database,
	input: {
		conversationKey: string;
		imageAssetId: string;
		imageReceivedAt: string;
		windowSeconds: number;
	},
): Promise<ClaimedLineTextContext | null> {
	const previouslyClaimed = await db
		.prepare(
			`SELECT message_id, text_content, received_at, consumed_at, linked_event_id
			FROM line_text_contexts
			WHERE linked_image_asset_id = ? AND conversation_key = ?`,
		)
		.bind(input.imageAssetId, input.conversationKey)
		.first<LineTextContextRow>();
	if (previouslyClaimed) return toClaimedContext(previouslyClaimed);

	const imageTime = new Date(input.imageReceivedAt).getTime();
	if (!Number.isFinite(imageTime)) return null;
	const cutoff = new Date(imageTime - input.windowSeconds * 1000).toISOString();
	const consumedAt = new Date().toISOString();
	const claimed = await db
		.prepare(
			`UPDATE line_text_contexts
			SET consumed_at = ?, linked_image_asset_id = ?
			WHERE message_id = (
				SELECT message_id
				FROM line_text_contexts
				WHERE conversation_key = ?
					AND consumed_at IS NULL
					AND received_at >= ?
					AND received_at <= ?
				ORDER BY received_at DESC
				LIMIT 1
			)
			AND consumed_at IS NULL
			RETURNING message_id, text_content, received_at, consumed_at, linked_event_id`,
		)
		.bind(consumedAt, input.imageAssetId, input.conversationKey, cutoff, input.imageReceivedAt)
		.first<LineTextContextRow>();

	return claimed ? toClaimedContext(claimed) : null;
}

export async function markLineTextContextLinked(
	db: D1Database,
	messageId: string,
	eventId: string,
): Promise<void> {
	await db
		.prepare(
			`UPDATE line_text_contexts
			SET linked_event_id = ?
			WHERE message_id = ? AND linked_event_id IS NULL`,
		)
		.bind(eventId, messageId)
		.run();
}

export async function deleteAssetSpecificLineTextContexts(
	db: D1Database,
	eventId: string,
	assetIds: string[],
	sourceMessageIds: string[],
): Promise<number> {
	let deleted = 0;
	for (const assetId of assetIds) {
		const result = await db.prepare('DELETE FROM line_text_contexts WHERE linked_event_id = ? AND linked_image_asset_id = ?')
			.bind(eventId, assetId).run();
		deleted += result.meta.changes ?? 0;
	}
	for (const messageId of sourceMessageIds) {
		const result = await db.prepare('DELETE FROM line_text_contexts WHERE linked_event_id = ? AND message_id = ?')
			.bind(eventId, messageId).run();
		deleted += result.meta.changes ?? 0;
	}
	return deleted;
}
