import { describe, expect, it } from 'vitest';
import { handleAdminR2CleanupDryRun } from './admin-r2-cleanup';

describe('handleAdminR2CleanupDryRun', () => {
	it('exports the dry-run route handler', () => {
		expect(typeof handleAdminR2CleanupDryRun).toBe('function');
	});
});
