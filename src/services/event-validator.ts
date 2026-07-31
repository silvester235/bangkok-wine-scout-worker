import type { NormalizedWineEvent } from './event-normalizer';

export interface EventValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

export interface EventValidationInput {
	title: string | null;
	bookingUrl: string | null;
	event: NormalizedWineEvent;
	now?: Date;
}

function isValidIsoDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidTime(value: string): boolean {
	return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isValidUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * Metadata validation is informational. Once technical processing succeeds,
 * missing or malformed business metadata never blocks publication.
 */
export function validateWineEvent(input: EventValidationInput): EventValidationResult {
	const warnings: string[] = [];
	const title = input.title?.trim() ?? '';
	const bookingUrl = input.bookingUrl?.trim() ?? '';
	const event = input.event;

	if (!event.isWineEvent) warnings.push('Wine event classification not detected');
	if (!title) warnings.push('Title not detected');
	else if (title.length < 5) warnings.push('Title may be incomplete');

	if (!event.date) warnings.push('Date not detected');
	else if (!isValidIsoDate(event.date)) warnings.push('Detected date could not be normalized');

	if (!event.startTime) warnings.push('Time not detected');
	else if (!isValidTime(event.startTime)) warnings.push('Detected start time could not be normalized');

	if (event.priceTHB === null) warnings.push('Price not detected');
	else if (!Number.isFinite(event.priceTHB) || event.priceTHB < 0) {
		warnings.push('Detected price could not be normalized');
	}

	if (!bookingUrl) warnings.push('Booking URL not detected');
	else if (!isValidUrl(bookingUrl)) warnings.push('Detected booking URL could not be normalized');

	if (!event.venue?.trim()) warnings.push('Venue not detected');
	if (!event.contactEmail && !event.contactPhone) warnings.push('Contact information not detected');
	if (warnings.length > 0) warnings.push('Published with partial metadata');

	return { valid: true, errors: [], warnings };
}
