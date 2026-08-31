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
