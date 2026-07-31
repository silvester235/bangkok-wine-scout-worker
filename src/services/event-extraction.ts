import { parseEventDateFromText } from './date-parser';
import type { EventExtractionContext } from './event-extraction-context';

const EVENT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

export interface ExtractedWineEvent {
	isWineEvent: boolean;
	title: string | null;
	venue: string | null;
	address: string | null;
	date: string | null;
	startTime: string | null;
	endTime: string | null;
	timezone: string | null;
	price: string | null;
	currency: string | null;
	bookingUrl: string | null;
	contact: string | null;
	wines: string[];
	wineRegions: string[];
	menu: string[];
	notes: string[];
	confidence: number;
}

export interface EventExtractionResult {
	schemaVersion: 1;
	status: 'completed' | 'failed';
	intakeId: string;
	assetId: string;
	model: string;
	event: ExtractedWineEvent | null;
	processedAt: string;
	error?: string;
	rawResponse?: unknown;
}

const EVENT_SCHEMA = {
	type: 'object',
	properties: {
		isWineEvent: { type: 'boolean' },
		title: { type: ['string', 'null'] },
		venue: { type: ['string', 'null'] },
		address: { type: ['string', 'null'] },
		date: {
			type: ['string', 'null'],
			description: 'ISO date YYYY-MM-DD only when supported by the supplied LINE message or flyer OCR evidence; otherwise null.',
		},
		startTime: { type: ['string', 'null'] },
		endTime: { type: ['string', 'null'] },
		timezone: { type: ['string', 'null'] },
		price: { type: ['string', 'null'] },
		currency: { type: ['string', 'null'] },
		bookingUrl: { type: ['string', 'null'] },
		contact: { type: ['string', 'null'] },
		wines: { type: 'array', items: { type: 'string' } },
		wineRegions: { type: 'array', items: { type: 'string' } },
		menu: { type: 'array', items: { type: 'string' } },
		notes: { type: 'array', items: { type: 'string' } },
		confidence: { type: 'number', minimum: 0, maximum: 1 },
	},
	required: [
		'isWineEvent',
		'title',
		'venue',
		'address',
		'date',
		'startTime',
		'endTime',
		'timezone',
		'price',
		'currency',
		'bookingUrl',
		'contact',
		'wines',
		'wineRegions',
		'menu',
		'notes',
		'confidence',
	],
	additionalProperties: false,
} as const;

function parseJson(value: unknown): unknown {
	if (typeof value !== 'string') return value;

	const cleaned = value
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/, '');

	return JSON.parse(cleaned);
}

function unwrapResponse(response: unknown): unknown {
	if (!response || typeof response !== 'object') return parseJson(response);

	const record = response as Record<string, unknown>;

	if ('result' in record) return parseJson(record.result);
	if ('response' in record) return parseJson(record.response);

	return response;
}

function isExtractedWineEvent(value: unknown): value is ExtractedWineEvent {
	if (!value || typeof value !== 'object') return false;

	const event = value as Record<string, unknown>;
	return (
		typeof event.isWineEvent === 'boolean' &&
		(event.title === null || typeof event.title === 'string') &&
		Array.isArray(event.wines) &&
		Array.isArray(event.wineRegions) &&
		Array.isArray(event.menu) &&
		Array.isArray(event.notes) &&
		typeof event.confidence === 'number'
	);
}

/**
 * The model is not allowed to invent a year. Enforce that rule after inference:
 * when extraction has no date, resolve the visible day/month/weekday to the
 * earliest date that is today or in the future.
 */
export function resolveExtractedEventDate(
	event: ExtractedWineEvent,
	context: EventExtractionContext,
	referenceDate = new Date(),
): ExtractedWineEvent {
	if (event.date) return event;
	const sourceDate = context.sourceText ? parseEventDateFromText(context.sourceText, referenceDate) : null;
	const ocrDate = context.ocrText ? parseEventDateFromText(context.ocrText, referenceDate) : null;
	const date = sourceDate && ocrDate && sourceDate !== ocrDate ? null : sourceDate ?? ocrDate;

	return {
		...event,
		date,
	};
}

export async function extractAndStoreEvent(
	ai: Ai,
	bucket: R2Bucket,
	input: {
		intakeId: string;
		assetId: string;
		context: EventExtractionContext;
	},
): Promise<EventExtractionResult> {
	const eventKey = `intakes/${input.intakeId}/assets/${input.assetId}/event.json`;
	const contextKey = `intakes/${input.intakeId}/assets/${input.assetId}/extraction-context.json`;
	const processedAt = new Date().toISOString();

	await bucket.put(contextKey, JSON.stringify(input.context, null, 2), {
		httpMetadata: { contentType: 'application/json' },
		customMetadata: {
			intakeId: input.intakeId,
			assetId: input.assetId,
			hasSourceText: String(Boolean(input.context.sourceText)),
			hasOcrText: String(Boolean(input.context.ocrText)),
		},
	});

	try {
		if (!input.context.combinedText) throw new Error('Event extraction context is empty.');

		const response = (await ai.run(EVENT_MODEL, {
			messages: [
				{
					role: 'system',
					content:
						'Extract structured event data from the separately labeled LINE MESSAGE and FLYER OCR sources. Use both sources as factual evidence; information may appear in only one source. Never invent, autocomplete, translate, or paraphrase unsupported facts. If sources conflict, preserve uncertainty by lowering confidence and retaining the conflict in notes rather than silently choosing an unsupported value. You may correct an obvious OCR spelling error in a proper noun only when the intended spelling is highly certain from the supplied evidence. Return an ISO date in YYYY-MM-DD format only when supported by the evidence; never guess a year. Preserve wine names, vintages, regions, prices, venues, phone numbers, email addresses, and URLs exactly when possible. Use null or an empty array for genuinely missing information. Bangkok dates and times normally use Asia/Bangkok, but set timezone to null unless the text or location makes it reasonably clear.',
				},
				{
					role: 'user',
					content: input.context.combinedText,
				},
			],
			temperature: 0,
			max_tokens: 2048,
			stream: false,
			response_format: {
				type: 'json_schema',
				json_schema: EVENT_SCHEMA,
			},
		} as never)) as unknown;

		const rawEvent = unwrapResponse(response);
		if (!isExtractedWineEvent(rawEvent)) {
			throw new Error('Workers AI returned an invalid event structure.');
		}

		const event = resolveExtractedEventDate(rawEvent, input.context);
		const result: EventExtractionResult = {
			schemaVersion: 1,
			status: 'completed',
			intakeId: input.intakeId,
			assetId: input.assetId,
			model: EVENT_MODEL,
			event,
			processedAt,
		};

		await bucket.put(eventKey, JSON.stringify(result, null, 2), {
			httpMetadata: { contentType: 'application/json' },
			customMetadata: {
				intakeId: input.intakeId,
				assetId: input.assetId,
				status: result.status,
				model: EVENT_MODEL,
			},
		});

		return result;
	} catch (error) {
		const result: EventExtractionResult = {
			schemaVersion: 1,
			status: 'failed',
			intakeId: input.intakeId,
			assetId: input.assetId,
			model: EVENT_MODEL,
			event: null,
			processedAt,
			error: error instanceof Error ? error.message : String(error),
		};

		await bucket.put(eventKey, JSON.stringify(result, null, 2), {
			httpMetadata: { contentType: 'application/json' },
			customMetadata: {
				intakeId: input.intakeId,
				assetId: input.assetId,
				status: result.status,
				model: EVENT_MODEL,
			},
		});

		return result;
	}
}
