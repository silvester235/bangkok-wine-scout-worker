export interface MatchableEvent {
	id?: string;
	title: string | null;
	date: string | null;
	startTime: string | null;
	venue: string | null;
}

export interface ExistingEventCandidate extends MatchableEvent {
	id: string;
}

export interface EventMatchResult {
	matched: boolean;
	eventId: string | null;
	confidence: number;
	reasons: string[];
}

interface CandidateScore {
	eventId: string;
	confidence: number;
	reasons: string[];
	positiveSignals: number;
}

const MATCH_THRESHOLD = 0.75;

function canonicalText(value: string | null): string | null {
	if (!value) return null;
	const normalized = value
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLocaleLowerCase('en-US')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.replace(/\s+/g, ' ');
	return normalized || null;
}

function tokenSimilarity(left: string, right: string): number {
	if (left === right) return 1;
	if (left.includes(right) || right.includes(left)) {
		const shorter = Math.min(left.length, right.length);
		const longer = Math.max(left.length, right.length);
		return 0.8 + 0.2 * (shorter / longer);
	}

	const leftTokens = new Set(left.split(' '));
	const rightTokens = new Set(right.split(' '));
	const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
	const union = new Set([...leftTokens, ...rightTokens]).size;
	return union === 0 ? 0 : intersection / union;
}

function scoreCandidate(incoming: MatchableEvent, candidate: ExistingEventCandidate): CandidateScore {
	let earned = 0;
	let available = 0;
	let positiveSignals = 0;
	const reasons: string[] = [];

	if (incoming.date && candidate.date) {
		available += 0.4;
		if (incoming.date.slice(0, 4) !== candidate.date.slice(0, 4)) {
			return { eventId: candidate.id, confidence: 0, reasons: ['different year'], positiveSignals: 0 };
		}
		if (incoming.date === candidate.date) {
			earned += 0.4;
			positiveSignals += 1;
			reasons.push('same date');
		} else {
			return { eventId: candidate.id, confidence: 0, reasons: ['different date'], positiveSignals: 0 };
		}
	}

	const incomingVenue = canonicalText(incoming.venue);
	const candidateVenue = canonicalText(candidate.venue);
	if (incomingVenue && candidateVenue) {
		available += 0.25;
		const similarity = tokenSimilarity(incomingVenue, candidateVenue);
		earned += 0.25 * similarity;
		if (similarity >= 0.8) {
			positiveSignals += 1;
			reasons.push(similarity === 1 ? 'same venue' : 'similar venue');
		} else if (similarity < 0.35) {
			return { eventId: candidate.id, confidence: 0, reasons: ['different venue'], positiveSignals: 0 };
		}
	}

	const incomingTitle = canonicalText(incoming.title);
	const candidateTitle = canonicalText(candidate.title);
	if (incomingTitle && candidateTitle) {
		available += 0.25;
		const similarity = tokenSimilarity(incomingTitle, candidateTitle);
		earned += 0.25 * similarity;
		if (similarity >= 0.5) {
			positiveSignals += 1;
			reasons.push(similarity === 1 ? 'same title' : 'similar title');
		} else if (similarity < 0.3) {
			return { eventId: candidate.id, confidence: 0, reasons: ['different title'], positiveSignals: 0 };
		}
	}

	if (incoming.startTime && candidate.startTime) {
		available += 0.1;
		if (incoming.startTime === candidate.startTime) {
			earned += 0.1;
			positiveSignals += 1;
			reasons.push('same start time');
		} else {
			reasons.push('different start time');
		}
	}

	if (available === 0) {
		return { eventId: candidate.id, confidence: 0, reasons: ['no comparable fields'], positiveSignals: 0 };
	}

	// Two substantial matching fields (for example title + venue on a menu
	// flyer) provide enough evidence. A single shared field remains capped below
	// the automatic match threshold and can never auto-merge by itself.
	const normalizedSimilarity = earned / available;
	const evidenceCoverage = Math.min(1, available / 0.5);
	const confidence = Number((normalizedSimilarity * evidenceCoverage).toFixed(4));

	return { eventId: candidate.id, confidence, reasons, positiveSignals };
}

export function matchExistingEvent(
	incoming: MatchableEvent,
	candidates: ExistingEventCandidate[],
): EventMatchResult {
	const ranked = candidates
		.map((candidate) => scoreCandidate(incoming, candidate))
		.sort((left, right) => right.confidence - left.confidence);

	const best = ranked[0];
	if (!best) {
		return { matched: false, eventId: null, confidence: 0, reasons: ['no candidates'] };
	}

	const matched = best.confidence >= MATCH_THRESHOLD && best.positiveSignals >= 2;
	return {
		matched,
		eventId: matched ? best.eventId : null,
		confidence: best.confidence,
		reasons: best.reasons,
	};
}
