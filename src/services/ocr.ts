const OCR_MODEL = '@cf/moondream/moondream3.1-9B-A2B';

export interface OcrResult {
	schemaVersion: 1;
	status: 'completed' | 'failed';
	intakeId: string;
	assetId: string;
	model: string;
	languageHint: 'auto';
	text: string;
	processedAt: string;
	error?: string;
	responseKeys?: string[];
	rawResponse?: unknown;
}

interface MoondreamResponse {
	answer?: string | null;
	result?: {
		answer?: string | null;
	};
}

function arrayBufferToBase64(content: ArrayBuffer): string {
	const bytes = new Uint8Array(content);
	const chunkSize = 0x8000;
	let binary = '';

	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}

	return btoa(binary);
}

function normalizeText(value: string | null | undefined): string {
	return (value ?? '')
		.replace(/\r\n/g, '\n')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function answerFrom(response: MoondreamResponse): string {
	return normalizeText(response.result?.answer ?? response.answer);
}

async function queryImage(ai: Ai, image: string, question: string): Promise<MoondreamResponse> {
	return (await ai.run(OCR_MODEL, {
		task: 'query',
		image,
		question,
		reasoning: true,
		temperature: 0,
		max_tokens: 8192,
		stream: false,
	})) as MoondreamResponse;
}

export async function extractAndStoreOcr(
	ai: Ai,
	bucket: R2Bucket,
	input: {
		intakeId: string;
		assetId: string;
		contentType: string;
		content: ArrayBuffer;
	},
): Promise<OcrResult> {
	const ocrKey = `intakes/${input.intakeId}/assets/${input.assetId}/ocr.json`;
	const processedAt = new Date().toISOString();

	try {
		const image = `data:${input.contentType};base64,${arrayBufferToBase64(input.content)}`;

		const transcriptionResponse = await queryImage(
			ai,
			image,
			'Transcribe every visible word in this image exactly as printed. Preserve reading order, line breaks, capitalization, punctuation, accents, symbols, and spacing. Carefully distinguish similar characters such as 0/O, 1/I/l, 5/S, 6/G, rn/m, cl/d, .org/.co.th, and +65/+66. Include all languages, dates, times, prices, wine and producer names, menu items, venue names, addresses, email addresses, phone numbers, URLs, and fine print. Do not summarize, explain, translate, correct spelling, use outside knowledge, or invent obscured text. Return only the transcription.',
		);
		const transcription = answerFrom(transcriptionResponse);

		const verificationResponse = await queryImage(
			ai,
			image,
			'Perform a second independent close reading of only the critical factual text on this image. Copy each visible value character-for-character and do not rely on likely spellings or outside knowledge. Inspect especially: event title; date; start and end time; venue; every wine, château, producer, and presenter name; price and currency; email; phone; URL; booking contact. Carefully distinguish accents and similar characters such as 0/O, 1/I/l, 5/S, 6/G, rn/m, cl/d, .org/.co.th, and +65/+66. Use one line per field in the form FIELD: exact visible text. Write UNCLEAR instead of guessing. Return only those field lines.',
		);
		const verification = answerFrom(verificationResponse);

		const text = normalizeText(
			[
				transcription,
				verification ? `--- VERIFIED CRITICAL FIELDS (SECOND IMAGE READING) ---\n${verification}` : '',
			]
				.filter(Boolean)
				.join('\n\n'),
		);

		const responseKeys = transcriptionResponse && typeof transcriptionResponse === 'object'
			? Object.keys(transcriptionResponse as Record<string, unknown>)
			: [];

		const result: OcrResult = {
			schemaVersion: 1,
			status: text ? 'completed' : 'failed',
			intakeId: input.intakeId,
			assetId: input.assetId,
			model: OCR_MODEL,
			languageHint: 'auto',
			text,
			processedAt,
			...(text
				? {}
				: {
						error: 'Workers AI returned no OCR text.',
						responseKeys,
						rawResponse: {
							transcription: transcriptionResponse,
							verification: verificationResponse,
						},
					}),
		};

		await bucket.put(ocrKey, JSON.stringify(result, null, 2), {
			httpMetadata: { contentType: 'application/json' },
			customMetadata: {
				intakeId: input.intakeId,
				assetId: input.assetId,
				status: result.status,
				model: OCR_MODEL,
			},
		});

		return result;
	} catch (error) {
		const result: OcrResult = {
			schemaVersion: 1,
			status: 'failed',
			intakeId: input.intakeId,
			assetId: input.assetId,
			model: OCR_MODEL,
			languageHint: 'auto',
			text: '',
			processedAt,
			error: error instanceof Error ? error.message : String(error),
		};

		await bucket.put(ocrKey, JSON.stringify(result, null, 2), {
			httpMetadata: { contentType: 'application/json' },
			customMetadata: {
				intakeId: input.intakeId,
				assetId: input.assetId,
				status: result.status,
				model: OCR_MODEL,
			},
		});

		return result;
	}
}
