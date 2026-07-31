import {
	APP_NAME,
	getOptionalAiEventResolutionOptions,
	getOptionalLineTextContextWindowSeconds,
	VERSION,
} from '../config';
import { isKnownCommand, routeCommand } from '../commands/router';
import { buildEventExtractionContext } from '../services/event-extraction-context';
import { extractAndStoreEvent } from '../services/event-extraction';
import { normalizeUtf8Text, normalizeWineEvent } from '../services/event-normalizer';
import { saveWineEvent } from '../services/event-repository';
import { storeLineImageAsset } from '../services/event-intake';
import { validateWineEvent } from '../services/event-validator';
import {
	downloadLineMessageContent,
	pushToLine,
	replyToLine,
} from '../services/line';
import { extractAndStoreOcr } from '../services/ocr';
import {
	buildLineConversationKey,
	claimLineTextContext,
	markLineTextContextLinked,
	storePendingLineText,
} from '../services/line-text-context';
import type { WorkerEnv } from '../types/env';
import type {
	LineImageMessageEvent,
	LineTextMessageEvent,
	LineWebhookPayload,
} from '../types/line';

export interface ImageProcessingMessage {
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

	// Queue delivery is at-least-once. A duplicate means this image has already
	// entered the pipeline, so it must not generate another user notification.
	if (asset.duplicate) {
		console.log('DUPLICATE IMAGE MESSAGE SKIPPED:', message.messageId, asset.intakeId);
		return;
	}

	const correlationWindow = getOptionalLineTextContextWindowSeconds(env);
	const lineText = message.conversationKey && correlationWindow
		? await claimLineTextContext(env.DB, {
			conversationKey: message.conversationKey,
			imageAssetId: asset.assetId,
			imageReceivedAt: message.receivedAt,
			windowSeconds: correlationWindow,
		})
		: null;

	let eventStatus: 'completed' | 'failed' | 'skipped' = 'skipped';
	let eventTitle: string | null = null;
	let validationErrors: string[] = [];

	const ocr = await extractAndStoreOcr(env.AI, env.EVENT_INTAKES, {
		intakeId: asset.intakeId,
		assetId: asset.assetId,
		contentType: downloaded.contentType,
		content: downloaded.content,
	});

	const context = buildEventExtractionContext({
		sourceText: lineText?.text,
		ocrText: ocr.status === 'completed' ? ocr.text : null,
	});
	console.log('EVENT EXTRACTION CONTEXT', JSON.stringify({
		event: 'event_extraction_context_built',
		hasSourceText: Boolean(context.sourceText),
		hasOcrText: Boolean(context.ocrText),
		sourceTextLength: context.sourceText?.length ?? 0,
		ocrTextLength: context.ocrText?.length ?? 0,
	}));

	const extraction = await extractAndStoreEvent(env.AI, env.EVENT_INTAKES, {
		intakeId: asset.intakeId,
		assetId: asset.assetId,
		context,
	});
	eventStatus = extraction.status;
	eventTitle = normalizeUtf8Text(extraction.event?.title ?? null);

	console.log('EXTRACTED EVENT:', JSON.stringify(extraction.event));

	if (extraction.event) {
		const normalizedEvent = normalizeWineEvent(extraction.event);
		const validation = validateWineEvent({
			title: eventTitle,
			bookingUrl: normalizeUtf8Text(extraction.event.bookingUrl),
			event: normalizedEvent,
		});

		console.log('RAW WINES:', JSON.stringify(extraction.event.wines));
		console.log('NORMALIZED WINES:', JSON.stringify(normalizedEvent.wines));
		console.log('EVENT VALIDATION:', JSON.stringify(validation));

		// Persist both artifacts before deciding whether the event is allowed into D1.
		await env.EVENT_INTAKES.put(
			`intakes/${asset.intakeId}/assets/${asset.assetId}/event-normalized.json`,
			JSON.stringify(normalizedEvent, null, 2),
			{ httpMetadata: { contentType: 'application/json' } },
		);

		await env.EVENT_INTAKES.put(
				`intakes/${asset.intakeId}/assets/${asset.assetId}/event-validation.json`,
				JSON.stringify(validation, null, 2),
				{ httpMetadata: { contentType: 'application/json' } },
			);

		if (validation.valid) {
			const saved = await saveWineEvent(env.DB, {
				intakeId: asset.intakeId,
				assetId: asset.assetId,
				sourceType: 'line_image',
				sourceMessageId: message.messageId,
				r2ObjectKey: asset.objectKey,
				contentType: downloaded.contentType,
				relatedAssets: lineText ? [{
					intakeId: asset.intakeId,
					assetId: lineText.assetId,
					assetRole: 'other',
					sourceType: 'line_text',
					sourceMessageId: lineText.messageId,
					textContent: lineText.text,
					isPublic: false,
				}] : [],
				title: eventTitle,
				event: normalizedEvent,
			}, getOptionalAiEventResolutionOptions(env));
			if (lineText) await markLineTextContextLinked(env.DB, lineText.messageId, saved.id);
		} else {
			eventStatus = 'failed';
			validationErrors = validation.errors;
		}
	}

	if (!message.pushTarget) return;
	const finalText = eventStatus === 'completed'
		? `Stored, extraction completed, event validated, and database updated: ${eventTitle}. Intake: ${asset.intakeId}`
		: validationErrors.length > 0
			? `Stored, but event validation failed: ${validationErrors.join(', ')}. Intake: ${asset.intakeId}`
			: `Stored, but source extraction failed. Intake: ${asset.intakeId}`;

	// The status notification is best-effort. A LINE API error must not cause
	// Cloudflare Queues to process the completed intake again.
	try {
		await pushToLine(message.pushTarget, finalText, env.LINE_CHANNEL_ACCESS_TOKEN);
	} catch (error) {
		console.error('LINE STATUS PUSH FAILED:', error);
	}
}

async function acknowledgeAndQueueImage(event: LineImageMessageEvent, env: WorkerEnv): Promise<void> {
	await env.IMAGE_PROCESSING_QUEUE.send({
		messageId: event.message.id,
		lineUserId: event.source?.userId,
		pushTarget: getPushTarget(event),
		conversationKey: buildLineConversationKey(event.source) ?? undefined,
		receivedAt: new Date(event.timestamp ?? Date.now()).toISOString(),
	} satisfies ImageProcessingMessage);

	await replyToLine(event.replyToken, 'Image received – queued for processing', env.LINE_CHANNEL_ACCESS_TOKEN);
}

function formatCorrelationWindow(seconds: number | null): string {
	if (seconds === null) return 'soon';
	if (seconds % 60 === 0) {
		const minutes = seconds / 60;
		return `within ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
	}
	return `within ${seconds} seconds`;
}

export async function processWebhookEvents(body: LineWebhookPayload, env: WorkerEnv): Promise<void> {
	for (const event of body.events ?? []) {
		if (isImageMessageEvent(event)) await acknowledgeAndQueueImage(event, env);
		else if (isTextMessageEvent(event)) {
			if (isKnownCommand(event.message.text)) {
				await replyToLine(event.replyToken, routeCommand(event.message.text), env.LINE_CHANNEL_ACCESS_TOKEN);
				continue;
			}

			const conversationKey = buildLineConversationKey(event.source);
			if (event.message.text.trim() && conversationKey) {
				await storePendingLineText(env.DB, {
					messageId: event.message.id,
					conversationKey,
					text: event.message.text,
					receivedAt: new Date(event.timestamp ?? Date.now()).toISOString(),
				});
				const window = formatCorrelationWindow(getOptionalLineTextContextWindowSeconds(env));
				await replyToLine(
					event.replyToken,
					`Event details received. Send the related flyer image ${window}.`,
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
