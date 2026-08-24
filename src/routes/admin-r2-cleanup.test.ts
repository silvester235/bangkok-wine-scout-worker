import { describe, expect, it } from 'vitest';
import { handleAdminR2CleanupDelete, handleAdminR2CleanupDryRun } from './admin-r2-cleanup';

describe('admin R2 cleanup routes', () => {
	it('exports the dry-run route handler', () => {
		expect(typeof handleAdminR2CleanupDryRun).toBe('function');
	});

	it('exports the guarded delete route handler', () => {
		expect(typeof handleAdminR2CleanupDelete).toBe('function');
	});
});
