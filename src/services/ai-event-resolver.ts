export interface AiResolutionEvent {
	title: string | null;
	venue: string | null;
	date: string | null;
	time: string | null;
	price: number | null;
	description: string | null;
}

export interface AiResolutionCandidate extends AiResolutionEvent {
	id: string;
}

export interface AiEventResolutionResult {
	decision: 'MATCH' | 'NEW_EVENT';
	candidateId: string | null;
	confidence: number;
	reason: string;
}

export interface AiEventResolverConfig {
	provider: string;
	model: string;
	timeoutMs: number;
}

const RESPONSE_SCHEMA = {
	type: 'object',
	properties: {
		decision: { type: 'string', enum: ['MATCH', 'NEW_EVENT'] },
		candidateId: { type: ['string', 'null'] },
		confidence: { type: 'number', minimum: 0, maximum: 1 },
		reason: { type: 'string' },
	},
	required: ['decision', 'candidateId', 'confidence', 'reason'],
	additionalProperties: false,
} as const;

function parseResponse(response: unknown): unknown {
	if (typeof response === 'string') return JSON.parse(response);
	if (!response || typeof response !== 'object') return response;

	const record = response as Record<string, unknown>;
	if ('response' in record) return parseResponse(record.response);
	if ('result' in record) return parseResponse(record.result);
	return response;
}

function validateResponse(value: unknown, candidateIds: Set<string>): AiEventResolutionResult {
	if (!value || typeof value !== 'object') throw new Error('AI event resolver returned malformed JSON.');

	const result = value as Record<string, unknown>;
	if (result.decision !== 'MATCH' && result.decision !== 'NEW_EVENT') {
		throw new Error('AI event resolver returned an invalid decision.');
	}
	if (typeof result.confidence !== 'number' || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
		throw new Error('AI event resolver returned an invalid confidence.');
	}
	if (typeof result.reason !== 'string' || !result.reason.trim()) {
		throw new Error('AI event resolver returned an invalid reason.');
	}

	const candidateId = result.candidateId;
	if (result.decision === 'MATCH') {
		if (typeof candidateId !== 'string' || !candidateIds.has(candidateId)) {
			throw new Error('AI event resolver returned an invalid candidate ID.');
		}
	} else if (candidateId !== null) {
		throw new Error('AI event resolver returned a candidate for a new event.');
	}

	return {
		decision: result.decision,
		candidateId: candidateId as string | null,
		confidence: result.confidence,
		reason: result.reason.trim(),
	};
}

export async function resolveEventWithAi(
	ai: Ai,
	config: AiEventResolverConfig,
	incoming: AiResolutionEvent,
	candidates: AiResolutionCandidate[],
): Promise<AiEventResolutionResult> {
	if (config.provider !== 'workers_ai') throw new Error(`Unsupported AI event resolver provider: ${config.provider}`);

	const limitedCandidates = candidates.slice(0, 5);
	const prompt = [
		'You are an event matching specialist. Determine whether the incoming event is an existing event or a new event.',
		'Consider title similarity, venue, date, time, menu or description, organizer, pricing, and obvious OCR mistakes.',
		'Prefer precision over recall. If uncertain, return NEW_EVENT.',
		'Use only the supplied candidates. Never invent a candidate ID.',
		JSON.stringify({ incomingEvent: incoming, candidates: limitedCandidates }),
	].join('\n\n');

	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const response = await Promise.race([
			ai.run(config.model as never, {
				messages: [
					{ role: 'system', content: 'Return only JSON matching the requested schema.' },
					{ role: 'user', content: prompt },
				],
				temperature: 0,
				stream: false,
				response_format: {
					type: 'json_schema',
					json_schema: RESPONSE_SCHEMA,
				},
			} as never),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error('AI event resolver timed out.')), config.timeoutMs);
			}),
		]);

		return validateResponse(parseResponse(response), new Set(limitedCandidates.map((candidate) => candidate.id)));
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}
