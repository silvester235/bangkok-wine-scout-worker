import { parseEventDate } from './date-parser';
import { parseEventTime } from './time-parser';

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

const MOJIBAKE_PATTERN = /(?:Ã[\x80-\xBF]|Â[\x80-\xBF]|â[\x80-\xBF]{1,2}|ð[\x80-\xBF]|ï¿½)/;

const COMMON_MOJIBAKE_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
	['â€™', '’'],
	['â€˜', '‘'],
	['â€œ', '“'],
	['â€', '”'],
	['â€“', '–'],
	['â€”', '—'],
	['â€¦', '…'],
	['Ã¢', 'â'],
	['Ã©', 'é'],
	['Ã¨', 'è'],
	['Ãª', 'ê'],
	['Ã«', 'ë'],
	['Ã ', 'à'],
	['Ã¡', 'á'],
	['Ã´', 'ô'],
	['Ã¶', 'ö'],
	['Ã¼', 'ü'],
	['Ã§', 'ç'],
	['Ã±', 'ñ'],
	['Â', ''],
];

// Windows-1252 characters used for byte values 0x80–0x9F.
const WINDOWS_1252_BYTES = new Map<number, number>([
	[0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
	[0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
	[0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
	[0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
	[0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
	[0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
	[0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

function windows1252Byte(character: string): number | null {
	const codePoint = character.codePointAt(0);
	if (codePoint === undefined) return null;
	if (codePoint <= 0xff) return codePoint;
	return WINDOWS_1252_BYTES.get(codePoint) ?? null;
}

function replaceCommonMojibake(value: string): string {
	let repaired = value;
	for (const [broken, correct] of COMMON_MOJIBAKE_REPLACEMENTS) {
		repaired = repaired.split(broken).join(correct);
	}
	return repaired;
}

/**
 * Repairs UTF-8 text accidentally decoded as Windows-1252/Latin-1.
 * Correct Unicode text, including Thai and legitimate French accents, is unchanged.
 */
export function normalizeUtf8Text(value: string | null): string | null {
	if (!value) return value;

	const normalizedValue = value.normalize('NFC');
	const directlyRepaired = replaceCommonMojibake(normalizedValue).normalize('NFC');
	if (directlyRepaired !== normalizedValue || !MOJIBAKE_PATTERN.test(normalizedValue)) return directlyRepaired;

	try {
		const bytes: number[] = [];
		for (const character of normalizedValue) {
			const byte = windows1252Byte(character);
			if (byte === null) return directlyRepaired;
			bytes.push(byte);
		}

		return new TextDecoder('utf-8', {
			fatal: true,
			ignoreBOM: false,
		})
			.decode(new Uint8Array(bytes))
			.normalize('NFC');
	} catch {
		return directlyRepaired;
	}
}

function normalizePrice(price: string | null): number | null {
	if (!price) return null;
	const match = price.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
	return match ? Number(match[0]) : null;
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

function firstEmail(values: Array<string | null>): string | null {
	for (const value of values) {
		const email = extractEmail(value);
		if (email) return email;
	}
	return null;
}

function firstPhone(values: Array<string | null>): string | null {
	for (const value of values) {
		const phone = extractPhone(value);
		if (phone) return phone;
	}
	return null;
}

export function normalizeWineEvent(event: {
	isWineEvent: boolean;
	date: string | null;
	startTime: string | null;
	price: string | null;
	venue: string | null;
	address: string | null;
	contact: string | null;
	bookingUrl: string | null;
	notes: string[];
	wines: string[];
}): NormalizedWineEvent {
	const venue = normalizeUtf8Text(event.venue);
	const contact = normalizeUtf8Text(event.contact);
	const address = normalizeUtf8Text(event.address);
	const bookingUrl = normalizeUtf8Text(event.bookingUrl);
	const notes = event.notes.map((note) => normalizeUtf8Text(note) ?? note);
	const contactSources = [contact, address, bookingUrl, ...notes];

	return {
		date: parseEventDate(normalizeUtf8Text(event.date)),
		startTime: parseEventTime(normalizeUtf8Text(event.startTime)),
		priceTHB: normalizePrice(normalizeUtf8Text(event.price)),
		venue,
		contactEmail: firstEmail(contactSources),
		contactPhone: firstPhone(contactSources),
		wines: event.wines.map((wine) => normalizeUtf8Text(wine) ?? wine),
		wineRegions: [],
		isWineEvent: event.isWineEvent,
	};
}
