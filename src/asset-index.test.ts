import { AssetIndex, collectAttachments, sniffExtension, extensionOf } from './asset-index';

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]);
const JPEG_HEADER = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0]);
const PDF_HEADER = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]);

function headerOf(text: string): Uint8Array {
	const bytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
	return bytes;
}

describe('sniffExtension', () => {
	it('should detect common binary formats', () => {
		expect(sniffExtension(PNG_HEADER)).toBe('png');
		expect(sniffExtension(JPEG_HEADER)).toBe('jpg');
		expect(sniffExtension(PDF_HEADER)).toBe('pdf');
	});

	it('should detect SVG markup', () => {
		expect(sniffExtension(headerOf('<svg xmlns="http://www.w3.org/2000/svg">'))).toBe('svg');
	});

	it('should return empty for unknown or missing content', () => {
		expect(sniffExtension(null)).toBe('');
		expect(sniffExtension(headerOf('just some plain text'))).toBe('');
	});
});

describe('extensionOf', () => {
	it('should extract the lowercased extension', () => {
		expect(extensionOf('photo.PNG')).toBe('png');
		expect(extensionOf('no-extension')).toBe('');
	});
});

describe('AssetIndex', () => {
	const datPath = '/archive/file_00000000aaaa.dat';

	it('should recover the real name from the asset file names manifest', () => {
		const index = new AssetIndex({
			allFiles: [datPath],
			assetFileNames: { 'file_00000000aaaa.dat': 'holiday.png' },
			readHeader: () => PNG_HEADER,
		});

		const asset = index.resolve('file_00000000aaaa');
		expect(asset).not.toBeNull();
		expect(asset!.fileName).toBe('holiday.png');
		expect(asset!.mimeType).toBe('image/png');
		expect(asset!.isImage).toBe(true);
		expect(asset!.path).toBe(datPath);
	});

	it('should prefer the attachment name over the manifests', () => {
		const index = new AssetIndex({
			allFiles: [datPath],
			assetFileNames: { 'file_00000000aaaa.dat': 'generic.png' },
			libraryFiles: [{ file_id: 'file_00000000aaaa', file_name: 'library.png' }],
			attachments: [{ id: 'file_00000000aaaa', name: 'what-the-user-saw.png', mime_type: 'image/png' }],
			readHeader: () => PNG_HEADER,
		});

		expect(index.resolve('file_00000000aaaa')!.fileName).toBe('what-the-user-saw.png');
	});

	it('should fall back to the library name when nothing else is known', () => {
		const index = new AssetIndex({
			allFiles: [datPath],
			libraryFiles: [{ file_id: 'file_00000000aaaa', file_name: 'report.pdf', mime_type: 'application/pdf' }],
			readHeader: () => PDF_HEADER,
		});

		const asset = index.resolve('file_00000000aaaa')!;
		expect(asset.fileName).toBe('report.pdf');
		expect(asset.mimeType).toBe('application/pdf');
		expect(asset.isImage).toBe(false);
	});

	it('should correct a wrong declared extension using the file content', () => {
		// A pasted SVG is recorded by the export as "Pasted text.txt"
		const index = new AssetIndex({
			allFiles: [datPath],
			libraryFiles: [{ file_id: 'file_00000000aaaa', file_name: 'Pasted text.txt', file_extension: 'txt' }],
			readHeader: () => headerOf('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'),
		});

		const asset = index.resolve('file_00000000aaaa')!;
		expect(asset.fileName).toBe('Pasted text.svg');
		expect(asset.mimeType).toBe('image/svg+xml');
	});

	it('should keep jpeg when the sniffed type is the equivalent jpg', () => {
		const index = new AssetIndex({
			allFiles: [datPath],
			assetFileNames: { 'file_00000000aaaa.dat': 'photo.jpeg' },
			readHeader: () => JPEG_HEADER,
		});

		expect(index.resolve('file_00000000aaaa')!.fileName).toBe('photo.jpeg');
	});

	it('should derive a name from the content when no manifest knows the file', () => {
		const index = new AssetIndex({
			allFiles: [datPath],
			readHeader: () => PNG_HEADER,
		});

		expect(index.resolve('file_00000000aaaa')!.fileName).toBe('file_00000000aaaa.png');
	});

	it('should still resolve files from the older export layout', () => {
		const index = new AssetIndex({
			allFiles: ['/archive/dalle-generations/file-abc123-picture.webp'],
		});

		const asset = index.resolve('file-abc123')!;
		expect(asset.fileName).toBe('file-abc123-picture.webp');
		expect(asset.isImage).toBe(true);
	});

	it('should return null for a file that is not in the archive', () => {
		const index = new AssetIndex({ allFiles: [datPath] });
		expect(index.resolve('file_00000000ffff')).toBeNull();
	});

	describe('libraryFilesForThread', () => {
		it('should return library files originating from a conversation', () => {
			const index = new AssetIndex({
				allFiles: [datPath, '/archive/file_00000000bbbb.dat'],
				libraryFiles: [
					{ file_id: 'file_00000000aaaa', file_name: 'scene.png', origination_thread_id: 'conv-1' },
					{ file_id: 'file_00000000bbbb', file_name: 'other.png', origination_thread_id: 'conv-2' },
				],
				readHeader: () => PNG_HEADER,
			});

			const assets = index.libraryFilesForThread('conv-1', () => false);
			expect(assets).toHaveLength(1);
			expect(assets[0].fileName).toBe('scene.png');
		});

		it('should skip files already used in the conversation', () => {
			const index = new AssetIndex({
				allFiles: [datPath],
				libraryFiles: [
					{ file_id: 'file_00000000aaaa', file_name: 'scene.png', origination_thread_id: 'conv-1' },
				],
				readHeader: () => PNG_HEADER,
			});

			expect(index.libraryFilesForThread('conv-1', () => true)).toHaveLength(0);
		});
	});

	describe('unreferenced', () => {
		it('should list blobs no conversation refers to', () => {
			const index = new AssetIndex({
				allFiles: [datPath, '/archive/file_00000000bbbb.dat'],
				assetFileNames: {
					'file_00000000aaaa.dat': 'used.png',
					'file_00000000bbbb.dat': 'orphan.png',
				},
				readHeader: () => PNG_HEADER,
			});

			const leftovers = index.unreferenced((id) => id === 'file_00000000aaaa', () => false);
			expect(leftovers).toHaveLength(1);
			expect(leftovers[0].fileName).toBe('orphan.png');
		});

		it('should not list files claimed by a conversation in the export', () => {
			const index = new AssetIndex({
				allFiles: [datPath],
				libraryFiles: [
					{ file_id: 'file_00000000aaaa', file_name: 'scene.png', origination_thread_id: 'conv-1' },
				],
				readHeader: () => PNG_HEADER,
			});

			expect(index.unreferenced(() => false, (threadId) => threadId === 'conv-1')).toHaveLength(0);
			expect(index.unreferenced(() => false, () => false)).toHaveLength(1);
		});

		it('should collapse duplicates that share a digest', () => {
			const index = new AssetIndex({
				allFiles: [datPath, '/archive/file_00000000bbbb.dat'],
				libraryFiles: [
					{ file_id: 'file_00000000aaaa', file_name: 'Pasted text.txt', sha256_digest: 'same' },
					{ file_id: 'file_00000000bbbb', file_name: 'Pasted text(1).txt', sha256_digest: 'same' },
				],
			});

			expect(index.unreferenced(() => false, () => false)).toHaveLength(1);
		});
	});
});

describe('collectAttachments', () => {
	it('should gather attachments from every message', () => {
		const conv = {
			mapping: {
				a: { message: { metadata: { attachments: [{ id: 'file_1', name: 'a.pdf' }] } } },
				b: { message: { metadata: { attachments: [{ id: 'file_2', name: 'b.png' }] } } },
				c: { message: { metadata: {} } },
				d: {},
			},
		};

		const attachments = collectAttachments(conv);
		expect(attachments.map(a => a.id)).toEqual(['file_1', 'file_2']);
	});

	it('should tolerate a conversation without a mapping', () => {
		expect(collectAttachments({})).toEqual([]);
		expect(collectAttachments(null)).toEqual([]);
	});
});
