import { convertConversation, parseConversationsJson, ConversionOptions } from './chatgpt-converter';

describe('parseConversationsJson', () => {
	it('should parse valid JSON array', () => {
		const json = '[{"title": "Test"}, {"title": "Test 2"}]';
		const result = parseConversationsJson(json);
		expect(result).toHaveLength(2);
		expect(result[0].title).toBe('Test');
	});
});

describe('convertConversation', () => {
	it('should convert a basic conversation', () => {
		const conv = {
			title: 'Test Conversation',
			create_time: 1704067200, // 2024-01-01 00:00:00 UTC
			update_time: 1704067200,
			mapping: {
				'msg1': {
					message: {
						author: { role: 'user' },
						content: { parts: ['Hello'] },
						create_time: 1704067200,
					}
				},
				'msg2': {
					message: {
						author: { role: 'assistant' },
						content: { parts: ['Hi there!'] },
						create_time: 1704067201,
					}
				}
			}
		};

		const result = convertConversation(conv);

		expect(result.title).toBe('2024-01-01 Test Conversation');
		// User messages in blockquote with header
		expect(result.body).toContain('> # User');
		expect(result.body).toContain('> Hello');
		// Assistant messages with header (not blockquote)
		expect(result.body).toContain('# ChatGPT');
		expect(result.body).toContain('Hi there!');
	});

	it('should use custom user and assistant names', () => {
		const conv = {
			title: 'Test',
			mapping: {
				'msg1': {
					message: {
						author: { role: 'user' },
						content: { parts: ['Hello'] },
						create_time: 1704067200,
					}
				},
				'msg2': {
					message: {
						author: { role: 'assistant' },
						content: { parts: ['Hi'] },
						create_time: 1704067201,
					}
				}
			}
		};

		const options: ConversionOptions = {
			userName: 'Alice',
			assistantName: 'GPT-4',
		};

		const result = convertConversation(conv, options);

		expect(result.body).toContain('# Alice');
		expect(result.body).toContain('# GPT-4');
	});

	it('should not quote user messages when disabled', () => {
		const conv = {
			title: 'Test',
			mapping: {
				'msg1': {
					message: {
						author: { role: 'user' },
						content: { parts: ['Hello'] },
						create_time: 1704067200,
					}
				}
			}
		};

		const options: ConversionOptions = {
			quoteUserMessages: false,
		};

		const result = convertConversation(conv, options);

		expect(result.body).toContain('# User');
		expect(result.body).toContain('Hello');
		expect(result.body).not.toContain('> #');
		expect(result.body).not.toContain('> Hello');
	});

	it('should format title with custom format', () => {
		const conv = {
			title: 'My Chat',
			create_time: 1704067200, // 2024-01-01
		};

		const options: ConversionOptions = {
			titleFormat: '{title} ({date:MM/DD/YY})',
		};

		const result = convertConversation(conv, options);

		expect(result.title).toBe('My Chat (01/01/24)');
	});

	it('should exclude thinking messages by default', () => {
		const conv = {
			title: 'Test',
			mapping: {
				'msg1': {
					message: {
						author: { role: 'assistant' },
						content: { thoughts: [{ summary: 'Thinking', content: 'Deep thoughts' }] },
						create_time: 1704067200,
					}
				}
			}
		};

		const result = convertConversation(conv);

		expect(result.body).not.toContain('Deep thoughts');
	});

	it('should include thinking messages when enabled', () => {
		const conv = {
			title: 'Test',
			mapping: {
				'msg1': {
					message: {
						author: { role: 'assistant' },
						content: { thoughts: [{ summary: 'Thinking', content: 'Deep thoughts' }] },
						create_time: 1704067200,
					}
				}
			}
		};

		const options: ConversionOptions = {
			includeThinking: true,
		};

		const result = convertConversation(conv, options);

		expect(result.body).toContain('Deep thoughts');
	});

	it('should clean entity markup from text', () => {
		const conv = {
			title: 'Test',
			mapping: {
				'msg1': {
					message: {
						author: { role: 'assistant' },
						content: { parts: ['Check out \ue200entity\ue202["software","Windows 11"]\ue201 settings'] },
						create_time: 1704067200,
					}
				}
			}
		};

		const result = convertConversation(conv);

		expect(result.body).toContain('Windows 11');
		expect(result.body).not.toContain('entity');
		expect(result.body).not.toContain('\ue200');
	});

	it('should remove image_group markup', () => {
		const conv = {
			title: 'Test',
			mapping: {
				'msg1': {
					message: {
						author: { role: 'assistant' },
						content: { parts: ['Here is info\ue200image_group\ue202{"query":["test"]}\ue201 and more text'] },
						create_time: 1704067200,
					}
				}
			}
		};

		const result = convertConversation(conv);

		expect(result.body).toContain('Here is info');
		expect(result.body).toContain('and more text');
		expect(result.body).not.toContain('image_group');
		expect(result.body).not.toContain('query');
	});

	it('should track image assets', () => {
		const conv = {
			title: 'Test',
			mapping: {
				'msg1': {
					message: {
						author: { role: 'user' },
						content: {
							parts: [{
								content_type: 'image_asset_pointer',
								asset_pointer: 'file-service://file-abc123'
							}]
						},
						create_time: 1704067200,
					}
				}
			}
		};

		const result = convertConversation(conv);

		expect(result.assets).toHaveLength(1);
		expect(result.assets[0].fileId).toBe('file-abc123');
		expect(result.assets[0].type).toBe('image');
		expect(result.body).toContain('![Image](asset://file-abc123)');
	});

	it('should preserve timestamps', () => {
		const conv = {
			title: 'Test',
			create_time: 1704067200,
			update_time: 1704153600,
		};

		const result = convertConversation(conv);

		expect(result.createdTime).toBe(1704067200000);
		expect(result.updatedTime).toBe(1704153600000);
	});

	it('should handle multimodal messages with images and text', () => {
		const conv = {
			title: 'Test',
			mapping: {
				'msg1': {
					message: {
						author: { role: 'user' },
						content: {
							content_type: 'multimodal_text',
							parts: [
								{
									content_type: 'image_asset_pointer',
									asset_pointer: 'file-service://file-img1'
								},
								{
									content_type: 'image_asset_pointer',
									asset_pointer: 'file-service://file-img2'
								},
								'which logo do you prefer?'
							]
						},
						create_time: 1704067200,
					}
				}
			}
		};

		const options: ConversionOptions = {
			quoteUserMessages: false,
		};

		const result = convertConversation(conv, options);

		expect(result.assets).toHaveLength(2);
		expect(result.body).toContain('![Image](asset://file-img1)');
		expect(result.body).toContain('![Image](asset://file-img2)');
		expect(result.body).toContain('which logo do you prefer?');
	});
});
