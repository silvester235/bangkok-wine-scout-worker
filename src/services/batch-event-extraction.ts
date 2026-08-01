import type { ExtractedWineEvent } from './event-extraction';
import type { EventAssetRole } from './event-repository';

export const BATCH_EVENT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

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
}

export interface BatchExtractionResult {
	events: BatchExtractedEvent[];
	unassignedAssets: string[];
	ambiguous: boolean;
	diagnostics: BatchExtractionDiagnostics;
}

const eventProperties = {
	isWineEvent: { type: 'boolean' }, title: { type: ['string', 'null'] }, venue: { type: ['string', 'null'] },
	address: { type: ['string', 'null'] }, date: { type: ['string', 'null'] }, startTime: { type: ['string', 'null'] },
	endTime: { type: ['string', 'null'] }, timezone: { type: ['string', 'null'] }, price: { type: ['string', 'null'] },
	currency: { type: ['string', 'null'] }, bookingUrl: { type: ['string', 'null'] }, contact: { type: ['string', 'null'] },
	wines: { type: 'array', items: { type: 'string' } }, wineRegions: { type: 'array', items: { type: 'string' } },
	menu: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } },
	confidence: { type: 'number' },
	assetAssignments: { type: 'array', items: { type: 'object', properties: { assetId: { type: 'string' }, role: { type: 'string', enum: ['main', 'flyer', 'menu', 'reminder', 'social', 'map', 'other'] } }, required: ['assetId', 'role'], additionalProperties: false } },
} as const;
const required = [...Object.keys(eventProperties)] as string[];
const schema = { type: 'object', properties: { events: { type: 'array', items: { type: 'object', properties: eventProperties, required, additionalProperties: false } }, unassignedAssets: { type: 'array', items: { type: 'string' } }, ambiguous: { type: 'boolean' } }, required: ['events', 'unassignedAssets', 'ambiguous'], additionalProperties: false } as const;
const roles = new Set<EventAssetRole>(['main', 'flyer', 'menu', 'reminder', 'social', 'map', 'other']);

function parseJson(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	return JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
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
		if (typeof event.isWineEvent !== 'boolean') return `events[${index}].isWineEvent must be a boolean`;
		for (const field of ['title', 'venue', 'address', 'date', 'startTime', 'endTime', 'timezone', 'price', 'currency', 'bookingUrl', 'contact']) {
			if (!nullableString(event[field])) return `events[${index}].${field} must be a string or null`;
		}
		for (const field of ['wines', 'wineRegions', 'menu', 'notes']) if (!stringArray(event[field])) return `events[${index}].${field} must be a string array`;
		if (typeof event.confidence !== 'number' || !Number.isFinite(event.confidence)) return `events[${index}].confidence must be a finite number`;
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

export function buildBatchAnalysisContext(assets: BatchAssetContext[]): string {
	return assets.map((asset) => `ASSET ${asset.ordinal}\nassetId: ${asset.assetId}\nreceivedAt: ${asset.receivedAt}\ncontentType: ${asset.contentType}\n${asset.lineText ? `LINE TEXT:\n${asset.lineText}\n` : ''}OCR TEXT:\n${asset.ocrText || '[OCR unavailable]'}`).join('\n\n---\n\n');
}

function failureResult(assets: BatchAssetContext[], diagnostics: BatchExtractionDiagnostics): BatchExtractionResult {
	return { events: [], unassignedAssets: assets.map((asset) => asset.assetId), ambiguous: true, diagnostics };
}

export async function extractBatchEvents(ai: Ai, bucket: R2Bucket, batchId: string, assets: BatchAssetContext[]): Promise<BatchExtractionResult> {
	const context = buildBatchAnalysisContext(assets);
	await bucket.put(`line-batches/${batchId}/analysis-context.txt`, context, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
	let rawResponse: unknown = null;
	let parsed: unknown;
	try {
		if (!assets.some((asset) => asset.ocrText || asset.lineText)) throw new Error('Batch analysis context is empty.');
		rawResponse = await ai.run(BATCH_EVENT_MODEL, { messages: [{ role: 'system', content: 'Analyze a provisional batch of LINE images. Timing is not evidence of event identity. Split conflicting titles, dates, or venues into separate events. Assign supporting menu/reminder assets only when a primary asset explicitly identifies the event. A menu or wine list without independent event identity must be unassigned and must not become an event. Never invent missing facts. Keep every asset boundary and return only supported structured data.' }, { role: 'user', content: context }], temperature: 0, max_tokens: 4096, stream: false, response_format: { type: 'json_schema', json_schema: schema } } as never) as unknown;
		console.log({ event: 'line_batch_analysis_raw_ai_response', batchId, model: BATCH_EVENT_MODEL, rawResponse });
		try { parsed = unwrapBatchResponse(rawResponse); }
		catch (error) {
			const parseError = error instanceof Error ? error.message : String(error);
			const result = failureResult(assets, { model: BATCH_EVENT_MODEL, rawResponse, parseSuccess: false, parseError, schemaValidationSuccess: false, schemaValidationError: null, fallbackRequired: true, fallbackReason: 'batch analysis response could not be parsed' });
			console.error({ event: 'line_batch_analysis_diagnostics', batchId, ...result.diagnostics });
			await bucket.put(`line-batches/${batchId}/analysis.json`, JSON.stringify(result, null, 2), { httpMetadata: { contentType: 'application/json' } });
			return result;
		}
		const schemaError = validateBatchAnalysisSchema(parsed);
		if (schemaError) {
			const result = failureResult(assets, { model: BATCH_EVENT_MODEL, rawResponse, parseSuccess: true, parseError: null, schemaValidationSuccess: false, schemaValidationError: schemaError, fallbackRequired: true, fallbackReason: 'batch analysis response failed schema validation' });
			console.error({ event: 'line_batch_analysis_diagnostics', batchId, ...result.diagnostics });
			await bucket.put(`line-batches/${batchId}/analysis.json`, JSON.stringify(result, null, 2), { httpMetadata: { contentType: 'application/json' } });
			return result;
		}
		const valid = parsed as Omit<BatchExtractionResult, 'diagnostics'>;
		const known = new Set(assets.map((asset) => asset.assetId));
		const assigned = new Set<string>();
		for (const event of valid.events) event.assetAssignments = event.assetAssignments.filter((assignment) => known.has(assignment.assetId) && !assigned.has(assignment.assetId) && (assigned.add(assignment.assetId), true));
		valid.unassignedAssets = [...new Set([...valid.unassignedAssets.filter((id) => known.has(id)), ...assets.map((asset) => asset.assetId).filter((id) => !assigned.has(id))])];
		const allUnassigned = assigned.size === 0;
		const fallbackRequired = valid.events.length === 0 || allUnassigned;
		const result: BatchExtractionResult = { ...valid, diagnostics: { model: BATCH_EVENT_MODEL, rawResponse, parseSuccess: true, parseError: null, schemaValidationSuccess: true, schemaValidationError: null, fallbackRequired, fallbackReason: valid.events.length === 0 ? 'batch analysis returned zero events' : allUnassigned ? 'batch analysis assigned no assets to its event candidates' : null } };
		console.log({ event: 'line_batch_analysis_diagnostics', batchId, ...result.diagnostics, normalizedAnalysisResult: { events: result.events, unassignedAssets: result.unassignedAssets, ambiguous: result.ambiguous } });
		await bucket.put(`line-batches/${batchId}/analysis.json`, JSON.stringify(result, null, 2), { httpMetadata: { contentType: 'application/json' } });
		return result;
	} catch (error) {
		const parseError = error instanceof Error ? error.message : String(error);
		const result = failureResult(assets, { model: BATCH_EVENT_MODEL, rawResponse, parseSuccess: false, parseError, schemaValidationSuccess: false, schemaValidationError: null, fallbackRequired: true, fallbackReason: 'batch analysis invocation failed' });
		console.error({ event: 'line_batch_analysis_diagnostics', batchId, ...result.diagnostics });
		await bucket.put(`line-batches/${batchId}/analysis.json`, JSON.stringify(result, null, 2), { httpMetadata: { contentType: 'application/json' } });
		return result;
	}
}
