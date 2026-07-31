import { describe, expect, it } from 'vitest';
import { mergeEventData, type CanonicalEventData } from './event-merger';

const completeEvent: CanonicalEventData = {
	title: 'California Wine Dinner',
	date: '2026-08-15',
	startTime: '19:00',
	priceTHB: 3200,
	venue: 'Waldorf Astoria Bangkok',
	contactEmail: 'events@example.com',
	contactPhone: '+66 2 000 0000',
	wines: ['Château Margaux', 'Cloudy Bay'],
	wineRegions: ['Bordeaux', 'Marlborough'],
	isWineEvent: true,
};

const emptyEvent: CanonicalEventData = {
	title: null,
	date: null,
	startTime: null,
	priceTHB: null,
	venue: null,
	contactEmail: null,
	contactPhone: null,
	wines: [],
	wineRegions: [],
	isWineEvent: false,
};

describe('mergeEventData', () => {
	it('fills missing existing fields from incoming data', () => {
		const result = mergeEventData(emptyEvent, completeEvent);

		expect(result.event).toEqual(completeEvent);
		expect(result.changedFields).toEqual(Object.keys(completeEvent));
		expect(result.conflicts).toEqual([]);
	});

	it('preserves existing non-empty scalar values', () => {
		const result = mergeEventData(completeEvent, {
			title: 'Reminder',
			date: '2026-08-16',
			startTime: '20:00',
			priceTHB: 3500,
			venue: 'Another Venue',
			contactEmail: 'other@example.com',
			contactPhone: '+66 2 999 9999',
		});

		expect(result.event).toMatchObject(completeEvent);
		expect(result.changedFields).toEqual([]);
	});

	it('does not let empty incoming values erase data', () => {
		const result = mergeEventData(completeEvent, {
			title: '  ',
			date: null,
			startTime: undefined,
			priceTHB: null,
			venue: '',
			contactEmail: ' ',
			contactPhone: null,
			wines: [],
			wineRegions: [],
		});

		expect(result.event).toEqual(completeEvent);
		expect(result.changedFields).toEqual([]);
		expect(result.conflicts).toEqual([]);
	});

	it.each([
		['title', 'Reminder: California Wine Dinner'],
		['date', '2026-08-16'],
		['startTime', '20:00'],
	] as const)('preserves and reports a conflicting %s', (field, incomingValue) => {
		const result = mergeEventData(completeEvent, { [field]: incomingValue });

		expect(result.event[field]).toBe(completeEvent[field]);
		expect(result.conflicts).toEqual([{
			field,
			existingValue: completeEvent[field],
			incomingValue,
		}]);
	});

	it('preserves and reports a conflicting price, including when the existing price is zero', () => {
		const existing = { ...completeEvent, priceTHB: 0 };
		const result = mergeEventData(existing, { priceTHB: 3200 });

		expect(result.event.priceTHB).toBe(0);
		expect(result.conflicts).toEqual([{ field: 'priceTHB', existingValue: 0, incomingValue: 3200 }]);
	});

	it('treats cosmetic venue differences as equal', () => {
		const result = mergeEventData(completeEvent, { venue: '  waldorf astoria bangkok  ' });

		expect(result.event.venue).toBe('Waldorf Astoria Bangkok');
		expect(result.conflicts).toEqual([]);
	});

	it('preserves and reports a materially different venue', () => {
		const result = mergeEventData(completeEvent, { venue: 'The Allium Bangkok' });

		expect(result.event.venue).toBe(completeEvent.venue);
		expect(result.conflicts).toEqual([{
			field: 'venue',
			existingValue: completeEvent.venue,
			incomingValue: 'The Allium Bangkok',
		}]);
	});

	it('fills only missing contact details and preserves cosmetic phone formatting', () => {
		const existing = { ...completeEvent, contactEmail: null };
		const result = mergeEventData(existing, {
			contactEmail: ' bookings@example.com ',
			contactPhone: '+66 (2) 000-0000',
		});

		expect(result.event.contactEmail).toBe('bookings@example.com');
		expect(result.event.contactPhone).toBe(completeEvent.contactPhone);
		expect(result.changedFields).toEqual(['contactEmail']);
		expect(result.conflicts).toEqual([]);
	});

	it('merges wines as a stable case-insensitive union', () => {
		const result = mergeEventData(completeEvent, {
			wines: ['cloudy bay', ' Penfolds Bin 389 ', '', 'CHÂTEAU MARGAUX'],
		});

		expect(result.event.wines).toEqual(['Château Margaux', 'Cloudy Bay', 'Penfolds Bin 389']);
		expect(result.changedFields).toEqual(['wines']);
	});

	it('merges wine regions as a stable case-insensitive union', () => {
		const result = mergeEventData(completeEvent, {
			wineRegions: [' marlborough ', 'Napa Valley', 'BORDEAUX'],
		});

		expect(result.event.wineRegions).toEqual(['Bordeaux', 'Marlborough', 'Napa Valley']);
		expect(result.changedFields).toEqual(['wineRegions']);
	});

	it('upgrades isWineEvent from false to true', () => {
		const result = mergeEventData({ ...completeEvent, isWineEvent: false }, { isWineEvent: true });

		expect(result.event.isWineEvent).toBe(true);
		expect(result.changedFields).toEqual(['isWineEvent']);
	});

	it('never downgrades isWineEvent from true to false', () => {
		const result = mergeEventData(completeEvent, { isWineEvent: false });

		expect(result.event.isWineEvent).toBe(true);
		expect(result.changedFields).toEqual([]);
	});

	it('is idempotent when the same incoming event is merged twice', () => {
		const incoming = {
			contactEmail: 'new@example.com',
			wines: [' Penfolds Bin 389 '],
			wineRegions: ['Napa Valley'],
			isWineEvent: true,
		};
		const first = mergeEventData({ ...emptyEvent, title: 'Wine Dinner' }, incoming);
		const second = mergeEventData(first.event, incoming);

		expect(second.event).toEqual(first.event);
		expect(second.changedFields).toEqual([]);
		expect(second.conflicts).toEqual([]);
	});
});
