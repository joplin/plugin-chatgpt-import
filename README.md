# ChatGPT Import Plugin for Joplin

Import your ChatGPT conversation history into Joplin as searchable, organized notes.

## Features

- Import ChatGPT export archives (ZIP files) directly into Joplin
- Preserves conversation structure with user/assistant messages
- Imports attached images, audio, and video files as Joplin resources
- Supports both single `conversations.json` and split `conversations-XXX.json` files
- Cleans up ChatGPT internal markup (entity references, image search queries)
- Configurable note titles with date/time formatting
- Optional collapsible sections for tool outputs
- Preserves original conversation timestamps

## Installation

1. Download the plugin `.jpl` file from the releases page
2. In Joplin, go to **Tools > Options > Plugins**
3. Click the gear icon and select "Install from file"
4. Select the downloaded `.jpl` file

## Usage

1. Export your data from ChatGPT:
   - Go to ChatGPT Settings > Data Controls > Export Data
   - Wait for the export email and download the ZIP file

2. Import into Joplin:
   - Go to **File > Import > ChatGPT Export (ZIP)**
   - Select your downloaded ZIP file
   - Wait for the import to complete

All conversations will be imported into a new "ChatGPT Import" notebook.

## Settings

Configure the plugin in **Tools > Options > ChatGPT Import**:

| Setting | Description | Default |
|---------|-------------|---------|
| User name | Display name for user messages | `User` |
| Assistant name | Display name for assistant messages | `ChatGPT` |
| Note title format | Format string for note titles (see below) | `{date} {title}` |
| Show date in note body | Display conversation date below the title | `true` |
| Use collapsible sections | Wrap tool outputs in collapsible `<details>` tags | `true` |
| Include thinking/reasoning | Include internal thinking messages from the assistant | `false` |

### Title Format Placeholders

- `{title}` - The conversation title
- `{date}` - Date in YYYY-MM-DD format
- `{date:FORMAT}` - Date with custom format
- `{time}` - Time in HH:MM format

Custom date FORMAT can use: `YYYY`, `YY`, `MM`, `M`, `DD`, `D`

Examples:
- `{date} {title}` → "2024-01-15 My Conversation"
- `{title} ({date:MM/DD/YY})` → "My Conversation (01/15/24)"
- `{date} {time} - {title}` → "2024-01-15 14:30 - My Conversation"

## Building from Source

```bash
npm install
npm run dist
```

The built plugin will be in the `publish/` directory.

## Credits

- Code to do the Markdown conversion based on [ChatGPT Conversations To Markdown
](https://github.com/daugaard47/ChatGPT_Conversations_To_Markdown) by [daugaard47](https://github.com/daugaard47)

## License

MIT
