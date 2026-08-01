import type { NormalizedWineEvent } from './event-normalizer';

export interface PublishabilityResult {
	publishable: boolean;
	score: number;
	reasons: string[];
	missingRequiredFields: string[];
	rejectionReasons: string[];
	exactReason: string;
}

const GENERIC_TITLES = new Set(['wine event', 'event', 'wine dinner', 'untitled']);

/** Hard publication boundary: menu/wine text alone can never create an event. */
export function validatePublishableEvent(input: { title: string | null; bookingUrl: string | null; event: NormalizedWineEvent }): PublishabilityResult {
	const title = input.title?.trim() ?? '';
	const meaningfulTitle = title.length >= 5 && !GENERIC_TITLES.has(title.toLocaleLowerCase('en-US'));
	const contact = Boolean(input.bookingUrl?.trim() || input.event.contactEmail || input.event.contactPhone);
	let score = 0;
	const reasons: string[] = [];
	if (meaningfulTitle) { score += 2; reasons.push('meaningful title'); }
	if (input.event.date) { score += 2; reasons.push('event date'); }
	if (input.event.venue?.trim()) { score += 1; reasons.push('venue'); }
	if (input.event.startTime) { score += 1; reasons.push('start time'); }
	if (contact) { score += 1; reasons.push('booking/contact'); }
	if (input.event.isWineEvent) { score += 1; reasons.push('wine-event evidence'); }
	// Identity needs both a meaningful title and date, plus corroborating event context.
	const missingRequiredFields: string[] = [];
	const rejectionReasons: string[] = [];
	if (!meaningfulTitle) {
		missingRequiredFields.push('meaningfulTitle');
		rejectionReasons.push(title ? `title is generic or shorter than 5 characters: ${JSON.stringify(title)}` : 'title is missing');
	}
	if (!input.event.date) {
		missingRequiredFields.push('date');
		rejectionReasons.push('event date is missing');
	}
	if (score < 5) {
		missingRequiredFields.push('minimumMetadataScore');
		rejectionReasons.push(`metadata score ${score} is below required score 5`);
	}
	const publishable = rejectionReasons.length === 0;
	return {
		publishable,
		score,
		reasons,
		missingRequiredFields,
		rejectionReasons,
		exactReason: publishable ? 'publishable: all deterministic requirements passed' : `not publishable: ${rejectionReasons.join('; ')}`,
	};
}
