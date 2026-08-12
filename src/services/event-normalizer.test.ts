import { describe, expect, it } from 'vitest';
import { normalizeWineEvent } from './event-normalizer';

function normalizedBookingUrl(bookingUrl: string): string | null | undefined {
	return normalizeWineEvent({
		isWineEvent: true, date: null, startTime: null, price: null, venue: null, address: null,
		contact: null, bookingUrl, notes: [], wines: [],
	}).bookingUrl;
}

describe('rich event normalization', () => {
	it('preserves the complete Chez Papa flyer metadata and exact price qualifier', () => {
		const event = normalizeWineEvent({
			isWineEvent: true,
			organizer: 'Chez Papa French Bistro', venue: 'Chez Papa Bangkok',
			address: 'Chez Papa Bangkok – Sukhumvit 51', district: 'Sukhumvit 51', date: '26 August 2026', startTime: '6 PM',
			endTime: null, timezone: 'Asia/Bangkok', price: 'THB 1,490++', priceAmount: 1490, priceQualifier: '++', currency: 'THB',
			websiteUrl: 'chezpapabangkok.carrd.co', bookingUrl: null, bookingInstructions: 'Book your table',
			contact: '063 832 3605', contactPhone: '063 832 3605', contactText: 'Book your table: 063 832 3605',
			description: '5 Courses Wine Pairing Experience', courseCount: 5, wines: [], wineRegions: [],
			wineProducers: ['Chapoutier'], merchants: ['Vinum Lector'], partners: [], menu: [], notes: [],
			sourceContactInformation: ['063 832 3605', 'chezpapabangkok.carrd.co'],
		});

		expect(event).toEqual(expect.objectContaining({
			organizer: 'Chez Papa French Bistro', venue: 'Chez Papa Bangkok', address: 'Chez Papa Bangkok – Sukhumvit 51',
			district: 'Sukhumvit 51', date: '2026-08-26', startTime: '18:00', priceTHB: 1490,
			priceText: 'THB 1,490++', priceQualifier: '++', contactPhone: '063 832 3605',
			websiteUrl: 'https://chezpapabangkok.carrd.co/', bookingInstructions: 'Book your table',
			description: '5 Courses Wine Pairing Experience', courseCount: 5,
			wineProducers: ['Chapoutier'], merchants: ['Vinum Lector'],
		}));
	});
});

describe('booking URL normalization', () => {
	it('preserves a plain URL', () => {
		expect(normalizedBookingUrl('https://example.com/book')).toBe('https://example.com/book');
	});

	it('unwraps a Markdown link whose label is the URL', () => {
		expect(normalizedBookingUrl('[https://bit.ly/augpvts](https://bit.ly/augpvts)')).toBe('https://bit.ly/augpvts');
	});

	it('unwraps a Markdown link with a text label', () => {
		expect(normalizedBookingUrl('[Book now](https://example.com/book)')).toBe('https://example.com/book');
	});

	it('rejects Markdown whose target is not a URL', () => {
		expect(normalizedBookingUrl('[Book now](not-a-url)')).toBeNull();
	});
});
