export interface ImageIntakeRequest {
	intakeId?: string;
	sourceType: 'line_image';
	sourceReference: string;
	lineUserId?: string;
	receivedAt: string;
	contentType: string;
	content: ArrayBuffer;
	role?: 'invitation' | 'menu' | 'wine_list' | 'other';
}

export interface StoredImageAsset {
	intakeId: string;
	assetId: string;
	objectKey: string;
	metadataKey: string;
	duplicate: boolean;
}

interface IntakeAssetMetadata {
	id: string;
	intakeId: string;
	sourceType: 'line_image';
	sourceReference: string;
	lineUserId?: string;
	role: 'invitation' | 'menu' | 'wine_list' | 'other';
	status: 'stored';
	objectKey: string;
	contentType: string;
	receivedAt: string;
	storedAt: string;
}

function buildDefaultIntakeId(sourceReference: string): string {
	return `line-${sourceReference}`;
}

function buildAssetId(sourceReference: string): string {
	return `line-message-${sourceReference}`;
}

export async function storeLineImageAsset(
	bucket: R2Bucket,
	request: ImageIntakeRequest,
): Promise<StoredImageAsset> {
	const intakeId = request.intakeId ?? buildDefaultIntakeId(request.sourceReference);
	const assetId = buildAssetId(request.sourceReference);
	const prefix = `intakes/${intakeId}/assets/${assetId}`;
	const objectKey = `${prefix}/original`;
	const metadataKey = `${prefix}/metadata.json`;

	const existing = await bucket.head(metadataKey);
	if (existing) {
		return { intakeId, assetId, objectKey, metadataKey, duplicate: true };
	}

	await bucket.put(objectKey, request.content, {
		httpMetadata: { contentType: request.contentType },
		customMetadata: {
			intakeId,
			assetId,
			sourceType: request.sourceType,
			sourceReference: request.sourceReference,
		},
	});

	const metadata: IntakeAssetMetadata = {
		id: assetId,
		intakeId,
		sourceType: request.sourceType,
		sourceReference: request.sourceReference,
		lineUserId: request.lineUserId,
		role: request.role ?? 'other',
		status: 'stored',
		objectKey,
		contentType: request.contentType,
		receivedAt: request.receivedAt,
		storedAt: new Date().toISOString(),
	};

	await bucket.put(metadataKey, JSON.stringify(metadata, null, 2), {
		httpMetadata: { contentType: 'application/json' },
		customMetadata: {
			intakeId,
			assetId,
			status: metadata.status,
			role: metadata.role,
		},
	});

	return { intakeId, assetId, objectKey, metadataKey, duplicate: false };
}
