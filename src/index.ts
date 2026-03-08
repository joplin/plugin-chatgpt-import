import joplin from 'api';
import { FileSystemItem, ImportContext, SettingItemType } from 'api/types';
import { convertConversation, parseConversationsJson, ConversionOptions } from './chatgpt-converter';

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

interface FileInfo {
	path: string;
	type: 'image' | 'audio' | 'video' | 'dalle';
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

// Find asset file from pre-scanned file list
function findAssetFile(fileId: string, allFiles: string[]): FileInfo | null {
	if (!fileId) return null;

	const searchStrategies: Array<{ test: (p: string) => boolean; type: FileInfo['type'] }> = [
		{ test: (p) => p.toLowerCase().includes('dalle-generations') && p.includes(fileId), type: 'dalle' },
		{ test: (p) => p.toLowerCase().includes('/audio/') && p.includes(fileId), type: 'audio' },
		{ test: (p) => p.toLowerCase().includes('user-') && p.includes(fileId), type: 'image' },
		{ test: (p) => p.includes(fileId), type: 'image' },
	];

	for (const strategy of searchStrategies) {
		for (const filePath of allFiles) {
			if (strategy.test(filePath)) {
				return { path: filePath, type: strategy.type };
			}
		}
	}

	return null;
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
							for (const assetRef of converted.assets) {
								const fileInfo = findAssetFile(assetRef.fileId, allFiles);
								if (fileInfo) {
									try {
										// Create resource from file
										const resource = await joplin.data.post(
											['resources'],
											null,
											{ title: basename(fileInfo.path) },
											[{ path: fileInfo.path }]
										);

										// Replace placeholder URL with Joplin resource URL
										// The markdown structure is already correct: ![Image](asset://fileId)
										// We just need to replace the asset:// URL with :/${resourceId}
										const placeholder = `asset://${assetRef.fileId}`;
										const resourceUrl = `:/${resource.id}`;
										updatedBody = updatedBody.replace(placeholder, resourceUrl);
									} catch (resourceError) {
										console.error(`Failed to attach resource ${assetRef.fileId}:`, resourceError);
									}
								}
							}

							// Update note body with resolved asset links
							if (updatedBody !== converted.body) {
								await joplin.data.put(['notes', note.id], null, {
									body: updatedBody,
								});
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
