export interface NormalizedWineEvent {
	date: string | null;
	startTime: string | null;
	priceTHB: number | null;
	venue: string | null;
	contactEmail: string | null;
	contactPhone: string | null;
	wines: string[];
	wineRegions: string[];
	isWineEvent: boolean;
}

const MOJIBAKE_PATTERN = /(?:Ã.|Â.|â.|ð.|ï¿½)/;

/**
 * Repairs text that was UTF-8 encoded but accidentally decoded as Latin-1.
 * Correct Unicode text (including Thai) is returned unchanged.
 */
export function normalizeUtf8Text(value: string | null): string | null {
	if (!value || !MOJIBAKE_PATTERN.test(value)) return value;

	try {
		const bytes = Uint8Array.from(value, (character) => character.charCodeAt(0));
		const repaired = new TextDecoder('utf-8', { fatal: true }).decode(bytes);

		return MOJIBAKE_PATTERN.test(repaired) ? value : repaired;
	} catch {
		return value;
	}
}

function normalizePrice(price: string | null): number | null {
	if (!price) return null;
	const match = price.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
	return match ? Number(match[0]) : null;
}

function normalizeDate(value: string | null): string | null {
	if (!value) return null;
	const parsed = new Date(value);
	if (!Number.isNaN(parsed.getTime())) {
		return parsed.toISOString().slice(0, 10);
	}
	return value;
}

function extractEmail(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
	return match?.[0] ?? null;
}

function extractPhone(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/\+?\d[\d\s-]{7,}/);
	return match?.[0]?.trim() ?? null;
}

export function normalizeWineEvent(event: {
	isWineEvent: boolean;
	date: string | null;
	startTime: string | null;
	price: string | null;
	venue: string | null;
	contact: string | null;
	bookingUrl: string | null;
	wines: string[];
}): NormalizedWineEvent {
	const venue = normalizeUtf8Text(event.venue);
	const contact = normalizeUtf8Text(event.contact);
	const bookingUrl = normalizeUtf8Text(event.bookingUrl);

	return {
		date: normalizeDate(normalizeUtf8Text(event.date)),
		startTime: normalizeUtf8Text(event.startTime),
		priceTHB: normalizePrice(normalizeUtf8Text(event.price)),
		venue,
		contactEmail: extractEmail(contact) ?? extractEmail(bookingUrl),
		contactPhone: extractPhone(contact),
		wines: event.wines.map((wine) => normalizeUtf8Text(wine) ?? wine),
		wineRegions: [],
		isWineEvent: event.isWineEvent,
	};
}
