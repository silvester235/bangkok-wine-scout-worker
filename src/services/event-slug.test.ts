import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildEventSlugBase, createUniqueEventSlug, slugifyEventPart } from './event-slug';

declare module 'cloudflare:test' {
	interface ProvidedEnv { DB: D1Database }
}

beforeAll(async () => {
	await env.DB.prepare('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, slug TEXT)').run();
	await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_slug_test ON events(slug) WHERE slug IS NOT NULL').run();
});

beforeEach(async () => {
	await env.DB.prepare('DELETE FROM events').run();
});

describe('public event slugs', () => {
	it('normalizes accents and punctuation into an ASCII-safe slug', () => {
		expect(slugifyEventPart('Cuvée & Rhône — Édition!')).toBe('cuvee-rhone-edition');
	});

	it('uses title, venue, and date deterministically', () => {
		expect(buildEventSlugBase({ title: 'Austrian Wine Masterclass', venue: 'Attico', date: '2026-07-31' }))
			.toBe('austrian-wine-masterclass-attico-2026-07-31');
	});

	it('uses a safe fallback for a missing title and other empty fields', () => {
		expect(buildEventSlugBase({ title: null, venue: null, date: null })).toBe('wine-event');
	});

	it('adds a stable suffix when the public base collides', async () => {
		await env.DB.prepare('INSERT INTO events (id, slug) VALUES (?, ?)').bind('event-1', 'same-title-venue-2026-08-01').run();
		const input = { id: 'event-2', title: 'Same Title', venue: 'Venue', date: '2026-08-01' };
		const first = await createUniqueEventSlug(env.DB, input);
		const second = await createUniqueEventSlug(env.DB, input);

		expect(first).toMatch(/^same-title-venue-2026-08-01-[a-z0-9]+$/);
		expect(second).toBe(first);
	});

	it('preserves an existing slug after later event changes', async () => {
		await env.DB.prepare('INSERT INTO events (id, slug) VALUES (?, ?)').bind('event-1', 'original-slug').run();
		expect(await createUniqueEventSlug(env.DB, {
			id: 'event-1', title: 'Changed title', venue: 'Changed venue', date: '2030-01-01',
		})).toBe('original-slug');
	});
});
