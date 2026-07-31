import type { WorkerEnv } from './types/env';
import type { AiEventResolutionOptions } from './services/event-repository';

export const APP_NAME = 'Bangkok Wine Scout';
export const VERSION = '0.5.0';

function parseNumber(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number.`);
	return parsed;
}

export function getAiEventResolutionOptions(env: WorkerEnv): AiEventResolutionOptions {
	if (env.AI_PROVIDER !== 'workers_ai') {
		throw new Error(`Unsupported AI event resolver provider: ${env.AI_PROVIDER || 'missing'}.`);
	}
	if (!env.AI_MODEL?.trim()) throw new Error('AI_MODEL is required.');
	if (!env.AI) throw new Error('AI binding is required.');

	const highThreshold = parseNumber(env.HIGH_THRESHOLD, 'HIGH_THRESHOLD');
	const lowThreshold = parseNumber(env.LOW_THRESHOLD, 'LOW_THRESHOLD');
	const timeoutMs = parseNumber(env.AI_TIMEOUT_MS, 'AI_TIMEOUT_MS');

	if (lowThreshold < 0 || highThreshold > 1 || lowThreshold >= highThreshold) {
		throw new Error('AI event resolution thresholds must satisfy 0 <= LOW_THRESHOLD < HIGH_THRESHOLD <= 1.');
	}
	if (timeoutMs <= 0) throw new Error('AI_TIMEOUT_MS must be greater than zero.');

	return {
		ai: env.AI,
		highThreshold,
		lowThreshold,
		resolver: {
			provider: env.AI_PROVIDER,
			model: env.AI_MODEL,
			timeoutMs,
		},
	};
}

export function getOptionalAiEventResolutionOptions(env: WorkerEnv): AiEventResolutionOptions | undefined {
	try {
		return getAiEventResolutionOptions(env);
	} catch (error) {
		console.error('AI EVENT RESOLUTION CONFIG INVALID', JSON.stringify({
			error: error instanceof Error ? error.message : String(error),
		}));
		return undefined;
	}
}
