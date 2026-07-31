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
		expect(result.errors).toEqual([]);
	});

	it('does not reject an event in the past', () => {
		const result = validateWineEvent({
			title: 'Austrian Wine Masterclass',
			bookingUrl: 'https://example.com/book',
			event: validEvent({ date: '2021-07-31' }),
			now: NOW,
		});

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('treats missing metadata as informational', () => {
		const result = validateWineEvent({
			title: null,
			bookingUrl: null,
			event: validEvent({ date: null }),
			now: NOW,
		});

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toContain('Title not detected');
		expect(result.warnings).toContain('Date not detected');
		expect(result.warnings).toContain('Published with partial metadata');
	});

	it('does not reject an uncertain wine-event classification', () => {
		const result = validateWineEvent({
			title: 'Private Dinner Event',
			bookingUrl: null,
			event: validEvent({ isWineEvent: false }),
			now: NOW,
		});

		expect(result.valid).toBe(true);
		expect(result.warnings).toContain('Wine event classification not detected');
	});

	it('reports invalid booking URLs without rejecting publication', () => {
		const result = validateWineEvent({
			title: 'French Wine Dinner',
			bookingUrl: 'example dot com',
			event: validEvent(),
			now: NOW,
		});

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toContain('Detected booking URL could not be normalized');
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
			'Time not detected',
			'Price not detected',
			'Booking URL not detected',
			'Venue not detected',
			'Contact information not detected',
			'Published with partial metadata',
		]);
	});
});
