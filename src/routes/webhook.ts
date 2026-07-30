import { APP_NAME, VERSION } from '../config';
import { routeCommand } from '../commands/router';
import { extractAndStoreEvent } from '../services/event-extraction';
import { storeLineImageAsset } from '../services/event-intake';
import {
	downloadLineMessageContent,
	pushToLine,
	replyToLine,
} from '../services/line';
import { extractAndStoreOcr } from '../services/ocr';
import type { WorkerEnv } from '../types/env';
import type {
	LineImageMessageEvent,
	LineTextMessageEvent,
	LineWebhookPayload,
} from '../types/line';

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
	env: WorkerEnv,
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
	let eventStatus: 'completed' | 'failed' | 'skipped' = 'skipped';
	let eventTitle: string | null = null;

	if (!asset.duplicate) {
		const ocr = await extractAndStoreOcr(env.AI, env.EVENT_INTAKES, {
			intakeId: asset.intakeId,
			assetId: asset.assetId,
			contentType: downloaded.contentType,
			content: downloaded.content,
		});
		ocrStatus = ocr.status;
		ocrCharacters = ocr.text.length;

		if (ocr.status === 'completed') {
			const extraction = await extractAndStoreEvent(
				env.AI,
				env.EVENT_INTAKES,
				{
					intakeId: asset.intakeId,
					assetId: asset.assetId,
					ocrText: ocr.text,
				},
			);
			eventStatus = extraction.status;
			eventTitle = extraction.event?.title ?? null;
		}
	}

	console.log('LINE image intake completed', {
		messageId: event.message.id,
		intakeId: asset.intakeId,
		assetId: asset.assetId,
		contentHash: asset.contentHash,
		duplicate: asset.duplicate,
		ocrStatus,
		ocrCharacters,
		eventStatus,
		eventTitle,
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
	} else if (ocrStatus !== 'completed') {
		finalText = `Stored, but OCR failed. Intake: ${asset.intakeId}`;
	} else if (eventStatus === 'completed') {
		finalText = eventTitle
			? `Stored, OCR completed, and event extracted: ${eventTitle}. Intake: ${asset.intakeId}`
			: `Stored, OCR completed, and event data extracted. Intake: ${asset.intakeId}`;
	} else {
		finalText = `Stored and OCR completed, but event extraction failed. Intake: ${asset.intakeId}`;
	}

	await pushToLine(target, finalText, env.LINE_CHANNEL_ACCESS_TOKEN);
}

async function acknowledgeAndProcessImage(
	event: LineImageMessageEvent,
	env: WorkerEnv,
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
	env: WorkerEnv,
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
	env: WorkerEnv,
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
