import type { NormalizedWineEvent } from './event-normalizer';

export interface CanonicalEventData extends NormalizedWineEvent {
	title: string | null;
}

export type CanonicalEventField = keyof CanonicalEventData;

export interface EventMergeConflict {
	field: CanonicalEventField;
	existingValue: CanonicalEventData[CanonicalEventField];
	incomingValue: CanonicalEventData[CanonicalEventField];
}

export interface EventMergeResult {
	event: CanonicalEventData;
	changedFields: CanonicalEventField[];
	conflicts: EventMergeConflict[];
}

type StringField = 'title' | 'date' | 'startTime' | 'venue' | 'contactEmail' | 'contactPhone'
	| 'organizer' | 'address' | 'district' | 'websiteUrl' | 'bookingUrl' | 'bookingInstructions'
	| 'contactText' | 'description' | 'priceText' | 'currency' | 'priceQualifier' | 'endTime' | 'timezone';

function displayString(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const trimmed = value.trim();
	return trimmed || null;
}

function canonicalText(value: string): string {
	return value.normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/g, ' ');
}

function canonicalPhone(value: string): string {
	return value.replace(/[^\d+]/g, '');
}

function stringsEqual(field: StringField, left: string, right: string): boolean {
	if (field === 'contactPhone') return canonicalPhone(left) === canonicalPhone(right);
	return canonicalText(left) === canonicalText(right);
}

function mergeString(
	field: StringField,
	existingValue: string | null,
	incomingValue: string | null | undefined,
	conflicts: EventMergeConflict[],
): string | null {
	const existing = displayString(existingValue);
	const incoming = displayString(incomingValue);
	if (!existing) return incoming;
	if (!incoming || stringsEqual(field, existing, incoming)) return existingValue;

	conflicts.push({ field, existingValue, incomingValue: incoming });
	return existingValue;
}

function mergeNumber(
	field: 'priceTHB' | 'courseCount',
	existingValue: number | null,
	incomingValue: number | null | undefined,
	conflicts: EventMergeConflict[],
): number | null {
	if (existingValue === null) return incomingValue ?? null;
	if (incomingValue === null || incomingValue === undefined || incomingValue === existingValue) return existingValue;

	conflicts.push({ field, existingValue, incomingValue });
	return existingValue;
}

function mergeStableUnion(existing: string[], incoming: string[] | null | undefined): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();

	for (const value of [...existing, ...(incoming ?? [])]) {
		const display = displayString(value);
		if (!display) continue;
		const canonical = canonicalText(display);
		if (seen.has(canonical)) continue;
		seen.add(canonical);
		merged.push(display);
	}

	return merged;
}

function arraysEqual(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function mergeEventData(
	existing: CanonicalEventData,
	incoming: Partial<CanonicalEventData>,
): EventMergeResult {
	const conflicts: EventMergeConflict[] = [];
	const event: CanonicalEventData = {
		title: mergeString('title', existing.title, incoming.title, conflicts),
		date: mergeString('date', existing.date, incoming.date, conflicts),
		startTime: mergeString('startTime', existing.startTime, incoming.startTime, conflicts),
		priceTHB: mergeNumber('priceTHB', existing.priceTHB, incoming.priceTHB, conflicts),
		venue: mergeString('venue', existing.venue, incoming.venue, conflicts),
		contactEmail: mergeString('contactEmail', existing.contactEmail, incoming.contactEmail, conflicts),
		contactPhone: mergeString('contactPhone', existing.contactPhone, incoming.contactPhone, conflicts),
		wines: mergeStableUnion(existing.wines, incoming.wines),
		wineRegions: mergeStableUnion(existing.wineRegions, incoming.wineRegions),
		isWineEvent: existing.isWineEvent || incoming.isWineEvent === true,
	};
	const mutable = event as unknown as Record<string, unknown>;
	for (const field of ['organizer','address','district','websiteUrl','bookingUrl','bookingInstructions','contactText','description','priceText','currency','priceQualifier','endTime','timezone'] as const) {
		if (existing[field] !== undefined || incoming[field] !== undefined) mutable[field] = mergeString(field, existing[field] ?? null, incoming[field], conflicts);
	}
	if (existing.courseCount !== undefined || incoming.courseCount !== undefined) mutable.courseCount = mergeNumber('courseCount', existing.courseCount ?? null, incoming.courseCount, conflicts);
	for (const field of ['wineProducers','partners','merchants','menu','notes','sourceContactInformation'] as const) {
		if (existing[field] !== undefined || incoming[field] !== undefined) mutable[field] = mergeStableUnion(existing[field] ?? [], incoming[field]);
	}

	const changedFields = (Object.keys(event) as CanonicalEventField[]).filter((field) => {
		const before = existing[field];
		const after = event[field];
		if (Array.isArray(before) && Array.isArray(after)) return !arraysEqual(before, after);
		return before !== after;
	});

	return { event, changedFields, conflicts };
}
