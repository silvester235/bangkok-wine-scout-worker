import { extractImageMetadata, type ExifMetadata, type ImageDimensions } from './image-metadata';

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
	contentHash: string;
	duplicate: boolean;
}

interface IntakeAssetMetadata {
	schemaVersion: 2;
	id: string;
	intakeId: string;
	sourceType: 'line_image';
	sourceReference: string;
	lineUserId?: string;
	role: 'invitation' | 'menu' | 'wine_list' | 'other';
	status: 'stored';
	objectKey: string;
	originalFilename: string | null;
	originalFilenameAvailable: false;
	contentType: string;
	byteSize: number;
	contentHash: {
		algorithm: 'sha256';
		value: string;
	};
	dimensions: ImageDimensions | null;
	exif: ExifMetadata;
	receivedAt: string;
	storedAt: string;
}

interface ImageHashIndex {
	contentHash: string;
	intakeId: string;
	assetId: string;
	objectKey: string;
	metadataKey: string;
	createdAt: string;
}

function buildDefaultIntakeId(sourceReference: string): string {
	return `line-${sourceReference}`;
}

function buildAssetId(sourceReference: string): string {
	return `line-message-${sourceReference}`;
}

function bytesToHex(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

async function calculateSha256(content: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', content);
	return bytesToHex(digest);
}

export async function storeLineImageAsset(
	bucket: R2Bucket,
	request: ImageIntakeRequest,
): Promise<StoredImageAsset> {
	const contentHash = await calculateSha256(request.content);
	const hashIndexKey = `image-hashes/sha256/${contentHash}.json`;
	const existingHash = await bucket.get(hashIndexKey);

	if (existingHash) {
		const index = (await existingHash.json()) as ImageHashIndex;
		return {
			intakeId: index.intakeId,
			assetId: index.assetId,
			objectKey: index.objectKey,
			metadataKey: index.metadataKey,
			contentHash,
			duplicate: true,
		};
	}

	const imageMetadata = extractImageMetadata(request.content);
	const byteSize = request.content.byteLength;
	const intakeId = request.intakeId ?? buildDefaultIntakeId(request.sourceReference);
	const assetId = buildAssetId(request.sourceReference);
	const prefix = `intakes/${intakeId}/assets/${assetId}`;
	const objectKey = `${prefix}/original`;
	const metadataKey = `${prefix}/metadata.json`;

	await bucket.put(objectKey, request.content, {
		httpMetadata: { contentType: request.contentType },
		customMetadata: {
			intakeId,
			assetId,
			sourceType: request.sourceType,
			sourceReference: request.sourceReference,
			contentHash,
			byteSize: String(byteSize),
			...(imageMetadata.dimensions
				? {
					width: String(imageMetadata.dimensions.width),
					height: String(imageMetadata.dimensions.height),
				}
				: {}),
		},
	});

	const metadata: IntakeAssetMetadata = {
		schemaVersion: 2,
		id: assetId,
		intakeId,
		sourceType: request.sourceType,
		sourceReference: request.sourceReference,
		lineUserId: request.lineUserId,
		role: request.role ?? 'other',
		status: 'stored',
		objectKey,
		originalFilename: null,
		originalFilenameAvailable: false,
		contentType: request.contentType,
		byteSize,
		contentHash: {
			algorithm: 'sha256',
			value: contentHash,
		},
		dimensions: imageMetadata.dimensions ?? null,
		exif: imageMetadata.exif,
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
			contentHash,
			byteSize: String(byteSize),
		},
	});

	const hashIndex: ImageHashIndex = {
		contentHash,
		intakeId,
		assetId,
		objectKey,
		metadataKey,
		createdAt: new Date().toISOString(),
	};

	await bucket.put(hashIndexKey, JSON.stringify(hashIndex, null, 2), {
		httpMetadata: { contentType: 'application/json' },
		customMetadata: {
			contentHash,
			intakeId,
			assetId,
		},
	});

	return {
		intakeId,
		assetId,
		objectKey,
		metadataKey,
		contentHash,
		duplicate: false,
	};
}
