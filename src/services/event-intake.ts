export interface ImageIntakeRequest {
	sourceType: 'line_image';
	sourceReference: string;
	lineUserId?: string;
	receivedAt: string;
	contentType: string;
	content: ArrayBuffer;
}

export interface StoredImageIntake {
	intakeId: string;
	objectKey: string;
	metadataKey: string;
	duplicate: boolean;
}

interface IntakeMetadata {
	id: string;
	sourceType: 'line_image';
	sourceReference: string;
	lineUserId?: string;
	status: 'stored';
	objectKey: string;
	contentType: string;
	receivedAt: string;
	storedAt: string;
}

function buildIntakeId(sourceReference: string): string {
	return `line-${sourceReference}`;
}

export async function storeLineImageIntake(
	bucket: R2Bucket,
	request: ImageIntakeRequest,
): Promise<StoredImageIntake> {
	const intakeId = buildIntakeId(request.sourceReference);
	const prefix = `intakes/${intakeId}`;
	const objectKey = `${prefix}/original`;
	const metadataKey = `${prefix}/metadata.json`;

	const existing = await bucket.head(metadataKey);
	if (existing) {
		return { intakeId, objectKey, metadataKey, duplicate: true };
	}

	await bucket.put(objectKey, request.content, {
		httpMetadata: { contentType: request.contentType },
		customMetadata: {
			intakeId,
			sourceType: request.sourceType,
			sourceReference: request.sourceReference,
		},
	});

	const metadata: IntakeMetadata = {
		id: intakeId,
		sourceType: request.sourceType,
		sourceReference: request.sourceReference,
		lineUserId: request.lineUserId,
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
			status: metadata.status,
		},
	});

	return { intakeId, objectKey, metadataKey, duplicate: false };
}
