import type { WorkerEnv } from '../types/env';
import { ifNoneMatchMatches } from '../services/http-etag';
import {
	getPublicAsset,
	getPublishedEventBySlug,
	listPublishedEvents,
	type PublicEventCursor,
} from '../services/public-event-repository';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const LIST_CACHE = 'public, max-age=60, stale-while-revalidate=300';
const DETAIL_CACHE = 'public, max-age=300, stale-while-revalidate=3600';
const ASSET_CACHE = 'public, max-age=3600, stale-while-revalidate=86400';
const ALLOWED_QUERY_PARAMETERS = new Set(['limit', 'cursor', 'from', 'to', 'venue', 'region', 'wine', 'includePast']);

class ApiError extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message);
	}
}

function jsonResponse(body: unknown, status = 200, cacheControl?: string, head = false): Response {
	const text = JSON.stringify(body);
	const headers = new Headers({ 'content-type': 'application/json; charset=UTF-8' });
	if (cacheControl) headers.set('cache-control', cacheControl);
	return new Response(head ? null : text, { status, headers });
}

function errorResponse(error: ApiError, head = false): Response {
	return jsonResponse({ error: { code: error.code, message: error.message } }, error.status, undefined, head);
}

function isIsoDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function readOptionalFilter(searchParams: URLSearchParams, name: string): string | undefined {
	const value = searchParams.get(name);
	if (value === null) return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 100) throw new ApiError(400, `INVALID_${name.toUpperCase()}`, `${name} must contain 1 to 100 characters.`);
	return trimmed;
}

function encodeCursor(cursor: PublicEventCursor): string {
	return btoa(JSON.stringify(cursor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeCursor(value: string): PublicEventCursor {
	try {
		if (!value || value.length > 500 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
		const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
		const parsed = JSON.parse(atob(padded)) as Partial<PublicEventCursor>;
		if ((parsed.date !== null && !isIsoDate(parsed.date ?? '')) || typeof parsed.startTime !== 'string' || typeof parsed.id !== 'string' || !parsed.id) throw new Error();
		if (parsed.startTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(parsed.startTime)) throw new Error();
		return { date: parsed.date ?? null, startTime: parsed.startTime, id: parsed.id };
	} catch {
		throw new ApiError(400, 'INVALID_CURSOR', 'The supplied cursor is invalid.');
	}
}

export function getBangkokLocalDate(now = new Date()): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
	}).formatToParts(now);
	const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
	return `${value('year')}-${value('month')}-${value('day')}`;
}

function parseListOptions(url: URL) {
	for (const name of url.searchParams.keys()) {
		if (!ALLOWED_QUERY_PARAMETERS.has(name)) throw new ApiError(400, 'INVALID_QUERY_PARAMETER', `Unsupported query parameter: ${name}.`);
	}
	const limitValue = url.searchParams.get('limit');
	const limit = limitValue === null ? DEFAULT_LIMIT : Number(limitValue);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new ApiError(400, 'INVALID_LIMIT', `limit must be an integer from 1 to ${MAX_LIMIT}.`);
	}
	const includePastValue = url.searchParams.get('includePast');
	if (includePastValue !== null && includePastValue !== 'true' && includePastValue !== 'false') {
		throw new ApiError(400, 'INVALID_INCLUDE_PAST', 'includePast must be true or false.');
	}
	const from = readOptionalFilter(url.searchParams, 'from');
	const to = readOptionalFilter(url.searchParams, 'to');
	if (from && !isIsoDate(from)) throw new ApiError(400, 'INVALID_FROM', 'from must be an ISO date in YYYY-MM-DD format.');
	if (to && !isIsoDate(to)) throw new ApiError(400, 'INVALID_TO', 'to must be an ISO date in YYYY-MM-DD format.');
	if (from && to && from > to) throw new ApiError(400, 'INVALID_DATE_RANGE', 'from must not be later than to.');
	const cursorValue = url.searchParams.get('cursor');
	return {
		limit,
		from,
		to,
		venue: readOptionalFilter(url.searchParams, 'venue'),
		region: readOptionalFilter(url.searchParams, 'region'),
		wine: readOptionalFilter(url.searchParams, 'wine'),
		includePast: includePastValue === 'true',
		todayBangkok: getBangkokLocalDate(),
		cursor: cursorValue === null ? undefined : decodeCursor(cursorValue),
	};
}

function validateIdentifier(value: string): string {
	let decoded: string;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
	}
	if (!decoded || decoded.length > 200 || !/^[a-z0-9][a-z0-9-]*$/.test(decoded)) {
		throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
	}
	return decoded;
}

async function handleEventList(request: Request, env: WorkerEnv): Promise<Response> {
	const options = parseListOptions(new URL(request.url));
	const result = await listPublishedEvents(env.DB, options);
	return jsonResponse({
		data: result.events,
		pagination: { nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null, limit: options.limit },
	}, 200, LIST_CACHE, request.method === 'HEAD');
}

async function handleEventDetail(request: Request, env: WorkerEnv, slug: string): Promise<Response> {
	const event = await getPublishedEventBySlug(env.DB, validateIdentifier(slug));
	if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', 'The requested event was not found.');
	return jsonResponse({ data: event }, 200, DETAIL_CACHE, request.method === 'HEAD');
}

async function handleEventAssets(request: Request, env: WorkerEnv, slug: string): Promise<Response> {
	const event = await getPublishedEventBySlug(env.DB, validateIdentifier(slug));
	if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', 'The requested event was not found.');
	return jsonResponse({ data: event.assets }, 200, DETAIL_CACHE, request.method === 'HEAD');
}

async function handleAsset(request: Request, env: WorkerEnv, assetId: string): Promise<Response> {
	let decodedId: string;
	try {
		decodedId = decodeURIComponent(assetId);
	} catch {
		throw new ApiError(404, 'ASSET_NOT_FOUND', 'The requested asset was not found.');
	}
	if (!decodedId || decodedId.length > 200 || decodedId.includes('/')) {
		throw new ApiError(404, 'ASSET_NOT_FOUND', 'The requested asset was not found.');
	}
	const asset = await getPublicAsset(env.DB, decodedId);
	if (!asset) throw new ApiError(404, 'ASSET_NOT_FOUND', 'The requested asset was not found.');
	const conditionalEtag = request.headers.get('if-none-match');
	if (request.method === 'HEAD' || conditionalEtag) {
		const metadata = await env.EVENT_INTAKES.head(asset.r2ObjectKey);
		if (!metadata) throw new ApiError(404, 'ASSET_NOT_FOUND', 'The requested asset was not found.');
		const headers = new Headers();
		metadata.writeHttpMetadata(headers);
		headers.set('content-type', metadata.httpMetadata?.contentType ?? asset.contentType ?? 'application/octet-stream');
		headers.set('etag', metadata.httpEtag);
		headers.set('cache-control', ASSET_CACHE);
		if (ifNoneMatchMatches(conditionalEtag, metadata.httpEtag)) return new Response(null, { status: 304, headers });
		if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
	}
	const object = await env.EVENT_INTAKES.get(asset.r2ObjectKey);
	if (!object) throw new ApiError(404, 'ASSET_NOT_FOUND', 'The requested asset was not found.');
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('content-type', object.httpMetadata?.contentType ?? asset.contentType ?? 'application/octet-stream');
	headers.set('etag', object.httpEtag);
	headers.set('cache-control', ASSET_CACHE);
	return new Response(object.body, { status: 200, headers });
}

function configuredOrigin(env: WorkerEnv): string | null {
	const value = env.PUBLIC_SITE_ORIGIN?.trim();
	if (!value) return null;
	try {
		const url = new URL(value);
		return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value ? value : null;
	} catch {
		return null;
	}
}

function addCors(response: Response, request: Request, env: WorkerEnv): Response {
	const headers = new Headers(response.headers);
	headers.append('vary', 'Origin');
	const origin = request.headers.get('origin');
	if (origin && origin === configuredOrigin(env)) {
		headers.set('access-control-allow-origin', origin);
		headers.set('access-control-allow-methods', 'GET, HEAD, OPTIONS');
		headers.set('access-control-allow-headers', 'Content-Type');
	}
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function handlePublicApi(request: Request, env: WorkerEnv): Promise<Response> {
	try {
		if (request.url.length > 4096) throw new ApiError(400, 'REQUEST_URL_TOO_LONG', 'The request URL is too long.');
		if (request.method === 'OPTIONS') return addCors(new Response(null, { status: 204 }), request, env);
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			const response = errorResponse(new ApiError(405, 'METHOD_NOT_ALLOWED', 'Only GET, HEAD, and OPTIONS are supported.'));
			response.headers.set('allow', 'GET, HEAD, OPTIONS');
			return addCors(response, request, env);
		}

		const pathname = new URL(request.url).pathname;
		let response: Response;
		if (pathname === '/api/events') response = await handleEventList(request, env);
		else {
			const eventAssets = pathname.match(/^\/api\/events\/([^/]+)\/assets$/);
			const eventDetail = pathname.match(/^\/api\/events\/([^/]+)$/);
			const asset = pathname.match(/^\/api\/assets\/([^/]+)$/);
			if (eventAssets) response = await handleEventAssets(request, env, eventAssets[1]);
			else if (eventDetail) response = await handleEventDetail(request, env, eventDetail[1]);
			else if (asset) response = await handleAsset(request, env, asset[1]);
			else throw new ApiError(404, 'NOT_FOUND', 'The requested API resource was not found.');
		}
		return addCors(response, request, env);
	} catch (error) {
		if (error instanceof ApiError) return addCors(errorResponse(error, request.method === 'HEAD'), request, env);
		console.error('PUBLIC API FAILED', error);
		return addCors(errorResponse(new ApiError(500, 'INTERNAL_ERROR', 'The request could not be completed.')), request, env);
	}
}
