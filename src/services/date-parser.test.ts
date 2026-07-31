import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEventDate } from './date-parser';

afterEach(() => {
	vi.useRealTimers();
});

describe('parseEventDate', () => {
	it.each([
		['2026-07-31', '2026-07-31'],
		['31/07/2026', '2026-07-31'],
		['31-07-2026', '2026-07-31'],
		['31.07.2026', '2026-07-31'],
		['31/07/26', '2026-07-31'],
		['31 Jul 2026', '2026-07-31'],
		['31 July 2026', '2026-07-31'],
		['31 JULY 2026', '2026-07-31'],
		['31 กรกฎาคม 2569', '2026-07-31'],
	])('normalizes %s to %s', (input, expected) => {
		expect(parseEventDate(input)).toBe(expected);
	});

	it('uses the current year when a date without a year is still upcoming', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));

		expect(parseEventDate('31 July')).toBe('2026-07-31');
	});

	it('uses the next year when a date without a year has already passed', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-01T00:00:00Z'));

		expect(parseEventDate('31 July')).toBe('2027-07-31');
	});

	it.each([
		null,
		'',
		'not a date',
		'2026-02-30',
		'31/13/2026',
		'32 July 2026',
		'31 Foo 2026',
	])('returns null for invalid input %s', (input) => {
		expect(parseEventDate(input)).toBeNull();
	});
});
