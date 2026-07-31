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

function bangkokDate(value: Date): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Asia/Bangkok',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(value);
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

export function validateWineEvent(input: EventValidationInput): EventValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const title = input.title?.trim() ?? '';
	const bookingUrl = input.bookingUrl?.trim() ?? '';
	const event = input.event;

	if (!event.isWineEvent) errors.push('Not classified as a wine event');
	if (!title) errors.push('Missing title');
	else if (title.length < 5) errors.push('Title is too short');

	if (!event.date) {
		errors.push('Missing or invalid date');
	} else if (!isValidIsoDate(event.date)) {
		errors.push('Invalid date');
	} else if (event.date < bangkokDate(input.now ?? new Date())) {
		errors.push('Event date is in the past');
	}

	if (event.startTime !== null && !isValidTime(event.startTime)) {
		errors.push('Invalid start time');
	}

	if (event.priceTHB !== null && (!Number.isFinite(event.priceTHB) || event.priceTHB < 0)) {
		errors.push('Invalid price');
	}

	if (bookingUrl && !isValidUrl(bookingUrl)) errors.push('Invalid booking URL');

	if (!event.startTime) warnings.push('Missing start time');
	if (!event.venue?.trim()) warnings.push('Missing venue');
	if (event.priceTHB === null) warnings.push('Missing price');
	if (!bookingUrl) warnings.push('Missing booking URL');
	if (!event.contactEmail && !event.contactPhone) warnings.push('Missing contact information');

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}
