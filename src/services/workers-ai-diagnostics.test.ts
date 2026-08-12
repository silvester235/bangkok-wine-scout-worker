import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyWorkersAiRetryable, runWorkersAi, workersAiErrorMetadata } from './workers-ai-diagnostics';

afterEach(() => vi.restoreAllMocks());

describe('Workers AI failure diagnostics', () => {
	it('preserves useful 4006 metadata and classifies quota exhaustion as non-retryable', async () => {
		const error = Object.assign(new Error("AiError: 4006: you have used up your daily free allocation of 10,000 neurons"), { name: 'AiError', code: 4006, status: 429 });
		await expect(workersAiErrorMetadata(error)).resolves.toMatchObject({ errorName: 'AiError', errorCode: 4006, httpStatus: 429, retryable: false });
		expect(classifyWorkersAiRetryable(error)).toBe(false);
	});

	it('logs only structured, redacted metadata without request or image content', async () => {
		const error = Object.assign(new Error('quota failed Authorization: Bearer secret-token data:image/jpeg;base64,AQID'), { code: 4006, status: 429, body: 'access_token=very-secret' });
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const ai = { run: vi.fn().mockRejectedValue(error) } as unknown as Ai;
		await expect(runWorkersAi(ai, { messages: [{ content: 'private user message' }], image: 'AQID' }, { submissionId: 's1', workflowInstanceId: 'w1', stage: 'analyse_submission', model: 'vision-model', accountId: '5043abe3e62c4f0f4beed6b298a238f1', attempt: 2 })).rejects.toBe(error);
		const output = String(log.mock.calls[0][0]);
		expect(JSON.parse(output)).toMatchObject({ component: 'workers_ai', event: 'request_failed', submissionId: 's1', workflowInstanceId: 'w1', stage: 'analyse_submission', model: 'vision-model', aiBindingName: 'AI', cloudflareAccountId: '5043ab…38f1', attempt: 2, errorCode: 4006, httpStatus: 429, retryable: false });
		expect(output).not.toContain('private user message');
		expect(output).not.toContain('AQID');
		expect(output).not.toContain('secret-token');
		expect(output).not.toContain('very-secret');
	});

	it('retains supported response identifiers while excluding sensitive headers', async () => {
		const response = new Response('{"error":"capacity"}', { status: 503, headers: { 'cf-ray': 'abc-SIN', 'retry-after': '30', authorization: 'Bearer nope' } });
		const metadata = await workersAiErrorMetadata(Object.assign(new Error('capacity'), { response }));
		expect(metadata).toMatchObject({ httpStatus: 503, responseBody: '{"error":"capacity"}', responseHeaders: { 'cf-ray': 'abc-SIN', 'retry-after': '30' }, retryable: true });
		expect(metadata.responseHeaders).not.toHaveProperty('authorization');
	});
});
