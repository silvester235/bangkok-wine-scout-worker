import { describe, expect, it } from 'vitest';
import { parseEventTime } from './time-parser';

describe('parseEventTime', () => {
	it.each([
		['7pm', '19:00'],
		['7 PM', '19:00'],
		['7.30 PM', '19:30'],
		['7:30 p.m.', '19:30'],
		['12 am', '00:00'],
		['12 pm', '12:00'],
		['19:30', '19:30'],
		['19.30', '19:30'],
		['1930', '19:30'],
		['18:30-21:00', '18:30'],
		['18.30 – 21.00', '18:30'],
		['from 19:30 hrs', '19:30'],
		['เวลา 19.30 น.', '19:30'],
		['noon', '12:00'],
		['midnight', '00:00'],
	])('normalizes %s to %s', (input, expected) => {
		expect(parseEventTime(input)).toBe(expected);
	});

	it.each([
		null,
		'',
		'not a time',
		'25:00',
		'19:75',
		'13 pm',
		'2460',
	])('returns null for invalid input %s', (input) => {
		expect(parseEventTime(input)).toBeNull();
	});
});
