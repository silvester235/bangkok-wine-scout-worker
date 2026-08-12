import { describe, expect, it, vi } from 'vitest';
import type { WorkerEnv } from '../types/env';
import { processWebhookEvents } from './webhook';

const { replyToLine } = vi.hoisted(() => ({
	replyToLine: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/line', () => ({
	downloadLineMessageContent: vi.fn(),
	pushToLine: vi.fn(),
	replyToLine,
}));

describe('LINE PDF webhook handling', () => {
	it('rejects PDFs with guidance to send flyer pages as images and does not queue work', async () => {
		const queueSend = vi.fn().mockResolvedValue(undefined);
		const env = {
			LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
			IMAGE_PROCESSING_QUEUE: { send: queueSend },
		} as unknown as WorkerEnv;

		await processWebhookEvents({
			events: [{
				type: 'message',
				replyToken: 'reply-pdf-1',
				message: {
					id: 'pdf-1',
					type: 'file',
					fileName: 'wine-dinner.pdf',
					fileSize: 123456,
				},
			}],
		}, env);

		expect(replyToLine).toHaveBeenCalledWith(
			'reply-pdf-1',
			'PDF files aren’t supported yet. Please send the flyer pages as images instead. You can send multiple images — Bangkok Wine Scout will process them together as one event.',
			'test-token',
		);
		expect(queueSend).not.toHaveBeenCalled();
	});
});
