import { describe, expect, it } from 'vitest';
import { normalizeWineEntities, normalizeWineEntity } from '../src/services/wine-normalizer';

describe('wine entity normalizer', () => {
	it('normalizes a known OCR alias', () => {
		expect(normalizeWineEntity('Château Toumeufeuille')).toEqual({
			raw: 'Château Toumeufeuille',
			normalized: 'Château Tournefeuille',
			confidence: 0.94,
			matchType: 'alias',
		});
	});

	it('normalizes the Bordeaux flyer OCR result', () => {
		expect(normalizeWineEntity('Château Châteaufeuille')).toEqual({
			raw: 'Château Châteaufeuille',
			normalized: 'Château Tournefeuille',
			confidence: 0.94,
			matchType: 'alias',
		});
	});

	it('recognizes canonical names despite accents and casing', () => {
		expect(normalizeWineEntity('chateau tournefeuille')).toEqual({
			raw: 'chateau tournefeuille',
			normalized: 'Château Tournefeuille',
			confidence: 1,
			matchType: 'exact',
		});
	});

	it('preserves unknown wine names', () => {
		expect(normalizeWineEntity('Touteuil La Révérence')).toEqual({
			raw: 'Touteuil La Révérence',
			normalized: 'Touteuil La Révérence',
			confidence: 0.5,
			matchType: 'unmatched',
		});
	});

	it('normalizes a list without changing its order', () => {
		expect(normalizeWineEntities(['Château Toumeufeuille', 'Unknown Wine'])).toHaveLength(2);
		expect(normalizeWineEntities(['Château Toumeufeuille', 'Unknown Wine'])[1].normalized).toBe('Unknown Wine');
	});
});
