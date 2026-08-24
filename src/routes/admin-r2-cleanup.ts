import { inspectR2CleanupCandidates } from '../services/admin-r2-cleanup-service';
import type { WorkerEnv } from '../types/env';

const SESSION_COOKIE = '__Host-bws_admin_session';
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

export async function handleAdminR2CleanupDryRun(request: Request, env: WorkerEnv): Promise<Response> {
	if (!await isAuthorized(request, env)) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: { 'cache-control': 'no-store' } });
	const url = new URL(request.url);
	const rawMinAge = url.searchParams.get('minAgeDays');
	const minAgeDays = rawMinAge === null ? undefined : Number(rawMinAge);
	try {
		const result = await inspectR2CleanupCandidates(env, { minAgeDays });
		return Response.json(result, { status: 200, headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers: { 'cache-control': 'no-store' } });
	}
}
