import type { BatchAssetContext, BatchExtractedEvent } from './batch-event-extraction';
import type { EventAssetRole } from './event-repository';

export interface AssetContribution {
	assetId: string;
	candidateIndex: number;
	role: EventAssetRole | 'unassigned';
	contributedFields: string[];
	identityScore: number;
	menuLike: boolean;
	assigned: boolean;
}

export interface AttributionResult {
	events: BatchExtractedEvent[];
	unassignedAssets: string[];
	contributions: AssetContribution[];
}

function canonical(value: string): string {
	return value.normalize('NFKD').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function contains(evidence: string, value: string | null | undefined): boolean {
	if (!value) return false;
	const needle = canonical(value);
	return needle.length >= 4 && evidence.includes(needle);
}

function dateAliases(date: string | null): string[] {
	if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
	const [year, month, day] = date.split('-').map(Number);
	const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)));
	return [date, `${day} ${monthName} ${year}`, `${monthName} ${day} ${year}`];
}

function contributionFields(event: BatchExtractedEvent, asset: BatchAssetContext): { fields: string[]; identityScore: number; menuLike: boolean } {
	const evidence = canonical(`${asset.lineText ?? ''}\n${asset.ocrText}`);
	const fields: string[] = [];
	let identityScore = 0;
	if (contains(evidence, event.title)) { fields.push('title'); identityScore += 3; }
	if (dateAliases(event.date).some((alias) => contains(evidence, alias))) { fields.push('date'); identityScore += 3; }
	if (contains(evidence, event.venue)) { fields.push('venue'); identityScore += 2; }
	if (contains(evidence, event.address)) { fields.push('address'); identityScore += 1; }
	if (contains(evidence, event.startTime?.replace(':', ' '))) { fields.push('startTime'); identityScore += 1; }
	if (event.price && contains(evidence, event.price.replace(/[^\d.,]/g, ''))) fields.push('price');
	if (contains(evidence, event.bookingUrl)) fields.push('bookingUrl');
	if (contains(evidence, event.contact)) fields.push('contact');
	for (const [field, values] of [['wines', event.wines], ['wineRegions', event.wineRegions], ['menu', event.menu], ['notes', event.notes]] as const) {
		for (const value of values) if (contains(evidence, value)) fields.push(`${field}:${value}`);
	}
	const menuLike = fields.some((field) => field.startsWith('wines:') || field.startsWith('wineRegions:') || field.startsWith('menu:'))
		|| /\b(menu|wine list|starter|appetizer|main course|dessert|pairing|served with|vintage)\b/i.test(asset.ocrText);
	return { fields: [...new Set(fields)], identityScore, menuLike };
}

/**
 * Rebuilds asset ownership from factual evidence in each asset. AI assignments are
 * retained as hints, but an unassigned asset is linked whenever its text supplied
 * data that survives in the event candidate.
 */
export function attributeContributingAssets(events: BatchExtractedEvent[], assets: BatchAssetContext[]): AttributionResult {
	const cloned = events.map((event) => ({ ...event, assetAssignments: [...event.assetAssignments] }));
	const contributions: AssetContribution[] = [];
	const globallyAssigned = new Set<string>();

	for (const [candidateIndex, event] of cloned.entries()) {
		const evidence = assets.map((asset) => ({ asset, ...contributionFields(event, asset) }));
		const hintedAssignments = new Map(event.assetAssignments.map((assignment) => [assignment.assetId, assignment.role]));
		event.assetAssignments = [];
		for (const item of evidence) {
			const hintedRole = hintedAssignments.get(item.asset.assetId);
			let assigned = false;
			let role: EventAssetRole | 'unassigned' = 'unassigned';
			if (!globallyAssigned.has(item.asset.assetId) && item.fields.length > 0) {
				// Content-only evidence is safe for a menu when there is one candidate.
				// In a multi-event batch, require identity evidence to avoid cross-linking.
				if (cloned.length === 1 || item.identityScore >= 3) {
					assigned = true;
					role = item.menuLike && item.identityScore < 3 ? 'menu' : hintedRole ?? 'other';
					event.assetAssignments.push({ assetId: item.asset.assetId, role });
					globallyAssigned.add(item.asset.assetId);
				}
			}
			contributions.push({ assetId: item.asset.assetId, candidateIndex, role, contributedFields: item.fields, identityScore: item.identityScore, menuLike: item.menuLike, assigned });
		}

		const assignedEvidence = evidence.filter((item) => event.assetAssignments.some((assignment) => assignment.assetId === item.asset.assetId));
		const primary = assignedEvidence.sort((a, b) => b.identityScore - a.identityScore || a.asset.ordinal - b.asset.ordinal)[0];
		if (primary && primary.identityScore > 0) {
			event.assetAssignments = event.assetAssignments.map((assignment) => assignment.assetId === primary.asset.assetId
				? { ...assignment, role: 'main' }
				: assignment.role === 'main' ? { ...assignment, role: 'flyer' } : assignment);
		}
	}

	const finalAssigned = new Set(cloned.flatMap((event) => event.assetAssignments.map((assignment) => assignment.assetId)));
	for (const contribution of contributions) {
		const assignment = cloned[contribution.candidateIndex]?.assetAssignments.find((item) => item.assetId === contribution.assetId);
		if (assignment) { contribution.assigned = true; contribution.role = assignment.role; }
	}
	return { events: cloned, unassignedAssets: assets.map((asset) => asset.assetId).filter((assetId) => !finalAssigned.has(assetId)), contributions };
}
