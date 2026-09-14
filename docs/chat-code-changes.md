# Code changes in chat

Tool messages may carry an optional `fileChanges` array alongside their original
`text`, stable ID and execution status. The UI displays a unified diff inside the
existing tool activity disclosure. Raw arguments and output remain available.

## Historical evidence

- Claude `Edit` and `MultiEdit` inputs provide replacement excerpts. `Write` inputs
  without prior content provide a code preview, never an invented file creation.
- OpenCode edit/write result metadata may supply a unified patch; `apply_patch`
  metadata supplies per-file patches. Pending or failed operations use their input
  evidence instead of treating result metadata as a successful change.
- Codex app-server file updates supply unified patches, while additions and deletions
  supply full contents. `kind.move_path` identifies renames; the known app-server
  `Moved to:` suffix is removed only when it matches that structured path. Rollout
  function/freeform `apply_patch` calls retain excerpt rows and their result status.

The model carries path, operation, provenance, rows and counts for the represented
change. Rows have `add`, `remove`, `context` or `meta` kinds. Native unified hunks
supply old/new coordinates; full creations/deletions start at line one. Replacement
excerpts and apply-patch search anchors do not invent file coordinates. Replacement
counts describe the excerpt, including when an input requests replacement of every
occurrence. Running and failed operations retain their normal tool status.

No working-tree file is read to reconstruct historical content. Paths are displayed
as text, not opened automatically. Unsupported, binary, malformed or oversized data
uses the existing bounded raw output renderer. Partial multi-edit extraction falls
back for the entire operation rather than silently omitting a file.

## Bounds and compatibility

Extraction accepts at most 30 file/replacement records, 100,000 characters per
input and 2,000 rows per file. The combined optional payload is limited to 200,000
serialized characters. Excerpt line differencing uses an LCS capped at 250,000
cells; larger pairs use the raw fallback. No additional dependency is required.

The UI shares eight preview units across file headers and rows, then expands in
200-unit increments. Character limits also bound long individual rows. Highlighting
is lazy and limited to 20,000-character blocks; old/new sides are tokenized separately
within visible hunks so multiline comments retain their syntax context. React spans
render tokens without HTML injection. Code scrolls horizontally within the preview.

History readers, cursors, snapshots and WebSocket deltas retain the additive field.
Snapshot records have no separate message schema version: older snapshots without
`fileChanges` remain readable as raw output, and fresh native reads enrich them.
Diff-only changes participate in the existing full-message stream fingerprint.

## Verification

Unit fixtures cover all three provider formats, multiple edits/files, CRLF, Unicode,
blank lines, missing final newlines, renames and defensive limits. Integration tests
cover Claude provisional/indexed history, OpenCode SQLite pagination, Codex cursors,
snapshots and actual WebSocket updates/reconnection. Browser tests cover German and
English, all providers, keyboard expansion, status updates, reload, syntax tokens and
390px horizontal containment in Chromium and WebKit.

Provider schema references:

- [Codex file-change types](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/FileUpdateChange.ts)
- [Codex patch conversion](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/item_builders.rs)
- [OpenCode edit tool](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/edit.ts)
- [OpenCode patch tool](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/apply_patch.ts)
