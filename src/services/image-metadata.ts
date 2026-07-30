export interface ImageDimensions {
	width: number;
	height: number;
}

export interface ExifMetadata {
	present: boolean;
	orientation?: number;
	make?: string;
	model?: string;
	dateTimeOriginal?: string;
	dateTime?: string;
	software?: string;
}

export interface ExtractedImageMetadata {
	dimensions?: ImageDimensions;
	exif: ExifMetadata;
}

function readAscii(view: DataView, offset: number, length: number): string {
	const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
	return new TextDecoder('ascii').decode(bytes).replace(/\0+$/, '').trim();
}

function parsePng(view: DataView): ImageDimensions | undefined {
	if (
		view.byteLength >= 24 &&
		view.getUint32(0, false) === 0x89504e47 &&
		view.getUint32(4, false) === 0x0d0a1a0a
	) {
		return {
			width: view.getUint32(16, false),
			height: view.getUint32(20, false),
		};
	}
	return undefined;
}

function parseGif(view: DataView): ImageDimensions | undefined {
	if (view.byteLength < 10) return undefined;
	const signature = readAscii(view, 0, 6);
	if (signature !== 'GIF87a' && signature !== 'GIF89a') return undefined;
	return {
		width: view.getUint16(6, true),
		height: view.getUint16(8, true),
	};
}

function parseWebp(view: DataView): ImageDimensions | undefined {
	if (
		view.byteLength < 30 ||
		readAscii(view, 0, 4) !== 'RIFF' ||
		readAscii(view, 8, 4) !== 'WEBP'
	) {
		return undefined;
	}

	const chunkType = readAscii(view, 12, 4);
	if (chunkType === 'VP8X') {
		const width = 1 + view.getUint8(24) + (view.getUint8(25) << 8) + (view.getUint8(26) << 16);
		const height = 1 + view.getUint8(27) + (view.getUint8(28) << 8) + (view.getUint8(29) << 16);
		return { width, height };
	}

	if (chunkType === 'VP8L' && view.byteLength >= 25 && view.getUint8(20) === 0x2f) {
		const bits = view.getUint32(21, true);
		return {
			width: (bits & 0x3fff) + 1,
			height: ((bits >> 14) & 0x3fff) + 1,
		};
	}

	return undefined;
}

function readExifString(
	view: DataView,
	tiffOffset: number,
	entryOffset: number,
	littleEndian: boolean,
): string | undefined {
	const type = view.getUint16(entryOffset + 2, littleEndian);
	const count = view.getUint32(entryOffset + 4, littleEndian);
	if (type !== 2 || count === 0) return undefined;

	const valueOffset = count <= 4
		? entryOffset + 8
		: tiffOffset + view.getUint32(entryOffset + 8, littleEndian);
	if (valueOffset < 0 || valueOffset + count > view.byteLength) return undefined;
	return readAscii(view, valueOffset, count);
}

function parseExifIfd(
	view: DataView,
	tiffOffset: number,
	ifdOffset: number,
	littleEndian: boolean,
	exif: ExifMetadata,
): number | undefined {
	if (ifdOffset + 2 > view.byteLength) return undefined;
	const entries = view.getUint16(ifdOffset, littleEndian);
	for (let index = 0; index < entries; index += 1) {
		const entryOffset = ifdOffset + 2 + index * 12;
		if (entryOffset + 12 > view.byteLength) break;
		const tag = view.getUint16(entryOffset, littleEndian);

		switch (tag) {
			case 0x0112:
				exif.orientation = view.getUint16(entryOffset + 8, littleEndian);
				break;
			case 0x010f:
				exif.make = readExifString(view, tiffOffset, entryOffset, littleEndian);
				break;
			case 0x0110:
				exif.model = readExifString(view, tiffOffset, entryOffset, littleEndian);
				break;
			case 0x0131:
				exif.software = readExifString(view, tiffOffset, entryOffset, littleEndian);
				break;
			case 0x0132:
				exif.dateTime = readExifString(view, tiffOffset, entryOffset, littleEndian);
				break;
			case 0x9003:
				exif.dateTimeOriginal = readExifString(view, tiffOffset, entryOffset, littleEndian);
				break;
			case 0x8769:
				return tiffOffset + view.getUint32(entryOffset + 8, littleEndian);
		}
	}
	return undefined;
}

function parseJpeg(view: DataView): ExtractedImageMetadata | undefined {
	if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return undefined;

	let offset = 2;
	let dimensions: ImageDimensions | undefined;
	const exif: ExifMetadata = { present: false };

	while (offset + 4 <= view.byteLength) {
		if (view.getUint8(offset) !== 0xff) break;
		const marker = view.getUint8(offset + 1);
		offset += 2;
		if (marker === 0xd9 || marker === 0xda) break;
		if (offset + 2 > view.byteLength) break;

		const segmentLength = view.getUint16(offset, false);
		if (segmentLength < 2 || offset + segmentLength > view.byteLength) break;
		const segmentStart = offset + 2;

		const isSof = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
		if (isSof && segmentLength >= 7) {
			dimensions = {
				height: view.getUint16(segmentStart + 1, false),
				width: view.getUint16(segmentStart + 3, false),
			};
		}

		if (marker === 0xe1 && segmentLength >= 10 && readAscii(view, segmentStart, 6) === 'Exif') {
			exif.present = true;
			const tiffOffset = segmentStart + 6;
			if (tiffOffset + 8 <= view.byteLength) {
				const byteOrder = view.getUint16(tiffOffset, false);
				const littleEndian = byteOrder === 0x4949;
				if (littleEndian || byteOrder === 0x4d4d) {
					const firstIfd = tiffOffset + view.getUint32(tiffOffset + 4, littleEndian);
					const exifIfd = parseExifIfd(view, tiffOffset, firstIfd, littleEndian, exif);
					if (exifIfd !== undefined) {
						parseExifIfd(view, tiffOffset, exifIfd, littleEndian, exif);
					}
				}
			}
		}

		offset += segmentLength;
	}

	return { dimensions, exif };
}

export function extractImageMetadata(content: ArrayBuffer): ExtractedImageMetadata {
	const view = new DataView(content);
	const jpeg = parseJpeg(view);
	if (jpeg) return jpeg;

	return {
		dimensions: parsePng(view) ?? parseGif(view) ?? parseWebp(view),
		exif: { present: false },
	};
}
