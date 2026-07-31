import { describe, expect, it } from 'vitest';
import { ifNoneMatchMatches } from './http-etag';

describe('ifNoneMatchMatches', () => {
	it('matches an exact ETag', () => {
		expect(ifNoneMatchMatches('"asset-tag"', '"asset-tag"')).toBe(true);
	});

	it('matches one ETag in a comma-separated list', () => {
		expect(ifNoneMatchMatches('"other", "asset-tag", W/"third"', '"asset-tag"')).toBe(true);
	});

	it('uses weak comparison for GET and HEAD validators', () => {
		expect(ifNoneMatchMatches('W/"asset-tag"', '"asset-tag"')).toBe(true);
		expect(ifNoneMatchMatches('"asset-tag"', 'W/"asset-tag"')).toBe(true);
	});

	it('matches the wildcard validator', () => {
		expect(ifNoneMatchMatches('*', '"asset-tag"')).toBe(true);
	});

	it('rejects missing and non-matching validators', () => {
		expect(ifNoneMatchMatches(null, '"asset-tag"')).toBe(false);
		expect(ifNoneMatchMatches('"other"', '"asset-tag"')).toBe(false);
	});
});
