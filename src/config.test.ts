import { describe, expect, it, vi } from 'vitest';
import {
	getLineTextContextWindowSeconds,
	getLineImageBatchWindowSeconds,
	getOptionalLineTextContextWindowSeconds,
	getLineMessageBatchWindowSeconds,
} from './config';
import type { WorkerEnv } from './types/env';

describe('LINE text context configuration', () => {
	it('uses the documented default when the setting is missing', () => {
		expect(getLineTextContextWindowSeconds({} as WorkerEnv)).toBe(600);
	});

	it('strictly validates a configured positive integer', () => {
		expect(getLineTextContextWindowSeconds({ LINE_TEXT_CONTEXT_WINDOW_SECONDS: '120' } as WorkerEnv)).toBe(120);
		expect(() => getLineTextContextWindowSeconds({ LINE_TEXT_CONTEXT_WINDOW_SECONDS: '2.5' } as WorkerEnv)).toThrow();
		expect(() => getLineTextContextWindowSeconds({ LINE_TEXT_CONTEXT_WINDOW_SECONDS: '0' } as WorkerEnv)).toThrow();
	});

	it('disables correlation without throwing when configuration is invalid', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		expect(getOptionalLineTextContextWindowSeconds({
			LINE_TEXT_CONTEXT_WINDOW_SECONDS: 'invalid',
		} as WorkerEnv)).toBeNull();
		expect(error).toHaveBeenCalledWith('LINE TEXT CONTEXT CONFIG INVALID', expect.stringContaining('error'));
		error.mockRestore();
	});
});

describe('LINE message batch configuration',()=>{
	it('keeps the image inactivity window independent from the longer message window',()=>{const configured={LINE_MESSAGE_BATCH_WINDOW_SECONDS:'60',LINE_IMAGE_BATCH_WINDOW_SECONDS:'15'} as WorkerEnv;expect(getLineImageBatchWindowSeconds(configured)).toBe(15);expect(getLineMessageBatchWindowSeconds(configured)).toBe(60)});
	it('defaults to 60 seconds and prefers the new variable',()=>{expect(getLineMessageBatchWindowSeconds({} as WorkerEnv)).toBe(60);expect(getLineMessageBatchWindowSeconds({LINE_MESSAGE_BATCH_WINDOW_SECONDS:'60',LINE_IMAGE_BATCH_WINDOW_SECONDS:'15'} as WorkerEnv)).toBe(60)});
	it('supports the deprecated image variable as fallback',()=>{expect(getLineMessageBatchWindowSeconds({LINE_IMAGE_BATCH_WINDOW_SECONDS:'15'} as WorkerEnv)).toBe(15)});
});
