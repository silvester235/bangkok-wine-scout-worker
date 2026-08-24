import { describe, expect, it } from 'vitest';
import { inspectR2CleanupCandidates } from './admin-r2-cleanup-service';

describe('inspectR2CleanupCandidates', () => {
	it('exports the dry-run scanner', () => {
		expect(typeof inspectR2CleanupCandidates).toBe('function');
	});
});
