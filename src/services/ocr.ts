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
		const response = (await ai.run(OCR_MODEL, {
			task: 'query',
			image,
			question:
				'Transcribe every visible word in this image exactly as written. Preserve reading order and line breaks. Include all languages, dates, times, prices, wine names, menu items, addresses, phone numbers, URLs, and fine print. Do not summarize, explain, translate, or invent missing text. Return only the transcription.',
			reasoning: false,
			temperature: 0,
			max_tokens: 8192,
			stream: false,
		})) as MoondreamResponse;

		const text = normalizeText(response.result?.answer ?? response.answer);
		const responseKeys =
			response && typeof response === 'object' ? Object.keys(response as Record<string, unknown>) : [];

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
						rawResponse: response,
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
