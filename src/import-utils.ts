// Helpers shared by the importers

import joplin from 'api';
import { ModelType } from 'api/types';
import { ConversionOptions } from './markdown-utils';

export const fs = joplin.require('fs-extra');

// Simple path utilities to avoid requiring 'path' module
export function joinPath(...parts: string[]): string {
	return parts.join('/').replace(/\/+/g, '/');
}

export function basename(filePath: string): string {
	const parts = filePath.split('/');
	return parts[parts.length - 1] || '';
}

export function dirname(filePath: string): string {
	const parts = filePath.split('/');
	parts.pop();
	return parts.join('/') || '/';
}

export async function getAllFiles(dir: string): Promise<string[]> {
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

// Read a JSON file, returning a fallback when it is absent or invalid
export async function readOptionalJson<T>(filePath: string, fallback: T): Promise<T> {
	try {
		if (!await fs.pathExists(filePath)) return fallback;
		return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
	} catch (error) {
		console.warn(`Import: could not read ${basename(filePath)}:`, error);
		return fallback;
	}
}

// Create an empty working directory in the plugin data dir
export async function createTempDir(prefix: string): Promise<string> {
	const dataDir = await joplin.plugins.dataDir();
	const tempDir = joinPath(dataDir, `${prefix}-${Date.now()}`);
	await fs.ensureDir(tempDir);
	return tempDir;
}

export async function extractZip(zipPath: string, destinationDir: string): Promise<{ entryName: string; name: string }[]> {
	await fs.ensureDir(destinationDir);
	return (joplin as any).fs.archiveExtract(zipPath, destinationDir);
}

// Create a top level notebook, adding a counter to the title when a notebook
// of that name already exists, so that importing twice never merges imports.
export async function createUniqueNotebook(baseTitle: string): Promise<{ id: string; title: string }> {
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

	let title = baseTitle;
	if (existingTitles.has(title)) {
		let counter = 2;
		while (existingTitles.has(`${baseTitle} (${counter})`)) {
			counter++;
		}
		title = `${baseTitle} (${counter})`;
	}

	return joplin.data.post(['folders'], null, { title });
}

export async function readConversionOptions(assistantNameSetting: string): Promise<ConversionOptions> {
	return {
		userName: await joplin.settings.value('userName'),
		assistantName: await joplin.settings.value(assistantNameSetting),
		useFrontmatter: false,  // Joplin has its own metadata
		useCollapsibleThinking: await joplin.settings.value('useCollapsibleThinking'),
		includeDate: await joplin.settings.value('includeDate'),
		includeThinking: await joplin.settings.value('includeThinking'),
		titleFormat: await joplin.settings.value('titleFormat'),
		quoteUserMessages: await joplin.settings.value('quoteUserMessages'),
		toolCalls: await joplin.settings.value('toolCalls'),
	};
}

// Store ids on a note as user data, which is synced but not shown. The export
// is usually deleted after importing, so this is the only place they survive.
export async function setNoteUserData(noteId: string, values: Record<string, string>): Promise<void> {
	for (const key in values) {
		if (!values[key]) continue;
		try {
			await joplin.data.userDataSet(ModelType.Note, noteId, key, values[key]);
		} catch (error) {
			console.error(`Failed to store note user data ${key}:`, error);
		}
	}
}
