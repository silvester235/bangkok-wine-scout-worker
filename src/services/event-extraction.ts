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
			description: 'ISO date YYYY-MM-DD when unambiguous; otherwise preserve the visible date text.',
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
						'Extract a wine event only from the supplied OCR transcription. Never infer facts that are not explicitly present. Use null or an empty array for missing information. Preserve original names and wording. Bangkok dates and times normally use Asia/Bangkok, but set timezone to null unless the text or location makes it reasonably clear.',
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
				json_schema: {
					name: 'wine_event',
					strict: true,
					schema: EVENT_SCHEMA,
				},
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
