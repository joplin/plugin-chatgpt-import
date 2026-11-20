import {
	ConversionOptions, ResolvedConfig, resolveConfig, renderMessage, escapeLinkText,
	formatDateLong, formatNoteTitle,
} from './markdown-utils';

export type { ConversionOptions };
export { escapeLinkText };

interface Thought {
	summary?: string;
	content?: string;
}

interface MessageContent {
	content_type?: string;
	parts?: (string | ContentPart)[];
	text?: string;
	result?: string;
	thoughts?: Thought[];
	user_profile?: string;
	user_instructions?: string;
	content?: string;
}

interface ContentPart {
	content_type?: string;
	asset_pointer?: string;
	audio_asset_pointer?: AssetPointer;
	video_asset_pointer?: AssetPointer;
	metadata?: AssetMetadata;
	text?: string;
}

interface AssetPointer {
	asset_pointer?: string;
	metadata?: AssetMetadata;
}

interface AssetMetadata {
	start?: number;
	end?: number;
}

interface MessageAuthor {
	role?: string;
	name?: string;
}

interface Message {
	author?: MessageAuthor;
	content?: MessageContent;
	recipient?: string;
	create_time?: number;
	channel?: string;
	metadata?: {
		is_visually_hidden_from_conversation?: boolean;
		attachments?: MessageAttachment[];
	};
}

// An attachment declared in message metadata. Non-image uploads (PDF, docx,
// text files) appear only here - they have no asset pointer in the message
// content - so they must be picked up separately.
interface MessageAttachment {
	id?: string;
	name?: string;
	mime_type?: string;
}

interface MappingItem {
	message?: Message;
}

interface Conversation {
	id?: string;
	conversation_id?: string;
	// Despite its name this is the project ("gizmo") the conversation belongs
	// to, when it was created inside a ChatGPT project.
	conversation_template_id?: string;
	title?: string;
	create_time?: number;
	update_time?: number;
	mapping?: Record<string, MappingItem>;
}

export interface ConvertedConversation {
	title: string;
	body: string;
	createdTime: number;
	updatedTime: number;
	assets: AssetReference[];
	// Source conversation id, kept so assets can be linked back to it and so
	// the note can record where it came from.
	conversationId: string;
	// Project id, or empty when the conversation is not in a project.
	projectId: string;
}

export interface AssetReference {
	fileId: string;
	type: 'image' | 'audio' | 'video' | 'dalle' | 'file';
	// Name as shown in ChatGPT, when known
	name?: string;
}

interface ProcessingContext {
	config: ResolvedConfig;
	assets: AssetReference[];
	// File ids already emitted for the message being processed
	emitted: Record<string, boolean>;
}

// Convert a single ChatGPT conversation to Joplin-compatible format
export function convertConversation(
	conv: Conversation,
	options: ConversionOptions = {}
): ConvertedConversation {
	const config = resolveConfig(options, 'ChatGPT');

	const context: ProcessingContext = {
		config,
		assets: [],
		emitted: {},
	};

	const body = generateMarkdown(conv, context);
	const noteTitle = formatNoteTitle(
		conv.title || 'Untitled', conv.create_time ? conv.create_time * 1000 : null, config.titleFormat);

	return {
		title: noteTitle,
		body,
		createdTime: conv.create_time ? conv.create_time * 1000 : Date.now(),
		updatedTime: conv.update_time ? conv.update_time * 1000 : Date.now(),
		assets: context.assets,
		conversationId: conv.id || conv.conversation_id || '',
		projectId: conv.conversation_template_id || '',
	};
}

// Parse conversations.json content
export function parseConversationsJson(jsonContent: string): Conversation[] {
	return JSON.parse(jsonContent);
}

function generateMarkdown(conv: Conversation, context: ProcessingContext): string {
	let md = '';

	if (context.config.includeDate && conv.create_time) {
		md += `Date: ${formatDateLong(conv.create_time * 1000)}\n\n---\n\n`;
	}

	// Extract and sort messages
	const messages: Message[] = [];
	for (const key in conv.mapping || {}) {
		const item = conv.mapping![key];
		if (item.message && !item.message.metadata?.is_visually_hidden_from_conversation) {
			// Skip commentary channel messages (internal tool calls like image generation prompts)
			if (item.message.channel === 'commentary') continue;
			// Skip messages without timestamps (orphaned/initialization messages)
			if (!item.message.create_time) continue;
			messages.push(item.message);
		}
	}
	messages.sort((a, b) => (a.create_time || 0) - (b.create_time || 0));

	// Process each message
	for (const msg of messages) {
		if (msg.author?.role === 'system') continue;
		if (context.config.toolCalls === 'hide' && isToolCall(msg)) continue;
		const role = msg.author?.role;
		const author = getAuthorName(msg, context.config);
		context.emitted = {};
		let content = getMessageContent(msg, context);
		const attachmentLinks = processAttachments(msg, context);
		if (attachmentLinks) {
			content = content.trim() ? `${content}\n\n${attachmentLinks}` : attachmentLinks;
		}
		if (content.trim()) {
			md += renderMessage(author, content, role === 'user', context.config);
		}
	}

	return md;
}

// A message from the assistant addressed to a tool rather than to the user,
// for example a web search or a code interpreter call.
function isToolCall(msg: Message): boolean {
	return msg.author?.role === 'assistant' && !!msg.recipient && msg.recipient !== 'all';
}

function getAuthorName(msg: Message, config: ResolvedConfig): string {
	const role = msg.author?.role;
	const content = msg.content || {};
	const recipient = msg.recipient || '';
	const contentType = content.content_type || '';

	if (role === 'user') return config.userName;
	if (role === 'tool') {
		// Without the output, only media from the tool remains, such as a
		// generated image, which reads as coming from the assistant.
		return config.toolCalls === 'full' ? `Tool (${msg.author?.name || 'tool'})` : config.assistantName;
	}
	if (contentType === 'user_editable_context') return 'System (context)';

	const baseName = config.assistantName;

	if (contentType === 'code') {
		if (recipient === 'web') return `${baseName} (tool call)`;
		if (recipient === 'web.run') return `${baseName} (tool execution)`;
	}

	if (content.thoughts) return `${baseName} (thinking)`;
	if (contentType === 'reasoning_recap') return `${baseName} (reasoning summary)`;

	return baseName;
}

function getMessageContent(msg: Message, context: ProcessingContext): string {
	const content = msg.content || {};
	const contentType = content.content_type || '';
	const role = msg.author?.role;

	// Handle tool messages
	if (role === 'tool') {
		// Generated images arrive as tool output, so media is kept even when
		// the output itself is not.
		if (context.config.toolCalls !== 'full') {
			return content.parts ? processParts(content.parts, context, true) : '';
		}

		const toolName = msg.author?.name || 'tool';
		let processedContent = '';
		if (content.parts) {
			processedContent = processParts(content.parts, context);
		}
		const toolText = content.text || content.result || '';
		const fullContent = [processedContent, toolText].filter(s => s.trim()).join('\n\n');

		if (context.config.useCollapsibleThinking && fullContent) {
			return `<details><summary>Tool: ${toolName}</summary>\n\n${fullContent}\n\n</details>`;
		}
		return fullContent;
	}

	// Handle multimodal parts
	if (content.parts) {
		return processParts(content.parts, context);
	}

	// Handle user context messages
	if (contentType === 'user_editable_context') {
		const profile = content.user_profile || '';
		const instructions = content.user_instructions || '';
		let text = '*User Context*:\n';
		if (profile) text += `${profile}\n`;
		if (instructions) text += `${instructions}\n`;
		if (context.config.useCollapsibleThinking) {
			return `<details><summary>User Context</summary>\n\n${text.trim()}\n\n</details>`;
		}
		return text.trim();
	}

	// Handle reasoning recap
	if (contentType === 'reasoning_recap') {
		if (!context.config.includeThinking) return '';
		const recap = content.content || 'Reasoning completed';
		if (context.config.useCollapsibleThinking) {
			return `<details><summary>Reasoning Summary</summary>\n\n${recap}\n\n</details>`;
		}
		return recap;
	}

	// Handle internal thinking/thoughts
	if (content.thoughts) {
		if (!context.config.includeThinking) return '';
		let text = '';
		for (const t of content.thoughts) {
			if (t.summary && t.content) text += `**${t.summary}**: ${t.content}\n\n`;
		}
		if (context.config.useCollapsibleThinking && text) {
			return `<details><summary>Internal Reasoning</summary>\n\n${text}</details>`;
		}
		return text;
	}

	// Handle code content
	if (contentType === 'code') {
		return '```\n' + (content.text || '') + '\n```';
	}

	// Handle regular text
	if (content.text) return content.text;
	if (content.result) return content.result;

	return '';
}

// Emit links for files attached to a message. Images referenced by an asset
// pointer in the message content are already handled by processParts, so only
// the remaining attachments are emitted here - in practice PDFs, Office
// documents and text uploads, which have no asset pointer at all.
function processAttachments(msg: Message, context: ProcessingContext): string {
	const attachments = msg.metadata?.attachments;
	if (!attachments?.length) return '';

	const links: string[] = [];
	for (const attachment of attachments) {
		const fileId = attachment.id;
		if (!fileId || context.emitted[fileId]) continue;
		context.emitted[fileId] = true;

		const name = attachment.name || 'Attachment';
		const isImage = (attachment.mime_type || '').startsWith('image/');
		context.assets.push({ fileId, type: isImage ? 'image' : 'file', name });
		const prefix = isImage ? '!' : '';
		links.push(`${prefix}[${escapeLinkText(name)}](asset://${fileId})`);
	}

	return links.join('\n');
}

// When mediaOnly is set, text is skipped and only images, audio and video are
// rendered.
function processParts(parts: (string | ContentPart)[], context: ProcessingContext, mediaOnly = false): string {
	if (!parts?.length) return '';
	const contentParts: string[] = [];

	for (const part of parts) {
		if (typeof part === 'string') {
			if (mediaOnly) continue;
			contentParts.push(cleanChatGptMarkup(processUrlsInText(part)));
		} else if (typeof part === 'object') {
			const type = part.content_type;

			if (type === 'text' && part.text) {
				// Explicit text content type
				if (mediaOnly) continue;
				contentParts.push(cleanChatGptMarkup(processUrlsInText(part.text)));
			} else if (type === 'image_asset_pointer') {
				const fileId = extractFileId(part.asset_pointer || '');
				if (fileId) {
					context.emitted[fileId] = true;
					context.assets.push({ fileId, type: 'image' });
					// Placeholder - will be replaced when asset is attached
					// The real file name is only known once the archive has
					// been indexed, so the label is filled in at import time.
					contentParts.push(`![](asset://${fileId})`);
				}
			} else if (type === 'audio_asset_pointer' || type === 'real_time_user_audio_video_asset_pointer') {
				// Process audio
				let audioPointer: string | null = null;
				let audioDuration: number | null = null;

				if (type === 'audio_asset_pointer') {
					audioPointer = part.asset_pointer || '';
					const meta = part.metadata || {};
					audioDuration = (meta.end || 0) - (meta.start || 0);
				} else {
					const audioPtr = part.audio_asset_pointer || {};
					audioPointer = audioPtr.asset_pointer || '';
					const meta = audioPtr.metadata || {};
					audioDuration = (meta.end || 0) - (meta.start || 0);
				}

				if (audioPointer) {
					const fileId = extractFileId(audioPointer);
					if (fileId) {
						context.emitted[fileId] = true;
						context.assets.push({ fileId, type: 'audio' });
						const durText = audioDuration ? ` (${audioDuration.toFixed(1)}s)` : '';
						contentParts.push(`[Audio${durText}](asset://${fileId})`);
					}
				}

				// Process video
				if (type === 'real_time_user_audio_video_asset_pointer') {
					const videoPtr = part.video_asset_pointer || {};
					const videoPointer = videoPtr.asset_pointer || '';
					if (videoPointer) {
						const fileId = extractFileId(videoPointer);
						if (fileId) {
							context.emitted[fileId] = true;
							context.assets.push({ fileId, type: 'video' });
							contentParts.push(`[Video](asset://${fileId})`);
						}
					}
				}
			} else if (part.text && !mediaOnly) {
				contentParts.push(cleanChatGptMarkup(processUrlsInText(part.text)));
			}
		}
	}
	return contentParts.join('\n');
}

function processUrlsInText(text: string): string {
	const urlRegex = /(https?:\/\/[^\s]+)/g;
	return text.replace(urlRegex, (url) => {
		// Check if already in markdown link format
		if (text.includes(`](${url})`)) return url;
		return `[Link](${url})`;
	});
}

// Clean ChatGPT internal markup from text
// - entity["type","name","description"] -> name
// - image_group{...} -> removed
function cleanChatGptMarkup(text: string): string {
	// Unicode markers used by ChatGPT
	const START = '\ue200';
	const MID = '\ue202';
	const END = '\ue201';

	let result = text;

	// Process entity markers: entity["type","name","description"] -> name
	// Pattern: \ue200entity\ue202[...]\ue201
	const entityRegex = new RegExp(
		START + 'entity' + MID + '\\[([^\\]]+)\\]' + END,
		'g'
	);
	result = result.replace(entityRegex, (_match, content) => {
		try {
			// Parse the JSON array to extract the name (second element)
			const parsed = JSON.parse('[' + content + ']');
			return parsed[1] || '';
		} catch {
			return '';
		}
	});

	// Remove image_group markers entirely: image_group{...} -> empty
	// Pattern: \ue200image_group\ue202{...}\ue201
	const imageGroupRegex = new RegExp(
		START + 'image_group' + MID + '\\{[^}]*\\}' + END,
		'g'
	);
	result = result.replace(imageGroupRegex, '');

	// Clean up any leftover markers (for other unknown types)
	const genericRegex = new RegExp(
		START + '[a-z_]+' + MID + '[^' + END + ']*' + END,
		'g'
	);
	result = result.replace(genericRegex, '');

	return result;
}

function extractFileId(assetPointer: string): string | null {
	if (!assetPointer) return null;
	let match = assetPointer.match(/file-service:\/\/(file-[a-zA-Z0-9_-]+)/);
	if (match) return match[1];
	match = assetPointer.match(/sediment:\/\/file_([0-9a-fA-F]+)/);
	if (match) return `file_${match[1]}`;
	return null;
}
