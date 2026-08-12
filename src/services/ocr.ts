import { runWorkersAi } from './workers-ai-diagnostics';

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
	attempts?: OcrAttempt[];
}

export interface OcrAttempt {
	attempt: number;
	focus: 'full_image' | 'contact_footer';
	status: 'completed' | 'failed';
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

function mergeTranscriptions(values: string[]): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const value of values) for (const line of value.split('\n')) {
		const display = line.trim();
		const key = display.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
		if (!display || seen.has(key)) continue;
		seen.add(key);
		lines.push(display);
	}
	return lines.join('\n');
}

function lacksContactEvidence(text: string): boolean {
	return !/(?:https?:\/\/|www\.|\b[\w.-]+\.(?:com|co\.th|org|net)\b|[\w.+-]+@[\w.-]+\.\w{2,}|\+?\d[\d\s-]{7,})/i.test(text);
}

export async function extractAndStoreOcr(
	rawAi: Ai,
	bucket: R2Bucket,
	input: {
		intakeId: string;
		assetId: string;
		contentType: string;
		content: ArrayBuffer;
		submissionId?: string;
		workflowInstanceId?: string;
		accountId?: string;
	},
): Promise<OcrResult> {
	const ai={run:(_model:string,request:unknown)=>runWorkersAi(rawAi,request,{stage:'ocr',model:OCR_MODEL,submissionId:input.submissionId,workflowInstanceId:input.workflowInstanceId,accountId:input.accountId})} as unknown as Ai;
	const ocrKey = `intakes/${input.intakeId}/assets/${input.assetId}/ocr.json`;
	const processedAt = new Date().toISOString();

	try {
		const image = `data:${input.contentType};base64,${arrayBufferToBase64(input.content)}`;
		const runAttempt = async (attempt: number, focus: OcrAttempt['focus'], question: string): Promise<OcrAttempt> => {
			const attemptProcessedAt = new Date().toISOString();
			try {
			const response = (await ai.run(OCR_MODEL, {
			task: 'query',
			image,
			question,
			reasoning: false,
			temperature: 0,
			max_tokens: 8192,
			stream: false,
			})) as MoondreamResponse;
			const text = normalizeText(response.result?.answer ?? response.answer);
			const result: OcrAttempt = { attempt, focus, status: text ? 'completed' : 'failed', text, processedAt: attemptProcessedAt,
				...(text ? {} : { error: 'Workers AI returned no OCR text.' }),
				responseKeys: response && typeof response === 'object' ? Object.keys(response as Record<string, unknown>) : [], rawResponse: response };
			await bucket.put(`intakes/${input.intakeId}/assets/${input.assetId}/ocr-attempts/${attempt}.json`, JSON.stringify(result, null, 2), { httpMetadata: { contentType: 'application/json' } });
			return result;
			} catch (error) {
				const result: OcrAttempt = { attempt, focus, status: 'failed', text: '', processedAt: attemptProcessedAt, error: error instanceof Error ? error.message : String(error) };
				await bucket.put(`intakes/${input.intakeId}/assets/${input.assetId}/ocr-attempts/${attempt}.json`, JSON.stringify(result, null, 2), { httpMetadata: { contentType: 'application/json' } });
				return result;
			}
		};

		const attempts: OcrAttempt[] = [await runAttempt(1, 'full_image',
			'Transcribe every visible word in this image exactly as printed. Preserve reading order, line breaks, capitalization, punctuation, accents, symbols, and spacing. Pay special attention to wine and producer names, dates, times, prices, email addresses, phone numbers, URLs, and venue names. Carefully distinguish similar characters such as 0/O, 1/I/l, 5/S, 6/G, rn/m, cl/d, .org/.co.th, and +65/+66. Never reconstruct a likely word, infer a missing field, use outside knowledge, or add text that is not visibly present. When a character or word is genuinely unreadable, write [UNCLEAR] in that exact position instead of guessing. Do not summarize, explain, translate, or correct spelling. Return only the transcription.')];
		if (attempts[0].status === 'completed' && lacksContactEvidence(attempts[0].text)) attempts.push(await runAttempt(2, 'contact_footer',
			'Inspect the entire image again, concentrating on small print in the footer, corners, and beside any QR code. Transcribe only visibly printed contact, booking, price, address, organizer, partner, website, phone, email, and QR-adjacent text. Preserve punctuation and every plus sign exactly. Do not infer or explain. Return only the transcription; return [NONE] if no such text is visible.'));

		const text = mergeTranscriptions(attempts.filter((attempt) => attempt.status === 'completed' && attempt.text !== '[NONE]').map((attempt) => attempt.text));

		const result: OcrResult = {
			schemaVersion: 1,
			status: text ? 'completed' : 'failed',
			intakeId: input.intakeId,
			assetId: input.assetId,
			model: OCR_MODEL,
			languageHint: 'auto',
			text,
			processedAt,
			attempts,
			...(text
				? {}
				: {
						error: 'Workers AI returned no OCR text.',
						responseKeys: attempts.flatMap((attempt) => attempt.responseKeys ?? []),
						rawResponse: attempts.map((attempt) => attempt.rawResponse),
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
