// Asset index for ChatGPT exports.
//
// Newer ChatGPT exports flatten every attachment into the archive root as
// opaque `file_<hex>.dat` blobs. The original file name and type live in
// separate manifests, so the index below merges them to recover both.
//
// Older exports keep properly named files inside `dalle-generations/`,
// `user-*/` and similar folders. Those are still resolved by falling back to
// the legacy path matching, so both formats keep working.

// A library file record as found in library_files.json. Only the fields we
// actually use are declared.
export interface LibraryFile {
	file_id?: string;
	file_name?: string;
	file_extension?: string;
	mime_type?: string;
	created_at?: string;
	sha256_digest?: string;
	// Conversation this file originated from. This is the only reliable link
	// between a library file and its conversation: initiating_conversation_id
	// is null even when the conversation is present in the export.
	origination_thread_id?: string;
}

// An attachment as found in message.metadata.attachments
export interface AttachmentMeta {
	id?: string;
	name?: string;
	mime_type?: string;
}

export interface ResolvedAsset {
	// Absolute path of the file on disk
	path: string;
	// File name to use for the Joplin resource, with a usable extension
	fileName: string;
	mimeType: string;
	isImage: boolean;
}

interface IndexEntry {
	path: string;
	// Name as declared by the manifests, if any
	declaredName?: string;
	mimeType?: string;
}

export interface AssetIndexSources {
	// Every file in the archive, as absolute paths
	allFiles: string[];
	// conversation_asset_file_names.json: "file_xxx.dat" -> "photo.png"
	assetFileNames?: Record<string, string>;
	// library_files.json
	libraryFiles?: LibraryFile[];
	// Attachments gathered from every message in every conversation
	attachments?: AttachmentMeta[];
	// Reads the first bytes of a file, for magic byte sniffing. Returns null
	// when the file cannot be read.
	readHeader?: (path: string) => Uint8Array | null;
}

const MIME_BY_EXTENSION: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	pdf: 'application/pdf',
	md: 'text/markdown',
	txt: 'text/plain',
	csv: 'text/csv',
	json: 'application/json',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	mp4: 'video/mp4',
	webm: 'video/webm',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export function extensionOf(fileName: string): string {
	const match = /\.([a-zA-Z0-9]+)$/.exec(fileName || '');
	return match ? match[1].toLowerCase() : '';
}

function mimeForName(fileName: string): string {
	return MIME_BY_EXTENSION[extensionOf(fileName)] || 'application/octet-stream';
}

function isImageMime(mime: string): boolean {
	return mime.startsWith('image/');
}

// Detect a file type from its leading bytes. The manifests are not always
// right about the extension - a pasted SVG is recorded as "Pasted text.txt" -
// so sniffing is used to correct the declared name rather than only as a
// fallback.
export function sniffExtension(header: Uint8Array | null): string {
	if (!header || header.length < 4) return '';

	const startsWith = (bytes: number[], offset = 0): boolean => {
		if (header.length < offset + bytes.length) return false;
		for (let i = 0; i < bytes.length; i++) {
			if (header[offset + i] !== bytes[i]) return false;
		}
		return true;
	};

	if (startsWith([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'png';
	if (startsWith([0xFF, 0xD8, 0xFF])) return 'jpg';
	if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'gif';
	if (startsWith([0x25, 0x50, 0x44, 0x46])) return 'pdf';
	// RIFF....WEBP
	if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
	// ZIP container: docx and friends. Left as zip only when nothing better is
	// known, since the declared extension is more specific.
	if (startsWith([0x50, 0x4B, 0x03, 0x04])) return 'zip';
	if (startsWith([0x49, 0x44, 0x33]) || startsWith([0xFF, 0xFB])) return 'mp3';

	// Text based formats: look for an <svg root within the first bytes.
	let text = '';
	for (let i = 0; i < Math.min(header.length, 512); i++) {
		text += String.fromCharCode(header[i]);
	}
	if (/<svg[\s>]/i.test(text) || (/<\?xml/i.test(text) && /<svg[\s>]/i.test(text))) return 'svg';

	return '';
}

function basename(filePath: string): string {
	const parts = filePath.split('/');
	return parts[parts.length - 1] || '';
}

// Matches the flattened blobs of the newer export format: file_<hex>.dat
const DAT_FILE_REGEX = /^(file_[0-9a-fA-F]+)\.dat$/;

export class AssetIndex {
	private entries: Record<string, IndexEntry> = {};
	private legacyFiles: string[] = [];
	private byThread: Record<string, LibraryFile[]> = {};
	private library: Record<string, LibraryFile> = {};
	private readHeader?: (path: string) => Uint8Array | null;

	public constructor(sources: AssetIndexSources) {
		this.readHeader = sources.readHeader;

		for (const filePath of sources.allFiles) {
			const match = DAT_FILE_REGEX.exec(basename(filePath));
			if (match) {
				this.entries[match[1]] = { path: filePath };
			} else {
				this.legacyFiles.push(filePath);
			}
		}

		// Naming sources, applied from least to most trusted so that the more
		// specific one wins.
		for (const file of sources.libraryFiles || []) {
			if (!file.file_id) continue;
			this.library[file.file_id] = file;

			const entry = this.entries[file.file_id];
			if (entry && file.file_name) {
				entry.declaredName = file.file_name;
				entry.mimeType = file.mime_type;
			}

			// Only index threads, so that a library file whose conversation is
			// absent from the export is not silently attached elsewhere.
			if (file.origination_thread_id) {
				const list = this.byThread[file.origination_thread_id] || [];
				list.push(file);
				this.byThread[file.origination_thread_id] = list;
			}
		}

		for (const key in sources.assetFileNames || {}) {
			const match = DAT_FILE_REGEX.exec(key);
			const fileId = match ? match[1] : key;
			const entry = this.entries[fileId];
			if (entry) {
				entry.declaredName = sources.assetFileNames![key];
				entry.mimeType = undefined;
			}
		}

		// Attachment metadata carries the name the user actually saw, so it
		// takes precedence over both manifests.
		for (const attachment of sources.attachments || []) {
			if (!attachment.id) continue;
			const entry = this.entries[attachment.id];
			if (entry && attachment.name) {
				entry.declaredName = attachment.name;
				entry.mimeType = attachment.mime_type || entry.mimeType;
			}
		}
	}

	// Resolve a file id to a path plus a usable file name. Returns null when
	// the archive does not contain the bytes.
	public resolve(fileId: string): ResolvedAsset | null {
		if (!fileId) return null;

		const entry = this.entries[fileId];
		if (entry) return this.describe(entry, fileId);

		// Older export format: files are stored under their real name in
		// per-type folders, so fall back to matching the id in the path.
		for (const filePath of this.legacyFiles) {
			if (filePath.includes(fileId)) {
				const fileName = basename(filePath);
				const mimeType = mimeForName(fileName);
				return { path: filePath, fileName, mimeType, isImage: isImageMime(mimeType) };
			}
		}

		return null;
	}

	// Library files that originated from the given conversation and are not
	// referenced anywhere in its messages.
	public libraryFilesForThread(threadId: string, alreadyUsed: (fileId: string) => boolean): ResolvedAsset[] {
		const files = this.byThread[threadId] || [];
		const result: ResolvedAsset[] = [];

		for (const file of files) {
			if (!file.file_id || alreadyUsed(file.file_id)) continue;
			const resolved = this.resolve(file.file_id);
			if (resolved) result.push(resolved);
		}

		return result;
	}

	// Every indexed blob that no conversation refers to, either through a
	// message or through a library origination thread.
	public unreferenced(isReferenced: (fileId: string) => boolean, knownThread: (threadId: string) => boolean): ResolvedAsset[] {
		const result: ResolvedAsset[] = [];
		const seenDigests: Record<string, boolean> = {};

		for (const fileId in this.entries) {
			if (isReferenced(fileId)) continue;

			const libraryFile = this.library[fileId];
			const threadId = libraryFile?.origination_thread_id;
			if (threadId && knownThread(threadId)) continue;

			// Library uploads are frequently duplicated - the same paste sent
			// twice a few seconds apart. Collapse them when the digest says
			// they are identical.
			const digest = libraryFile?.sha256_digest;
			if (digest) {
				if (seenDigests[digest]) continue;
				seenDigests[digest] = true;
			}

			const resolved = this.resolve(fileId);
			if (resolved) result.push(resolved);
		}

		return result;
	}

	public has(fileId: string): boolean {
		return !!this.entries[fileId];
	}

	private describe(entry: IndexEntry, fileId: string): ResolvedAsset {
		const declaredName = entry.declaredName || '';
		const declaredExtension = extensionOf(declaredName);
		const sniffed = this.readHeader ? sniffExtension(this.readHeader(entry.path)) : '';

		// Prefer the sniffed type when it disagrees with the declared one, as
		// the declared extension can be plain wrong. "zip" is ignored because
		// the declared extension (docx, xlsx...) is more specific.
		let extension = declaredExtension;
		if (sniffed && sniffed !== 'zip' && sniffed !== declaredExtension) {
			// jpg and jpeg describe the same thing, so keep what was declared.
			const sameImage = sniffed === 'jpg' && declaredExtension === 'jpeg';
			if (!sameImage) extension = sniffed;
		}
		if (!extension) extension = sniffed || '';

		let fileName = declaredName || fileId;
		if (extension && extensionOf(fileName) !== extension) {
			const stem = declaredName ? declaredName.replace(/\.[a-zA-Z0-9]+$/, '') : fileId;
			fileName = `${stem}.${extension}`;
		}

		const mimeType = (extension && MIME_BY_EXTENSION[extension]) || entry.mimeType || mimeForName(fileName);

		return { path: entry.path, fileName, mimeType, isImage: isImageMime(mimeType) };
	}
}

// Collect every attachment declared in a conversation's messages.
export function collectAttachments(conv: any): AttachmentMeta[] {
	const result: AttachmentMeta[] = [];
	for (const key in conv?.mapping || {}) {
		const message = conv.mapping[key]?.message;
		const attachments = message?.metadata?.attachments;
		if (!Array.isArray(attachments)) continue;
		for (const attachment of attachments) {
			if (attachment?.id) result.push(attachment);
		}
	}
	return result;
}
