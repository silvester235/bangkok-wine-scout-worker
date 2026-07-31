import {
	APP_NAME,
	getOptionalAiEventResolutionOptions,
	getOptionalLineTextContextWindowSeconds,
	VERSION,
} from '../config';
import { isKnownCommand, routeCommand } from '../commands/router';
import { buildEventExtractionContext } from '../services/event-extraction-context';
import { extractAndStoreEvent } from '../services/event-extraction';
import {
	normalizeUtf8Text,
	normalizeWineEvent,
	type NormalizedWineEvent,
} from '../services/event-normalizer';
import { findEventIdByAssetId, saveWineEvent } from '../services/event-repository';
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

const FALLBACK_EVENT_TITLE = 'Wine Event';

function createFallbackWineEvent(): NormalizedWineEvent {
	return {
		date: null,
		startTime: null,
		priceTHB: null,
		venue: null,
		contactEmail: null,
		contactPhone: null,
		wines: [],
		wineRegions: [],
		isWineEvent: true,
	};
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

	// A retry can find an R2 image whose earlier processing stopped before D1.
	// Skip only assets that are already linked; otherwise resume from extraction.
	if (asset.duplicate) {
		const linkedEventId = await findEventIdByAssetId(env.DB, asset.assetId);
		if (linkedEventId) {
			console.log('DUPLICATE IMAGE MESSAGE SKIPPED:', message.messageId, asset.intakeId, linkedEventId);
			return;
		}
		console.info('UNLINKED STORED IMAGE RESUMED', JSON.stringify({
			messageId: message.messageId,
			intakeId: asset.intakeId,
			assetId: asset.assetId,
		}));
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

	const ocr = await extractAndStoreOcr(env.AI, env.EVENT_INTAKES, {
		intakeId: asset.intakeId,
		assetId: asset.assetId,
		contentType: downloaded.contentType,
		content: downloaded.content,
	});
	if (ocr.status === 'failed') {
		console.info('OCR RECOVERABLE FAILURE', JSON.stringify({
			intakeId: asset.intakeId,
			assetId: asset.assetId,
			error: ocr.error ?? 'OCR returned no text',
		}));
	}

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
	console.log('EXTRACTED EVENT:', JSON.stringify(extraction.event));
	const extractedEvent = extraction.event;
	const usedFallback = extraction.status === 'failed' || extractedEvent === null;
	const eventTitle = extractedEvent && !usedFallback
		? normalizeUtf8Text(extractedEvent.title)
		: FALLBACK_EVENT_TITLE;
	const normalizedEvent = extractedEvent && !usedFallback
		? normalizeWineEvent(extractedEvent)
		: createFallbackWineEvent();
	const validation = validateWineEvent({
		title: eventTitle,
		bookingUrl: extractedEvent && !usedFallback ? normalizeUtf8Text(extractedEvent.bookingUrl) : null,
		event: normalizedEvent,
	});

	if (usedFallback) {
		console.info('EVENT EXTRACTION RECOVERABLE FAILURE', JSON.stringify({
			intakeId: asset.intakeId,
			assetId: asset.assetId,
			error: extraction.error ?? 'Extraction returned no event',
			action: 'publishing fallback event',
		}));
	}
	console.log('RAW WINES:', JSON.stringify(extraction.event?.wines ?? []));
	console.log('NORMALIZED WINES:', JSON.stringify(normalizedEvent.wines));
	console.log('EVENT VALIDATION:', JSON.stringify(validation));

	// Persist both artifacts before publishing the normalized event to D1.
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

	const saved = await saveWineEvent(env.DB, {
		intakeId: asset.intakeId,
		assetId: asset.assetId,
		assetRole: 'flyer',
		sourceType: 'line_image',
		sourceMessageId: message.messageId,
		isPublic: true,
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
	console.log('EVENT PUBLICATION', JSON.stringify({
		eventId: saved.id,
		fallback: usedFallback,
		message: validation.warnings.length > 0 || usedFallback
			? 'Published with partial metadata'
			: 'Published with complete detected metadata',
		warnings: validation.warnings,
	}));

	if (!message.pushTarget) return;
	const finalText = usedFallback
		? `Stored and published with partial metadata: ${FALLBACK_EVENT_TITLE}. Intake: ${asset.intakeId}`
		: `Stored, extraction completed, and event published${eventTitle ? `: ${eventTitle}` : ''}. Intake: ${asset.intakeId}`;

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
