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
			description: 'ISO date YYYY-MM-DD only when the complete date including a four-digit year is explicitly visible in the OCR text; otherwise null.',
		},
		startTime: { type: ['string', 'null'] },
		endTime: { type: ['string', 'null'] },
		timezone: { type: ['string', 'null'] },
		price: { type: ['string', 'null'] },
		currency: { type: ['string', 'null'] },
		bookingUrl: { type: ['string', 'null'] },
		contact: { type: ['string', 'null'] },
		wines: { type: 'array', items: { type: 'string' } },
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
		Array.isArray(event.menu) &&
		Array.isArray(event.notes) &&
		typeof event.confidence === 'number'
	);
}

export async function extractAndStoreEvent(
	ai: Ai,
	bucket: R2Bucket,
	input: {
		intakeId: string;
		assetId: string;
		ocrText: string;
	},
): Promise<EventExtractionResult> {
	const eventKey = `intakes/${input.intakeId}/assets/${input.assetId}/event.json`;
	const processedAt = new Date().toISOString();

	try {
		const response = (await ai.run(EVENT_MODEL, {
			messages: [
				{
					role: 'system',
					content:
						'Extract structured data from the supplied OCR transcription. Treat the OCR text as the primary and only factual source. Preserve factual information exactly and never add details that are not supported by the OCR. You may correct an obvious OCR spelling error in a proper noun, including a wine name, château name, winery, grape variety, restaurant name, or venue, only when the intended spelling is highly certain from the visible OCR context. Do not use outside knowledge to invent, autocomplete, or reconstruct missing information. Never translate or paraphrase. Return an ISO date in YYYY-MM-DD format only when the complete date, including a four-digit year, is explicitly visible in the OCR text. Never infer or guess a year; otherwise return null. Preserve phone numbers, email addresses, and URLs as recognized in the OCR. If one or two characters appear uncertain but the value is still present, retain the OCR output rather than discarding the entire value. Never invent missing characters, change a domain, or replace .th with .uk or another suffix. Put reservation details, email addresses, phone numbers, and URLs in contact, bookingUrl, address, or notes as appropriate so they remain available for downstream extraction. Preserve original capitalization, punctuation, accents, spacing, and wording unless applying a highly certain proper-noun OCR correction. Use null or an empty array for genuinely missing information. Set confidence lower whenever OCR text is unclear. Bangkok dates and times normally use Asia/Bangkok, but set timezone to null unless the text or location makes it reasonably clear.',
				},
				{
					role: 'user',
					content: input.ocrText,
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

		const event = unwrapResponse(response);
		if (!isExtractedWineEvent(event)) {
			throw new Error('Workers AI returned an invalid event structure.');
		}

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
