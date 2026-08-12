import { parseEventDateEvidenceFromText } from './date-parser';
import type { EventExtractionContext } from './event-extraction-context';

const EVENT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

export interface ExtractedWineEvent {
	isWineEvent: boolean;
	title: string | null;
	organizer?: string | null;
	venue: string | null;
	address: string | null;
	district?: string | null;
	date: string | null;
	startTime: string | null;
	endTime: string | null;
	timezone: string | null;
	price: string | null;
	priceAmount?: number | null;
	priceQualifier?: string | null;
	currency: string | null;
	bookingUrl: string | null;
	websiteUrl?: string | null;
	bookingInstructions?: string | null;
	contact: string | null;
	contactPhone?: string | null;
	contactEmail?: string | null;
	contactText?: string | null;
	description?: string | null;
	courseCount?: number | null;
	wines: string[];
	wineRegions: string[];
	wineProducers?: string[];
	partners?: string[];
	merchants?: string[];
	menu: string[];
	notes: string[];
	sourceContactInformation?: string[];
	qrCodePresent?: boolean;
	decodedQrValue?: string | null;
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
		organizer: { type: ['string', 'null'] },
		venue: { type: ['string', 'null'] },
		address: { type: ['string', 'null'] },
		district: { type: ['string', 'null'] },
		date: {
			type: ['string', 'null'],
			description: 'ISO date YYYY-MM-DD only when supported by the supplied LINE message or flyer OCR evidence; otherwise null.',
		},
		startTime: { type: ['string', 'null'] },
		endTime: { type: ['string', 'null'] },
		timezone: { type: ['string', 'null'] },
		price: { type: ['string', 'null'] },
		priceAmount: { type: ['number', 'null'] },
		priceQualifier: { type: ['string', 'null'] },
		currency: { type: ['string', 'null'] },
		bookingUrl: { type: ['string', 'null'] },
		websiteUrl: { type: ['string', 'null'] },
		bookingInstructions: { type: ['string', 'null'] },
		contact: { type: ['string', 'null'] },
		contactPhone: { type: ['string', 'null'] },
		contactEmail: { type: ['string', 'null'] },
		contactText: { type: ['string', 'null'] },
		description: { type: ['string', 'null'] },
		courseCount: { type: ['integer', 'null'], minimum: 1 },
		wines: { type: 'array', maxItems: 20, items: { type: 'string' } },
		wineRegions: { type: 'array', maxItems: 20, items: { type: 'string' } },
		wineProducers: { type: 'array', maxItems: 20, items: { type: 'string' } },
		partners: { type: 'array', maxItems: 20, items: { type: 'string' } },
		merchants: { type: 'array', maxItems: 20, items: { type: 'string' } },
		menu: { type: 'array', maxItems: 20, items: { type: 'string' } },
		notes: { type: 'array', maxItems: 20, items: { type: 'string' } },
		sourceContactInformation: { type: 'array', maxItems: 20, items: { type: 'string' } },
		qrCodePresent: { type: 'boolean' },
		decodedQrValue: { type: ['string', 'null'] },
		confidence: { type: 'number', minimum: 0, maximum: 1 },
	},
	required: [],
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
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function withEventDefaults(value: ExtractedWineEvent): ExtractedWineEvent {
	const event=value as unknown as Record<string,unknown>;
	return {...value,isWineEvent:typeof event.isWineEvent==='boolean'?event.isWineEvent:true,title:typeof event.title==='string'?event.title:null,
		venue:typeof event.venue==='string'?event.venue:null,address:typeof event.address==='string'?event.address:null,date:typeof event.date==='string'?event.date:null,
		startTime:typeof event.startTime==='string'?event.startTime:null,endTime:typeof event.endTime==='string'?event.endTime:null,timezone:typeof event.timezone==='string'?event.timezone:null,
		price:typeof event.price==='string'?event.price:null,currency:typeof event.currency==='string'?event.currency:null,bookingUrl:typeof event.bookingUrl==='string'?event.bookingUrl:null,
		contact:typeof event.contact==='string'?event.contact:null,wines:Array.isArray(event.wines)?event.wines.filter((item):item is string=>typeof item==='string'):[],
		wineRegions:Array.isArray(event.wineRegions)?event.wineRegions.filter((item):item is string=>typeof item==='string'):[],menu:Array.isArray(event.menu)?event.menu.filter((item):item is string=>typeof item==='string'):[],
		notes:Array.isArray(event.notes)?event.notes.filter((item):item is string=>typeof item==='string'):[],confidence:typeof event.confidence==='number'?event.confidence:0};
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
	const sourceEvidence = context.sourceText ? parseEventDateEvidenceFromText(context.sourceText, referenceDate) : null;
	const ocrEvidence = context.ocrText ? parseEventDateEvidenceFromText(context.ocrText, referenceDate) : null;
	if (sourceEvidence && ocrEvidence && sourceEvidence.date !== ocrEvidence.date) return { ...event, date: null };
	const deterministicDate = sourceEvidence?.date ?? ocrEvidence?.date;
	if (!deterministicDate) {
		const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(referenceDate);
		return event.date&&event.date<today?{...event,date:null}:event;
	}

	return {
		...event,
		// Visible source evidence is authoritative. This replaces a model-invented
		// year with one derived from the intake's processing reference date.
		date: deterministicDate,
	};
}

export async function extractAndStoreEvent(
	ai: Ai,
	bucket: R2Bucket,
	input: {
		intakeId: string;
		assetId: string;
		context: EventExtractionContext;
		referenceDate?: Date;
	},
): Promise<EventExtractionResult> {
	const eventKey = `intakes/${input.intakeId}/assets/${input.assetId}/event.json`;
	const contextKey = `intakes/${input.intakeId}/assets/${input.assetId}/extraction-context.json`;
	const processedAt = new Date().toISOString();
	let rawResponse: unknown = null;

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

		const response = rawResponse = (await ai.run(EVENT_MODEL, {
			messages: [
				{
					role: 'system',
					content:
						'Extract exactly one structured event from the separately labeled LINE MESSAGE, FLYER OCR, and any supplied QR evidence. Use both sources as complementary evidence. Extract every visible event fact: exact title; organizer; venue; full address and district/neighbourhood; date; start/end time; timezone only when supported; exact price text, numeric amount, currency, and +/++ qualifier; booking and website URLs; phone, email, LINE, social, and other contact text; booking instructions; description; menu and course count; wine names, geographic wine regions, wine producers; merchants/importers, sponsors, and partners; notes; QR presence and decoded value when separately supplied. Distinguish organizer from venue, producer from region, and merchant/importer from producer. Never invent, autocomplete, translate, or paraphrase unsupported facts. Preserve exact raw price and booking wording. If sources conflict, lower confidence and record the conflict in notes. Return an ISO date only when supported; never guess a year. Use null or empty arrays for missing information. Do not repeat the event or add prose outside the JSON response.',
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

		const event = resolveExtractedEventDate(withEventDefaults(rawEvent), input.context, input.referenceDate);
		const result: EventExtractionResult = {
			schemaVersion: 1,
			status: 'completed',
			intakeId: input.intakeId,
			assetId: input.assetId,
			model: EVENT_MODEL,
			event,
			processedAt,
			rawResponse,
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
			rawResponse,
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
