import { describe, expect, it } from 'vitest';
import { matchExistingEvent, type ExistingEventCandidate } from './event-matcher';

const candidates: ExistingEventCandidate[] = [
	{
		id: 'event-1',
		title: 'Italian Wine Dinner at Attico',
		date: '2026-07-31',
		startTime: '18:00',
		venue: 'ATTICO, Radisson Blu Plaza Bangkok',
	},
	{
		id: 'event-2',
		title: 'Bordeaux Wine Night',
		date: '2026-08-02',
		startTime: '19:00',
		venue: 'The Allium Bangkok',
	},
];

describe('matchExistingEvent', () => {
	it('matches the same event despite minor title and venue differences', () => {
		const result = matchExistingEvent(
			{
				title: 'Attico Italian Wine Dinner',
				date: '2026-07-31',
				startTime: '18:00',
				venue: 'Attico Radisson Blu',
			},
			candidates,
		);

		expect(result.matched).toBe(true);
		expect(result.eventId).toBe('event-1');
		expect(result.confidence).toBeGreaterThanOrEqual(0.75);
		expect(result.reasons).toContain('same date');
	});

	it('can match a supplementary menu flyer with no date when title and venue agree', () => {
		const result = matchExistingEvent(
			{
				title: 'Italian Wine Dinner Menu',
				date: null,
				startTime: null,
				venue: 'ATTICO Radisson Blu Plaza Bangkok',
			},
			candidates,
		);

		expect(result.matched).toBe(true);
		expect(result.eventId).toBe('event-1');
	});

	it('does not auto-match from only one shared field', () => {
		const result = matchExistingEvent(
			{
				title: null,
				date: '2026-07-31',
				startTime: null,
				venue: null,
			},
			candidates,
		);

		expect(result.matched).toBe(false);
		expect(result.eventId).toBeNull();
	});

	it('rejects a candidate with a conflicting date', () => {
		const result = matchExistingEvent(
			{
				title: 'Italian Wine Dinner at Attico',
				date: '2026-08-01',
				startTime: '18:00',
				venue: 'ATTICO, Radisson Blu Plaza Bangkok',
			},
			[candidates[0]],
		);

		expect(result.matched).toBe(false);
		expect(result.confidence).toBe(0);
		expect(result.reasons).toContain('different date');
	});

	it('rejects a similar title at a different venue', () => {
		const result = matchExistingEvent(
			{
				title: 'Italian Wine Dinner at Attico Bangkok',
				date: '2026-07-31',
				startTime: '18:00',
				venue: 'The Allium Bangkok',
			},
			[candidates[0]],
		);

		expect(result.matched).toBe(false);
		expect(result.confidence).toBe(0);
		expect(result.reasons).toContain('different venue');
	});

	it('rejects a different title at the same venue', () => {
		const result = matchExistingEvent(
			{
				title: 'Burgundy Masterclass',
				date: '2026-07-31',
				startTime: '18:00',
				venue: 'ATTICO, Radisson Blu Plaza Bangkok',
			},
			[candidates[0]],
		);

		expect(result.matched).toBe(false);
		expect(result.confidence).toBe(0);
		expect(result.reasons).toContain('different title');
	});

	it('returns no match when no candidates are supplied', () => {
		expect(
			matchExistingEvent(
				{ title: 'Wine Dinner', date: '2026-07-31', startTime: null, venue: 'ATTICO' },
				[],
			),
		).toEqual({ matched: false, eventId: null, confidence: 0, reasons: ['no candidates'] });
	});
});
