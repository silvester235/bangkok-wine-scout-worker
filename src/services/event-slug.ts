function normalizeAscii(value: string): string {
	return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

export function slugifyEventPart(value: string | null | undefined): string {
	return normalizeAscii(value ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-{2,}/g, '-');
}

function stableSuffix(value: string): string {
	let hash = 0x811c9dc5;
	for (const character of value) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36).padStart(7, '0');
}

export function buildEventSlugBase(input: {
	title: string | null;
	venue: string | null;
	date: string | null;
}): string {
	const parts = [
		slugifyEventPart(input.title),
		slugifyEventPart(input.venue),
		slugifyEventPart(input.date),
	].filter(Boolean);
	return parts.join('-') || 'wine-event';
}

export async function createUniqueEventSlug(
	db: D1Database,
	input: { id: string; title: string | null; venue: string | null; date: string | null; replaceGeneric?: boolean },
): Promise<string> {
	const existing = await db.prepare('SELECT slug FROM events WHERE id = ? LIMIT 1')
		.bind(input.id)
		.first<{ slug: string | null }>();
	if (existing?.slug && !(input.replaceGeneric && /^(?:wine-event|event|untitled)(?:-|$)/.test(existing.slug))) return existing.slug;

	const base = buildEventSlugBase(input);
	const collision = await db.prepare('SELECT id FROM events WHERE slug = ? LIMIT 1')
		.bind(base)
		.first<{ id: string }>();
	return !collision || collision.id === input.id ? base : `${base}-${stableSuffix(input.id)}`;
}
