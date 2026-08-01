import { parseEventDateFromText } from './date-parser';
import type { BatchAssetContext, BatchExtractedEvent } from './batch-event-extraction';
import type { EventAssetRole } from './event-repository';

export interface AssetContribution {
	assetId: string;
	candidateIndex: number | null;
	assigned: boolean;
	assignedRole: EventAssetRole | 'unassigned';
	attributionSignals: string[];
	conflictSignals: string[];
	exactReason: string;
	contributedFields: string[];
	identityScore: number;
	menuLike: boolean;
}

export interface AttributionResult {
	events: BatchExtractedEvent[];
	unassignedAssets: string[];
	contributions: AssetContribution[];
}

interface CandidateEvidence {
	candidateIndex: number;
	fields: string[];
	attributionSignals: string[];
	conflictSignals: string[];
	identityScore: number;
	menuLike: boolean;
	strongCandidate: boolean;
}

const genericTitles = new Set(['wine event', 'event', 'wine dinner', 'untitled']);

function canonical(value: string): string {
	return value.normalize('NFKD').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function contains(evidence: string, value: string | null | undefined): boolean {
	if (!value) return false;
	const needle = canonical(value);
	return needle.length >= 4 && evidence.includes(needle);
}

function meaningfulTitle(title: string | null): boolean {
	const value = canonical(title ?? '');
	return value.length >= 5 && !genericTitles.has(value);
}

function isStrongCandidate(event: BatchExtractedEvent): boolean {
	const additional = [event.startTime, event.price, event.venue, event.contact, event.bookingUrl].some(Boolean) || event.isWineEvent;
	return meaningfulTitle(event.title) && Boolean(event.date) && additional;
}

function dateAliases(date: string | null): string[] {
	if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
	const [year, month, day] = date.split('-').map(Number);
	const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)));
	return [date, `${day} ${monthName} ${year}`, `${monthName} ${day} ${year}`];
}

function menuStructureSignals(text: string): string[] {
	const signals: string[] = [];
	const headings = text.match(/\b(to start|starter|first course|pasta|main course|dessert)\b/gi) ?? [];
	if (headings.length > 0) signals.push(`menu course headings detected: ${[...new Set(headings.map((item) => item.toUpperCase()))].join(', ')}`);
	const vintages = text.match(/\b(?:19|20)\d{2}\b/g) ?? [];
	if (vintages.length >= 2) signals.push(`${vintages.length} wine vintages detected`);
	if (/\b(wine\s*list|wine pairing|paired with|served with)\b/i.test(text)) signals.push('wine-list or pairing structure detected');
	const foodLines = text.split(/\r?\n/).filter((line) => /\b(sauce|cream|roast|grill|pasta|risotto|beef|lamb|pork|fish|tuna|salmon|cheese|chocolate|truffle|mushroom)\b/i.test(line));
	if (foodLines.length >= 2) signals.push(`${foodLines.length} food-description lines detected`);
	return signals;
}

function eventHeading(text: string): string | null {
	const lines = text.split(/\r?\n/).map(canonical).filter((line) => /\b(wine dinner|wine tasting|winemaker dinner|masterclass)\b/.test(line));
	return lines.find((line) => line.split(' ').length >= 3) ?? null;
}

function tokenOverlap(left: string, right: string): number {
	const a = new Set(canonical(left).split(' ').filter(Boolean));
	const b = new Set(canonical(right).split(' ').filter(Boolean));
	if (!a.size || !b.size) return 0;
	return [...a].filter((token) => b.has(token)).length / Math.min(a.size, b.size);
}

function evaluateCandidate(event: BatchExtractedEvent, candidateIndex: number, asset: BatchAssetContext, allEvents: BatchExtractedEvent[]): CandidateEvidence {
	const rawEvidence = `${asset.lineText ?? ''}\n${asset.ocrText}`;
	const evidence = canonical(rawEvidence);
	const fields: string[] = [];
	const attributionSignals: string[] = [];
	const conflictSignals: string[] = [];
	let identityScore = 0;

	if (contains(evidence, event.title)) { fields.push('title'); identityScore += 3; attributionSignals.push('event title appears in asset'); }
	if (dateAliases(event.date).some((alias) => contains(evidence, alias))) { fields.push('date'); identityScore += 3; attributionSignals.push('event date appears in asset'); }
	if (contains(evidence, event.venue)) { fields.push('venue'); identityScore += 2; attributionSignals.push('venue survives into merged candidate'); }
	if (contains(evidence, event.address)) { fields.push('address'); identityScore += 1; attributionSignals.push('address survives into merged candidate'); }
	if (contains(evidence, event.startTime?.replace(':', ' '))) { fields.push('startTime'); identityScore += 1; attributionSignals.push('start time survives into merged candidate'); }
	if (event.price && contains(evidence, event.price.replace(/[^\d.,]/g, ''))) { fields.push('price'); attributionSignals.push('price survives into merged candidate'); }
	if (contains(evidence, event.bookingUrl)) { fields.push('bookingUrl'); attributionSignals.push('booking URL survives into merged candidate'); }
	if (contains(evidence, event.contact)) { fields.push('contact'); attributionSignals.push('contact details survive into merged candidate'); }

	for (const [field, values] of [['wines', event.wines], ['wineRegions', event.wineRegions], ['menu', event.menu], ['notes', event.notes]] as const) {
		const matches = values.filter((value) => contains(evidence, value));
		for (const value of matches) fields.push(`${field}:${value}`);
		if (matches.length > 0) attributionSignals.push(`${matches.length} ${field} value${matches.length === 1 ? '' : 's'} contributed to merged candidate`);
	}

	const structureSignals = menuStructureSignals(rawEvidence);
	attributionSignals.push(...structureSignals);
	const menuLike = structureSignals.length > 0 || fields.some((field) => field.startsWith('wines:') || field.startsWith('wineRegions:') || field.startsWith('menu:'));
	if (menuLike) attributionSignals.push('menu-like OCR structure');

	const detectedDate = parseEventDateFromText(rawEvidence, new Date(`${event.date ?? '2026-01-01'}T00:00:00Z`));
	if (detectedDate && event.date && detectedDate !== event.date) conflictSignals.push(`different event date detected: ${detectedDate} versus ${event.date}`);
	const heading = eventHeading(rawEvidence);
	if (heading && event.title && tokenOverlap(heading, event.title) < 0.4) conflictSignals.push(`different meaningful event title detected: ${heading}`);
	for (const [otherIndex, other] of allEvents.entries()) {
		if (otherIndex === candidateIndex) continue;
		if ((contains(evidence, other.title) || dateAliases(other.date).some((alias) => contains(evidence, alias))) && identityScore < 3) {
			conflictSignals.push(`asset identity points to candidate ${otherIndex}`);
		}
		if (other.venue && contains(evidence, other.venue) && event.venue && !contains(evidence, event.venue)) conflictSignals.push(`different venue points to candidate ${otherIndex}`);
	}

	return { candidateIndex, fields: [...new Set(fields)], attributionSignals: [...new Set(attributionSignals)], conflictSignals: [...new Set(conflictSignals)], identityScore, menuLike, strongCandidate: isStrongCandidate(event) };
}

/** Reconciles AI hints against bounded OCR/LINE evidence. */
export function attributeContributingAssets(events: BatchExtractedEvent[], assets: BatchAssetContext[]): AttributionResult {
	const cloned = events.map((event) => ({ ...event, assetAssignments: [] as BatchExtractedEvent['assetAssignments'] }));
	const hints = events.map((event) => new Map(event.assetAssignments.map((assignment) => [assignment.assetId, assignment.role])));
	const strongIndexes = events.map((event, index) => isStrongCandidate(event) ? index : -1).filter((index) => index >= 0);
	const contributions: AssetContribution[] = [];

	for (const asset of assets) {
		const evaluations = events.map((event, index) => evaluateCandidate(event, index, asset, events));
		let selected: CandidateEvidence | null = null;
		const conflictFree = evaluations.filter((item) => item.conflictSignals.length === 0);
		const identityRanked = conflictFree.filter((item) => item.identityScore >= 3).sort((a, b) => b.identityScore - a.identityScore);
		if (identityRanked.length > 0 && (identityRanked.length === 1 || identityRanked[0].identityScore > identityRanked[1].identityScore)) selected = identityRanked[0];
		else if (strongIndexes.length === 1) {
			const onlyStrong = evaluations[strongIndexes[0]];
			if (onlyStrong.conflictSignals.length === 0 && (onlyStrong.fields.length > 0 || onlyStrong.menuLike)) {
				selected = onlyStrong;
				onlyStrong.attributionSignals.push('exactly one strong primary event');
			}
		} else if (events.length === 1 && conflictFree[0]?.fields.length > 0) selected = conflictFree[0];

		if (!selected) {
			const diagnostic = evaluations.sort((a, b) => b.identityScore - a.identityScore || b.fields.length - a.fields.length)[0];
			contributions.push({ assetId: asset.assetId, candidateIndex: diagnostic?.candidateIndex ?? null, assigned: false, assignedRole: 'unassigned', attributionSignals: diagnostic?.attributionSignals ?? [], conflictSignals: diagnostic?.conflictSignals ?? [], exactReason: diagnostic?.conflictSignals.length ? `left unassigned: ${diagnostic.conflictSignals.join('; ')}` : strongIndexes.length > 1 && diagnostic?.menuLike ? 'left unassigned: multiple strong event candidates could plausibly own this supplementary asset' : 'left unassigned: no deterministic contribution or safe supplementary relationship', contributedFields: diagnostic?.fields ?? [], identityScore: diagnostic?.identityScore ?? 0, menuLike: diagnostic?.menuLike ?? false });
			continue;
		}

		const hintedRole = hints[selected.candidateIndex].get(asset.assetId);
		const assignedRole: EventAssetRole = selected.menuLike && selected.identityScore < 3 ? 'menu' : hintedRole ?? 'other';
		cloned[selected.candidateIndex].assetAssignments.push({ assetId: asset.assetId, role: assignedRole });
		contributions.push({ assetId: asset.assetId, candidateIndex: selected.candidateIndex, assigned: true, assignedRole, attributionSignals: [...new Set(selected.attributionSignals)], conflictSignals: [], exactReason: assignedRole === 'menu' ? 'assigned as menu to the only strong event candidate' : 'assigned to event from deterministic identity or contribution evidence', contributedFields: selected.fields, identityScore: selected.identityScore, menuLike: selected.menuLike });
	}

	for (const [candidateIndex, event] of cloned.entries()) {
		const assigned = contributions.filter((item) => item.assigned && item.candidateIndex === candidateIndex).sort((a, b) => b.identityScore - a.identityScore || (assets.find((asset) => asset.assetId === a.assetId)?.ordinal ?? 0) - (assets.find((asset) => asset.assetId === b.assetId)?.ordinal ?? 0));
		const primary = assigned[0];
		if (primary?.identityScore) {
			event.assetAssignments = event.assetAssignments.map((assignment) => assignment.assetId === primary.assetId ? { ...assignment, role: 'main' } : assignment.role === 'main' ? { ...assignment, role: 'flyer' } : assignment);
			primary.assignedRole = 'main';
			primary.exactReason = 'assigned as main because this asset has the strongest event-identity evidence';
		}
	}

	const assignedIds = new Set(cloned.flatMap((event) => event.assetAssignments.map((assignment) => assignment.assetId)));
	return { events: cloned, unassignedAssets: assets.map((asset) => asset.assetId).filter((assetId) => !assignedIds.has(assetId)), contributions };
}
