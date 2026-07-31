import { describe, expect, it, vi } from 'vitest';
import { resolveEventWithAi, type AiResolutionCandidate } from './ai-event-resolver';

const config = {
	provider: 'workers_ai',
	model: '@cf/meta/llama-3.1-8b-instruct-fast',
	timeoutMs: 50,
};

const incoming = {
	title: 'California Wine Tasting',
	venue: 'Waldorf Astoria Bangkok',
	date: '2026-08-15',
	time: '20:00',
	price: 3200,
	description: null,
};

const candidates: AiResolutionCandidate[] = Array.from({ length: 6 }, (_, index) => ({
	id: `event-${index + 1}`,
	title: 'California Wine Dinner',
	venue: 'Waldorf Astoria Bangkok',
	date: '2026-08-15',
	time: '19:00',
	price: 3200,
	description: null,
}));

function mockAi(response: unknown): { ai: Ai; run: ReturnType<typeof vi.fn> } {
	const run = vi.fn().mockResolvedValue(response);
	return { ai: { run } as unknown as Ai, run };
}

describe('resolveEventWithAi', () => {
	it('returns a validated MATCH and sends no more than five candidates', async () => {
		const { ai, run } = mockAi({
			decision: 'MATCH',
			candidateId: 'event-1',
			confidence: 0.91,
			reason: 'Same event with different title wording.',
		});

		const result = await resolveEventWithAi(ai, config, incoming, candidates);
		const request = run.mock.calls[0]?.[1] as { messages: Array<{ content: string }> };

		expect(result.decision).toBe('MATCH');
		expect(result.candidateId).toBe('event-1');
		expect(request.messages[1]?.content).not.toContain('event-6');
	});

	it('returns a validated NEW_EVENT decision', async () => {
		const { ai } = mockAi({
			decision: 'NEW_EVENT',
			candidateId: null,
			confidence: 0.95,
			reason: 'The event details differ.',
		});

		await expect(resolveEventWithAi(ai, config, incoming, candidates)).resolves.toMatchObject({
			decision: 'NEW_EVENT',
			candidateId: null,
		});
	});

	it('rejects invalid JSON', async () => {
		const { ai } = mockAi({ response: 'not json' });

		await expect(resolveEventWithAi(ai, config, incoming, candidates)).rejects.toBeInstanceOf(Error);
	});

	it('rejects a candidate ID that was not supplied', async () => {
		const { ai } = mockAi({
			decision: 'MATCH',
			candidateId: 'invented-event',
			confidence: 0.9,
			reason: 'Match.',
		});

		await expect(resolveEventWithAi(ai, config, incoming, candidates)).rejects.toThrow('invalid candidate ID');
	});

	it('times out a stalled model call', async () => {
		const ai = { run: vi.fn(() => new Promise(() => undefined)) } as unknown as Ai;

		await expect(resolveEventWithAi(ai, { ...config, timeoutMs: 1 }, incoming, candidates)).rejects.toThrow('timed out');
	});
});
