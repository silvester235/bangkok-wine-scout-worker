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
	organizer?: string | null;
	address?: string | null;
	district?: string | null;
	websiteUrl?: string | null;
	bookingUrl?: string | null;
	bookingInstructions?: string | null;
	contactText?: string | null;
	description?: string | null;
	courseCount?: number | null;
	priceText?: string | null;
	currency?: string | null;
	priceQualifier?: string | null;
	endTime?: string | null;
	timezone?: string | null;
	wineProducers?: string[];
	partners?: string[];
	merchants?: string[];
	menu?: string[];
	notes?: string[];
	sourceContactInformation?: string[];
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

function normalizeUrl(value: string | null | undefined): string | null {
	const display = normalizeUtf8Text(value ?? null)?.trim();
	if (!display) return null;
	const markdownUrl = display.match(/^\[[^\]\r\n]*\]\((https?:\/\/.+)\)$/)?.[1];
	const unwrapped = markdownUrl ?? display;
	const candidate = /^[\w.-]+\.[A-Za-z]{2,}(?:[/?#].*)?$/.test(unwrapped) ? `https://${unwrapped}` : unwrapped;
	try {
		const url = new URL(candidate);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
	} catch { return null; }
}
function normalizeCourseCount(value: number | null | undefined, evidence: Array<string | null | undefined>): number | null {
	if (Number.isInteger(value) && (value ?? 0) > 0 && (value ?? 0) <= 50) return value!;
	for (const text of evidence) {
		const match = text?.match(/\b(\d{1,2})\s*(?:courses?|course[- ]pairing)\b/i);
		if (match) return Number(match[1]);
	}
	return null;
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

function normalizeStringList(values: string[]): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const display = (normalizeUtf8Text(value) ?? value).trim();
		if (!display) continue;
		const canonical = display.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
		if (seen.has(canonical)) continue;
		seen.add(canonical);
		normalized.push(display);
	}
	return normalized;
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
	wineRegions?: string[];
	organizer?: string | null;
	district?: string | null;
	websiteUrl?: string | null;
	bookingInstructions?: string | null;
	contactPhone?: string | null;
	contactEmail?: string | null;
	contactText?: string | null;
	description?: string | null;
	courseCount?: number | null;
	priceAmount?: number | null;
	priceQualifier?: string | null;
	currency?: string | null;
	endTime?: string | null;
	timezone?: string | null;
	wineProducers?: string[];
	partners?: string[];
	merchants?: string[];
	menu?: string[];
	sourceContactInformation?: string[];
	qrCodePresent?: boolean;
	decodedQrValue?: string | null;
}): NormalizedWineEvent {
	const venue = normalizeUtf8Text(event.venue);
	const contact = normalizeUtf8Text(event.contact);
	const address = normalizeUtf8Text(event.address);
	const bookingUrl = normalizeUtf8Text(event.bookingUrl);
	const notes = event.notes.map((note) => normalizeUtf8Text(note) ?? note);
	const sourceContacts = normalizeStringList(event.sourceContactInformation ?? []);
	const menu = normalizeStringList(event.menu ?? []);
	const normalizedNotes = normalizeStringList(notes);
	const contactText = normalizeUtf8Text(event.contactText ?? event.contact ?? null);
	const decodedQrValue = normalizeUtf8Text(event.decodedQrValue ?? null);
	const contactSources = [event.contactEmail ?? null, event.contactPhone ?? null, contactText, contact, address, bookingUrl, decodedQrValue, ...sourceContacts, ...normalizedNotes];
	const priceText = normalizeUtf8Text(event.price);
	const explicitPrice = typeof event.priceAmount === 'number' && Number.isFinite(event.priceAmount) ? event.priceAmount : null;
	const priceQualifier = normalizeUtf8Text(event.priceQualifier ?? priceText?.match(/\+{1,2}|\bnet\b/i)?.[0] ?? null);
	const description = normalizeUtf8Text(event.description ?? null);

	return {
		date: parseEventDate(normalizeUtf8Text(event.date)),
		startTime: parseEventTime(normalizeUtf8Text(event.startTime)),
		priceTHB: explicitPrice ?? normalizePrice(priceText),
		venue,
		contactEmail: firstEmail(contactSources),
		contactPhone: firstPhone(contactSources),
		wines: normalizeStringList(event.wines),
		wineRegions: normalizeStringList(event.wineRegions ?? []),
		isWineEvent: event.isWineEvent,
		organizer: normalizeUtf8Text(event.organizer ?? null),
		address,
		district: normalizeUtf8Text(event.district ?? null),
		websiteUrl: normalizeUrl(event.websiteUrl),
		bookingUrl: normalizeUrl(event.bookingUrl) ?? normalizeUrl(decodedQrValue),
		bookingInstructions: normalizeUtf8Text(event.bookingInstructions ?? null),
		contactText,
		description,
		courseCount: normalizeCourseCount(event.courseCount, [description, ...menu, ...normalizedNotes]),
		priceText,
		currency: normalizeUtf8Text(event.currency ?? null)?.toUpperCase() ?? null,
		priceQualifier,
		endTime: parseEventTime(normalizeUtf8Text(event.endTime ?? null)),
		timezone: normalizeUtf8Text(event.timezone ?? null),
		wineProducers: normalizeStringList(event.wineProducers ?? []),
		partners: normalizeStringList(event.partners ?? []),
		merchants: normalizeStringList(event.merchants ?? []),
		menu,
		notes: normalizedNotes,
		sourceContactInformation: sourceContacts,
	};
}
