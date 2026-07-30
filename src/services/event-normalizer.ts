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
	return {
		date: normalizeDate(event.date),
		startTime: event.startTime,
		priceTHB: normalizePrice(event.price),
		venue: event.venue,
		contactEmail: extractEmail(event.contact) ?? extractEmail(event.bookingUrl),
		contactPhone: extractPhone(event.contact),
		wines: event.wines,
		wineRegions: [],
		isWineEvent: event.isWineEvent,
	};
}
