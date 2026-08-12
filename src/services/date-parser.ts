const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,

  มกราคม: 1,
  กุมภาพันธ์: 2,
  มีนาคม: 3,
  เมษายน: 4,
  พฤษภาคม: 5,
  มิถุนายน: 6,
  กรกฎาคม: 7,
  สิงหาคม: 8,
  กันยายน: 9,
  ตุลาคม: 10,
  พฤศจิกายน: 11,
  ธันวาคม: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

function normalizeYear(year: number): number {
  if (year >= 2500) return year - 543;
  if (year < 100) return 2000 + year;
  return year;
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function iso(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));

  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() + 1 !== month ||
    d.getUTCDate() !== day
  ) {
    return null;
  }

  return `${year}-${pad(month)}-${pad(day)}`;
}

function bangkokToday(referenceDate = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(referenceDate);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function resolveYearlessDate(
  day: number,
  month: number,
  weekday: number | null,
  referenceDate = new Date(),
): string | null {
  const today = bangkokToday(referenceDate);
  const currentYear = Number(today.slice(0, 4));

  // Search several years ahead because a supplied weekday may not match next year.
  for (let year = currentYear; year <= currentYear + 7; year += 1) {
    const candidate = iso(year, month, day);
    if (!candidate || candidate < today) continue;

    if (weekday !== null) {
      const candidateWeekday = new Date(`${candidate}T00:00:00Z`).getUTCDay();
      if (candidateWeekday !== weekday) continue;
    }

    return candidate;
  }

  return null;
}

export function parseEventDate(value: string | null, referenceDate = new Date()): string | null {
  if (!value) return null;

  const text = value.trim().replace(/,/g, '');

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return iso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const numeric = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (numeric) {
    return iso(
      normalizeYear(Number(numeric[3])),
      Number(numeric[2]),
      Number(numeric[1]),
    );
  }

  // Examples: 31 Jul 2026, 31st July, Friday 31st July.
  const words = text.match(
    /^(?:(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([^\s]+)(?:\s+(\d{2,4}))?$/i,
  );

  if (words) {
    const weekday = words[1] ? WEEKDAYS[words[1].toLowerCase()] : null;
    const day = Number(words[2]);
    const month = MONTHS[words[3].toLowerCase()];
    if (!month) return null;

    if (!words[4]) {
      return resolveYearlessDate(day, month, weekday, referenceDate);
    }

    const result = iso(normalizeYear(Number(words[4])), month, day);
    if (!result) return null;

    if (weekday !== null && new Date(`${result}T00:00:00Z`).getUTCDay() !== weekday) {
      return null;
    }

    return result;
  }

	// Examples: August 6, Thursday August 6, August 6 2026.
	const monthFirst = text.match(
		/^(?:(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)\s+)?([^\s]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{2,4}))?$/i,
	);
	if (monthFirst) {
		const weekday = monthFirst[1] ? WEEKDAYS[monthFirst[1].toLowerCase()] : null;
		const month = MONTHS[monthFirst[2].toLowerCase()];
		const day = Number(monthFirst[3]);
		if (!month) return null;
		if (!monthFirst[4]) return resolveYearlessDate(day, month, weekday, referenceDate);
		const result = iso(normalizeYear(Number(monthFirst[4])), month, day);
		if (!result) return null;
		if (weekday !== null && new Date(`${result}T00:00:00Z`).getUTCDay() !== weekday) return null;
		return result;
	}

  return null;
}

export function parseEventDateFromText(text: string, referenceDate = new Date()): string | null {
	return parseEventDateEvidenceFromText(text, referenceDate)?.date ?? null;
}

export interface EventDateEvidence { date:string; explicitYear:boolean; matchedText:string }

export function parseEventDateEvidenceFromText(text:string,referenceDate=new Date()):EventDateEvidence|null {
	const isoMatch=text.match(/\b\d{4}-\d{2}-\d{2}\b/);if(isoMatch){const date=parseEventDate(isoMatch[0],referenceDate);if(date)return{date,explicitYear:true,matchedText:isoMatch[0]};}
	const numericMatch=text.match(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/);if(numericMatch){const date=parseEventDate(numericMatch[0],referenceDate);if(date)return{date,explicitYear:true,matchedText:numericMatch[0]};}
	const dayFirst = text.match(
    /\b(?:(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)(?:\s+(\d{2,4}))?\b/i,
  );
	const monthFirst = text.match(
		/\b(?:(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)\s+)?(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{2,4}))?\b/i,
	);
	const match = dayFirst ?? monthFirst;
	if(!match)return null;const date=parseEventDate(match[0],referenceDate);if(!date)return null;
	const explicitYear=Boolean(dayFirst?dayFirst[4]:monthFirst?.[4]);
	return{date,explicitYear,matchedText:match[0]};
}
