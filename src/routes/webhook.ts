import { APP_NAME, VERSION } from '../config';
import { routeCommand } from '../commands/router';
import { extractAndStoreEvent } from '../services/event-extraction';
import { normalizeUtf8Text, normalizeWineEvent } from '../services/event-normalizer';
import { saveWineEvent } from '../services/event-repository';
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
	return candidate?.type === 'message' && candidate.message?.type === 'text' && typeof candidate.replyToken === 'string';
}

function isImageMessageEvent(event: unknown): event is LineImageMessageEvent {
	const candidate = event as LineImageMessageEvent;
	return candidate?.type === 'message' && candidate.message?.type === 'image' && typeof candidate.message.id === 'string' && typeof candidate.replyToken === 'string';
}

function getPushTarget(event: LineImageMessageEvent): string | undefined {
	return event.source?.userId ?? event.source?.groupId ?? event.source?.roomId;
}

async function processImageEvent(event: LineImageMessageEvent, env: WorkerEnv): Promise<void> {
	const downloaded = await downloadLineMessageContent(event.message.id, env.LINE_CHANNEL_ACCESS_TOKEN);
	const asset = await storeLineImageAsset(env.EVENT_INTAKES, {
		sourceType: 'line_image',
		sourceReference: event.message.id,
		lineUserId: event.source?.userId,
		receivedAt: new Date(event.timestamp ?? Date.now()).toISOString(),
		contentType: downloaded.contentType,
		content: downloaded.content,
	});

	let ocrStatus: 'completed' | 'failed' | 'skipped' = 'skipped';
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

		if (ocr.status === 'completed') {
			const extraction = await extractAndStoreEvent(env.AI, env.EVENT_INTAKES, {
				intakeId: asset.intakeId,
				assetId: asset.assetId,
				ocrText: ocr.text,
			});
			eventStatus = extraction.status;
			eventTitle = normalizeUtf8Text(extraction.event?.title ?? null);

			if (extraction.event) {
				const normalizedEvent = normalizeWineEvent(extraction.event);

				await env.EVENT_INTAKES.put(
					`intakes/${asset.intakeId}/assets/${asset.assetId}/event-normalized.json`,
					JSON.stringify(normalizedEvent, null, 2),
					{ httpMetadata: { contentType: 'application/json' } },
				);

				await saveWineEvent(env.DB, {
					intakeId: asset.intakeId,
					assetId: asset.assetId,
					title: eventTitle,
					event: normalizedEvent,
				});
			}
		}
	}

	const target = getPushTarget(event);
	if (!target) return;
	const finalText = asset.duplicate
		? `Already received. Existing intake: ${asset.intakeId}`
		: eventStatus === 'completed'
			? `Stored, OCR completed, event extracted, and database updated: ${eventTitle}. Intake: ${asset.intakeId}`
			: `Stored, but OCR failed. Intake: ${asset.intakeId}`;
	await pushToLine(target, finalText, env.LINE_CHANNEL_ACCESS_TOKEN);
}

async function acknowledgeAndProcessImage(event: LineImageMessageEvent, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
	await replyToLine(event.replyToken, 'Image received – processing', env.LINE_CHANNEL_ACCESS_TOKEN);
	ctx.waitUntil(processImageEvent(event, env));
}

async function processWebhookEvents(body: LineWebhookPayload, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
	for (const event of body.events ?? []) {
		if (isImageMessageEvent(event)) await acknowledgeAndProcessImage(event, env, ctx);
		else if (isTextMessageEvent(event)) await replyToLine(event.replyToken, routeCommand(event.message.text), env.LINE_CHANNEL_ACCESS_TOKEN);
	}
}

export async function handleWebhook(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
	const body = (await request.json()) as LineWebhookPayload;
	ctx.waitUntil(processWebhookEvents(body, env, ctx));
	return Response.json({ status: 'ok', received: true, service: APP_NAME, version: VERSION, timestamp: new Date().toISOString() });
}
