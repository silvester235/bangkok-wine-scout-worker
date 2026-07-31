import { describe, expect, it } from 'vitest';
import { buildEventExtractionContext } from './event-extraction-context';

describe('buildEventExtractionContext', () => {
	it('builds a source-text-only context', () => {
		expect(buildEventExtractionContext({ sourceText: 'Wine dinner details' })).toEqual({
			sourceText: 'Wine dinner details',
			ocrText: null,
			combinedText: '[LINE MESSAGE]\nWine dinner details',
		});
	});

	it('builds an OCR-only context', () => {
		expect(buildEventExtractionContext({ ocrText: 'FLYER TITLE' })).toEqual({
			sourceText: null,
			ocrText: 'FLYER TITLE',
			combinedText: '[FLYER OCR]\nFLYER TITLE',
		});
	});

	it('keeps both source boundaries explicit in deterministic order', () => {
		expect(buildEventExtractionContext({
			sourceText: 'Price THB 3,200',
			ocrText: 'California Wine Dinner',
		}).combinedText).toBe(
			'[LINE MESSAGE]\nPrice THB 3,200\n\n[FLYER OCR]\nCalifornia Wine Dinner',
		);
	});

	it('normalizes whitespace without duplicating missing sections', () => {
		const context = buildEventExtractionContext({ sourceText: '  First  \r\n\r\n\r\nSecond  ', ocrText: '   ' });

		expect(context).toEqual({
			sourceText: 'First\n\nSecond',
			ocrText: null,
			combinedText: '[LINE MESSAGE]\nFirst\n\nSecond',
		});
	});

	it('returns an empty combined context when both inputs are empty', () => {
		expect(buildEventExtractionContext({ sourceText: ' ', ocrText: null })).toEqual({
			sourceText: null,
			ocrText: null,
			combinedText: '',
		});
	});
});
