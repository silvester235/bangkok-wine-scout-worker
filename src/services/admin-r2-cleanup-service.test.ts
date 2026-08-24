import { describe, expect, it } from 'vitest';
import { classifyCleanupSafety, inspectR2CleanupCandidates } from './admin-r2-cleanup-service';

describe('inspectR2CleanupCandidates', () => {
	it('exports the dry-run scanner', () => {
		expect(typeof inspectR2CleanupCandidates).toBe('function');
	});
});

describe('classifyCleanupSafety', () => {
	it('allows an old unreferenced failed V2 submission with no result event', () => {
		const result = classifyCleanupSafety({
			pipeline: 'v2_agent',
			submission: { id: 'submission-1', status: 'failed', resultEventId: null },
			outboxStatuses: ['completed'],
		});
		expect(result.safeToDelete).toBe(true);
		expect(result.reasons).toEqual([]);
	});

	it('blocks a V1 batch that still needs review', () => {
		const result = classifyCleanupSafety({
			pipeline: 'v1_line',
			batch: { id: 'batch-1', status: 'needs_review', resultingEventIds: [] },
		});
		expect(result.safeToDelete).toBe(false);
		expect(result.reasons).toContain('active_or_review_line_batch:needs_review');
	});

	it('blocks terminal records that still point at an event', () => {
		const result = classifyCleanupSafety({
			pipeline: 'v2_agent',
			eventIds: ['event-1'],
			submission: { id: 'submission-1', status: 'published', resultEventId: 'event-1' },
			batch: { id: 'batch-1', status: 'completed', resultingEventIds: ['event-1'] },
		});
		expect(result.safeToDelete).toBe(false);
		expect(result.reasons).toEqual(expect.arrayContaining([
			'referenced_by_event',
			'agent_submission_has_result_event',
			'agent_submission_published',
			'line_batch_has_result_event',
		]));
	});

	it('blocks non-terminal delivery outbox work', () => {
		const result = classifyCleanupSafety({
			pipeline: 'v1_line',
			outboxStatuses: ['completed', 'retryable'],
		});
		expect(result.safeToDelete).toBe(false);
		expect(result.activeOutboxStatuses).toEqual(['retryable']);
		expect(result.reasons).toContain('active_delivery_outbox');
	});
});
