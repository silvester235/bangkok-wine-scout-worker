import { describe, expect, it } from 'vitest';
import { deleteSafeR2CleanupCandidates } from './admin-r2-cleanup-delete-service';

describe('deleteSafeR2CleanupCandidates', () => {
	it('exports the guarded delete service', () => {
		expect(typeof deleteSafeR2CleanupCandidates).toBe('function');
	});
});
