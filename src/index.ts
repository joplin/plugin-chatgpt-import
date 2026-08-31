import joplin from 'api';
import { FileSystemItem, ImportContext, ModelType, SettingItemType } from 'api/types';
import { convertConversation, parseConversationsJson, escapeLinkText, ConversionOptions } from './chatgpt-converter';
import { AssetIndex, LibraryFile, collectAttachments } from './asset-index';

const fs = joplin.require('fs-extra');

// Simple path utilities to avoid requiring 'path' module
function joinPath(...parts: string[]): string {
	return parts.join('/').replace(/\/+/g, '/');
}

function basename(filePath: string): string {
	const parts = filePath.split('/');
	return parts[parts.length - 1] || '';
}

function dirname(filePath: string): string {
	const parts = filePath.split('/');
	parts.pop();
	return parts.join('/') || '/';
}

// Replace every occurrence of a literal string. The same file can be
// referenced several times in one conversation.
function replaceAll(text: string, search: string, replacement: string): string {
	return text.split(search).join(replacement);
}

// Recover the file id from an indexed blob path (file_<hex>.dat)
function fileIdOf(filePath: string): string {
	const match = /^(file_[0-9a-fA-F]+)\.dat$/.exec(basename(filePath));
	return match ? match[1] : '';
}

async function getAllFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = joinPath(dir, entry.name);
		if (entry.isDirectory()) {
			const subFiles = await getAllFiles(fullPath);
			files.push(...subFiles);
		} else {
			files.push(fullPath);
		}
	}
	return files;
}

// Read a JSON file from the archive, returning a fallback when it is absent.
// The newer export format ships several manifests that older exports lack.
async function readOptionalJson<T>(filePath: string, fallback: T): Promise<T> {
	try {
		if (!await fs.pathExists(filePath)) return fallback;
		return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
	} catch (error) {
		console.warn(`ChatGPT import: could not read ${basename(filePath)}:`, error);
		return fallback;
	}
}

// Read the first bytes of a file, for magic byte sniffing
function readHeaderSync(filePath: string): Uint8Array | null {
	try {
		const fd = fs.openSync(filePath, 'r');
		try {
			const buffer = Buffer.alloc(512);
			const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
			return new Uint8Array(buffer.slice(0, bytesRead));
		} finally {
			fs.closeSync(fd);
		}
	} catch (error) {
		return null;
	}
}

async function extractZipToTemp(zipPath: string): Promise<string> {
	const dataDir = await joplin.plugins.dataDir();
	const tempDir = joinPath(dataDir, `chatgpt-import-${Date.now()}`);
	await fs.ensureDir(tempDir);

	const entries: { entryName: string; name: string }[] = await (joplin as any).fs.archiveExtract(zipPath, tempDir);

	// Find the actual content directory (may be nested)
	// Check if all entries share a common root directory
	const topLevelDirs = new Set<string>();
	for (const entry of entries) {
		const firstPart = entry.entryName.split('/')[0];
		if (firstPart) {
			topLevelDirs.add(firstPart);
		}
	}

	if (topLevelDirs.size === 1) {
		const rootDir = Array.from(topLevelDirs)[0];
		const rootPath = joinPath(tempDir, rootDir);
		const stat = await fs.stat(rootPath);
		if (stat.isDirectory()) {
			return rootPath;
		}
	}

	return tempDir;
}

joplin.plugins.register({
	onStart: async function() {
		// Register settings section
		await joplin.settings.registerSection('chatgptImport', {
			label: 'ChatGPT Import',
			iconName: 'fas fa-comments',
		});

		// Register settings
		await joplin.settings.registerSettings({
			'userName': {
				value: 'User',
				type: SettingItemType.String,
				section: 'chatgptImport',
				public: true,
				label: 'User name',
				description: 'Display name for user messages in imported conversations',
			},
			'assistantName': {
				value: 'ChatGPT',
				type: SettingItemType.String,
				section: 'chatgptImport',
				public: true,
				label: 'Assistant name',
				description: 'Display name for assistant messages in imported conversations',
			},
			'titleFormat': {
				value: '{date} {title}',
				type: SettingItemType.String,
				section: 'chatgptImport',
				public: true,
				label: 'Note title format',
				description: 'Format for note titles. Placeholders: {title}, {date}, {date:FORMAT}, {time}. FORMAT can use YYYY, YY, MM, M, DD, D.',
			},
			'includeDate': {
				value: false,
				type: SettingItemType.Bool,
				section: 'chatgptImport',
				public: true,
				label: 'Show date in note body',
				description: 'Display the conversation date at the top of the note body',
			},
			'useCollapsibleThinking': {
				value: true,
				type: SettingItemType.Bool,
				section: 'chatgptImport',
				public: true,
				label: 'Use collapsible sections',
				description: 'Wrap tool outputs and context in collapsible <details> sections',
			},
			'includeThinking': {
				value: false,
				type: SettingItemType.Bool,
				section: 'chatgptImport',
				public: true,
				label: 'Include thinking/reasoning',
				description: 'Include internal thinking and reasoning messages from the assistant',
			},
			'quoteUserMessages': {
				value: true,
				type: SettingItemType.Bool,
				section: 'chatgptImport',
				public: true,
				label: 'Quote user messages',
				description: 'Display user messages in blockquotes to distinguish them from assistant messages',
			},
		});

		await joplin.interop.registerImportModule({
			format: 'chatgpt',
			description: 'ChatGPT Export (ZIP)',
			isNoteArchive: true,
			sources: [FileSystemItem.File],
			fileExtensions: ['zip'],

			onExec: async (context: ImportContext) => {
				const sourcePath = context.sourcePath;
				let sourceDir: string | null = null;
				let tempDir: string | null = null;

				try {
					// Extract ZIP file
					sourceDir = await extractZipToTemp(sourcePath);
					// tempDir is the parent if sourceDir is nested, otherwise sourceDir itself
					const parentDir = dirname(sourceDir);
					const dataDir = await joplin.plugins.dataDir();
					tempDir = parentDir.startsWith(dataDir) ? parentDir : sourceDir;

					// Read conversations JSON file(s)
					// ChatGPT exports may have either a single conversations.json
					// or multiple conversations-XXX.json files
					const dirFiles = await fs.readdir(sourceDir);
					const conversationFiles = dirFiles
						.filter((f: string) => f.startsWith('conversations') && f.endsWith('.json'))
						.sort();

					if (conversationFiles.length === 0) {
						throw new Error('No conversations JSON files found in archive');
					}

					let conversations: any[] = [];
					for (const file of conversationFiles) {
						const filePath = joinPath(sourceDir, file);
						const jsonContent = await fs.readFile(filePath, 'utf8');
						const parsed = parseConversationsJson(jsonContent);
						conversations = conversations.concat(parsed);
					}

					// Create a notebook for the import with unique name
					let notebookTitle = 'ChatGPT Import';

					// Get all existing folder titles (handle pagination)
					const existingTitles = new Set<string>();
					let page = 1;
					let hasMore = true;
					while (hasMore) {
						const result = await joplin.data.get(['folders'], { fields: ['title'], page });
						for (const folder of result.items) {
							existingTitles.add(folder.title);
						}
						hasMore = result.has_more;
						page++;
					}

					if (existingTitles.has(notebookTitle)) {
						let counter = 2;
						while (existingTitles.has(`${notebookTitle} (${counter})`)) {
							counter++;
						}
						notebookTitle = `${notebookTitle} (${counter})`;
					}

					const notebook = await joplin.data.post(['folders'], null, {
						title: notebookTitle,
					});

					// Read settings
					const options: ConversionOptions = {
						userName: await joplin.settings.value('userName'),
						assistantName: await joplin.settings.value('assistantName'),
						useFrontmatter: false,  // Joplin has its own metadata
						useCollapsibleThinking: await joplin.settings.value('useCollapsibleThinking'),
						includeDate: await joplin.settings.value('includeDate'),
						includeThinking: await joplin.settings.value('includeThinking'),
						titleFormat: await joplin.settings.value('titleFormat'),
						quoteUserMessages: await joplin.settings.value('quoteUserMessages'),
						};

					let importedCount = 0;
					let errorCount = 0;
					const totalCount = conversations.length;

					console.info(`ChatGPT import: Starting import of ${totalCount} conversations...`);
					console.info(`ChatGPT import: Scanning files in archive...`);
					const allFiles = await getAllFiles(sourceDir);
					console.info(`ChatGPT import: Found ${allFiles.length} files in archive`);

					// Build the asset index. Newer exports flatten attachments
					// into opaque file_<hex>.dat blobs, so the real names and
					// types have to be recovered from the manifests.
					const assetFileNames = await readOptionalJson<Record<string, string>>(
						joinPath(sourceDir, 'conversation_asset_file_names.json'), {});
					const libraryFiles = await readOptionalJson<LibraryFile[]>(
						joinPath(sourceDir, 'library_files.json'), []);

					const attachments = [];
					const knownThreads: Record<string, boolean> = {};
					for (const conv of conversations) {
						const convId = conv.id || conv.conversation_id;
						if (convId) knownThreads[convId] = true;
						for (const attachment of collectAttachments(conv)) attachments.push(attachment);
					}

					const assetIndex = new AssetIndex({
						allFiles,
						assetFileNames,
						libraryFiles,
						attachments,
						readHeader: readHeaderSync,
					});

					// File ids referenced by at least one conversation, used to
					// work out which blobs are left over at the end.
					const referencedFiles: Record<string, boolean> = {};
					// Resource ids by file id, so a file shared by several
					// conversations is only imported once.
					const resourceCache: Record<string, string> = {};

					const attachAsset = async (fileId: string): Promise<string | null> => {
						if (resourceCache[fileId]) return resourceCache[fileId];

						const asset = assetIndex.resolve(fileId);
						if (!asset) return null;

						// Joplin derives the resource mime type and extension
						// from the file path alone - createResourceFromPath
						// ignores file_extension and mime in the props, and
						// only honours title - so the blob has to reach it
						// under a name that ends with the right extension.
						// A hard link avoids duplicating the bytes; it only
						// fails across filesystems, which cannot happen here
						// as the link sits next to the file it points to.
						let uploadPath = asset.path;
						if (basename(asset.path) !== asset.fileName) {
							uploadPath = joinPath(dirname(asset.path), `res-${fileId}-${asset.fileName}`);
							try {
								await fs.link(asset.path, uploadPath);
							} catch (linkError) {
								await fs.copy(asset.path, uploadPath);
							}
						}

						const resource = await joplin.data.post(
							['resources'], null, { title: asset.fileName }, [{ path: uploadPath }]);
						resourceCache[fileId] = resource.id;
						return resource.id;
					};

					console.info(`ChatGPT import: Processing conversations...`);

					for (const conv of conversations) {
						try {
							const converted = convertConversation(conv, options);

							// Create the note
							const note = await joplin.data.post(['notes'], null, {
								title: converted.title,
								body: converted.body,
								parent_id: notebook.id,
								user_created_time: converted.createdTime,
								user_updated_time: converted.updatedTime,
							});

							// Process and attach assets
							let updatedBody = converted.body;
							const usedInConversation: Record<string, boolean> = {};

							for (const assetRef of converted.assets) {
								referencedFiles[assetRef.fileId] = true;
								usedInConversation[assetRef.fileId] = true;
								const placeholder = `asset://${assetRef.fileId}`;

								try {
									const resourceId = await attachAsset(assetRef.fileId);
									if (resourceId) {
										// Images referenced by an asset pointer are
										// emitted with an empty label, as the real
										// file name is only known here. Fill it in
										// so the note shows the original name.
										const asset = assetIndex.resolve(assetRef.fileId);
										if (asset) {
											updatedBody = replaceAll(updatedBody, `![](${placeholder})`,
												`![${escapeLinkText(asset.fileName)}](${placeholder})`);
										}
										updatedBody = replaceAll(updatedBody, placeholder, `:/${resourceId}`);
									} else {
										// The export references a file whose bytes
										// are missing. Leave something readable
										// rather than a broken link.
										updatedBody = replaceAll(updatedBody, `](${placeholder})`,
											`] (missing from export: ${assetRef.name || assetRef.fileId})`);
									}
								} catch (resourceError) {
									console.error(`Failed to attach resource ${assetRef.fileId}:`, resourceError);
								}
							}

							// Images generated in this conversation but stored
							// in the ChatGPT library are not referenced by any
							// message, so append them at the end of the note.
							const libraryAssets = converted.conversationId
								? assetIndex.libraryFilesForThread(
									converted.conversationId, (id) => !!usedInConversation[id])
								: [];

							if (libraryAssets.length) {
								const links: string[] = [];
								for (const asset of libraryAssets) {
									const fileId = fileIdOf(asset.path);
									if (!fileId) continue;
									referencedFiles[fileId] = true;
									try {
										const resourceId = await attachAsset(fileId);
										if (resourceId) {
											const prefix = asset.isImage ? '!' : '';
											links.push(`${prefix}[${asset.fileName}](:/${resourceId})`);
										}
									} catch (resourceError) {
										console.error(`Failed to attach library file ${fileId}:`, resourceError);
									}
								}
								if (links.length) {
									updatedBody += `\n\n# Files from the ChatGPT library\n\n${links.join('\n\n')}\n`;
								}
							}

							// Update note body with resolved asset links
							if (updatedBody !== converted.body) {
								await joplin.data.put(['notes', note.id], null, {
									body: updatedBody,
								});
							}

							// The archive is deleted after import, so record the
							// ids that would otherwise be lost. The project id in
							// particular cannot be recovered from anywhere else.
							try {
								if (converted.conversationId) {
									await joplin.data.userDataSet(
										ModelType.Note, note.id, 'chatgpt.conversationId', converted.conversationId);
								}
								if (converted.projectId) {
									await joplin.data.userDataSet(
										ModelType.Note, note.id, 'chatgpt.projectId', converted.projectId);
								}
							} catch (userDataError) {
								console.error('Failed to store note user data:', userDataError);
							}

							importedCount++;
							// Log every 10 conversations for visibility
							if (importedCount % 10 === 0) {
								const percent = Math.round((importedCount / totalCount) * 100);
								console.info(`ChatGPT import: ${percent}% (${importedCount}/${totalCount})`);
							}
						} catch (convError) {
							console.error(`Error converting conversation "${conv.title}":`, convError);
							errorCount++;
						}
					}

					// Anything left over belongs to the ChatGPT library or to a
					// project rather than to a conversation. There is no
					// conversation to attach it to, so collect it in one note
					// so that the import stays lossless.
					const leftovers = assetIndex.unreferenced(
						(fileId) => !!referencedFiles[fileId],
						(threadId) => !!knownThreads[threadId]);

					if (leftovers.length) {
						const links: string[] = [];
						for (const asset of leftovers) {
							const fileId = fileIdOf(asset.path);
							if (!fileId) continue;
							try {
								const resourceId = await attachAsset(fileId);
								if (resourceId) {
									const prefix = asset.isImage ? '!' : '';
									links.push(`${prefix}[${asset.fileName}](:/${resourceId})`);
								}
							} catch (resourceError) {
								console.error(`Failed to attach library file ${fileId}:`, resourceError);
							}
						}

						if (links.length) {
							await joplin.data.post(['notes'], null, {
								title: 'ChatGPT Library',
								body: `These files were in the export but are not linked to any conversation.\n\n${links.join('\n\n')}\n`,
								parent_id: notebook.id,
							});
							console.info(`ChatGPT import: ${links.length} unlinked files added to the ChatGPT Library note`);
						}
					}

					console.info(`ChatGPT import complete: ${importedCount} conversations imported, ${errorCount} errors`);

				} finally {
					// Clean up temp directory
					if (tempDir) {
						try {
							await fs.remove(tempDir);
						} catch (cleanupError) {
							console.error('Failed to clean up temp directory:', cleanupError);
						}
					}
				}
			},
		});

		console.info('ChatGPT Import plugin started');
	},
});
