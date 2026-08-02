import { buildEventExtractionContext } from './event-extraction-context';
import { extractAndStoreEvent, type ExtractedWineEvent } from './event-extraction';
import { normalizeUtf8Text, normalizeWineEvent } from './event-normalizer';
import type { BatchAssetContext, BatchExtractedEvent } from './batch-event-extraction';
import { parseEventDateFromText } from './date-parser';

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

export async function recoverBatchEventsWithSingleAssetFallback(ai: Ai, bucket: R2Bucket, batchId: string, assets: BatchAssetContext[]): Promise<BatchFallbackResult> {
	const diagnostics: SingleAssetFallbackDiagnostic[] = [];
	const extracted = new Map<string, ExtractedWineEvent>();
	for (const asset of assets) {
		const extraction = await extractAndStoreEvent(ai, bucket, {
			intakeId: asset.intakeId,
			assetId: asset.assetId,
			context: buildEventExtractionContext({ sourceText: asset.lineText, ocrText: asset.ocrText }),
		});
		let event = extraction.status === 'completed' ? extraction.event : null;
		if(event&&!event.date){const deterministicDate=parseEventDateFromText(`${asset.lineText??''}\n${asset.ocrText}`,new Date(asset.receivedAt));if(deterministicDate)event={...event,date:deterministicDate};}
		if (event) extracted.set(asset.assetId, event);
		const strongPrimary = event ? isStrongPrimaryCandidate(event, `${asset.lineText ?? ''}\n${asset.ocrText}`) : false;
		const menuLike = isMenuLikeAsset(event, asset.ocrText);
		const normalized = event ? normalizeWineEvent(event) : null;
		const independentIdentity = Boolean(event && hasMeaningfulEventTitle(normalizeUtf8Text(event.title)) && normalized?.date);
		diagnostics.push({ assetId: asset.assetId, status: extraction.status, error: extraction.error ?? null, event, strongPrimary, menuLike, independentIdentity });
		console.log({ event: 'line_batch_single_asset_fallback_result', batchId, assetId: asset.assetId, model: extraction.model, status: extraction.status, extractionResult: event, error: extraction.error ?? null, strongPrimary, menuLike, independentIdentity });
	}

	const primaryDiagnostics = diagnostics.filter((item) => item.strongPrimary);
	const events: BatchExtractedEvent[] = primaryDiagnostics.map((diagnostic) => ({
		...extracted.get(diagnostic.assetId)!,
		assetAssignments: [{ assetId: diagnostic.assetId, role: 'flyer' }],
	}));
	const assigned = new Set(primaryDiagnostics.map((item) => item.assetId));

	// A secondary menu is safe to associate only when the provisional batch has
	// exactly one independently identified primary and no conflicting identity.
	if (events.length === 1) {
		for (const diagnostic of diagnostics) {
			if (assigned.has(diagnostic.assetId) || !diagnostic.menuLike || diagnostic.independentIdentity) continue;
			events[0].assetAssignments.push({ assetId: diagnostic.assetId, role: 'menu' });
			assigned.add(diagnostic.assetId);
			const secondary = extracted.get(diagnostic.assetId);
			if (secondary) {
				events[0].wines = unique([...events[0].wines, ...secondary.wines]);
				events[0].wineRegions = unique([...events[0].wineRegions, ...secondary.wineRegions]);
				events[0].menu = unique([...events[0].menu, ...secondary.menu]);
				events[0].notes = unique([...events[0].notes, ...secondary.notes]);
			}
		}
	}

	const result = {
		events,
		unassignedAssets: assets.map((asset) => asset.assetId).filter((assetId) => !assigned.has(assetId)),
		ambiguous: events.length === 0 || (events.length > 1 && assigned.size < assets.length),
		diagnostics,
	};
	await bucket.put(`line-batches/${batchId}/fallback-analysis.json`, JSON.stringify(result, null, 2), { httpMetadata: { contentType: 'application/json' } });
	console.log({ event: 'line_batch_single_asset_fallback_completed', batchId, normalizedAnalysisResult: { events: result.events, unassignedAssets: result.unassignedAssets, ambiguous: result.ambiguous } });
	return result;
}
