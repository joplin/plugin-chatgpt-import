import joplin from 'api';
import { ImportContext } from 'api/types';
import {
	ClaudeConversation, ClaudeArtifact, ClaudeCommentThread, ClaudeDocument, ConvertedNote,
	convertClaudeConversation, convertClaudePage,
} from './claude-converter';
import {
	fs, joinPath, basename, dirname, getAllFiles, readOptionalJson, createTempDir, extractZip,
	createUniqueNotebook, readConversionOptions, setNoteUserData,
} from './import-utils';

// Claude splits its export into one zip per category and part, for example
// conversations-000.zip, conversations-001.zip, projects-000.zip.
const ARCHIVE_NAME_REGEX = /^[a-z_]+-\d+\.zip$/;

interface ExportSources {
	// Zips to extract
	archives: string[];
	// Directories that already hold extracted export content
	extractedRoots: string[];
}

// The user downloads every zip listed in the export manifest into one folder
async function locateSources(sourceDir: string): Promise<ExportSources> {
	const names: string[] = await fs.readdir(sourceDir);
	const sources = {
		archives: names.filter(name => ARCHIVE_NAME_REGEX.test(name)).sort().map(name => joinPath(sourceDir, name)),
		// The zips may have been extracted already
		extractedRoots: names.indexOf('conversations.json') >= 0 ? [sourceDir] : [],
	};

	if (!sources.archives.length && !sources.extractedRoots.length) {
		throw new Error(`No Claude export files were found in "${sourceDir}". Select the folder where the zip files of the export (conversations-000.zip, frames-000.zip...) were downloaded.`);
	}

	return sources;
}

function isConversationsFile(filePath: string): boolean {
	return /^conversations(-\d+)?\.json$/.test(basename(filePath));
}

function isArtifactFile(filePath: string): boolean {
	return basename(filePath) === 'artifact.json' && basename(dirname(dirname(filePath))) === 'artifacts';
}

export async function importClaudeExport(context: ImportContext): Promise<void> {
	const tempDir = await createTempDir('claude-import');

	try {
		const sources = await locateSources(context.sourcePath);
		const roots = sources.extractedRoots.slice();

		// Every part has the same file names inside, so each zip gets its own
		// directory rather than being extracted on top of the others.
		for (const archive of sources.archives) {
			const destination = joinPath(tempDir, basename(archive).replace(/\.zip$/, ''));
			await extractZip(archive, destination);
			roots.push(destination);
		}

		const allFiles: string[] = [];
		for (const root of roots) allFiles.push(...await getAllFiles(root));

		const conversations: ClaudeConversation[] = [];
		const seenConversations: Record<string, boolean> = {};
		for (const file of allFiles.filter(isConversationsFile).sort()) {
			const parsed: ClaudeConversation[] = JSON.parse(await fs.readFile(file, 'utf8'));
			for (const conv of parsed) {
				if (conv.uuid && seenConversations[conv.uuid]) continue;
				if (conv.uuid) seenConversations[conv.uuid] = true;
				conversations.push(conv);
			}
		}

		if (!conversations.length) {
			throw new Error('No conversations were found in the Claude export');
		}

		const notebook = await createUniqueNotebook('Claude Import');
		const options = await readConversionOptions('claudeAssistantName');

		// Docs ("page" artifacts) are embedded in the conversations that
		// created them. Other artifact kinds are interactive apps that cannot
		// be represented in a note.
		const documents: { doc: ClaudeDocument; note: ConvertedNote }[] = [];
		let skippedArtifacts = 0;
		for (const file of allFiles.filter(isArtifactFile)) {
			const artifact = await readOptionalJson<ClaudeArtifact | null>(file, null);
			if (!artifact?.id) continue;
			const pagePath = joinPath(dirname(file), 'page.md');
			if (artifact.kind !== 'page' || !await fs.pathExists(pagePath)) {
				skippedArtifacts++;
				continue;
			}
			try {
				const markdown = await fs.readFile(pagePath, 'utf8');
				const comments = await readOptionalJson<ClaudeCommentThread[]>(joinPath(dirname(file), 'comments.json'), []);
				const note = convertClaudePage(artifact, markdown, Array.isArray(comments) ? comments : []);
				documents.push({ doc: { id: artifact.id, title: note.title, body: note.body }, note });
			} catch (pageError) {
				console.error(`Failed to read doc ${artifact.id}:`, pageError);
			}
		}

		let importedCount = 0;
		let emptyCount = 0;
		let errorCount = 0;
		const totalCount = conversations.length;
		const embeddedDocuments: Record<string, boolean> = {};

		console.info(`Claude import: Starting import of ${totalCount} conversations...`);

		for (const conv of conversations) {
			try {
				const converted = convertClaudeConversation(conv, options, documents.map(d => d.doc));

				// Some conversations are exported with every message empty.
				// There is nothing to keep in them.
				if (converted.isEmpty) {
					emptyCount++;
					continue;
				}

				const note = await joplin.data.post(['notes'], null, {
					title: converted.title,
					body: converted.body,
					parent_id: notebook.id,
					user_created_time: converted.createdTime,
					user_updated_time: converted.updatedTime,
				});

				await setNoteUserData(note.id, { 'claude.conversationId': converted.conversationId });
				for (const id of converted.documentIds) embeddedDocuments[id] = true;

				importedCount++;
				if (importedCount % 10 === 0) {
					const percent = Math.round(((importedCount + emptyCount) / totalCount) * 100);
					console.info(`Claude import: ${percent}% (${importedCount + emptyCount}/${totalCount})`);
				}
			} catch (convError) {
				console.error(`Error converting conversation "${conv.name}":`, convError);
				errorCount++;
			}
		}

		// A doc that no conversation refers to still has to be kept
		let standaloneCount = 0;
		for (const { doc, note } of documents) {
			if (embeddedDocuments[doc.id]) continue;
			try {
				const created = await joplin.data.post(['notes'], null, {
					title: note.title,
					body: note.body,
					parent_id: notebook.id,
					user_created_time: note.createdTime,
					user_updated_time: note.updatedTime,
				});
				await setNoteUserData(created.id, { 'claude.artifactId': doc.id });
				standaloneCount++;
			} catch (pageError) {
				console.error(`Failed to import doc ${doc.id}:`, pageError);
			}
		}

		console.info(`Claude import complete: ${importedCount} conversations imported, ${emptyCount} empty conversations skipped, ${errorCount} errors, ${Object.keys(embeddedDocuments).length} docs embedded, ${standaloneCount} standalone docs, ${skippedArtifacts} unsupported artifacts skipped`);

	} finally {
		try {
			await fs.remove(tempDir);
		} catch (cleanupError) {
			console.error('Failed to clean up temp directory:', cleanupError);
		}
	}
}
