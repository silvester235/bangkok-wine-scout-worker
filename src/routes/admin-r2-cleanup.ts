import { inspectR2CleanupCandidates } from '../services/admin-r2-cleanup-service';
import { deleteSafeR2CleanupCandidates } from '../services/admin-r2-cleanup-delete-service';
import type { WorkerEnv } from '../types/env';

const SESSION_COOKIE = '__Host-bws_admin_session';
const DELETE_CONFIRMATION = 'DELETE_SAFE_ORPHANS';
const encoder = new TextEncoder();

async function sameSecret(provided: string, expected: string): Promise<boolean> {
	const [left, right] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(provided)),
		crypto.subtle.digest('SHA-256', encoder.encode(expected)),
	]);
	const a = new Uint8Array(left);
	const b = new Uint8Array(right);
	let difference = a.length ^ b.length;
	for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
	return difference === 0;
}

function readCookie(request: Request, name: string): string | null {
	for (const part of (request.headers.get('cookie') ?? '').split(';')) {
		const separator = part.indexOf('=');
		if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
		return part.slice(separator + 1).trim();
	}
	return null;
}

function base64Url(bytes: ArrayBuffer): string {
	let binary = '';
	for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sessionSignature(payload: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return base64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

async function hasValidSession(request: Request, secret: string, now = Date.now()): Promise<boolean> {
	const value = readCookie(request, SESSION_COOKIE);
	if (!value) return false;
	const match = /^(v1\.([0-9]{10}))\.([A-Za-z0-9_-]{43})$/.exec(value);
	if (!match || Number(match[2]) <= Math.floor(now / 1000)) return false;
	return sameSecret(match[3], await sessionSignature(match[1], secret));
}

async function isAuthorized(request: Request, env: WorkerEnv): Promise<boolean> {
	const expected = env.ADMIN_API_TOKEN?.trim();
	if (!expected) return false;
	const authorization = request.headers.get('authorization');
	if (authorization?.startsWith('Bearer ') && await sameSecret(authorization.slice(7), expected)) return true;
	return hasValidSession(request, expected);
}

function noStoreJson(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export async function handleAdminR2CleanupDryRun(request: Request, env: WorkerEnv): Promise<Response> {
	if (!await isAuthorized(request, env)) return noStoreJson({ error: 'Unauthorized' }, 401);
	const url = new URL(request.url);
	const rawMinAge = url.searchParams.get('minAgeDays');
	const minAgeDays = rawMinAge === null ? undefined : Number(rawMinAge);
	try {
		const result = await inspectR2CleanupCandidates(env, { minAgeDays });
		return noStoreJson(result);
	} catch (error) {
		return noStoreJson({ error: error instanceof Error ? error.message : String(error) }, 400);
	}
}

export async function handleAdminR2CleanupDelete(request: Request, env: WorkerEnv): Promise<Response> {
	if (!await isAuthorized(request, env)) return noStoreJson({ error: 'Unauthorized' }, 401);
	let body: { confirm?: unknown; minAgeDays?: unknown; assetIds?: unknown; deleteAllSafe?: unknown };
	try {
		body = await request.json<typeof body>();
	} catch {
		return noStoreJson({ error: 'Invalid JSON body.' }, 400);
	}
	if (body.confirm !== DELETE_CONFIRMATION) {
		return noStoreJson({ error: `Confirmation required: ${DELETE_CONFIRMATION}` }, 400);
	}
	const minAgeDays = body.minAgeDays === undefined ? undefined : Number(body.minAgeDays);
	const assetIds = Array.isArray(body.assetIds)
		? [...new Set(body.assetIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()))]
		: undefined;
	const deleteAllSafe = body.deleteAllSafe === true;
	if (!deleteAllSafe && (!assetIds || assetIds.length === 0)) {
		return noStoreJson({ error: 'Provide assetIds or set deleteAllSafe=true.' }, 400);
	}
	if (deleteAllSafe && assetIds?.length) {
		return noStoreJson({ error: 'Use either assetIds or deleteAllSafe=true, not both.' }, 400);
	}
	try {
		const result = await deleteSafeR2CleanupCandidates(env, { minAgeDays, assetIds: deleteAllSafe ? undefined : assetIds });
		console.log(JSON.stringify({
			event: 'admin_r2_cleanup_delete',
			success: result.success,
			minAgeDays: result.minAgeDays,
			requestedAssets: result.requestedAssets,
			deletedAssets: result.deletedAssets,
			skippedAssets: result.skippedAssets,
			objectsDeleted: result.objectsDeleted,
			objectsFailed: result.objectsFailed,
		}));
		return noStoreJson(result, result.success ? 200 : 207);
	} catch (error) {
		return noStoreJson({ error: error instanceof Error ? error.message : String(error) }, 400);
	}
}
