export type QrDecodeStatus = 'complete' | 'not_available' | 'failed';

export interface QrDecodeResult {
	schemaVersion: 1;
	status: QrDecodeStatus;
	decoder: string;
	values: string[];
	processedAt: string;
	error?: string;
}

export interface QrDecoder {
	readonly name: string;
	decode(content: ArrayBuffer, contentType: string): Promise<string[]>;
}

/**
 * The Workers runtime has no built-in QR decoder. Keep the boundary explicit so a
 * maintained WASM decoder can be supplied without coupling ingestion to it.
 */
export class UnavailableQrDecoder implements QrDecoder {
	readonly name = 'unavailable';
	async decode(): Promise<string[]> { throw new Error('No Workers-compatible QR decoder is configured.'); }
}

export async function inspectAndStoreQr(
	bucket: R2Bucket,
	input: { intakeId: string; assetId: string; contentType: string; content: ArrayBuffer },
	decoder: QrDecoder = new UnavailableQrDecoder(),
): Promise<QrDecodeResult> {
	const processedAt = new Date().toISOString();
	let result: QrDecodeResult;
	try {
		const values = [...new Set((await decoder.decode(input.content, input.contentType)).map((value) => value.trim()).filter(Boolean))];
		result = { schemaVersion: 1, status: 'complete', decoder: decoder.name, values, processedAt };
	} catch (error) {
		const unavailable = decoder instanceof UnavailableQrDecoder;
		result = { schemaVersion: 1, status: unavailable ? 'not_available' : 'failed', decoder: decoder.name, values: [], processedAt,
			error: error instanceof Error ? error.message : String(error) };
	}
	await bucket.put(`intakes/${input.intakeId}/assets/${input.assetId}/qr.json`, JSON.stringify(result, null, 2), {
		httpMetadata: { contentType: 'application/json' },
		customMetadata: { intakeId: input.intakeId, assetId: input.assetId, status: result.status, decoder: result.decoder },
	});
	return result;
}
