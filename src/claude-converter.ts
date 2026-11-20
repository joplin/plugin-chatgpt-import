// Converter for Claude exports.
//
// A Claude export is split into several zips (conversations, frames...). Unlike ChatGPT exports it contains no file bytes at all:
// uploaded images and documents are only referenced by uuid, so they are
// rendered as plain text. Pasted text is the exception, as its full content
// is included inline in the message attachments.

import {
	ConversionOptions, ResolvedConfig, resolveConfig, renderMessage, collapsible, codeFence,
	escapeLinkText, escapeMarkdown, linkDestination, formatDateLong, formatNoteTitle, nestHeadings,
} from './markdown-utils';

interface Citation {
	details?: {
		type?: string;
		url?: string;
	};
}

interface ToolResultItem {
	type?: string;
	title?: string;
	url?: string;
	text?: string;
	name?: string;
	file_uuid?: string;
	file_path?: string;
	images?: { title?: string; url?: string; page_url?: string }[];
}

interface ContentBlock {
	type?: string;
	// text
	text?: string;
	citations?: Citation[];
	// thinking
	thinking?: string;
	summaries?: { summary?: string }[];
	// tool_use
	id?: string;
	name?: string;
	input?: unknown;
	// tool_result
	tool_use_id?: string;
	is_error?: boolean;
	content?: ToolResultItem[] | string;
	// image, document
	file_uuid?: string;
	title?: string;
}

// Text pasted into the message box. The export includes its full content.
interface MessageAttachment {
	file_name?: string;
	file_type?: string;
	extracted_content?: string;
}

// An uploaded file. Only the uuid and name are exported, not the bytes.
interface MessageFile {
	file_uuid?: string;
	file_name?: string;
}

interface ChatMessage {
	uuid?: string;
	parent_message_uuid?: string;
	sender?: string;
	text?: string;
	content?: ContentBlock[];
	attachments?: MessageAttachment[];
	files?: MessageFile[];
	created_at?: string;
}

export interface ClaudeConversation {
	uuid?: string;
	name?: string;
	created_at?: string;
	updated_at?: string;
	chat_messages?: ChatMessage[];
}

export interface ClaudeArtifact {
	id?: string;
	kind?: string;
	active_version?: string;
	updated_at?: string;
	versions?: { id?: string; title?: string; created_at?: string }[];
}

export interface ClaudeCommentThread {
	resolved?: boolean;
	tab?: string;
	comments?: { body?: string; created_at?: string }[];
}

export interface ConvertedNote {
	title: string;
	body: string;
	createdTime: number;
	updatedTime: number;
}

// A Claude doc, embedded in the conversations that created or edited it
export interface ClaudeDocument {
	id: string;
	title: string;
	body: string;
}

export interface ConvertedClaudeConversation extends ConvertedNote {
	conversationId: string;
	// Ids of the docs embedded in the note
	documentIds: string[];
	// True when nothing but missing file notices could be rendered. Some
	// exported conversations have every message empty.
	isEmpty: boolean;
}

// Parent of the first message of a conversation
const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';

const UNTITLED_MAX_LENGTH = 60;

interface ProcessingContext {
	config: ResolvedConfig;
	// Tool results by the id of the tool call they answer, so that each call
	// is rendered together with its result.
	toolResults: Record<string, ContentBlock>;
	// Ids of every tool call in the conversation
	toolCallIds: Record<string, boolean>;
	// Page titles seen in search results, used to label citations
	titlesByUrl: Record<string, string>;
	// Whether anything other than a missing file notice was rendered
	hasContent: boolean;
}

export function convertClaudeConversation(
	conv: ClaudeConversation, options: ConversionOptions = {}, documents: ClaudeDocument[] = []
): ConvertedClaudeConversation {
	const config = resolveConfig(options, 'Claude');
	const messages = currentBranch(conv.chat_messages || []);
	const placement = placeDocuments(messages, documents);

	const context: ProcessingContext = {
		config,
		toolResults: {},
		toolCallIds: {},
		titlesByUrl: {},
		hasContent: false,
	};

	for (const msg of messages) {
		for (const block of msg.content || []) {
			if (block.type === 'tool_use' && block.id) context.toolCallIds[block.id] = true;
			if (block.type !== 'tool_result') continue;
			if (block.tool_use_id) context.toolResults[block.tool_use_id] = block;
			if (Array.isArray(block.content)) {
				for (const item of block.content) {
					if (item.url && item.title) context.titlesByUrl[item.url] = item.title;
				}
			}
		}
	}

	const createdTime = parseTime(conv.created_at);

	let body = '';
	if (config.includeDate && createdTime) {
		body += `Date: ${formatDateLong(createdTime)}\n\n---\n\n`;
	}

	messages.forEach((msg, index) => {
		const isUser = msg.sender === 'human';
		let content = renderMessageContent(msg, context);
		const docs = placement.afterMessage[index] || [];
		if (docs.length) {
			content = [content, ...docs.map(renderDocument)].filter(s => s.trim()).join('\n\n');
			context.hasContent = true;
		}
		if (!content.trim()) return;
		const author = isUser ? config.userName : config.assistantName;
		body += renderMessage(author, content, isUser, config);
	});


	const title = conv.name?.trim() || titleFromFirstMessage(messages) || 'Untitled';

	return {
		title: formatNoteTitle(title, createdTime, config.titleFormat),
		body,
		createdTime: createdTime || Date.now(),
		updatedTime: parseTime(conv.updated_at) || createdTime || Date.now(),
		conversationId: conv.uuid || '',
		documentIds: placement.ids,
		isEmpty: !context.hasContent,
	};
}

interface DocumentPlacement {
	// Docs to render after the message at the given index
	afterMessage: Record<number, ClaudeDocument[]>;
	ids: string[];
}

// Tools that create, read or edit docs. A doc id can also turn up in other
// tool output, for example when searching past conversations, which says
// nothing about where the doc belongs.
function isDocumentTool(name: string): boolean {
	return /docs|artifact/i.test(name);
}

// A doc id only appears inside the tool calls that created or edited it. The
// export only holds the final version of the doc, so it is placed after the
// last assistant message that touched it. A doc that no docs tool touched in
// this conversation is not embedded.
function placeDocuments(messages: ChatMessage[], documents: ClaudeDocument[]): DocumentPlacement {
	const placement: DocumentPlacement = { afterMessage: {}, ids: [] };
	if (!documents.length) return placement;

	const callNames: Record<string, string> = {};
	for (const msg of messages) {
		for (const block of msg.content || []) {
			if (block.type === 'tool_use' && block.id && block.name) callNames[block.id] = block.name;
		}
	}

	const toolText = messages.map(msg => {
		if (msg.sender !== 'assistant') return '';
		const blocks = (msg.content || []).filter(block => {
			if (block.type === 'tool_use') return isDocumentTool(block.name || '');
			if (block.type === 'tool_result') return isDocumentTool(block.name || callNames[block.tool_use_id || ''] || '');
			return false;
		});
		return blocks.length ? JSON.stringify(blocks) : '';
	});

	for (const doc of documents) {
		if (!doc.id) continue;
		let lastIndex = -1;
		toolText.forEach((text, index) => {
			if (text.includes(doc.id)) lastIndex = index;
		});
		if (lastIndex < 0) continue;

		(placement.afterMessage[lastIndex] = placement.afterMessage[lastIndex] || []).push(doc);
		placement.ids.push(doc.id);
	}

	return placement;
}

// The doc's own headings are nested below the "Document" heading, so that
// they do not read as new messages.
function renderDocument(doc: ClaudeDocument): string {
	return `## Document: ${doc.title}\n\n${nestHeadings(doc.body.replace(/\n+$/, ''), 3)}`;
}

// Messages form a tree: editing a message starts a new branch, and the
// export keeps the abandoned one too. Follow the parent links back from the
// latest message so that only what the user last saw is imported. If the
// links do not form a usable chain, fall back to every message in order.
export function currentBranch(messages: ChatMessage[]): ChatMessage[] {
	if (messages.length < 2) return messages;

	const byId: Record<string, ChatMessage> = {};
	for (const msg of messages) {
		if (!msg.uuid) return messages;
		byId[msg.uuid] = msg;
	}

	// Without any message pointing at another, there is no tree to follow
	if (!messages.some(msg => msg.parent_message_uuid && byId[msg.parent_message_uuid])) return messages;

	const sorted = messages.slice().sort((a, b) => parseTime(a.created_at) - parseTime(b.created_at));
	const chain: ChatMessage[] = [];
	const seen: Record<string, boolean> = {};
	let current: ChatMessage | undefined = sorted[sorted.length - 1];
	while (current && !seen[current.uuid!]) {
		seen[current.uuid!] = true;
		chain.push(current);
		const parentId = current.parent_message_uuid;
		if (!parentId || parentId === ROOT_PARENT) return chain.reverse();
		current = byId[parentId];
	}

	// A link points at a message that is not in the export
	return messages;
}

function renderMessageContent(msg: ChatMessage, context: ProcessingContext): string {
	const parts: string[] = [];
	const citedUrls: string[] = [];
	const shownFiles: Record<string, boolean> = {};

	const fileNames: Record<string, string> = {};
	for (const file of msg.files || []) {
		if (file.file_uuid && file.file_name) fileNames[file.file_uuid] = file.file_name;
	}

	// Older exports only have the flat text field
	const blocks: ContentBlock[] = msg.content?.length ? msg.content : [{ type: 'text', text: msg.text || '' }];

	const pushContent = (text: string) => {
		parts.push(text);
		context.hasContent = true;
	};

	for (const block of blocks) {
		switch (block.type) {
		case 'text':
			if (block.text?.trim()) pushContent(block.text.trim());
			for (const citation of block.citations || []) {
				const url = citation.details?.url;
				if (url && citedUrls.indexOf(url) < 0) citedUrls.push(url);
			}
			break;

		case 'thinking': {
			if (!context.config.includeThinking) break;
			const thinking = renderThinking(block);
			if (thinking) pushContent(collapsible('Thinking', thinking, context.config));
			break;
		}

		case 'tool_use': {
			// Claude exports carry no media in tool output, so unlike
			// ChatGPT there is nothing to keep when the output is left out.
			if (context.config.toolCalls === 'hide') break;
			const result = block.id && context.config.toolCalls === 'full' ? context.toolResults[block.id] : undefined;
			pushContent(renderToolCall(block, result, context.config));
			break;
		}

		case 'tool_result':
			// Normally rendered along with its call. Only an orphaned result
			// is rendered on its own.
			if (context.config.toolCalls !== 'full') break;
			if (block.tool_use_id && context.toolCallIds[block.tool_use_id]) break;
			pushContent(renderToolCall({ name: block.name }, block, context.config));
			break;

		case 'image':
		case 'document': {
			const isImage = block.type === 'image';
			if (block.file_uuid) shownFiles[block.file_uuid] = true;
			const name = (block.file_uuid && fileNames[block.file_uuid]) || block.title || (isImage ? 'Image' : 'Document');
			parts.push(missingFile(name));
			break;
		}

		case 'injected_prompt_block':
			// Hidden context added by the app: system reminders, tool
			// listings, the current date. Never shown in the conversation.
			break;

		default:
			if (block.text?.trim()) pushContent(block.text.trim());
		}
	}

	// Pasted text has its full content in the export. An uploaded file of
	// the same name is the same thing, so it is not also listed as missing.
	const pastedNames: Record<string, boolean> = {};
	for (const attachment of msg.attachments || []) {
		const name = attachment.file_name || 'Pasted text';
		const content = attachment.extracted_content || '';
		if (!content.trim()) {
			parts.push(missingFile(name));
			continue;
		}
		if (attachment.file_name) pastedNames[attachment.file_name] = true;
		pushContent(collapsible(name, codeFence(content), context.config));
	}

	for (const file of msg.files || []) {
		if (file.file_uuid && shownFiles[file.file_uuid]) continue;
		if (file.file_name && pastedNames[file.file_name]) continue;
		parts.push(missingFile(file.file_name || 'Attachment'));
	}

	if (citedUrls.length) {
		const links = citedUrls.map(url => `- ${renderLink(context.titlesByUrl[url] || hostname(url), url)}`);
		parts.push(collapsible('Sources', links.join('\n'), context.config));
	}

	return parts.join('\n\n');
}

function renderThinking(block: ContentBlock): string {
	// The thinking text itself is usually withheld from the export, leaving
	// only the short summaries shown while Claude was working.
	if (block.thinking?.trim()) return block.thinking.trim();
	const summaries = (block.summaries || []).map(s => s.summary || '').filter(s => s.trim());
	return summaries.map(s => `- ${s}`).join('\n');
}

function renderToolCall(call: ContentBlock, result: ContentBlock | undefined, config: ResolvedConfig): string {
	const sections: string[] = [];

	if (call.input !== undefined && call.input !== null) {
		const isEmpty = typeof call.input === 'object' && !Object.keys(call.input as object).length;
		if (!isEmpty) sections.push(codeFence(JSON.stringify(call.input, null, '\t'), 'json'));
	}

	if (result) {
		const output = renderToolResult(result);
		if (output) sections.push(output);
	}

	const name = call.name || result?.name || 'tool';
	const summary = `Tool: ${name}${result?.is_error ? ' (error)' : ''}`;
	return collapsible(summary, sections.join('\n\n'), config);
}

function renderToolResult(result: ContentBlock): string {
	if (typeof result.content === 'string') {
		return result.content.trim() ? codeFence(result.content) : '';
	}

	const sections: string[] = [];
	let links: string[] = [];

	const flushLinks = () => {
		if (links.length) sections.push(links.join('\n'));
		links = [];
	};

	for (const item of result.content || []) {
		switch (item.type) {
		case 'knowledge':
			if (item.url) {
				links.push(`- ${renderLink(item.title || hostname(item.url), item.url)}`);
			} else if (item.title) {
				links.push(`- ${escapeMarkdown(item.title)}`);
			}
			break;

		case 'image_gallery':
			for (const image of item.images || []) {
				const url = image.page_url || image.url;
				if (url) links.push(`- ${renderLink(image.title || hostname(url), url)}`);
			}
			break;

		case 'image':
			flushLinks();
			sections.push(missingFile(item.name || 'Image'));
			break;

		case 'local_resource':
			flushLinks();
			sections.push(missingFile(item.name || basename(item.file_path || '') || 'File'));
			break;

		default:
			if (item.text?.trim()) {
				flushLinks();
				sections.push(codeFence(item.text));
			}
		}
	}

	flushLinks();
	return sections.join('\n\n');
}

function renderLink(label: string, url: string): string {
	// Labels come from page titles, which can span several lines
	const text = label.replace(/\s+/g, ' ').trim() || hostname(url);
	return `[${escapeLinkText(text)}](${linkDestination(url)})`;
}

function missingFile(name: string): string {
	return `*Attachment not included in the export: ${escapeMarkdown(name)}*`;
}

function titleFromFirstMessage(messages: ChatMessage[]): string {
	for (const msg of messages) {
		if (msg.sender !== 'human') continue;
		const blocks = msg.content?.length ? msg.content : [{ type: 'text', text: msg.text || '' }];
		for (const block of blocks) {
			if (block.type !== 'text' || !block.text) continue;
			const line = block.text.split('\n').map(l => l.replace(/^[#>\s*-]+/, '').trim()).find(l => l);
			if (line) return truncate(line, UNTITLED_MAX_LENGTH);
		}
	}
	return '';
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	const cut = text.slice(0, maxLength);
	const lastSpace = cut.lastIndexOf(' ');
	return `${(lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

// Convert a Claude doc (a "page" artifact) to a note
export function convertClaudePage(artifact: ClaudeArtifact, pageMarkdown: string, comments: ClaudeCommentThread[] = []): ConvertedNote {
	const versions = artifact.versions || [];
	const activeVersion = versions.find(v => v.id === artifact.active_version) || versions[0];
	const title = activeVersion?.title?.trim() || 'Untitled document';

	// The page starts with its name as a heading, which can be out of date
	// and is shown as the note title anyway. A single-tab doc then repeats
	// its title as the heading of the tab.
	const lines = pageMarkdown.replace(/^\uFEFF/, '').split('\n');
	const firstContent = () => lines.findIndex(line => line.trim() && !/^<!--.*-->$/.test(line.trim()));
	let index = firstContent();
	if (index >= 0 && /^# /.test(lines[index])) lines.splice(index, 1);
	index = firstContent();
	if (index >= 0 && lines[index].trim() === `# ${title}`) lines.splice(index, 1);
	let body = lines.join('\n').replace(/^\n+/, '');

	const commentText = renderComments(comments);
	if (commentText) body = `${body.replace(/\n+$/, '')}\n\n${commentText}`;

	const versionTimes = versions.map(v => parseTime(v.created_at)).filter(t => t);
	const createdTime = versionTimes.length ? Math.min(...versionTimes) : Date.now();
	const updatedTime = Math.max(createdTime, parseTime(artifact.updated_at), ...versionTimes);

	return { title, body: `${body.replace(/\n+$/, '')}\n`, createdTime, updatedTime };
}

function renderComments(threads: ClaudeCommentThread[]): string {
	const rendered: string[] = [];
	for (const thread of threads) {
		const comments = (thread.comments || []).filter(c => c.body?.trim());
		if (!comments.length) continue;
		const heading = [thread.tab ? `On "${thread.tab}"` : 'Comment', thread.resolved ? '(resolved)' : ''].filter(s => s).join(' ');
		const lines = comments.map(c => {
			const quoted = c.body!.trim().split('\n').map(l => `> ${l}`).join('\n');
			const time = parseTime(c.created_at);
			return time ? `${quoted}\n>\n> *${formatDateLong(time)}*` : quoted;
		});
		rendered.push(`**${escapeMarkdown(heading)}**\n\n${lines.join('\n\n')}`);
	}
	return rendered.length ? `## Comments\n\n${rendered.join('\n\n')}` : '';
}

function parseTime(value: string | undefined): number {
	if (!value) return 0;
	const time = Date.parse(value);
	return isNaN(time) ? 0 : time;
}

function hostname(url: string): string {
	const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
	return match ? match[1] : url;
}

function basename(filePath: string): string {
	const parts = filePath.split('/');
	return parts[parts.length - 1] || '';
}
