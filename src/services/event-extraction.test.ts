import { describe, expect, it, vi } from 'vitest';
import { buildEventExtractionContext } from './event-extraction-context';
import { extractAndStoreEvent, type ExtractedWineEvent } from './event-extraction';
import { normalizeWineEvent } from './event-normalizer';

const baseEvent: ExtractedWineEvent = {
	isWineEvent: true,
	title: 'California Wine Dinner',
	venue: 'Waldorf Astoria Bangkok',
	address: null,
	date: '2026-08-15',
	startTime: '19:00',
	endTime: null,
	timezone: 'Asia/Bangkok',
	price: 'THB 3,200',
	currency: 'THB',
	bookingUrl: null,
	contact: 'events@example.com',
	wines: ['Château Margaux 2018'],
	wineRegions: ['Bordeaux'],
	menu: [],
	notes: [],
	confidence: 0.9,
};

function dependencies(event: ExtractedWineEvent): {
	ai: Ai;
	bucket: R2Bucket;
	run: ReturnType<typeof vi.fn>;
} {
	const run = vi.fn().mockResolvedValue(event);
	return {
		ai: { run } as unknown as Ai,
		bucket: { put: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket,
		run,
	};
}

describe('context-aware event extraction', () => {
	it('uses a date supplied only by LINE text', async () => {
		const { ai, bucket } = dependencies({ ...baseEvent, date: null });
		const result = await extractAndStoreEvent(ai, bucket, {
			intakeId: 'intake-1',
			assetId: 'image-1',
			context: buildEventExtractionContext({ sourceText: 'Date: 15 August 2026' }),
		});

		expect(result.event?.date).toBe('2026-08-15');
	});

	it('passes LINE-only price and wine evidence through extraction and normalization', async () => {
		const event = {
			...baseEvent,
			price: 'THB 3,200',
			wines: ['Cloudy Bay', ' cloudy bay ', 'Penfolds Bin 389'],
			wineRegions: ['Marlborough', ' marlborough ', 'South Australia'],
		};
		const { ai, bucket } = dependencies(event);
		const result = await extractAndStoreEvent(ai, bucket, {
			intakeId: 'intake-1',
			assetId: 'image-1',
			context: buildEventExtractionContext({
				sourceText: 'THB 3,200\nCloudy Bay\nPenfolds Bin 389\nMarlborough\nSouth Australia',
				ocrText: 'California Wine Dinner',
			}),
		});
		const normalized = normalizeWineEvent(result.event!);

		expect(normalized.priceTHB).toBe(3200);
		expect(normalized.wines).toEqual(['Cloudy Bay', 'Penfolds Bin 389']);
		expect(normalized.wineRegions).toEqual(['Marlborough', 'South Australia']);
	});

	it('sends separately labeled complementary LINE and OCR sources to AI', async () => {
		const { ai, bucket, run } = dependencies(baseEvent);
		await extractAndStoreEvent(ai, bucket, {
			intakeId: 'intake-1',
			assetId: 'image-1',
			context: buildEventExtractionContext({
				sourceText: 'Price: THB 3,200',
				ocrText: 'California Wine Dinner',
			}),
		});
		const request = run.mock.calls[0]?.[1] as { messages: Array<{ content: string }> };

		expect(request.messages[0]?.content).toContain('Use both sources');
		expect(request.messages[0]?.content).toContain('If sources conflict');
		expect(request.messages[1]?.content).toBe(
			'[LINE MESSAGE]\nPrice: THB 3,200\n\n[FLYER OCR]\nCalifornia Wine Dinner',
		);
	});

	it('does not deterministically select between conflicting source dates', async () => {
		const { ai, bucket } = dependencies({ ...baseEvent, date: null });
		const result = await extractAndStoreEvent(ai, bucket, {
			intakeId: 'intake-1',
			assetId: 'image-1',
			context: buildEventExtractionContext({
				sourceText: 'Date: 15 August 2026',
				ocrText: 'Date: 16 August 2026',
			}),
		});

		expect(result.event?.date).toBeNull();
	});

	it('fails cleanly without invoking AI when both sources are empty', async () => {
		const { ai, bucket, run } = dependencies(baseEvent);
		const result = await extractAndStoreEvent(ai, bucket, {
			intakeId: 'intake-1',
			assetId: 'image-1',
			context: buildEventExtractionContext({ sourceText: ' ', ocrText: null }),
		});

		expect(result.status).toBe('failed');
		expect(result.error).toBe('Event extraction context is empty.');
		expect(run).not.toHaveBeenCalled();
	});
});
