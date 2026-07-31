import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEnv } from '../types/env';
import { processImageMessage } from './webhook';

const mocks = vi.hoisted(() => ({
	downloadLineMessageContent: vi.fn(),
	pushToLine: vi.fn(),
	storeLineImageAsset: vi.fn(),
	extractAndStoreOcr: vi.fn(),
	extractAndStoreEvent: vi.fn(),
	findEventIdByAssetId: vi.fn(),
	saveWineEvent: vi.fn(),
}));

vi.mock('../services/line', () => ({
	downloadLineMessageContent: mocks.downloadLineMessageContent,
	pushToLine: mocks.pushToLine,
	replyToLine: vi.fn(),
}));
vi.mock('../services/event-intake', () => ({ storeLineImageAsset: mocks.storeLineImageAsset }));
vi.mock('../services/ocr', () => ({ extractAndStoreOcr: mocks.extractAndStoreOcr }));
vi.mock('../services/event-extraction', () => ({ extractAndStoreEvent: mocks.extractAndStoreEvent }));
vi.mock('../services/event-repository', () => ({
	findEventIdByAssetId: mocks.findEventIdByAssetId,
	saveWineEvent: mocks.saveWineEvent,
}));

const bucketPut = vi.fn().mockResolvedValue(undefined);
const workerEnv = {
	LINE_CHANNEL_ACCESS_TOKEN: 'token',
	EVENT_INTAKES: { put: bucketPut },
	DB: {},
	AI: {},
	IMAGE_PROCESSING_QUEUE: {},
	AI_PROVIDER: 'workers_ai',
	AI_MODEL: 'model',
	HIGH_THRESHOLD: '0.85',
	LOW_THRESHOLD: '0.45',
	AI_TIMEOUT_MS: '5000',
	LINE_TEXT_CONTEXT_WINDOW_SECONDS: '',
} as unknown as WorkerEnv;

const message = {
	messageId: 'message-1',
	pushTarget: 'user-1',
	receivedAt: '2026-08-01T00:00:00.000Z',
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.downloadLineMessageContent.mockResolvedValue({
		contentType: 'image/jpeg',
		content: new Uint8Array([1, 2, 3]).buffer,
	});
	mocks.storeLineImageAsset.mockResolvedValue({
		intakeId: 'intake-1',
		assetId: 'asset-1',
		objectKey: 'intakes/intake-1/assets/asset-1/original',
		metadataKey: 'intakes/intake-1/assets/asset-1/metadata.json',
		contentHash: 'hash',
		duplicate: false,
	});
	mocks.extractAndStoreOcr.mockResolvedValue({
		status: 'failed',
		text: '',
		error: 'Workers AI returned no OCR text.',
	});
	mocks.saveWineEvent.mockResolvedValue({ id: 'intake-1:asset-1', duplicate: false });
	mocks.findEventIdByAssetId.mockResolvedValue(null);
	mocks.pushToLine.mockResolvedValue(undefined);
});

describe('image extraction fallback publication', () => {
	it.each([
		'Event extraction context is empty.',
		'Workers AI returned an invalid event structure.',
		'Unexpected token in JSON',
		'Workers AI request timed out.',
	])('publishes a fallback event after recoverable extraction failure: %s', async (error) => {
		mocks.extractAndStoreEvent.mockResolvedValue({
			status: 'failed',
			event: null,
			error,
		});

		await processImageMessage(message, workerEnv);

		expect(mocks.saveWineEvent).toHaveBeenCalledWith(
			workerEnv.DB,
			expect.objectContaining({
				title: 'Wine Event',
				assetRole: 'flyer',
				isPublic: true,
				r2ObjectKey: 'intakes/intake-1/assets/asset-1/original',
				event: {
					date: null,
					startTime: null,
					priceTHB: null,
					venue: null,
					contactEmail: null,
					contactPhone: null,
					wines: [],
					wineRegions: [],
					isWineEvent: true,
				},
			}),
			expect.any(Object),
		);
		expect(mocks.pushToLine).toHaveBeenCalledWith(
			'user-1',
			'Stored and published with partial metadata: Wine Event. Intake: intake-1',
			'token',
		);
	});

	it('keeps D1 and asset-linking failures fatal so the queue can retry', async () => {
		mocks.extractAndStoreEvent.mockResolvedValue({ status: 'failed', event: null, error: 'empty' });
		mocks.saveWineEvent.mockRejectedValue(new Error('D1 write failed'));

		await expect(processImageMessage(message, workerEnv)).rejects.toThrow('D1 write failed');
		expect(mocks.pushToLine).not.toHaveBeenCalled();
	});

	it('resumes a stored duplicate that has not yet been linked to an event', async () => {
		mocks.storeLineImageAsset.mockResolvedValue({
			intakeId: 'intake-1', assetId: 'asset-1', objectKey: 'original', duplicate: true,
		});
		mocks.extractAndStoreEvent.mockResolvedValue({ status: 'failed', event: null, error: 'empty' });

		await processImageMessage(message, workerEnv);

		expect(mocks.findEventIdByAssetId).toHaveBeenCalledWith(workerEnv.DB, 'asset-1');
		expect(mocks.saveWineEvent).toHaveBeenCalledOnce();
	});

	it('skips a stored duplicate that is already linked to an event', async () => {
		mocks.storeLineImageAsset.mockResolvedValue({
			intakeId: 'intake-1', assetId: 'asset-1', objectKey: 'original', duplicate: true,
		});
		mocks.findEventIdByAssetId.mockResolvedValue('event-1');

		await processImageMessage(message, workerEnv);

		expect(mocks.extractAndStoreOcr).not.toHaveBeenCalled();
		expect(mocks.saveWineEvent).not.toHaveBeenCalled();
	});
});
