# ChatGPT export format notes

Two export layouts exist and both must keep working.

## Legacy layout

Attachments are stored under their real names in per-type folders
(`dalle-generations/`, `user-*/`, `audio/`). Resolution is by matching the
file id inside the path.

## Current layout (flattened)

Every attachment is written to the archive root as an opaque
`file_<hex>.dat` blob. Names and types must be recovered from manifests:

| Source | Contents |
| --- | --- |
| `conversation_asset_file_names.json` | `file_xxx.dat` -> real file name |
| `library_files.json` | `file_id`, `file_name`, `file_extension`, `mime_type`, `sha256_digest`, `origination_thread_id` |
| `message.metadata.attachments[]` | `id`, `name`, `mime_type` - the name the user actually saw |

Precedence for naming: attachments > `conversation_asset_file_names.json` >
`library_files.json`. Magic bytes are also sniffed, because the declared
extension is sometimes wrong - a pasted SVG is recorded as `Pasted text.txt`.

### How a blob gets linked to a conversation

1. `asset_pointer` in the message content (`sediment://file_<hex>`). Images and
   audio only.
2. `message.metadata.attachments[]`, which has **no asset pointer at all**.
   This is the only route for PDFs, Office documents and text uploads, so a
   converter that only reads asset pointers silently drops them.
3. `library_files.origination_thread_id` -> conversation id. This is the only
   working link for images generated in a conversation but stored in the
   library. Note that `initiating_conversation_id` is null even when the
   conversation is present, and `origination_message_id` is frequently the
   sentinel `client-created-root`, so neither is usable.
4. Anything left over goes to a single "ChatGPT Library" note.

### Documents have no bytes

The export ships image bytes but generally **not document bytes**. Roughly 120
attachments in a real archive reference files that are simply not present,
mostly PDFs. These must degrade to readable text rather than a dangling
`asset://` link.

### Projects

`conversation.conversation_template_id` is the **project id** (`g-p-...`),
despite the name - projects are built on the gizmo/custom-GPT machinery, where
the gizmo supplied the system prompt. It joins to `library_files.gizmo_id`.

**Project titles are not in the export.** There is no gizmo table anywhere;
`conversation_template_id` is the only key that maps to a `g-p-` id. A project
name only ever appears incidentally inside assistant message text.

Since users delete the archive after importing, the ids are stored as note
user data (`chatgpt.projectId`, `chatgpt.conversationId`) via
`joplin.data.userDataSet`, which is synced and not user-visible. Without this
the project grouping is lost permanently.

# Claude export format notes

## Delivery

Claude provides a `manifest-<ids>.json` listing one zip per category and part
(`conversations-000.zip`, `projects-000.zip`, `frames-000.zip`,
`light_metadata-000.zip`; large accounts get `-001`, `-002`...). The plugin
**cannot download them**: the `export_url` links sit behind a Cloudflare
challenge and `cross-origin-resource-policy: same-origin`, and may only work
once. The user downloads the zips into one folder, and the importer takes
that folder. Every part contains the same file names,
so each zip must be extracted into its own directory.

## Content

| File | Contents |
| --- | --- |
| `conversations.json` | `uuid`, `name`, `created_at` (ISO), `chat_messages[]` |
| `projects/<uuid>.json` | `name`, `description`, `prompt_template` (instructions), `docs[]` with full `content`. Not imported, see below. |
| `artifacts/<id>/artifact.json` + `page.md` + `comments.json` | Claude docs (`kind: page`). Other kinds are bundled HTML/JS apps and are skipped. |
| `light_metadata` | Account and login history, not imported |

Message `content[]` blocks: `text` (with `citations`), `thinking` (the text is
almost always empty - only `summaries[]` survive), `tool_use` / `tool_result`
(paired by `id` / `tool_use_id`), `image` / `document` (by `file_uuid`), and
`injected_prompt_block`, which is hidden app context and must never be shown.

- **No file bytes at all.** Images and documents are only a `file_uuid` and an
  often empty `file_name`. Pasted text is the exception: `attachments[]` holds
  the full `extracted_content`.
- **No conversation -> project link.** Project names are present (unlike
  ChatGPT) but no conversation carries a project id. Projects are therefore
  not imported at all: on their own they are just unconnected metadata.
- **Docs link to conversations only through their id** appearing inside the
  calls and results of the docs tools (`mcp__Claude_Docs__*`, `Artifact`).
  Only those tools count: the id also shows up in unrelated output, such as a
  `conversation_search` result in another conversation, or in hidden context.
  Each doc is embedded after the last assistant message that touched it; docs
  no conversation touched become standalone notes.
- `page.md` starts with the page name as an H1, which can be stale (an older
  title), and a single-tab doc then repeats its title as the tab heading.
- Messages form a tree via `parent_message_uuid` (root parent is
  `00000000-0000-4000-8000-000000000000`); editing a message leaves the old
  branch in the export. Follow the chain back from the latest message.
- Some conversations are exported with every message empty (`text: ""`,
  `content: []`); all untitled ones in the sample were like this. They are
  skipped.
