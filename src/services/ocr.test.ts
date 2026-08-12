import { describe, expect, it, vi } from 'vitest';
import { extractAndStoreOcr } from './ocr';

describe('bounded flyer OCR passes', () => {
	it('runs one focused footer pass when the primary Chez Papa transcription lacks contact evidence', async () => {
		const run = vi.fn()
			.mockResolvedValueOnce({ answer: 'CHEZ PAPA\nWINE PAIRING DINNER\n26 August 2026\nFROM 6 PM\n5 COURSES\n1,490+' })
			.mockResolvedValueOnce({ answer: 'THB 1,490++\n063 832 3605\nChez Papa Bangkok - Sukhumvit 51\nchezpapabangkok.carrd.co\nVINUM LECTOR' });
		const put = vi.fn().mockResolvedValue(undefined);
		const result = await extractAndStoreOcr({ run } as unknown as Ai, { put } as unknown as R2Bucket, {
			intakeId: 'chez', assetId: 'flyer', contentType: 'image/jpeg', content: new Uint8Array([1, 2]).buffer,
		});

		expect(run).toHaveBeenCalledTimes(2);
		expect(result.status).toBe('completed');
		expect(result.text).toContain('063 832 3605');
		expect(result.text).toContain('chezpapabangkok.carrd.co');
		expect(result.text).toContain('THB 1,490++');
		expect(result.attempts?.map((attempt) => attempt.focus)).toEqual(['full_image', 'contact_footer']);
		expect(put).toHaveBeenCalledWith(expect.stringContaining('/ocr.json'), expect.any(String), expect.any(Object));
	});

	it('keeps successful primary OCR when the optional focused pass fails', async () => {
		const run = vi.fn().mockResolvedValueOnce({ answer: 'WINE PAIRING DINNER\n26 August 2026' }).mockRejectedValueOnce(new Error('model unavailable'));
		const result = await extractAndStoreOcr({ run } as unknown as Ai, { put: vi.fn() } as unknown as R2Bucket, {
			intakeId: 'chez', assetId: 'flyer', contentType: 'image/jpeg', content: new Uint8Array([1]).buffer,
		});
		expect(result.status).toBe('completed');
		expect(result.text).toContain('WINE PAIRING DINNER');
		expect(result.attempts?.[1]).toEqual(expect.objectContaining({ status: 'failed', error: 'model unavailable' }));
	});
});
