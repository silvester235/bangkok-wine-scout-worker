import { APP_NAME, VERSION } from '../config';
import { routeCommand } from '../commands/router';
import { storeLineImageAsset } from '../services/event-intake';
import {
	downloadLineMessageContent,
	pushToLine,
	replyToLine,
} from '../services/line';
import { extractAndStoreOcr } from '../services/ocr';
import type {
	LineImageMessageEvent,
	LineTextMessageEvent,
	LineWebhookPayload,
} from '../types/line';

interface Env {
	LINE_CHANNEL_ACCESS_TOKEN: string;
	EVENT_INTAKES: R2Bucket;
	AI: Ai;
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

function getPushTarget(event: LineImageMessageEvent): string | undefined {
	return event.source?.userId ?? event.source?.groupId ?? event.source?.roomId;
}

async function processImageEvent(
	event: LineImageMessageEvent,
	env: Env,
): Promise<void> {
	console.log('LINE image intake started', { messageId: event.message.id });

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

	let ocrStatus: 'completed' | 'failed' | 'skipped' = 'skipped';
	let ocrCharacters = 0;

	if (!asset.duplicate) {
		const ocr = await extractAndStoreOcr(env.AI, env.EVENT_INTAKES, {
			intakeId: asset.intakeId,
			assetId: asset.assetId,
			contentType: downloaded.contentType,
			content: downloaded.content,
		});
		ocrStatus = ocr.status;
		ocrCharacters = ocr.text.length;
	}

	console.log('LINE image intake completed', {
		messageId: event.message.id,
		intakeId: asset.intakeId,
		assetId: asset.assetId,
		contentHash: asset.contentHash,
		duplicate: asset.duplicate,
		ocrStatus,
		ocrCharacters,
	});

	const target = getPushTarget(event);
	if (!target) {
		console.warn('LINE image final status not sent: no push target', {
			messageId: event.message.id,
		});
		return;
	}

	let finalText: string;
	if (asset.duplicate) {
		finalText = `Already received. Existing intake: ${asset.intakeId}`;
	} else if (ocrStatus === 'completed') {
		finalText = `Stored and OCR completed. Intake: ${asset.intakeId}`;
	} else {
		finalText = `Stored, but OCR failed. Intake: ${asset.intakeId}`;
	}

	await pushToLine(target, finalText, env.LINE_CHANNEL_ACCESS_TOKEN);
}

async function acknowledgeAndProcessImage(
	event: LineImageMessageEvent,
	env: Env,
	ctx: ExecutionContext,
): Promise<void> {
	await replyToLine(
		event.replyToken,
		'Image received – processing',
		env.LINE_CHANNEL_ACCESS_TOKEN,
	);

	ctx.waitUntil(
		processImageEvent(event, env).catch(async (error) => {
			console.error('LINE image processing failed:', error);

			const target = getPushTarget(event);
			if (!target) return;

			try {
				await pushToLine(
					target,
					'Image processing failed. Please try again.',
					env.LINE_CHANNEL_ACCESS_TOKEN,
				);
			} catch (pushError) {
				console.error('LINE failure notification failed:', pushError);
			}
		}),
	);
}

async function processWebhookEvents(
	body: LineWebhookPayload,
	env: Env,
	ctx: ExecutionContext,
): Promise<void> {
	for (const event of body.events ?? []) {
		if (isImageMessageEvent(event)) {
			await acknowledgeAndProcessImage(event, env, ctx);
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
}

export async function handleWebhook(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	try {
		const body = (await request.json()) as LineWebhookPayload;

		ctx.waitUntil(
			processWebhookEvents(body, env, ctx).catch((error) => {
				console.error('Webhook background processing failed:', error);
			}),
		);

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
