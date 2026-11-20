// Formatting shared by every conversation converter, so that notes look the
// same whichever service the conversations were exported from.

// How tool calls are rendered:
// - full: the call and its output
// - callOnly: the tool name and input, without the output
// - hide: nothing
// Images, audio and video produced by a tool are kept in every mode, as
// ChatGPT delivers generated images as tool output.
export type ToolCallMode = 'full' | 'callOnly' | 'hide';

// Options for converting conversations to Markdown
export interface ConversionOptions {
	// Display name for user messages (default: "User")
	userName?: string;
	// Display name for assistant messages (default depends on the converter)
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
	// How tool calls are rendered (default: "hide")
	toolCalls?: ToolCallMode;
}

// Options with defaults resolved
export interface ResolvedConfig {
	userName: string;
	assistantName: string;
	useFrontmatter: boolean;
	useCollapsibleThinking: boolean;
	includeDate: boolean;
	includeThinking: boolean;
	titleFormat: string;
	quoteUserMessages: boolean;
	toolCalls: ToolCallMode;
}

export function resolveConfig(options: ConversionOptions, defaultAssistantName: string): ResolvedConfig {
	return {
		userName: options.userName || 'User',
		assistantName: options.assistantName || defaultAssistantName,
		useFrontmatter: options.useFrontmatter !== false,
		useCollapsibleThinking: options.useCollapsibleThinking !== false,
		includeDate: options.includeDate === true,
		includeThinking: options.includeThinking === true,
		titleFormat: options.titleFormat || '{date} {title}',
		quoteUserMessages: options.quoteUserMessages !== false,
		toolCalls: options.toolCalls === 'full' || options.toolCalls === 'callOnly' ? options.toolCalls : 'hide',
	};
}

// Render one message under its author heading. User messages are quoted when
// enabled, so that they stand apart from the assistant replies.
export function renderMessage(author: string, content: string, isUser: boolean, config: ResolvedConfig): string {
	if (isUser && config.quoteUserMessages) {
		const quotedContent = content.split('\n').map(line => `> ${line}`).join('\n');
		return `> # ${author}\n>\n${quotedContent}\n\n`;
	}
	return `# ${author}\n\n${content}\n\n`;
}

// Wrap content in a collapsible section, or under a bold label when
// collapsible sections are disabled.
export function collapsible(summary: string, content: string, config: ResolvedConfig): string {
	if (config.useCollapsibleThinking) {
		return `<details><summary>${escapeHtml(summary)}</summary>\n\n${content}\n\n</details>`;
	}
	return `**${escapeMarkdown(summary)}**\n\n${content}`;
}

// Fence text as a code block. The fence is made longer than any run of
// backticks in the text, so that content which itself contains code blocks
// cannot close it early.
export function codeFence(text: string, language = ''): string {
	let longestRun = 0;
	const runs = text.match(/`+/g) || [];
	for (const run of runs) longestRun = Math.max(longestRun, run.length);
	const fence = '`'.repeat(Math.max(3, longestRun + 1));
	return `${fence}${language}\n${text.replace(/\n+$/, '')}\n${fence}`;
}

// Shift every ATX heading so that the highest one ends up at the given
// level, keeping their relative levels. Used to nest a document under an
// existing heading. Headings inside fenced code blocks are left alone.
export function nestHeadings(markdown: string, topLevel: number): string {
	const lines = markdown.split('\n');
	const headingLevels: (number | null)[] = [];
	let openFence = '';

	for (const line of lines) {
		const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			if (!openFence) {
				openFence = marker;
			} else if (marker[0] === openFence[0] && marker.length >= openFence.length) {
				openFence = '';
			}
			headingLevels.push(null);
			continue;
		}
		const headingMatch = openFence ? null : /^ {0,3}(#{1,6})(?=\s|$)/.exec(line);
		headingLevels.push(headingMatch ? headingMatch[1].length : null);
	}

	const levels = headingLevels.filter((level): level is number => level !== null);
	if (!levels.length) return markdown;
	const shift = topLevel - Math.min(...levels);

	return lines.map((line, index) => {
		const level = headingLevels[index];
		if (level === null) return line;
		const newLevel = Math.max(1, Math.min(6, level + shift));
		return line.replace(/^( {0,3})#{1,6}/, (_match, indent: string) => indent + '#'.repeat(newLevel));
	}).join('\n');
}

// Escape characters that would break out of a markdown link label
export function escapeLinkText(text: string): string {
	return text.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

// Escape characters that would turn plain text into markdown formatting
export function escapeMarkdown(text: string): string {
	return text.replace(/([\\`*_[\]<>#])/g, '\\$1');
}

export function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Make a URL safe to use as a markdown link destination, where spaces and
// unbalanced parentheses would end it early.
export function linkDestination(url: string): string {
	return url.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

export function formatDateLong(timestampMs: number): string {
	const d = new Date(timestampMs);
	const months = ['January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'];
	return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// Format note title using format string with placeholders
// Supported: {title}, {date}, {date:FORMAT}, {time}
// FORMAT can include: YYYY, YY, MM, M, DD, D
export function formatNoteTitle(title: string, timestampMs: number | null, format: string): string {
	let result = format;

	// Replace {title}. A function is used so that "$" in the title is not
	// treated as a replacement pattern.
	result = result.replace(/\{title\}/g, () => title);

	if (timestampMs) {
		const d = new Date(timestampMs);
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
