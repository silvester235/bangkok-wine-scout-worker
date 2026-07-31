export interface EventExtractionContext {
	sourceText: string | null;
	ocrText: string | null;
	combinedText: string;
}

function normalizeSourceText(value: string | null | undefined): string | null {
	if (!value) return null;
	const normalized = value
		.replace(/\r\n?/g, '\n')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return normalized || null;
}

export function buildEventExtractionContext(input: {
	sourceText?: string | null;
	ocrText?: string | null;
}): EventExtractionContext {
	const sourceText = normalizeSourceText(input.sourceText);
	const ocrText = normalizeSourceText(input.ocrText);
	const sections: string[] = [];

	if (sourceText) sections.push(`[LINE MESSAGE]\n${sourceText}`);
	if (ocrText) sections.push(`[FLYER OCR]\n${ocrText}`);

	return { sourceText, ocrText, combinedText: sections.join('\n\n') };
}
