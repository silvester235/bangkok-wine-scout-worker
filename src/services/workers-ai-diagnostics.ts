export const WORKERS_AI_BINDING_NAME = 'AI';

export interface WorkersAiRequestContext {
	submissionId?: string;
	workflowInstanceId?: string;
	stage: string;
	model: string;
	accountId?: string;
	attempt?: number;
}

export interface WorkersAiErrorMetadata {
	errorName: string;
	errorCode: string | number | null;
	httpStatus: number | null;
	errorMessage: string;
	responseBody: string | null;
	responseHeaders: Record<string, string>;
	retryable: boolean;
}

const MAX_DIAGNOSTIC_TEXT = 2_000;
const SAFE_HEADERS = new Set(['cf-ray', 'cf-request-id', 'x-request-id', 'retry-after', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']);

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export function redactDiagnosticText(value: unknown): string {
	return String(value ?? '')
		.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[image data redacted]')
		.replace(/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, '[authorization redacted]')
		.replace(/(["']?(?:authorization|api[_-]?token|access[_-]?token|channel[_-]?access[_-]?token|secret)["']?\s*[:=]\s*)["']?[^\s,"'}]+/gi, '$1[redacted]')
		.slice(0, MAX_DIAGNOSTIC_TEXT);
}

export function maskAccountId(accountId: string | undefined): string | null {
	if (!accountId) return null;
	return accountId.length > 12 ? `${accountId.slice(0, 6)}…${accountId.slice(-4)}` : '[masked]';
}

function numeric(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
	return null;
}

function errorCode(source: Record<string, unknown> | null, message: string): string | number | null {
	const direct = source?.code ?? source?.errorCode;
	if (typeof direct === 'string' || typeof direct === 'number') return direct;
	return message.match(/(?:AiError:\s*)?(\d{4}):/i)?.[1] ?? null;
}

function responseHeaders(response: Response | null): Record<string, string> {
	if (!response) return {};
	const headers: Record<string, string> = {};
	for (const [name, value] of response.headers) if (SAFE_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = redactDiagnosticText(value);
	return headers;
}

export function isWorkersAiQuotaError(error: unknown): boolean {
	const source = record(error);
	const message = error instanceof Error ? error.message : String(error);
	const code = errorCode(source, message);
	return code === 4006 || code === '4006' || code === 3036 || code === '3036' || /daily free allocation|used up.*neurons|quota exhausted/i.test(message);
}

export function classifyWorkersAiRetryable(error: unknown): boolean {
	if (isWorkersAiQuotaError(error)) return false;
	const source = record(error);
	const status = numeric(source?.status ?? source?.statusCode ?? record(source?.response)?.status);
	if (status !== null) return status === 408 || status === 409 || status === 429 || status >= 500;
	return true;
}

export async function workersAiErrorMetadata(error: unknown): Promise<WorkersAiErrorMetadata> {
	const source = record(error);
	const nestedResponse = source?.response instanceof Response ? source.response : null;
	const message = redactDiagnosticText(error instanceof Error ? error.message : String(error));
	let body: string | null = null;
	if (nestedResponse) {
		try { body = redactDiagnosticText(await nestedResponse.clone().text()); } catch { /* binding errors may not expose a readable body */ }
	} else {
		const candidate = source?.body ?? source?.responseBody;
		if (typeof candidate === 'string') body = redactDiagnosticText(candidate);
	}
	return {
		errorName: redactDiagnosticText(error instanceof Error ? error.name : typeof error),
		errorCode: errorCode(source, message),
		httpStatus: numeric(source?.status ?? source?.statusCode ?? nestedResponse?.status),
		errorMessage: message,
		responseBody: body,
		responseHeaders: responseHeaders(nestedResponse),
		retryable: classifyWorkersAiRetryable(error),
	};
}

export async function runWorkersAi<T>(ai: Ai, input: unknown, context: WorkersAiRequestContext): Promise<T> {
	const started = Date.now();
	const requestTimestampUtc = new Date().toISOString();
	try {
		return await ai.run(context.model as never, input as never) as T;
	} catch (error) {
		const metadata = await workersAiErrorMetadata(error);
		console.error(JSON.stringify({
			component: 'workers_ai', event: 'request_failed', submissionId: context.submissionId ?? null,
			workflowInstanceId: context.workflowInstanceId ?? null, stage: context.stage, model: context.model,
			aiBindingName: WORKERS_AI_BINDING_NAME, cloudflareAccountId: maskAccountId(context.accountId),
			requestTimestampUtc, attempt: context.attempt ?? 1, ...metadata, elapsedMs: Date.now() - started,
		}));
		throw error;
	}
}
