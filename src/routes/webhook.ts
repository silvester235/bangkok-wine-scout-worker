import { APP_NAME, VERSION } from '../config';
import { routeCommand } from '../commands/router';
import { storeLineImageAsset } from '../services/event-intake';
import {
	downloadLineMessageContent,
	replyToLine,
} from '../services/line';
import type {
	LineImageMessageEvent,
	LineTextMessageEvent,
	LineWebhookPayload,
} from '../types/line';

interface Env {
	LINE_CHANNEL_ACCESS_TOKEN: string;
	EVENT_INTAKES: R2Bucket;
}

function isTextMessageEvent(event: unknown): event is LineTextMessageEvent {
	const candidate = event as LineTextMessageEvent;
	return (
		candidate?.type === 'message' &&
		candidate.message?.type === 'text' &&
		typeof candidate.replyToken === 'string'
	);
}

function isImageMessageEvent(event: unknown): event is LineImageMessageEvent {
	const candidate = event as LineImageMessageEvent;
	return (
		candidate?.type === 'message' &&
		candidate.message?.type === 'image' &&
		typeof candidate.message.id === 'string' &&
		typeof candidate.replyToken === 'string'
	);
}

async function handleImageEvent(
	event: LineImageMessageEvent,
	env: Env,
): Promise<void> {
	const downloaded = await downloadLineMessageContent(
		event.message.id,
		env.LINE_CHANNEL_ACCESS_TOKEN,
	);

	const asset = await storeLineImageAsset(env.EVENT_INTAKES, {
		sourceType: 'line_image',
		sourceReference: event.message.id,
		lineUserId: event.source?.userId,
		receivedAt: new Date(event.timestamp ?? Date.now()).toISOString(),
		contentType: downloaded.contentType,
		content: downloaded.content,
	});

	const replyText = asset.duplicate
		? `This flyer was already received. Intake: ${asset.intakeId}`
		: `Flyer received and stored for review. Intake: ${asset.intakeId}`;

	await replyToLine(
		event.replyToken,
		replyText,
		env.LINE_CHANNEL_ACCESS_TOKEN,
	);
}

export async function handleWebhook(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		const body = (await request.json()) as LineWebhookPayload;

		for (const event of body.events ?? []) {
			if (isImageMessageEvent(event)) {
				await handleImageEvent(event, env);
				continue;
			}

			if (isTextMessageEvent(event)) {
				const replyText = routeCommand(event.message.text);
				await replyToLine(
					event.replyToken,
					replyText,
					env.LINE_CHANNEL_ACCESS_TOKEN,
				);
			}
		}

		return Response.json({
			status: 'ok',
			received: true,
			service: APP_NAME,
			version: VERSION,
			timestamp: new Date().toISOString(),
		});
	} catch (error) {
		console.error('Webhook error:', error);

		return Response.json(
			{
				status: 'error',
				message: 'Webhook processing failed',
				service: APP_NAME,
				version: VERSION,
				timestamp: new Date().toISOString(),
			},
			{ status: 500 },
		);
	}
}
