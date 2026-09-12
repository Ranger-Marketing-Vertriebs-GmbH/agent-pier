# Code edit diffs in chat

Status: proposed implementation plan; implementation has not started.
Baseline: main at 8edeacbc, after PR #66.

## Intended experience

Show code edits as a compact, unified diff inside the existing expandable tool
activity group. Use the same presentation for Codex, Claude and OpenCode.

- A file header shows its path, operation and added/removed line counts when known.
- Deleted lines have a subdued red background and a minus marker; added lines use
  green and a plus marker. Code tokens retain syntax highlighting in both cases.
- Show old/new line numbers only when the native data provides reliable positions.
  Mark excerpt-only replacements as excerpts instead of inventing file positions.
- Keep the existing eight-line preview budget across a tool call, including calls
  that edit multiple files. Expand progressively; do not render entire large diffs
  as soon as the activity group opens.
- Use a unified view on desktop and mobile. Preserve code whitespace and allow
  horizontal scrolling inside the code area without widening the chat page.
- Keep raw arguments and results available under a secondary details disclosure.
  Existing tool grouping, status and streaming behavior remain the entry point.

Example: `src/example.ts · +2 −1`, followed by removed and added code lines, then
the existing localized expand control. A running or failed edit must not look like
a confirmed successful file change.

## What already exists

- `web/features/chat/ToolOutput.jsx` provides lazy, progressive previews.
- `ToolCode.jsx` safely renders lowlight syntax tokens as React elements.
- `tool-output.js` recognizes plain diff text and separately highlights edit fields
  such as `old_string` and `new_string`; it does not combine them into a diff.
- `server/features/chat/history-parsers.js` flattens native tool inputs and results
  into text. Codex thread file changes already contain paths and diff strings,
  but that structure is discarded by the current normalized output.

## Implementation sequence

1. Capture sanitized fixtures for supported native edit records from each provider.
   Cover both initial history and incremental updates. Verify exact field names
   and success/failure semantics rather than assuming one schema fits all tools.
   Include Codex thread changes and its supported rollout patch-call records,
   Claude replacement/write calls, and OpenCode edit/patch/write state records.

2. Add small provider-specific extractors and a bounded shared change model.
   Preserve the existing text fallback. Optional structured changes carry path,
   operation, hunks or before/after excerpts, coordinate provenance and completeness.
   Preserve native patch hunks where available. Derive a line diff only from a
   verified before/after pair. Unknown records continue to display raw output.
   Keep extraction outside the main parser file to respect the 600-line limit.

3. Preserve that optional structure across all relevant history paths: provisional
   loading, indexed pagination, caches and streamed updates. Check message change
   detection so a completed diff updates the existing tool row by stable ID.
   Handle any persisted cache schema explicitly; old histories must remain readable.

4. Build a dedicated file-change renderer alongside the existing tool output.
   Combine per-line addition/deletion styling with token highlighting for the file's
   language. Tokenize bounded old/new code blocks before mapping tokens to rows so
   multiline strings and comments are not independently reinterpreted per line.
   Unsupported languages remain readable plain code. Never inject highlighted HTML.

5. Retain lazy rendering, preview and character budgets. Bound diff computation as
   well as DOM size; large or malformed records use a clearly truncated raw fallback.
   Prefer an existing suitable diff dependency if present; otherwise assess a small
   maintained line-diff package and its production bundle cost before adding it.
   Any dependency belongs in package.json/package-lock.json and the normal release
   package; no separate manual installation on users' machines.

6. Add German and English strings together, browser coverage and screenshots.
   Run focused checks, catalog parity, the complete repository check, and required
   Linux/macOS and Chromium/WebKit CI before merging the implementation PR.
   Remove this completed temporary plan in the final cleanup commit before opening
   that PR; retain any lasting format guidance under the normal architecture docs.

## Fidelity rules

- Render historical evidence only. Do not read today's working-tree files to fill
  missing before/after content or manufacture historical line numbers.
- A write with no known prior contents is a code preview, not an all-added diff,
  unless the native operation explicitly confirms creation.
- Mark pending, failed and incomplete operations accurately. Do not infer that a
  proposed patch was applied merely because its arguments contain valid diff text.
- Support multiple files, additions, deletions, renames and no-final-newline markers
  only to the extent native records supply them. Binary/unknown changes use a summary.
- Preserve account isolation, file-link validation and the existing handling of
  untrusted paths/text. No file mutation or new execution capability is introduced.

## Acceptance checks

- Equivalent edits from all three providers produce equivalent readable diff rows.
- Single/multiple replacements, CRLF, Unicode, blank lines, multiline syntax,
  unknown extensions, large records and malformed/truncated patches are covered.
- Running-to-completed/failed updates do not duplicate cards or reset expanded state.
- Reload and pagination retain the same diff and status as streamed updates.
- A 390px mobile chat does not overflow; long code scrolls inside its preview.
- Keyboard users can expand/collapse and read changes without relying on color alone.
- German and English labels, raw fallback and eight-line progressive previews work
  in both Chromium and WebKit. Tests use isolated fixtures, never live sessions.

## Deferred choices

Side-by-side desktop diffs, word-level highlighting, file-wide unchanged context,
and applying/reverting changes from chat are outside this first implementation.
The initial spike is limited to verifying native records and producing a representative
diff fixture for each provider; it must resolve data gaps before UI implementation.
