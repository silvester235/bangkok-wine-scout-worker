import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Bangkok Wine Scout worker', () => {
	it('returns the service status on GET /', async () => {
		const response = await SELF.fetch('https://example.com/');

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('Bangkok Wine Scout is running.');
	});

	it('returns health information on GET /health', async () => {
		const response = await SELF.fetch('https://example.com/health');
		const body = await response.json<{
			status: string;
			service: string;
			version: string;
			timestamp: string;
		}>();

		expect(response.status).toBe(200);
		expect(body.status).toBe('ok');
		expect(body.service).toBe('Bangkok Wine Scout');
		expect(body.version).toBe('0.6.0');
		expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
	});

	it('accepts valid JSON on POST /webhook', async () => {
		const response = await SELF.fetch('https://example.com/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				test: true,
				message: 'Hello Bangkok Wine Scout',
			}),
		});
		const body = await response.json<{ status: string; received: boolean }>();

		expect(response.status).toBe(200);
		expect(body.status).toBe('ok');
		expect(body.received).toBe(true);
	});

	it('rejects invalid JSON on POST /webhook', async () => {
		const response = await SELF.fetch('https://example.com/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: 'hello',
		});
		const body = await response.json<{ status: string; message: string }>();

		expect(response.status).toBe(400);
		expect(body.status).toBe('error');
		expect(body.message).toBe('Invalid request body');
	});

	it('returns 404 for unknown routes', async () => {
		const response = await SELF.fetch('https://example.com/unknown');

		expect(response.status).toBe(404);
		expect(await response.text()).toBe('Not found');
	});
});
