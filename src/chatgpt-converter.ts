// Options for converting ChatGPT conversations to Markdown
export interface ConversionOptions {
	// Display name for user messages (default: "User")
	userName?: string;
	// Display name for assistant messages (default: "ChatGPT")
	assistantName?: string;
	// Include YAML frontmatter with metadata (default: true)
	useFrontmatter?: boolean;
	// Wrap tool outputs and thinking in collapsible <details> sections (default: true)
	useCollapsibleThinking?: boolean;
	// Show conversation date below the title (default: false)
	includeDate?: boolean;
	// Include internal thinking/reasoning messages from the assistant (default: false)
	includeThinking?: boolean;
	// Format string for note titles. Supports placeholders:
	// - {title}: conversation title
	// - {date}: date in YYYY-MM-DD format
	// - {date:FORMAT}: date with custom format (YYYY, YY, MM, DD, M, D)
	// - {time}: time in HH:MM format
	// Default: "{date} {title}"
	titleFormat?: string;
	// Put user messages in blockquotes (default: true)
	quoteUserMessages?: boolean;
}

// Internal config with resolved defaults
interface ResolvedConfig {
	userName: string;
	assistantName: string;
	useFrontmatter: boolean;
	useCollapsibleThinking: boolean;
	includeDate: boolean;
	includeThinking: boolean;
	titleFormat: string;
	quoteUserMessages: boolean;
}

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
	};
}

interface MappingItem {
	message?: Message;
}

interface Conversation {
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
}

export interface AssetReference {
	fileId: string;
	type: 'image' | 'audio' | 'video' | 'dalle';
}

interface ProcessingContext {
	config: ResolvedConfig;
	assets: AssetReference[];
}

// Convert a single ChatGPT conversation to Joplin-compatible format
export function convertConversation(
	conv: Conversation,
	options: ConversionOptions = {}
): ConvertedConversation {
	const config: ResolvedConfig = {
		userName: options.userName || 'User',
		assistantName: options.assistantName || 'ChatGPT',
		useFrontmatter: options.useFrontmatter !== false,
		useCollapsibleThinking: options.useCollapsibleThinking !== false,
		includeDate: options.includeDate === true,
		includeThinking: options.includeThinking === true,
		titleFormat: options.titleFormat || '{date} {title}',
		quoteUserMessages: options.quoteUserMessages !== false,
	};

	const context: ProcessingContext = {
		config,
		assets: [],
	};

	const body = generateMarkdown(conv, context);
	const noteTitle = formatNoteTitle(conv, config.titleFormat);

	return {
		title: noteTitle,
		body,
		createdTime: conv.create_time ? conv.create_time * 1000 : Date.now(),
		updatedTime: conv.update_time ? conv.update_time * 1000 : Date.now(),
		assets: context.assets,
	};
}

// Parse conversations.json content
export function parseConversationsJson(jsonContent: string): Conversation[] {
	return JSON.parse(jsonContent);
}

function generateMarkdown(conv: Conversation, context: ProcessingContext): string {
	let md = '';

	if (context.config.includeDate && conv.create_time) {
		md += `Date: ${formatDateLong(conv.create_time)}\n\n---\n\n`;
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
		const role = msg.author?.role;
		const author = getAuthorName(msg, context.config);
		const content = getMessageContent(msg, context);
		if (content.trim()) {
			if (role === 'user' && context.config.quoteUserMessages) {
				// User messages in blockquote
				const quotedContent = content.split('\n').map(line => `> ${line}`).join('\n');
				md += `> # ${author}\n>\n${quotedContent}\n\n`;
			} else {
				// Assistant/tool messages with header (or user without quote)
				md += `# ${author}\n\n${content}\n\n`;
			}
		}
	}

	return md;
}

function getAuthorName(msg: Message, config: ResolvedConfig): string {
	const role = msg.author?.role;
	const content = msg.content || {};
	const recipient = msg.recipient || '';
	const contentType = content.content_type || '';

	if (role === 'user') return config.userName;
	if (role === 'tool') return `Tool (${msg.author?.name || 'tool'})`;
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

function processParts(parts: (string | ContentPart)[], context: ProcessingContext): string {
	if (!parts?.length) return '';
	const contentParts: string[] = [];

	for (const part of parts) {
		if (typeof part === 'string') {
			contentParts.push(cleanChatGptMarkup(processUrlsInText(part)));
		} else if (typeof part === 'object') {
			const type = part.content_type;

			if (type === 'text' && part.text) {
				// Explicit text content type
				contentParts.push(cleanChatGptMarkup(processUrlsInText(part.text)));
			} else if (type === 'image_asset_pointer') {
				const fileId = extractFileId(part.asset_pointer || '');
				if (fileId) {
					context.assets.push({ fileId, type: 'image' });
					// Placeholder - will be replaced when asset is attached
					contentParts.push(`![Image](asset://${fileId})`);
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
							context.assets.push({ fileId, type: 'video' });
							contentParts.push(`[Video](asset://${fileId})`);
						}
					}
				}
			} else if (part.text) {
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

function formatDateLong(ts: number): string {
	const d = new Date(ts * 1000);
	const months = ['January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'];
	return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// Format note title using format string with placeholders
// Supported: {title}, {date}, {date:FORMAT}, {time}
// FORMAT can include: YYYY, YY, MM, M, DD, D
function formatNoteTitle(conv: Conversation, format: string): string {
	const title = conv.title || 'Untitled';
	const ts = conv.create_time;

	let result = format;

	// Replace {title}
	result = result.replace(/\{title\}/g, title);

	if (ts) {
		const d = new Date(ts * 1000);
		const year = d.getFullYear();
		const month = d.getMonth() + 1;
		const day = d.getDate();
		const hours = d.getHours();
		const minutes = d.getMinutes();

		// Replace {date} with default YYYY-MM-DD
		result = result.replace(/\{date\}/g,
			`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);

		// Replace {date:FORMAT} with custom format
		result = result.replace(/\{date:([^}]+)\}/g, (_match, fmt: string) => {
			let formatted = fmt;
			formatted = formatted.replace(/YYYY/g, String(year));
			formatted = formatted.replace(/YY/g, String(year).slice(-2));
			formatted = formatted.replace(/MM/g, String(month).padStart(2, '0'));
			formatted = formatted.replace(/M/g, String(month));
			formatted = formatted.replace(/DD/g, String(day).padStart(2, '0'));
			formatted = formatted.replace(/D/g, String(day));
			return formatted;
		});

		// Replace {time}
		result = result.replace(/\{time\}/g,
			`${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`);
	} else {
		// No timestamp - remove date/time placeholders
		result = result.replace(/\{date(:[^}]+)?\}/g, '');
		result = result.replace(/\{time\}/g, '');
	}

	// Clean up extra spaces
	return result.replace(/\s+/g, ' ').trim();
}
