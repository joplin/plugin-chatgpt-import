import {
	convertClaudeConversation, convertClaudePage, currentBranch,
	ClaudeConversation,
} from './claude-converter';
import { nestHeadings } from './markdown-utils';

const ROOT = '00000000-0000-4000-8000-000000000000';

function conversation(messages: any[], extra: Partial<ClaudeConversation> = {}): ClaudeConversation {
	return {
		uuid: 'conv-1',
		name: 'Test Conversation',
		created_at: '2024-01-01T00:00:00Z',
		updated_at: '2024-01-02T00:00:00Z',
		chat_messages: messages,
		...extra,
	};
}

function message(uuid: string, parent: string, sender: string, content: any[], extra: any = {}) {
	return {
		uuid,
		parent_message_uuid: parent,
		sender,
		text: '',
		content,
		attachments: [],
		files: [],
		created_at: `2024-01-01T00:00:0${uuid.slice(-1)}Z`,
		...extra,
	};
}

const text = (value: string, extra: any = {}) => ({ type: 'text', text: value, citations: [], ...extra });

describe('convertClaudeConversation', () => {
	it('should convert a basic conversation', () => {
		const result = convertClaudeConversation(conversation([
			message('m1', ROOT, 'human', [text('Hello')]),
			message('m2', 'm1', 'assistant', [text('Hi there!')]),
		]));

		expect(result.title).toBe('2024-01-01 Test Conversation');
		expect(result.body).toContain('> # User\n>\n> Hello');
		expect(result.body).toContain('# Claude\n\nHi there!');
		expect(result.conversationId).toBe('conv-1');
		expect(result.createdTime).toBe(Date.parse('2024-01-01T00:00:00Z'));
		expect(result.updatedTime).toBe(Date.parse('2024-01-02T00:00:00Z'));
		expect(result.isEmpty).toBe(false);
	});

	it('should use the configured names', () => {
		const result = convertClaudeConversation(conversation([
			message('m1', ROOT, 'human', [text('Hello')]),
			message('m2', 'm1', 'assistant', [text('Hi')]),
		]), { userName: 'Me', assistantName: 'Bot', quoteUserMessages: false });

		expect(result.body).toContain('# Me\n\nHello');
		expect(result.body).toContain('# Bot\n\nHi');
	});

	it('should skip hidden injected prompts', () => {
		const result = convertClaudeConversation(conversation([
			message('m1', ROOT, 'human', [
				text('Hello'),
				{ type: 'injected_prompt_block', injection_source: 'date_note', prompt: 'The current date is...' },
			]),
		]));

		expect(result.body).not.toContain('current date');
	});

	it('should render a tool call together with its result', () => {
		const result = convertClaudeConversation(conversation([
			message('m1', ROOT, 'human', [text('Search this')]),
			message('m2', 'm1', 'assistant', [
				{ type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: { query: 'joplin' } },
				{ type: 'tool_result', tool_use_id: 'toolu_1', name: 'web_search', content: [
					{ type: 'knowledge', title: 'Joplin', url: 'https://joplinapp.org' },
					{ type: 'knowledge', title: 'Multi\nline [title]', url: 'https://example.com/a (b)' },
				] },
				text('Here is what I found'),
			]),
		]), { toolCalls: 'full' });

		expect(result.body).toContain('<details><summary>Tool: WebSearch</summary>');
		expect(result.body).toContain('"query": "joplin"');
		expect(result.body).toContain('- [Joplin](https://joplinapp.org)');
		expect(result.body).toContain('- [Multi line \\[title\\]](https://example.com/a%20%28b%29)');
		// The result is not rendered a second time on its own
		expect(result.body.match(/<summary>Tool:/g)).toHaveLength(1);
	});

	it('should flag failed tool calls', () => {
		const result = convertClaudeConversation(conversation([
			message('m1', ROOT, 'assistant', [
				{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
				{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: [{ type: 'text', text: 'not found' }] },
			]),
		]), { toolCalls: 'full' });

		expect(result.body).toContain('<summary>Tool: Bash (error)</summary>');
		expect(result.body).toContain('```\nnot found\n```');
	});

	it('should fence tool output containing backticks safely', () => {
		const result = convertClaudeConversation(conversation([
			message('m1', ROOT, 'assistant', [
				{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
				{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '```js\ncode\n```' }] },
			]),
		]), { toolCalls: 'full' });

		expect(result.body).toContain('````\n```js\ncode\n```\n````');
	});

	describe('tool call modes', () => {
		const toolConversation = () => conversation([
			message('m1', ROOT, 'assistant', [
				{ type: 'tool_use', id: 'toolu_1', name: 'WebFetch', input: { url: 'https://example.com' } },
				{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'Fetched page content' }] },
				{ type: 'tool_result', tool_use_id: 'toolu_orphan', name: 'setup', content: [{ type: 'text', text: 'Orphaned output' }] },
				text('Answer'),
			]),
		]);

		it('should hide tool calls by default', () => {
			const result = convertClaudeConversation(toolConversation());

			expect(result.body).not.toContain('Tool:');
			expect(result.body).not.toContain('Fetched page content');
			expect(result.body).not.toContain('Orphaned output');
			expect(result.body).toContain('Answer');
		});

		it('should show only the call and its input', () => {
			const result = convertClaudeConversation(toolConversation(), { toolCalls: 'callOnly' });

			expect(result.body).toContain('<summary>Tool: WebFetch</summary>');
			expect(result.body).toContain('"url": "https://example.com"');
			expect(result.body).not.toContain('Fetched page content');
			expect(result.body).not.toContain('Orphaned output');
		});

		it('should show the call and its output in full mode', () => {
			const result = convertClaudeConversation(toolConversation(), { toolCalls: 'full' });

			expect(result.body).toContain('Fetched page content');
			expect(result.body).toContain('<summary>Tool: setup</summary>');
			expect(result.body).toContain('Orphaned output');
		});

		it('should treat a conversation of hidden tool calls only as empty', () => {
			const result = convertClaudeConversation(conversation([
				message('m1', ROOT, 'assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }]),
			]));

			expect(result.isEmpty).toBe(true);
		});
	});

	it('should exclude thinking by default', () => {
		const conv = conversation([
			message('m1', ROOT, 'assistant', [
				{ type: 'thinking', thinking: '', summaries: [{ summary: 'Weighing options' }] },
				text('Answer'),
			]),
		]);

		expect(convertClaudeConversation(conv).body).not.toContain('Weighing options');

		const withThinking = convertClaudeConversation(conv, { includeThinking: true }).body;
		expect(withThinking).toContain('<details><summary>Thinking</summary>\n\n- Weighing options');
	});

	it('should prefer the full thinking text over its summaries', () => {
		const result = convertClaudeConversation(conversation([
			message('m1', ROOT, 'assistant', [
				{ type: 'thinking', thinking: 'Full reasoning', summaries: [{ summary: 'Short' }] },
			]),
		]), { includeThinking: true });

		expect(result.body).toContain('Full reasoning');
		expect(result.body).not.toContain('Short');
	});

	it('should list cited sources', () => {
		const result = convertClaudeConversation(conversation([
			message('m1', ROOT, 'assistant', [
				{ type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: {} },
				{ type: 'tool_result', tool_use_id: 'toolu_1', content: [
					{ type: 'knowledge', title: 'Known page', url: 'https://a.example/page' },
				] },
				text('A claim', { citations: [
					{ details: { type: 'web_search_citation', url: 'https://a.example/page' } },
					{ details: { type: 'web_search_citation', url: 'https://b.example/other' } },
					{ details: { type: 'web_search_citation', url: 'https://a.example/page' } },
				] }),
			]),
		]));

		expect(result.body).toContain('<summary>Sources</summary>');
		expect(result.body).toContain('- [Known page](https://a.example/page)\n- [b.example](https://b.example/other)');
	});

	it('should include pasted text in full', () => {
		const result = convertClaudeConversation(conversation([
			message('m1', ROOT, 'human', [text('Summarise this')], {
				attachments: [{ file_name: '', file_type: 'txt', extracted_content: 'The pasted article' }],
			}),
		]));

		expect(result.body).toContain('> <details><summary>Pasted text</summary>');
		expect(result.body).toContain('> The pasted article');
	});

	it('should describe uploaded files whose bytes are not exported', () => {
		const result = convertClaudeConversation(conversation([
			message('m1', ROOT, 'human', [
				{ type: 'image', file_uuid: 'f1' },
				{ type: 'document', file_uuid: 'f2' },
				text('What is this?'),
			], {
				files: [
					{ file_uuid: 'f1', file_name: 'photo_1.png' },
					{ file_uuid: 'f2', file_name: '' },
					{ file_uuid: 'f3', file_name: 'notes.pdf' },
				],
			}),
		]));

		expect(result.body).toContain('*Attachment not included in the export: photo\\_1.png*');
		expect(result.body).toContain('*Attachment not included in the export: Document*');
		expect(result.body).toContain('*Attachment not included in the export: notes.pdf*');
		expect(result.body.match(/not included/g)).toHaveLength(3);
	});

	it('should not list a pasted file again as missing', () => {
		const result = convertClaudeConversation(conversation([
			message('m1', ROOT, 'human', [text('Look')], {
				attachments: [{ file_name: 'ch11.rpy', extracted_content: 'label start:' }],
				files: [{ file_uuid: 'f1', file_name: 'ch11.rpy' }],
			}),
		]));

		expect(result.body).toContain('label start:');
		expect(result.body).not.toContain('not included');
	});

	it('should fall back to the flat text field of older exports', () => {
		const result = convertClaudeConversation(conversation([
			{ uuid: 'm1', sender: 'human', text: 'Old style message', created_at: '2024-01-01T00:00:00Z' },
		]));

		expect(result.body).toContain('> Old style message');
	});

	it('should report conversations with nothing but missing files as empty', () => {
		const empty = convertClaudeConversation(conversation([
			message('m1', ROOT, 'human', [], { files: [{ file_uuid: 'f1', file_name: '' }] }),
			message('m2', 'm1', 'assistant', []),
		], { name: '' }));

		expect(empty.isEmpty).toBe(true);
		expect(empty.title).toBe('2024-01-01 Untitled');
	});

	it('should derive a title from the first message when the conversation has none', () => {
		const result = convertClaudeConversation(conversation([
			message('m1', ROOT, 'human', [text('## How do I export my notes from Joplin to a folder of Markdown files?')]),
		], { name: '' }), { titleFormat: '{title}' });

		expect(result.title).toBe('How do I export my notes from Joplin to a folder of…');
	});
});

describe('currentBranch', () => {
	it('should drop the abandoned version of an edited message', () => {
		const messages = [
			message('m1', ROOT, 'human', [text('First try')]),
			message('m2', ROOT, 'human', [text('Edited')]),
			message('m3', 'm2', 'assistant', [text('Reply')]),
		];

		expect(currentBranch(messages).map(m => m.uuid)).toEqual(['m2', 'm3']);

		const result = convertClaudeConversation(conversation(messages));
		expect(result.body).not.toContain('First try');
		expect(result.body).toContain('Edited');
	});

	it('should keep every message when the links are broken', () => {
		const messages = [
			message('m1', ROOT, 'human', [text('A')]),
			message('m2', 'm1', 'assistant', [text('B')]),
			message('m3', 'unknown', 'human', [text('C')]),
		];

		expect(currentBranch(messages)).toHaveLength(3);
	});

	it('should keep every message when there are no links', () => {
		const messages = [
			message('m1', ROOT, 'human', [text('A')]),
			message('m2', ROOT, 'assistant', [text('B')]),
		];
		messages.forEach(m => delete (m as any).parent_message_uuid);

		expect(currentBranch(messages)).toHaveLength(2);
	});
});

describe('convertClaudePage', () => {
	const artifact = {
		id: 'a1',
		kind: 'page',
		active_version: 'v2',
		updated_at: '2024-01-05T00:00:00Z',
		versions: [
			{ id: 'v2', title: 'Final title', created_at: '2024-01-04T00:00:00Z' },
			{ id: 'v1', title: 'Draft', created_at: '2024-01-02T00:00:00Z' },
		],
	};

	it('should use the active version title and drop the duplicate heading', () => {
		const result = convertClaudePage(artifact, '# Final title\n\n<!-- tab: Final title -->\n\nBody text\n');

		expect(result.title).toBe('Final title');
		expect(result.body).toBe('<!-- tab: Final title -->\n\nBody text\n');
	});

	it('should drop an outdated page name and the repeated tab title', () => {
		const result = convertClaudePage(artifact, '# Old name\n\n<!-- tab: Old name -->\n\n# Final title\n\n## Part\n\nText\n');

		expect(result.body).toBe('<!-- tab: Old name -->\n\n\n## Part\n\nText\n');
		expect(result.createdTime).toBe(Date.parse('2024-01-02T00:00:00Z'));
		expect(result.updatedTime).toBe(Date.parse('2024-01-05T00:00:00Z'));
	});

	it('should append comment threads', () => {
		const result = convertClaudePage(artifact, 'Body', [
			{ resolved: true, tab: 'Main', comments: [{ body: 'Looks good', created_at: '2024-01-04T10:00:00Z' }] },
			{ resolved: false, comments: [] },
		]);

		expect(result.body).toContain('## Comments\n\n**On "Main" (resolved)**\n\n> Looks good\n>\n> *4 January 2024*');
	});
});

describe('embedded documents', () => {
	const doc = { id: 'doc-123', title: 'Letter', body: '# Section\n\nDear Sir\n\n```\n# not a heading\n```\n' };

	it('should embed a doc after the last assistant message that touched it', () => {
		const result = convertClaudeConversation(conversation([
			message('m1', ROOT, 'human', [text('Write a letter')]),
			message('m2', 'm1', 'assistant', [
				{ type: 'tool_use', id: 'toolu_1', name: 'mcp__Claude_Docs__create', input: { title: 'Letter' } },
				{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '{"id": "doc-123"}' }] },
				text('Here is a first draft'),
			]),
			message('m3', 'm2', 'human', [text('Make it shorter')]),
			message('m4', 'm3', 'assistant', [
				{ type: 'tool_use', id: 'toolu_2', name: 'mcp__Claude_Docs__update', input: { id: 'doc-123' } },
				text('Done'),
			]),
			message('m5', 'm4', 'human', [text('Thanks')]),
		]), {}, [doc, { id: 'doc-other', title: 'Other', body: 'Unrelated' }]);

		expect(result.documentIds).toEqual(['doc-123']);
		expect(result.body).toContain('# Claude\n\nDone\n\n## Document: Letter\n\n### Section\n\nDear Sir');
		// Code blocks are left as they are
		expect(result.body).toContain('```\n# not a heading\n```');
		expect(result.body.match(/Document: Letter/g)).toHaveLength(1);
		expect(result.body.indexOf('Document: Letter')).toBeLessThan(result.body.indexOf('Thanks'));
		expect(result.body).not.toContain('Unrelated');
	});

	it('should embed a doc even when tool calls are hidden', () => {
		const result = convertClaudeConversation(conversation([
			message('m1', ROOT, 'assistant', [
				{ type: 'tool_use', id: 'toolu_1', name: 'mcp__Claude_Docs__create', input: { id: 'doc-123' } },
			]),
		]), { toolCalls: 'hide' }, [doc]);

		expect(result.isEmpty).toBe(false);
		expect(result.body).toContain('# Claude\n\n## Document: Letter');
		expect(result.body).not.toContain('Tool:');
	});

	it('should not embed a doc only mentioned outside the docs tools', () => {
		const result = convertClaudeConversation(conversation([
			message('m1', ROOT, 'human', [
				text('Did I contact the mediator?'),
				{ type: 'injected_prompt_block', prompt: '<artifact-view-context artifact="doc-123">' },
			]),
			message('m2', 'm1', 'assistant', [
				{ type: 'tool_use', id: 'toolu_1', name: 'conversation_search', input: { query: 'mediator' } },
				{ type: 'tool_result', tool_use_id: 'toolu_1', name: 'conversation_search', content: [{ type: 'text', text: 'Found doc-123' }] },
				text('No'),
			]),
		]), {}, [doc]);

		expect(result.documentIds).toEqual([]);
		expect(result.body).not.toContain('Document: Letter');
	});
});

describe('nestHeadings', () => {
	it('should move the highest heading to the given level', () => {
		expect(nestHeadings('## A\n\ntext\n\n### B\n\n#### C', 3)).toBe('### A\n\ntext\n\n#### B\n\n##### C');
	});

	it('should cap headings at level 6', () => {
		expect(nestHeadings('# A\n\n###### F', 3)).toBe('### A\n\n###### F');
	});

	it('should leave fenced code and text without headings alone', () => {
		expect(nestHeadings('# A\n\n```\n# comment\n```', 2)).toBe('## A\n\n```\n# comment\n```');
		expect(nestHeadings('No headings #here', 3)).toBe('No headings #here');
	});
});
