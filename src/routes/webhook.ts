import {
	APP_NAME, getLineMessageBatchWindowSeconds, VERSION,
} from '../config';
import { isKnownCommand, routeCommand } from '../commands/router';
import { storeLineImageAsset } from '../services/event-intake';
import {
	downloadLineMessageContent,
	replyToLine,
} from '../services/line';
import {
	buildLineConversationKey,
	storePendingLineText,
} from '../services/line-text-context';
import { closeCollectingBatch, registerBatchAsset, registerBatchText } from '../services/line-image-batch-repository';
import type { BatchProcessingMessage } from '../services/line-image-batch-processing';
import type { WorkerEnv } from '../types/env';
import type {
	LineImageMessageEvent,
	LineTextMessageEvent,
	LineWebhookPayload,
} from '../types/line';

export interface ImageProcessingMessage {
	type: 'register_image';
	messageId: string;
	lineUserId?: string;
	pushTarget?: string;
	conversationKey?: string;
	receivedAt: string;
}

function isTextMessageEvent(event: unknown): event is LineTextMessageEvent {
	const candidate = event as LineTextMessageEvent;
	return candidate?.type === 'message' && candidate.message?.type === 'text' && typeof candidate.replyToken === 'string';
}

function isImageMessageEvent(event: unknown): event is LineImageMessageEvent {
	const candidate = event as LineImageMessageEvent;
	return candidate?.type === 'message' && candidate.message?.type === 'image' && typeof candidate.message.id === 'string' && typeof candidate.replyToken === 'string';
}

function getPushTarget(event: LineImageMessageEvent): string | undefined {
	return event.source?.userId ?? event.source?.groupId ?? event.source?.roomId;
}

export async function processImageMessage(message: ImageProcessingMessage, env: WorkerEnv): Promise<void> {
	const downloaded = await downloadLineMessageContent(message.messageId, env.LINE_CHANNEL_ACCESS_TOKEN);
	const asset = await storeLineImageAsset(env.EVENT_INTAKES, {
		sourceType: 'line_image',
		sourceReference: message.messageId,
		lineUserId: message.lineUserId,
		receivedAt: message.receivedAt,
		contentType: downloaded.contentType,
		content: downloaded.content,
	});

	const conversationKey=message.conversationKey??`line-message:${message.messageId}`;
	const registered=await registerBatchAsset(env.DB,{assetId:asset.assetId,intakeId:asset.intakeId,lineMessageId:message.messageId,contentType:downloaded.contentType,r2ObjectKey:asset.objectKey,receivedAt:message.receivedAt,conversationKey,pushTarget:message.pushTarget});
	if(registered.duplicate) return;
	await env.IMAGE_PROCESSING_QUEUE.send({type:'process_batch',batchId:registered.batch.id,expectedLastReceivedAt:registered.batch.lastReceivedAt} satisfies BatchProcessingMessage,{delaySeconds:getLineMessageBatchWindowSeconds(env)});
}

async function acknowledgeAndQueueImage(event: LineImageMessageEvent, env: WorkerEnv): Promise<void> {
	await env.IMAGE_PROCESSING_QUEUE.send({
		type: 'register_image',
		messageId: event.message.id,
		lineUserId: event.source?.userId,
		pushTarget: getPushTarget(event),
		conversationKey: buildLineConversationKey(event.source) ?? undefined,
		receivedAt: new Date(event.timestamp ?? Date.now()).toISOString(),
	} satisfies ImageProcessingMessage);

	await replyToLine(event.replyToken, 'Image received – waiting for related messages.', env.LINE_CHANNEL_ACCESS_TOKEN);
}

export async function processWebhookEvents(body: LineWebhookPayload, env: WorkerEnv): Promise<void> {
	for (const event of body.events ?? []) {
		if (isImageMessageEvent(event)) await acknowledgeAndQueueImage(event, env);
		else if (isTextMessageEvent(event)) {
			const conversationKey = buildLineConversationKey(event.source);
			if (event.message.text.trim().toLowerCase() === '/done') {
				const closed = conversationKey ? await closeCollectingBatch(env.DB, conversationKey) : null;
				if (closed?.processingAt) {
					await env.IMAGE_PROCESSING_QUEUE.send({type:'process_batch',batchId:closed.id,expectedLastReceivedAt:closed.lastReceivedAt,closedProcessingToken:closed.processingAt} satisfies BatchProcessingMessage);
					await replyToLine(event.replyToken, 'Batch closed – processing now.', env.LINE_CHANNEL_ACCESS_TOKEN);
				} else await replyToLine(event.replyToken, 'No active batch to close.', env.LINE_CHANNEL_ACCESS_TOKEN);
				continue;
			}
			if (isKnownCommand(event.message.text)) {
				await replyToLine(event.replyToken, routeCommand(event.message.text), env.LINE_CHANNEL_ACCESS_TOKEN);
				continue;
			}

			if (event.message.text.trim() && conversationKey) {
				const receivedAt=new Date(event.timestamp ?? Date.now()).toISOString();
				await storePendingLineText(env.DB, {
					messageId: event.message.id,
					conversationKey,
					text: event.message.text,
					receivedAt,
				});
				const registered=await registerBatchText(env.DB,{messageId:event.message.id,text:event.message.text,receivedAt,conversationKey,pushTarget:getPushTarget(event as unknown as LineImageMessageEvent)});
				if(!registered.duplicate)await env.IMAGE_PROCESSING_QUEUE.send({type:'process_batch',batchId:registered.batch.id,expectedLastReceivedAt:registered.batch.lastReceivedAt} satisfies BatchProcessingMessage,{delaySeconds:getLineMessageBatchWindowSeconds(env)});
				await replyToLine(
					event.replyToken,
					'Event details received – waiting for related images or text.',
					env.LINE_CHANNEL_ACCESS_TOKEN,
				);
				continue;
			}

			await replyToLine(event.replyToken, routeCommand(event.message.text), env.LINE_CHANNEL_ACCESS_TOKEN);
		}
	}
}

export async function handleWebhook(request: Request, env: WorkerEnv): Promise<Response> {
	let body: LineWebhookPayload;

	try {
		body = (await request.json()) as LineWebhookPayload;
	} catch {
		return Response.json(
			{ status: 'error', message: 'Invalid request body' },
			{ status: 400 },
		);
	}

	await processWebhookEvents(body, env);
	return Response.json({ status: 'ok', received: true, service: APP_NAME, version: VERSION, timestamp: new Date().toISOString() });
}
