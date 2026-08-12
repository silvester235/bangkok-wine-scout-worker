import { buildEventExtractionContext } from './event-extraction-context';
import { extractAndStoreEvent, type ExtractedWineEvent } from './event-extraction';
import { normalizeUtf8Text, normalizeWineEvent } from './event-normalizer';
import type { BatchAssetContext, BatchExtractedEvent } from './batch-event-extraction';
import { parseEventDateFromText } from './date-parser';
import { parseEventTime } from './time-parser';
import { parsePriceEvidence } from './deterministic-event-parser';

export interface SingleAssetFallbackDiagnostic {
	assetId: string;
	status: 'completed' | 'failed';
	error: string | null;
	event: ExtractedWineEvent | null;
	strongPrimary: boolean;
	menuLike: boolean;
	independentIdentity: boolean;
}

export interface BatchFallbackResult {
	events: BatchExtractedEvent[];
	unassignedAssets: string[];
	ambiguous: boolean;
	diagnostics: SingleAssetFallbackDiagnostic[];
}

const genericTitles = new Set(['wine event', 'event', 'wine dinner', 'untitled']);

export function hasMeaningfulEventTitle(title: string | null): boolean {
	const normalized = title?.trim().toLocaleLowerCase('en-US') ?? '';
	return normalized.length >= 5 && !genericTitles.has(normalized);
}

export function isStrongPrimaryCandidate(event: ExtractedWineEvent, evidenceText: string): boolean {
	const normalized = normalizeWineEvent(event);
	const additionalSignals = [
		Boolean(normalized.startTime),
		Boolean(normalized.priceTHB !== null),
		Boolean(normalized.venue),
		Boolean(normalized.contactEmail || normalized.contactPhone || event.bookingUrl),
		Boolean(event.isWineEvent || /\bwine\s+(?:dinner|tasting|event)\b/i.test(evidenceText)),
	].filter(Boolean).length;
	return hasMeaningfulEventTitle(normalizeUtf8Text(event.title)) && Boolean(normalized.date) && additionalSignals >= 1;
}

export function isMenuLikeAsset(event: ExtractedWineEvent | null, ocrText: string): boolean {
	if (event && (event.menu.length > 0 || event.wines.length >= 2)) return true;
	return /\b(menu|wine\s*list|starter|appetizer|main\s+course|dessert|course|pairing|dish|served\s+with|vintage)\b/i.test(ocrText);
}

function unique(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }

function deriveFallbackTitle(text: string): string {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const usable = lines.filter((line) => {
		if (line.length < 3 || line.length > 100 || /^\[?unclear\]?$/i.test(line)) return false;
		if (/^(?:menu|buffet|all you can eat|scan|line|contact|meet us|information)$/i.test(line)) return false;
		if (/^(?:\d{1,2}[.:]\d{2}|\d{1,2}\s*(?:am|pm)|(?:thb|฿)?\s*[\d,.]+(?:\s*\+\+|\.-)?)$/i.test(line)) return false;
		if (/^(?:\d{1,2}\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(line)) return false;
		return true;
	});
	return usable.find((line) => /\b(?:wine|aperitivo|tasting|dinner|masterclass|event)\b/i.test(line))
		?? usable[0]
		?? 'Wine Event';
}

function deriveFallbackPrice(text: string): string | null {
	return parsePriceEvidence(text).value?.raw ?? null;
}

function minimalEvent(asset: BatchAssetContext): ExtractedWineEvent {
	const evidence = `${asset.lineText ?? ''}\n${asset.ocrText}`.trim();
	return {
		isWineEvent: true,
		title: deriveFallbackTitle(evidence),
		venue: null,
		address: null,
		date: parseEventDateFromText(evidence, new Date(asset.receivedAt)),
		startTime: parseEventTime(evidence),
		endTime: null,
		timezone: null,
		price: deriveFallbackPrice(evidence),
		currency: null,
		bookingUrl: null,
		contact: null,
		wines: [],
		wineRegions: [],
		menu: [],
		notes: [],
		confidence: 0,
	};
}

function candidateScore(event: ExtractedWineEvent, diagnostic: SingleAssetFallbackDiagnostic): number {
	const normalized = normalizeWineEvent(event);
	return (hasMeaningfulEventTitle(normalizeUtf8Text(event.title)) ? 5 : 0)
		+ (normalized.date ? 4 : 0)
		+ (normalized.venue ? 2 : 0)
		+ (normalized.startTime ? 1 : 0)
		+ (normalized.priceTHB !== null ? 1 : 0)
		+ (event.bookingUrl || event.contact ? 1 : 0)
		+ (diagnostic.menuLike ? -3 : 2);
}

export async function recoverBatchEventsWithSingleAssetFallback(ai: Ai, bucket: R2Bucket, batchId: string, assets: BatchAssetContext[]): Promise<BatchFallbackResult> {
	const diagnostics: SingleAssetFallbackDiagnostic[] = [];
	const extracted = new Map<string, ExtractedWineEvent>();
	for (const asset of assets) {
		const extraction = await extractAndStoreEvent(ai, bucket, {
			intakeId: asset.intakeId,
			assetId: asset.assetId,
			context: buildEventExtractionContext({ sourceText: asset.lineText, ocrText: asset.ocrText }),
			referenceDate: new Date(asset.receivedAt),
		});
		let event = extraction.status === 'completed' ? extraction.event : null;
		if(event){const deterministicDate=parseEventDateFromText(`${asset.lineText??''}\n${asset.ocrText}`,new Date(asset.receivedAt));if(deterministicDate)event={...event,date:deterministicDate};}
		if (event) extracted.set(asset.assetId, event);
		const strongPrimary = event ? isStrongPrimaryCandidate(event, `${asset.lineText ?? ''}\n${asset.ocrText}`) : false;
		const menuLike = isMenuLikeAsset(event, asset.ocrText);
		const normalized = event ? normalizeWineEvent(event) : null;
		const independentIdentity = Boolean(event && hasMeaningfulEventTitle(normalizeUtf8Text(event.title)) && normalized?.date);
		diagnostics.push({ assetId: asset.assetId, status: extraction.status, error: extraction.error ?? null, event, strongPrimary, menuLike, independentIdentity });
		console.log({ event: 'line_batch_single_asset_fallback_result', batchId, assetId: asset.assetId, model: extraction.model, status: extraction.status, detectedFields:event?Object.entries(event).filter(([,value])=>value!==null&&value!==undefined&&(!Array.isArray(value)||value.length>0)).map(([field])=>field):[], error: extraction.error ?? null, strongPrimary, menuLike, independentIdentity });
	}

	const ranked = assets.map((asset, index) => {
		const diagnostic = diagnostics[index];
		const extractedEvent = extracted.get(asset.assetId);
		const deterministic = minimalEvent(asset);
		const event = extractedEvent
			? {
				...extractedEvent,
				isWineEvent: true,
				title: hasMeaningfulEventTitle(normalizeUtf8Text(extractedEvent.title)) ? extractedEvent.title : deterministic.title,
				date: extractedEvent.date ?? deterministic.date,
				startTime: extractedEvent.startTime ?? deterministic.startTime,
				price: extractedEvent.price ?? deterministic.price,
			}
			: deterministic;
		return { asset, diagnostic, event, score: candidateScore(event, diagnostic) };
	}).sort((left, right) => right.score - left.score || left.asset.ordinal - right.asset.ordinal);

	const primary = ranked[0];
	const events: BatchExtractedEvent[] = primary ? [{
		...primary.event,
		assetAssignments: assets.map((asset) => ({
			assetId: asset.assetId,
			role: asset.assetId === primary.asset.assetId
				? 'main' as const
				: diagnostics.find((item) => item.assetId === asset.assetId)?.menuLike ? 'menu' as const : 'other' as const,
		})),
	}] : [];

	if (events[0] && primary) {
		for (const secondary of extracted.values()) {
			if (secondary === extracted.get(primary.asset.assetId)) continue;
			events[0].wines = unique([...events[0].wines, ...secondary.wines]);
			events[0].wineRegions = unique([...events[0].wineRegions, ...secondary.wineRegions]);
			events[0].menu = unique([...events[0].menu, ...secondary.menu]);
			events[0].notes = unique([...events[0].notes, ...secondary.notes]);
			events[0].wineProducers = unique([...(events[0].wineProducers ?? []), ...(secondary.wineProducers ?? [])]);
			events[0].partners = unique([...(events[0].partners ?? []), ...(secondary.partners ?? [])]);
			events[0].merchants = unique([...(events[0].merchants ?? []), ...(secondary.merchants ?? [])]);
			events[0].sourceContactInformation = unique([...(events[0].sourceContactInformation ?? []), ...(secondary.sourceContactInformation ?? [])]);
		}
	}

	const result = {
		events,
		unassignedAssets: [],
		ambiguous: false,
		diagnostics,
	};
	await bucket.put(`line-batches/${batchId}/fallback-analysis.json`, JSON.stringify(result, null, 2), { httpMetadata: { contentType: 'application/json' } });
	console.log({ event: 'line_batch_single_asset_fallback_completed', batchId, eventCount:result.events.length, unassignedAssetCount:result.unassignedAssets.length, ambiguous:result.ambiguous });
	return result;
}
