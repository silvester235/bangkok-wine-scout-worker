import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NormalizedWineEvent } from './event-normalizer';
import { findCandidateEvents, saveWineEvent, type StoredWineEventInput } from './event-repository';

declare module 'cloudflare:test' {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

const schema = `
	CREATE TABLE IF NOT EXISTS events (
		id TEXT PRIMARY KEY,
		intake_id TEXT NOT NULL,
		asset_id TEXT NOT NULL,
		title TEXT,
		event_date TEXT,
		start_time TEXT,
		price_thb INTEGER,
		venue TEXT,
		contact_email TEXT,
		contact_phone TEXT,
		wines_json TEXT NOT NULL DEFAULT '[]',
		is_wine_event INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL
	);
	CREATE UNIQUE INDEX IF NOT EXISTS idx_events_asset_id ON events(asset_id);
	CREATE TABLE IF NOT EXISTS event_assets (
		event_id TEXT NOT NULL,
		intake_id TEXT NOT NULL,
		asset_id TEXT NOT NULL,
		asset_role TEXT NOT NULL DEFAULT 'other',
		linked_at TEXT NOT NULL,
		PRIMARY KEY (event_id, asset_id),
		FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
	);
	CREATE UNIQUE INDEX IF NOT EXISTS idx_event_assets_asset_id ON event_assets(asset_id);
`;

const baseEvent: NormalizedWineEvent = {
	date: '2026-08-15',
	startTime: '19:00',
	priceTHB: 3200,
	venue: 'Waldorf Astoria Bangkok',
	contactEmail: 'events@example.com',
	contactPhone: '+66 2 000 0000',
	wines: ['Château Example'],
	wineRegions: [],
	isWineEvent: true,
};

function input(
	assetId: string,
	overrides: Partial<Omit<StoredWineEventInput, 'event'>> & { event?: Partial<NormalizedWineEvent> } = {},
): StoredWineEventInput {
	return {
		intakeId: `intake-${assetId}`,
		assetId,
		assetRole: 'flyer',
		title: 'California Wine Dinner',
		...overrides,
		event: { ...baseEvent, ...overrides.event },
	};
}

beforeAll(async () => {
	for (const statement of schema.split(';').map((value) => value.trim()).filter(Boolean)) {
		await env.DB.prepare(statement).run();
	}
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM event_assets'),
		env.DB.prepare('DELETE FROM events'),
	]);
});

describe('D1 event resolution', () => {
	it('returns bounded candidates with the exact date first', async () => {
		await saveWineEvent(env.DB, input('nearby', { event: { date: '2026-08-14' } }));
		await saveWineEvent(env.DB, input('exact'));

		const candidates = await findCandidateEvents(env.DB, {
			title: 'California Wine Dinner',
			date: '2026-08-15',
			venue: 'Waldorf Astoria Bangkok',
		});

		expect(candidates.map((candidate) => candidate.id)).toEqual([
			'intake-exact:exact',
			'intake-nearby:nearby',
		]);
	});

	it('reuses an exact duplicate instead of creating a second event', async () => {
		const first = await saveWineEvent(env.DB, input('flyer-1'));
		const duplicate = await saveWineEvent(env.DB, input('flyer-2'));

		expect(duplicate).toEqual({ id: first.id, duplicate: true });
		expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM events').first<{ count: number }>())?.count).toBe(1);
	});

	it.each([
		['menu', 'California Wine Dinner Menu'],
		['reminder', 'Reminder: California Wine Dinner'],
	] as const)('links a %s flyer to its existing event', async (assetRole, title) => {
		const first = await saveWineEvent(env.DB, input('flyer-1'));
		const supplementary = await saveWineEvent(env.DB, input(`${assetRole}-1`, {
			assetRole,
			title,
			event: { date: null, startTime: null, priceTHB: null },
		}));

		expect(supplementary.id).toBe(first.id);
		expect(supplementary.duplicate).toBe(true);
	});

	it('keeps same-venue events separate when their titles differ', async () => {
		await saveWineEvent(env.DB, input('event-1'));
		const other = await saveWineEvent(env.DB, input('event-2', { title: 'Burgundy Masterclass' }));

		expect(other).toEqual({ id: 'intake-event-2:event-2', duplicate: false });
	});

	it('keeps similar-title events separate when their venues differ', async () => {
		await saveWineEvent(env.DB, input('event-1'));
		const other = await saveWineEvent(env.DB, input('event-2', {
			title: 'California Wine Dinner Bangkok',
			event: { venue: 'The Allium Bangkok' },
		}));

		expect(other.duplicate).toBe(false);
	});

	it('creates a new event when lookup has no candidates', async () => {
		const result = await saveWineEvent(env.DB, input('only-event'));

		expect(result).toEqual({ id: 'intake-only-event:only-event', duplicate: false });
	});

	it('fills missing fields while preserving existing values', async () => {
		await saveWineEvent(env.DB, input('flyer-1', {
		title: 'California Wine Dinner',
			event: {
				priceTHB: null,
				contactEmail: null,
				contactPhone: '+66 2 111 1111',
				wines: ['Existing detailed wine'],
			},
		}));

		await saveWineEvent(env.DB, input('flyer-2', {
			title: '',
			event: {
				priceTHB: 3200,
				venue: null,
				contactEmail: 'new@example.com',
				contactPhone: '+66 2 999 9999',
				wines: ['Less useful replacement'],
			},
		}));

		const row = await env.DB.prepare(
			'SELECT title, price_thb, venue, contact_email, contact_phone, wines_json FROM events',
		).first<{
			title: string;
			price_thb: number;
			venue: string;
			contact_email: string;
			contact_phone: string;
			wines_json: string;
		}>();

		expect(row).toEqual({
			title: 'California Wine Dinner',
			price_thb: 3200,
			venue: 'Waldorf Astoria Bangkok',
			contact_email: 'new@example.com',
			contact_phone: '+66 2 111 1111',
			wines_json: '["Existing detailed wine"]',
		});
	});

	it('links an asset exactly once when processing is repeated', async () => {
		const event = input('flyer-1');
		await saveWineEvent(env.DB, event);
		await saveWineEvent(env.DB, event);

		const link = await env.DB.prepare(
			'SELECT COUNT(*) AS count, MIN(asset_role) AS role FROM event_assets WHERE asset_id = ?',
		).bind('flyer-1').first<{ count: number; role: string }>();

		expect(link).toEqual({ count: 1, role: 'flyer' });
	});
});
