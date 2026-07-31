import { describe, expect, it } from 'vitest';
import type { NormalizedWineEvent } from './event-normalizer';
import { validateWineEvent } from './event-validator';

const NOW = new Date('2026-07-31T08:00:00.000Z');

function validEvent(overrides: Partial<NormalizedWineEvent> = {}): NormalizedWineEvent {
	return {
		date: '2026-08-15',
		startTime: '19:00',
		priceTHB: 2500,
		venue: 'Bangkok Hotel',
		contactEmail: 'events@example.com',
		contactPhone: null,
		wines: [],
		wineRegions: [],
		isWineEvent: true,
		...overrides,
	};
}

describe('validateWineEvent', () => {
	it('accepts a complete future event', () => {
		const result = validateWineEvent({
			title: 'French Wine Dinner',
			bookingUrl: 'https://example.com/book',
			event: validEvent(),
			now: NOW,
		});

		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it('accepts an event taking place today in Bangkok', () => {
		const result = validateWineEvent({
			title: 'Austrian Wine Masterclass',
			bookingUrl: 'https://example.com/book',
			event: validEvent({ date: '2026-07-31' }),
			now: NOW,
		});

		expect(result.valid).toBe(true);
		expect(result.errors).not.toContain('Event date is in the past');
	});

	it('rejects an event in the past in Bangkok', () => {
		const result = validateWineEvent({
			title: 'Austrian Wine Masterclass',
			bookingUrl: 'https://example.com/book',
			event: validEvent({ date: '2021-07-31' }),
			now: NOW,
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toContain('Event date is in the past');
	});

	it('rejects missing required fields', () => {
		const result = validateWineEvent({
			title: null,
			bookingUrl: null,
			event: validEvent({ date: null }),
			now: NOW,
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toContain('Missing title');
		expect(result.errors).toContain('Missing or invalid date');
	});

	it('rejects a non-wine event', () => {
		const result = validateWineEvent({
			title: 'Private Dinner Event',
			bookingUrl: null,
			event: validEvent({ isWineEvent: false }),
			now: NOW,
		});

		expect(result.errors).toContain('Not classified as a wine event');
	});

	it('rejects invalid booking URLs', () => {
		const result = validateWineEvent({
			title: 'French Wine Dinner',
			bookingUrl: 'example dot com',
			event: validEvent(),
			now: NOW,
		});

		expect(result.errors).toContain('Invalid booking URL');
	});

	it('returns warnings for optional missing data', () => {
		const result = validateWineEvent({
			title: 'French Wine Dinner',
			bookingUrl: null,
			event: validEvent({
				startTime: null,
				priceTHB: null,
				venue: null,
				contactEmail: null,
				contactPhone: null,
			}),
			now: NOW,
		});

		expect(result.valid).toBe(true);
		expect(result.warnings).toEqual([
			'Missing start time',
			'Missing venue',
			'Missing price',
			'Missing booking URL',
			'Missing contact information',
		]);
	});
});
