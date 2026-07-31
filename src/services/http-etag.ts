function normalizeWeakEtag(value: string): string {
	return value.trim().replace(/^W\//i, '');
}

export function ifNoneMatchMatches(headerValue: string | null, currentEtag: string): boolean {
	if (!headerValue) return false;
	const normalizedCurrent = normalizeWeakEtag(currentEtag);
	return headerValue.split(',').some((value) => {
		const candidate = value.trim();
		if (candidate === '*') return true;
		if (!/^(?:W\/)?"[^"]*"$/i.test(candidate)) return false;
		return normalizeWeakEtag(candidate) === normalizedCurrent;
	});
}
