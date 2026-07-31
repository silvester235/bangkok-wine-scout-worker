function pad(value: number): string {
	return value.toString().padStart(2, '0');
}

function formatTime(hour: number, minute: number): string | null {
	if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
	return `${pad(hour)}:${pad(minute)}`;
}

function normalizeInput(value: string): string {
	return value
		.normalize('NFC')
		.toLowerCase()
		.replace(/[–—−]/g, '-')
		.replace(/\bfrom\b/g, ' ')
		.replace(/\b(?:hrs?|hours?|เวลา)\b/g, ' ')
		.replace(/น\.?/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function parseMeridiemTime(value: string): string | null {
	const match = value.match(/(?:^|\s)(\d{1,2})(?:[:.]([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?=$|\s|-)/i);
	if (!match) return null;

	let hour = Number(match[1]);
	const minute = Number(match[2] ?? '0');
	const meridiem = match[3].replace(/\./g, '').toLowerCase();

	if (hour < 1 || hour > 12) return null;
	if (meridiem === 'am') {
		if (hour === 12) hour = 0;
	} else if (hour !== 12) {
		hour += 12;
	}

	return formatTime(hour, minute);
}

function parseTwentyFourHourTime(value: string): string | null {
	const match = value.match(/(?:^|\s)([01]?\d|2[0-3])[:.]([0-5]\d)(?=$|\s|-)/);
	if (!match) return null;
	return formatTime(Number(match[1]), Number(match[2]));
}

function parseCompactTime(value: string): string | null {
	const match = value.match(/(?:^|\s)([01]\d|2[0-3])([0-5]\d)(?=$|\s|-)/);
	if (!match) return null;
	return formatTime(Number(match[1]), Number(match[2]));
}

/**
 * Normalizes common event time formats to HH:mm.
 * For a time range, the first (start) time is returned.
 */
export function parseEventTime(value: string | null): string | null {
	if (!value) return null;

	const text = normalizeInput(value);
	if (!text) return null;

	if (/\bnoon\b/.test(text)) return '12:00';
	if (/\bmidnight\b/.test(text)) return '00:00';

	return (
		parseMeridiemTime(text) ??
		parseTwentyFourHourTime(text) ??
		parseCompactTime(text)
	);
}
