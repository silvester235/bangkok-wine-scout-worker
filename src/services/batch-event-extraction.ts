import type { ExtractedWineEvent } from './event-extraction';
import type { EventAssetRole } from './event-repository';

export const BATCH_EVENT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
export const MAX_BATCH_PROMPT_CHARS = 14_000;

export interface BatchAssetContext {
	assetId: string;
	intakeId: string;
	ordinal: number;
	receivedAt: string;
	contentType: string;
	ocrText: string;
	lineText?: string | null;
}

export interface BatchExtractedEvent extends ExtractedWineEvent {
	assetAssignments: Array<{ assetId: string; role: EventAssetRole }>;
}

export interface BatchExtractionDiagnostics {
	model: string;
	rawResponse: unknown;
	parseSuccess: boolean;
	parseError: string | null;
	schemaValidationSuccess: boolean;
	schemaValidationError: string | null;
	fallbackRequired: boolean;
	fallbackReason: string | null;
	finishReason?: string | null;
	tokenUsage?: unknown;
	repetitionDetected?: boolean;
}

export interface BatchExtractionResult {
	events: BatchExtractedEvent[];
	unassignedAssets: string[];
	ambiguous: boolean;
	diagnostics: BatchExtractionDiagnostics;
}

const eventProperties = {
	isWineEvent: { type: 'boolean' }, title: { type: ['string', 'null'] }, organizer: { type: ['string', 'null'] }, venue: { type: ['string', 'null'] },
	address: { type: ['string', 'null'] }, district: { type: ['string', 'null'] }, date: { type: ['string', 'null'] }, startTime: { type: ['string', 'null'] },
	endTime: { type: ['string', 'null'] }, timezone: { type: ['string', 'null'] }, price: { type: ['string', 'null'] }, priceAmount: { type: ['number', 'null'] }, priceQualifier: { type: ['string', 'null'] },
	currency: { type: ['string', 'null'] }, bookingUrl: { type: ['string', 'null'] }, websiteUrl: { type: ['string', 'null'] }, bookingInstructions: { type: ['string', 'null'] }, contact: { type: ['string', 'null'] }, contactPhone: { type: ['string', 'null'] }, contactEmail: { type: ['string', 'null'] }, contactText: { type: ['string', 'null'] }, description: { type: ['string', 'null'] }, courseCount: { type: ['integer', 'null'] },
	wines: { type: 'array', maxItems: 20, items: { type: 'string' } }, wineRegions: { type: 'array', maxItems: 20, items: { type: 'string' } },
	wineProducers: { type: 'array', maxItems: 20, items: { type: 'string' } }, partners: { type: 'array', maxItems: 20, items: { type: 'string' } }, merchants: { type: 'array', maxItems: 20, items: { type: 'string' } }, menu: { type: 'array', maxItems: 20, items: { type: 'string' } }, notes: { type: 'array', maxItems: 20, items: { type: 'string' } }, sourceContactInformation: { type: 'array', maxItems: 20, items: { type: 'string' } }, qrCodePresent: { type: 'boolean' }, decodedQrValue: { type: ['string', 'null'] },
	confidence: { type: 'number' },
	assetAssignments: { type: 'array', items: { type: 'object', properties: { assetId: { type: 'string' }, role: { type: 'string', enum: ['main', 'flyer', 'menu', 'reminder', 'social', 'map', 'other'] } }, required: ['assetId', 'role'], additionalProperties: false } },
} as const;
const required = ['assetAssignments'];
const schema = { type: 'object', properties: { events: { type: 'array', maxItems: 1, items: { type: 'object', properties: eventProperties, required, additionalProperties: false } }, unassignedAssets: { type: 'array', items: { type: 'string' } }, ambiguous: { type: 'boolean' } }, required: ['events', 'unassignedAssets', 'ambiguous'], additionalProperties: false } as const;
const roles = new Set<EventAssetRole>(['main', 'flyer', 'menu', 'reminder', 'social', 'map', 'other']);

function parseJson(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	return JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}

function responseDiagnostics(value: unknown): Pick<BatchExtractionDiagnostics, 'finishReason' | 'tokenUsage' | 'repetitionDetected'> {
	const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	const result = record.result && typeof record.result === 'object' ? record.result as Record<string, unknown> : {};
	const finishReason = [record.finish_reason, record.finishReason, result.finish_reason, result.finishReason].find((item) => typeof item === 'string') as string | undefined;
	const tokenUsage = record.usage ?? result.usage;
	const rawText = typeof record.response === 'string' ? record.response : typeof record.result === 'string' ? record.result : JSON.stringify(record.response ?? record.result ?? '');
	const chunks = rawText.match(/.{80,200}/g) ?? [];
	const seen = new Set<string>();
	const repetitionDetected = chunks.some((chunk) => { const key = chunk.replace(/\s+/g, ' ').trim(); if (seen.has(key)) return true; seen.add(key); return false; });
	return { finishReason: finishReason ?? null, tokenUsage: tokenUsage ?? null, repetitionDetected };
}

/** Workers AI JSON mode may return either `{ response: object }`, `{ result: object }`, or the object itself. */
export function unwrapBatchResponse(response: unknown): unknown {
	if (!response || typeof response !== 'object') return parseJson(response);
	const record = response as Record<string, unknown>;
	if ('result' in record) return parseJson(record.result);
	if ('response' in record) return parseJson(record.response);
	return response;
}

function nullableString(value: unknown): boolean { return value === null || typeof value === 'string'; }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }

export function validateBatchAnalysisSchema(value: unknown): string | null {
	if (!value || typeof value !== 'object') return 'analysis must be an object';
	const analysis = value as Record<string, unknown>;
	if (!Array.isArray(analysis.events)) return 'events must be an array';
	if (!stringArray(analysis.unassignedAssets)) return 'unassignedAssets must be an array of asset IDs';
	if (typeof analysis.ambiguous !== 'boolean') return 'ambiguous must be a boolean';
	for (const [index, item] of analysis.events.entries()) {
		if (!item || typeof item !== 'object') return `events[${index}] must be an object`;
		const event = item as Record<string, unknown>;
		if (event.isWineEvent !== undefined && typeof event.isWineEvent !== 'boolean') return `events[${index}].isWineEvent must be a boolean`;
		for (const field of ['title', 'venue', 'address', 'date', 'startTime', 'endTime', 'timezone', 'price', 'currency', 'bookingUrl', 'contact']) {
			if (event[field] !== undefined && !nullableString(event[field])) return `events[${index}].${field} must be a string or null`;
		}
		for (const field of ['organizer', 'district', 'priceQualifier', 'websiteUrl', 'bookingInstructions', 'contactPhone', 'contactEmail', 'contactText', 'description', 'decodedQrValue']) if (event[field] !== undefined && !nullableString(event[field])) return `events[${index}].${field} must be a string or null`;
		if (event.priceAmount !== undefined && event.priceAmount !== null && typeof event.priceAmount !== 'number') return `events[${index}].priceAmount must be a number or null`;
		if (event.courseCount !== undefined && event.courseCount !== null && typeof event.courseCount !== 'number') return `events[${index}].courseCount must be a number or null`;
		if (event.qrCodePresent !== undefined && typeof event.qrCodePresent !== 'boolean') return `events[${index}].qrCodePresent must be a boolean`;
		for (const field of ['wines', 'wineRegions', 'menu', 'notes']) if (event[field] !== undefined && !stringArray(event[field])) return `events[${index}].${field} must be a string array`;
		for (const field of ['wineProducers', 'partners', 'merchants', 'sourceContactInformation']) if (event[field] !== undefined && !stringArray(event[field])) return `events[${index}].${field} must be a string array`;
		if (event.confidence !== undefined && (typeof event.confidence !== 'number' || !Number.isFinite(event.confidence))) return `events[${index}].confidence must be a finite number`;
		if (!Array.isArray(event.assetAssignments)) return `events[${index}].assetAssignments must be an array`;
		for (const [assignmentIndex, item] of event.assetAssignments.entries()) {
			if (!item || typeof item !== 'object') return `events[${index}].assetAssignments[${assignmentIndex}] must be an object`;
			const assignment = item as Record<string, unknown>;
			if (typeof assignment.assetId !== 'string') return `events[${index}].assetAssignments[${assignmentIndex}].assetId must be a string`;
			if (typeof assignment.role !== 'string' || !roles.has(assignment.role as EventAssetRole)) return `events[${index}].assetAssignments[${assignmentIndex}].role is unsupported`;
		}
	}
	return null;
}

function withEventDefaults(value: Record<string, unknown>): BatchExtractedEvent {
	return {
		...value,
		isWineEvent: typeof value.isWineEvent === 'boolean' ? value.isWineEvent : true,
		title: typeof value.title === 'string' ? value.title : null,
		venue: typeof value.venue === 'string' ? value.venue : null,
		address: typeof value.address === 'string' ? value.address : null,
		date: typeof value.date === 'string' ? value.date : null,
		startTime: typeof value.startTime === 'string' ? value.startTime : null,
		endTime: typeof value.endTime === 'string' ? value.endTime : null,
		timezone: typeof value.timezone === 'string' ? value.timezone : null,
		price: typeof value.price === 'string' ? value.price : null,
		currency: typeof value.currency === 'string' ? value.currency : null,
		bookingUrl: typeof value.bookingUrl === 'string' ? value.bookingUrl : null,
		contact: typeof value.contact === 'string' ? value.contact : null,
		wines: stringArray(value.wines) ? value.wines : [],
		wineRegions: stringArray(value.wineRegions) ? value.wineRegions : [],
		menu: stringArray(value.menu) ? value.menu : [],
		notes: stringArray(value.notes) ? value.notes : [],
		confidence: typeof value.confidence === 'number' ? value.confidence : 0,
		assetAssignments: value.assetAssignments as BatchExtractedEvent['assetAssignments'],
	} as BatchExtractedEvent;
}

export function buildBatchAnalysisContext(assets: BatchAssetContext[]): string {
	return assets.map((asset) => `ASSET ${asset.ordinal}\nassetId: ${asset.assetId}\nreceivedAt: ${asset.receivedAt}\ncontentType: ${asset.contentType}\n${asset.lineText ? `LINE TEXT:\n${asset.lineText}\n` : ''}SOURCE CONTENT:\n${asset.ocrText || '[content unavailable]'}`).join('\n\n---\n\n');
}

function failureResult(assets: BatchAssetContext[], diagnostics: BatchExtractionDiagnostics): BatchExtractionResult {
	return { events: [], unassignedAssets: assets.map((asset) => asset.assetId), ambiguous: true, diagnostics };
}

function diagnosticsForLog(diagnostics: BatchExtractionDiagnostics): Omit<BatchExtractionDiagnostics,'rawResponse'> & {rawResponseStored:boolean} {
	const {rawResponse,...safe}=diagnostics;return{...safe,rawResponseStored:rawResponse!==null&&rawResponse!==undefined};
}

export async function extractBatchEvents(ai: Ai, bucket: R2Bucket, batchId: string, assets: BatchAssetContext[]): Promise<BatchExtractionResult> {
	const unboundedContext=buildBatchAnalysisContext(assets);const context=unboundedContext.slice(0,MAX_BATCH_PROMPT_CHARS);const promptTruncated=context.length<unboundedContext.length;
	console.log({event:'line_batch_analysis_prompt_metrics',batchId,promptSize:context.length,estimatedPromptTokens:Math.ceil(new TextEncoder().encode(context).byteLength/4),truncationOccurred:promptTruncated,textReduced:promptTruncated,originalPromptSize:unboundedContext.length});
	await bucket.put(`line-batches/${batchId}/analysis-context.txt`, context, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
	let rawResponse: unknown = null;
	let parsed: unknown;
	try {
		if (!assets.some((asset) => asset.ocrText || asset.lineText)) throw new Error('Batch analysis context is empty.');
			rawResponse = await ai.run(BATCH_EVENT_MODEL, { messages: [{ role: 'system', content: 'This LINE message batch represents at most one event. Return zero or one event only and never repeat a candidate. Extract every visible event fact, including organizer, venue, address/district, exact price and qualifier, all contacts and booking details, description/course count/menu, wines, geographic regions, producers, merchants/importers/partners, and QR evidence when supplied. Distinguish venue from organizer, producer from region, and merchant from producer. Preserve exact raw wording for prices and booking instructions. Never invent facts or add prose outside JSON. Use null and empty arrays for missing fields. If no event can be identified, return events: [], preserve all asset IDs in unassignedAssets, and set ambiguous: true. Asset assignments are role hints only.' }, { role: 'user', content: context }], temperature: 0, max_tokens: 1400, stream: false, response_format: { type: 'json_schema', json_schema: schema } } as never) as unknown;
		console.log({ event: 'line_batch_analysis_raw_ai_response_stored', batchId, model: BATCH_EVENT_MODEL, responseType: typeof rawResponse, ...responseDiagnostics(rawResponse) });
		try { parsed = unwrapBatchResponse(rawResponse); }
		catch (error) {
			const parseError = error instanceof Error ? error.message : String(error);
			const result = failureResult(assets, { model: BATCH_EVENT_MODEL, rawResponse, parseSuccess: false, parseError, schemaValidationSuccess: false, schemaValidationError: null, fallbackRequired: true, fallbackReason: 'batch analysis response could not be parsed', ...responseDiagnostics(rawResponse) });
			console.error({ event: 'line_batch_analysis_diagnostics', batchId, ...diagnosticsForLog(result.diagnostics) });
			await bucket.put(`line-batches/${batchId}/analysis.json`, JSON.stringify(result, null, 2), { httpMetadata: { contentType: 'application/json' } });
			return result;
		}
		const schemaError = validateBatchAnalysisSchema(parsed);
		if (schemaError) {
			const result = failureResult(assets, { model: BATCH_EVENT_MODEL, rawResponse, parseSuccess: true, parseError: null, schemaValidationSuccess: false, schemaValidationError: schemaError, fallbackRequired: true, fallbackReason: 'batch analysis response failed schema validation', ...responseDiagnostics(rawResponse) });
			console.error({ event: 'line_batch_analysis_diagnostics', batchId, ...diagnosticsForLog(result.diagnostics) });
			await bucket.put(`line-batches/${batchId}/analysis.json`, JSON.stringify(result, null, 2), { httpMetadata: { contentType: 'application/json' } });
			return result;
		}
		const parsedAnalysis = parsed as {events:Record<string,unknown>[];unassignedAssets:string[];ambiguous:boolean};
		const valid: Omit<BatchExtractionResult, 'diagnostics'> = {...parsedAnalysis,events:parsedAnalysis.events.map(withEventDefaults)};
		const known = new Set(assets.map((asset) => asset.assetId));
		const assigned = new Set<string>();
		for (const event of valid.events) event.assetAssignments = event.assetAssignments.filter((assignment) => known.has(assignment.assetId) && !assigned.has(assignment.assetId) && (assigned.add(assignment.assetId), true));
		valid.unassignedAssets = [...new Set([...valid.unassignedAssets.filter((id) => known.has(id)), ...assets.map((asset) => asset.assetId).filter((id) => !assigned.has(id))])];
		const allUnassigned = assigned.size === 0;
		const fallbackRequired = valid.events.length === 0 || allUnassigned;
		const result: BatchExtractionResult = { ...valid, diagnostics: { model: BATCH_EVENT_MODEL, rawResponse, parseSuccess: true, parseError: null, schemaValidationSuccess: true, schemaValidationError: null, fallbackRequired, fallbackReason: valid.events.length === 0 ? 'batch analysis returned zero events' : allUnassigned ? 'batch analysis assigned no assets to its event candidates' : null, ...responseDiagnostics(rawResponse) } };
		console.log({ event: 'line_batch_analysis_diagnostics', batchId, ...diagnosticsForLog(result.diagnostics), eventCount:result.events.length, unassignedAssetCount:result.unassignedAssets.length, ambiguous:result.ambiguous });
		await bucket.put(`line-batches/${batchId}/analysis.json`, JSON.stringify(result, null, 2), { httpMetadata: { contentType: 'application/json' } });
		return result;
	} catch (error) {
		const parseError = error instanceof Error ? error.message : String(error);
		const result = failureResult(assets, { model: BATCH_EVENT_MODEL, rawResponse, parseSuccess: false, parseError, schemaValidationSuccess: false, schemaValidationError: null, fallbackRequired: true, fallbackReason: 'batch analysis invocation failed', ...responseDiagnostics(rawResponse) });
		console.error({ event: 'line_batch_analysis_diagnostics', batchId, ...diagnosticsForLog(result.diagnostics) });
		await bucket.put(`line-batches/${batchId}/analysis.json`, JSON.stringify(result, null, 2), { httpMetadata: { contentType: 'application/json' } });
		return result;
	}
}
