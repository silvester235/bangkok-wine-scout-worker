export interface NormalizedWineEntity {
	raw: string;
	normalized: string;
	confidence: number;
	matchType: 'exact' | 'alias' | 'fuzzy' | 'unmatched';
}

interface WineReference {
	canonical: string;
	aliases: string[];
}

const WINE_REFERENCES: WineReference[] = [
	{
		canonical: 'Château Tournefeuille',
		aliases: [
			'Château Toumeufeuille',
			'Chateau Toumeufeuille',
			'Château Châteaufeuille',
			'Chateau Chateaufeuille',
		],
	},
];

function comparisonKey(value: string): string {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLocaleLowerCase('en')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

function levenshteinDistance(left: string, right: string): number {
	if (left === right) return 0;
	if (!left.length) return right.length;
	if (!right.length) return left.length;

	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	const current = new Array<number>(right.length + 1);

	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		current[0] = leftIndex;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
			current[rightIndex] = Math.min(
				current[rightIndex - 1] + 1,
				previous[rightIndex] + 1,
				previous[rightIndex - 1] + substitutionCost,
			);
		}
		for (let index = 0; index < current.length; index += 1) previous[index] = current[index];
	}

	return previous[right.length];
}

function similarity(left: string, right: string): number {
	const longestLength = Math.max(left.length, right.length);
	if (longestLength === 0) return 1;
	return 1 - levenshteinDistance(left, right) / longestLength;
}

function roundConfidence(value: number): number {
	return Math.round(value * 100) / 100;
}

export function normalizeWineEntity(rawWine: string): NormalizedWineEntity {
	const raw = rawWine.trim();
	if (!raw) {
		return { raw: rawWine, normalized: rawWine, confidence: 0, matchType: 'unmatched' };
	}

	const rawKey = comparisonKey(raw);

	for (const reference of WINE_REFERENCES) {
		if (rawKey === comparisonKey(reference.canonical)) {
			return { raw, normalized: reference.canonical, confidence: 1, matchType: 'exact' };
		}

		if (reference.aliases.some((alias) => rawKey === comparisonKey(alias))) {
			return { raw, normalized: reference.canonical, confidence: 0.94, matchType: 'alias' };
		}
	}

	let bestReference: WineReference | null = null;
	let bestSimilarity = 0;
	for (const reference of WINE_REFERENCES) {
		const candidateSimilarity = similarity(rawKey, comparisonKey(reference.canonical));
		if (candidateSimilarity > bestSimilarity) {
			bestSimilarity = candidateSimilarity;
			bestReference = reference;
		}
	}

	if (bestReference && bestSimilarity >= 0.82) {
		return {
			raw,
			normalized: bestReference.canonical,
			confidence: roundConfidence(bestSimilarity),
			matchType: 'fuzzy',
		};
	}

	return { raw, normalized: raw, confidence: 0.5, matchType: 'unmatched' };
}

export function normalizeWineEntities(wines: string[]): NormalizedWineEntity[] {
	return wines.map(normalizeWineEntity);
}
