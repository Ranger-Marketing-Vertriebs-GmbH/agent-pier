# AgentPier: chat image attachments

Images cannot currently reach the agent. `ChatImages` only renders pictures the agent itself names in its output; the composer sends plain text to `POST /sessions/:id/input`, which tmux types into the CLI. User request: drag an image into the chat so the model sees it. Scope is the chat composer through drag and drop, clipboard paste and a file button. The terminal view is out of scope.

## Storage and access

A tmux buffer carries text, never image bytes, so the picture must reach the CLI as a readable file path. Attachments live outside the user's project under `.data/chat-attachments/<accountId>/<sessionId>/`, keeping uploads out of the repository and letting them expire with the session. Because every provider confines file reads, each session is granted that directory at launch, next to the existing `sharedProfiles.prepare` step in `launchResolved`.

Claude and Codex both accept `--add-dir`, scoped to the exact session directory. OpenCode has no such flag; it uses `references` in the account's `opencode.json`, which its external-directory permission boundary honours automatically. That entry is written during the same launch step, but against the account directory and only when absent, because `profileLocation` is account-scoped and per-session entries would grow the config without bound. The asymmetry is accepted and deliberate: under OpenCode a session can read attachments belonging to other sessions of the same account, under Claude and Codex it cannot. Edits reuse the `jsonc-parser` `modify`/`applyEdits` path already in `configuration.js` so unrelated configuration survives. Shell sessions get nothing, as no model is involved.

Sessions started before this feature carry no grant. They record no attachment path, the UI hides the attachment area, and the message states that the session must be restarted. No silent fallback into the workspace.

## Upload

`POST /api/sessions/:id/chat/attachments` takes `{ name, data }` with base64 content under a route-scoped body limit, mounted ahead of the global 64 kB parser exactly as `/api/accounts/:id/extensions/skills` already is. No multipart parser and no new dependency.

The client-supplied name is a display label only and never touches the filesystem. Stored files get a generated `<timestamp>-<random>.<extension>` name whose extension derives from the magic bytes, making path traversal structurally impossible rather than filtered. Content is validated by `rasterType` from `chat-images.js`, which already recognises PNG, JPEG, GIF, WebP and AVIF from their headers and rejects PNG and GIF decompression bombs by pixel count; it becomes an export instead of being reimplemented. Limits follow existing values: 10 MB per image, which fits the 15 MB route limit after base64 expansion, and eight attachments per message, matching the cap in `reportedImages` and `ChatImages`. Directories are created `0o700` and files `0o600`. Uploads are refused for stopped sessions, shell sessions and sessions without a grant. Deleting a session discards its directory alongside the other `discard` calls in the sessions route.

## Composer and history

Dropping is accepted across the whole chat panel rather than the textarea alone, with an overlay, since people aim loosely while dragging. Paste is handled on the textarea for screenshots, and a hidden `<input type="file" accept="image/*" multiple>` serves touch and mouse users. Upload happens on drop, not on submit, so size and format errors surface before the message is sent; attachments appear as chips previewed from a local object URL and can be removed again.

On submit the absolute paths follow the text, one per line. Paths stay bare: `@path` would trigger the CLIs' file autocompletion mid-paste and corrupt the input, and Markdown image syntax is read inconsistently across the three tools. Multi-line input is safe because `session-manager` pastes with `paste-buffer -p -r`, so newlines arrive literally and only the separate Enter submits. The chosen path shape — absolute, known extension, alone on a line — is already recognised by `reportedImages`, so history thumbnails need only `"user"` added to the role list in `descriptors`. Attachment logic lives in a dedicated hook and component beside `useChatController`, keeping files within the 600-line structure limit. All strings go to the central German i18n modules.

## Accepted residual risk

Previews became `data:` URIs rather than `blob:` object URLs: the app's CSP allows `img-src 'self' data:` and no `blob:`, and relaxing the policy was the worse trade. The retained base64 is released when a chip is removed or the message is sent, and a client-side 10 MB check keeps oversized files from being read at all.

Directory creation and the OpenCode config write are both guarded so a failure degrades to "this session has no attachments" and never aborts a launch. One consequence is deliberate and unverified: when the `references` entry is written and the directory creation then fails, the entry is left in place, so it can point at a directory that does not exist until the next successful launch recreates it. Whether OpenCode warns about a reference to a missing path could not be established — its documentation is silent and the CLI is not installed on the development machine, so the whole OpenCode branch is covered by config fixtures only, never against the real tool. Confirm this empirically before relying on the OpenCode path.

## Verification

Integration coverage for a successful upload, oversize rejection, non-image bytes disguised with an image extension, shell and stale sessions, and cleanup on session deletion. A property test asserts over arbitrary client-supplied names that the resulting path never escapes the attachment directory, the invariant the design's safety rests on. A matrix test confirms each tool receives its own grant: the flag for Claude and Codex, the config entry for OpenCode, nothing for shell. Browser tests cover drop, paste and file selection, chip removal, the path reaching the sent message, and the thumbnail appearing in history. Development follows the repository's test-first practice.
