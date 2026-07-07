# Migration: tool-surface consolidation (27 → 15 tools)

This release consolidates the MCP tool surface from **27 tools to 15** with no
loss of capability. Fewer tools means less context loaded on every turn and
more reliable tool selection.

**Nothing breaks immediately.** Every retired tool name still works: the server
rewrites it to its canonical tool (and arguments) and logs a one-time
deprecation notice. Retired names are hidden from the tool list by default; set
`EVERNOTE_LEGACY_TOOLS=true` to re-advertise them during a migration window.
Update your callers to the canonical tools, then drop the flag — the aliases
will be removed in a future major.

## What changed, by bucket

### Resources (5 → 2)

`evernote_get_resource` now projects one attachment through an `as` view.
**Its default changed from binary download to text extraction.**

| Old call | New call |
|---|---|
| `get_resource({guid})` (binary) | `get_resource({guid, as:"binary"})` |
| `get_resource({guid, includeData:true})` | `get_resource({guid, as:"binary"})` |
| `get_resource({guid, includeData:false})` | `get_resource({guid, as:"metadata"})` |
| `get_resource_text({resourceGuid})` | `get_resource({guid, as:"text"})` |
| `get_resource_recognition({resourceGuid})` | `get_resource({guid, as:"recognition"})` |
| `list_note_resources({noteGuid})` | `get_note({guid, includeAttachmentText:false})` → read `resources[]` |

`as:"metadata"` returns `{guid, filename, mimeType, size, hash, hasRecognition}`
for a single attachment — the same per-resource fields the old
`list_note_resources` returned. `get_note`'s `resources[]` lists a note's
attachments with `{guid, filename, mimeType, size}` (no `hash`/`hasRecognition`;
fetch those per-attachment via `as:"metadata"`). `add_resource_to_note` is
unchanged.

### Polling (4 → 1)

| Old | New |
|---|---|
| `start_polling()` | `polling({action:"start"})` |
| `stop_polling()` | `polling({action:"stop"})` |
| `poll_now()` | `polling({action:"poll"})` |
| `polling_status()` | `polling({action:"status"})` |

### Connection / account (4 → 1)

| Old | New |
|---|---|
| `health_check({verbose?})` | `connection({action:"status", verbose?})` |
| `get_user_info()` | `connection({action:"user"})` |
| `reconnect()` | `connection({action:"reconnect"})` |
| `revoke_auth()` | `connection({action:"revoke"})` |

### Notebooks & tags (4 → 3 each)

`list_notebooks` / `list_tags` return the full list, or a single entity when
given a `name` or `guid`.

| Old | New |
|---|---|
| `get_notebook({name?/guid?})` | `list_notebooks({name?/guid?})` |
| `get_tag({name?/guid?})` | `list_tags({name?/guid?})` |

`create_notebook` / `update_notebook` / `create_tag` / `update_tag` are unchanged.

### Notes (6 → 5)

`patch_note` folds into `update_note` as **patch mode**: pass `replacements[]`
(mutually exclusive with `title`/`content`/`tags`/`notebookName`).

| Old | New |
|---|---|
| `patch_note({guid, replacements})` | `update_note({guid, replacements})` |

`create_note` / `get_note` / `delete_note` / `search_notes` are unchanged.

## The 15 canonical tools

Notes: `create_note`, `get_note`, `update_note`, `delete_note`, `search_notes` ·
Notebooks: `list_notebooks`, `create_notebook`, `update_notebook` ·
Tags: `list_tags`, `create_tag`, `update_tag` ·
Resources: `get_resource`, `add_resource_to_note` ·
Admin: `polling`, `connection`.

## Deprecated aliases (14)

`get_resource_text`, `get_resource_recognition`, `list_note_resources`,
`start_polling`, `stop_polling`, `poll_now`, `polling_status`, `health_check`,
`get_user_info`, `reconnect`, `revoke_auth`, `get_notebook`, `get_tag`,
`patch_note` — all still callable; set `EVERNOTE_LEGACY_TOOLS=true` to list them.
