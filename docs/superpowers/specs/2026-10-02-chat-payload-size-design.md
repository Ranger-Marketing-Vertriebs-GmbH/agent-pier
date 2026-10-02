# Chat payload size and slow-network resilience

## Problem

On a slow mobile connection, a Claude Code session became unusable. The chat stayed empty and showed
`undefined is not an object (evaluating 'e.messages.length')`.

Verified on installed release 1.21.12:

1. **The snapshot is large because of inlined images.** The live snapshot holds only the newest 50
   messages. One saved snapshot is still 2.0 MB, and gzip only reduces it to 1.48 MB (−27%). The cause is
   seven `Read` tool rows of 109–366 KB each, whose text is almost entirely base64.
   `history-parsers.js:178-181` builds tool text from `text(output.content) || show(output.content)`.
   For an image `tool_result`, `text()` returns "", so `show()` writes `JSON.stringify` of the image block,
   base64 included. Nothing is compressed today: the chat WebSocket uses `perMessageDeflate: false`, and
   there is no HTTP compression.
2. **Slow link, competing downloads.** If the first WebSocket snapshot does not arrive within
   `FIRST_SNAPSHOT_TIMEOUT` (30 s), the socket is closed mid-transfer. An HTTP fallback read and, one
   second later, a new socket then download the same payload in parallel and keep missing their deadlines.
3. **The crash.** An interrupted or unparsable 2xx body becomes `{}` in `web/lib/api.js:35`.
   - The HTTP fallback passes it unchecked to `useChatStream.accept`, which reads `next.messages.length`
     and throws.
   - The fallback catches the TypeError and shows it as the error text, which is the reported message.

The fix is to make the payload small. Validating responses is hygiene that turns the crash into an
understandable, recoverable state.

## Goals

1. Images in tool output stay visible as real images in the chat, but are never inlined as base64 into
   client-bound chat payloads; the client loads them on demand.
2. Large textual tool output is capped in chat payloads, and the full output is available on demand.
3. API responses and chat WebSocket frames are compressed.
4. An invalid chat response never leaves the chat broken. It shows an explanation, and the chat recovers
   on the next valid snapshot.

Non-goals:
- Changing `api()`'s handling of unparsable bodies.
- Transport timeouts and the competing-download behavior. They are documented here, and payload size is
  the remedy.
- Capping `fileChanges`. It is already bounded at 200,000 characters per row (`file-change-model.js:2`) and
  is a follow-up candidate.
- The 50-message window, terminal WebSocket compression, and delta reload on session switch.

## 1. Image payloads in tool output (server parsers)

Tool images remain visible: they are shown as real images, loaded on demand, using the chat's existing
image infrastructure (the `ChatImages` component with thumbnails, a full-size dialog, and retry; served by
`GET /api/sessions/:id/chat/images/:imageId`).

**Parser extraction.** In `server/features/chat/history-parsers.js`, when tool input or output is
serialized (the `show()` path, including Codex/MCP `result.content` items), structured image payloads are
taken out of the serialized JSON:

- Claude image blocks: `{ type: "image", source: { type: "base64", media_type, data } }`.
- MCP and Codex image items: `{ type: "image", data, mimeType }`.

Only `image/png`, `image/jpeg`, `image/gif` and `image/webp` are extracted. Other types stay as they are.

- Each extracted image is replaced in the text by the placeholder `[image N]`, with N starting at 1 per
  row in order of appearance.
- The row gains a server-internal field `toolImages: [{ mime, data }]`.
- If the tool input has a `file_path` string (for example `Read`), it is recorded once as
  `toolImagePath` for labelling.

This applies to every provider parser that serializes tool input or output: `normalizeClaude`,
`normalizeCodex`, `normalizeCodexRecords` and `normalizeOpenCode`.

**Client-bound payload.** `ChatImages.decorate` replaces `toolImages` on each row with
`images: [{ id, path }]`:
- `id` is a sha256 hex of `[sessionId, providerSessionId, messageId, N, sha256(data)]`.
- `path` is the `toolImagePath` basename plus ` · N` when present, otherwise `image N`.

Base64 data never leaves the server in chat payloads. The decoded images are kept in a bounded in-memory
`ToolImageStore`, keyed by `id`, with the same bounds and least-recently-used policy as the text store
(section 2).

**Serving.** `ChatImages.file(id, imageId)` checks the tool image store first. On a miss, it re-derives the
image from `chat.read(id)`, which covers the live window. If both miss, it falls through to the existing
file-based image lookup. The existing route keeps its headers (inline, same-origin, sandboxed CSP).

**Client.** An expanded tool row renders `<ChatImages images={message.images} sessionId />` above its
output. Thumbnails load lazily, so nothing is fetched until the row is opened.

Persisted server snapshots keep the base64 (server-local). Only client-bound payloads shrink.

## 2. Large textual tool output (server and client)

**Where.** In `ChatImages.decorate` (`server/features/chat/chat-images.js`). Every client-bound chat payload
passes through it:
- the live read (`GET /chat` via `ChatSync.read`)
- the WebSocket stream (`chat-streams.js`)
- history pages (`decoratePage`)
- the bind response

Persisted snapshots keep the full (image-free) text.

**Rule.** Applies to rows with `role: "tool"` whose `text.length` exceeds `TOOL_TEXT_LIMIT` = 16,384 code
units, and only if the result is shorter than the original:
- `text` becomes the first 12,288 code units.
- A new field `textTail` holds the last 4,096 code units.
- `truncated` becomes `{ length: <original text.length>, bytes: <Buffer.byteLength(original, "utf8")> }`.
- Cuts never split a surrogate pair. No marker string is inserted into content.
- Other rows are untouched.

**Full text store.** A new module, `server/features/chat/tool-text-store.js` (`ToolTextStore`):
- **Contents:** an in-memory map keyed by `JSON.stringify([sessionId, messageId])`, with the value
  `{ text, providerSessionId }`.
- **Bounds:** 32 MiB in total and 4 MiB per entry, counting `text.length * 2`, with least recently used
  eviction. Replacing a key subtracts the old entry first. Entries above 4 MiB are not stored.
- **Lifecycle:** not persisted. `forgetSession(sessionId)` drops a session's entries when its chat data is
  removed (`routes/sessions.js:64` path).
- **Writes:** `decorate` stores the full text of each truncated row.

**Endpoint.** `GET /api/sessions/:id/chat/messages/:messageId/text`, behind `requireLogin`. The handler:
1. Resolves the session, which gives 404 for an unknown session, as other chat routes do.
2. Looks up the store.
3. On a miss, re-derives the text from `chat.read(id)`. This is cached for one second and covers rows in
   the live window. If the row is found there, its full text is returned. Re-derivation works only for
   the live window.
4. Returns `{ text }` with `no-store` when the text is found and its `providerSessionId` matches the
   session's current snapshot binding.
5. Otherwise returns 404 with a translated server message (`server/lib/i18n/de` and
   `server/lib/i18n/en`), for example "This output is no longer available. Reload the chat to load it
   again." There is no error code; the client translates by `messageKey`.

**Client.**
- A truncated tool row renders `text`, then a localized omission line ("… 352 KB omitted …", computed from
  `truncated.bytes` minus the bytes of head and tail), then `textTail`.
- A button "Load full output (366 KB)" sits below, sized from `truncated.bytes`. Clicking it fetches the
  endpoint and renders the full text with the existing `ToolOutput` behavior.
- The fetched text is kept in component state and reset when `truncated.length` changes, for example
  while a running row grows.
- On error, the translated message is shown and the button stays available.
- `ToolChanges`' raw view uses the same rendering.
- Without the full text, `toolBlocks` parsing runs on `text` only, and a cut leading JSON value falls back
  to plain text, which is acceptable for a preview.

## 3. Compression

**HTTP.**
- Add the `compression` dependency (1.8.x, compatible with Express 5.2).
- Mount it in `server/app.js` right after `app.use("/api", requireLogin(...))` and before
  `fileTransferStreams`. The MCP transport (mounted earlier) and `/auth` stay uncompressed. API routes,
  static assets, and the SPA document are compressed.
- Threshold 1 KiB. The filter is `compression.filter` and excludes responses with
  `Content-Disposition: attachment`. Downloads already use `application/octet-stream`, which the default
  filter rejects; the attachment check is belt and braces.
- BREACH is not a realistic concern: the session cookie is `sameSite: "strict"`, and requests are
  checked for Host and Origin.

**Chat WebSocket.**
- `server/http/chat-websocket.js` enables `perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true }`.
  The default `ws` concurrency limit applies. The existing 2 MB `bufferedAmount` backpressure check
  remains valid.
- The terminal WebSocket is unchanged.

**Provisioning.** Releases run `npm ci --omit=dev` and ship `node_modules`
(`scripts/release-package.mjs:86-92`). A pure-JS dependency needs no installer change. Update
third-party license output if the build tooling requires it.

## 4. Invalid response handling (client)

- `isChatSnapshot(value)` in `web/features/chat/chat-sync.js` returns true for a non-null object with an array
  `messages`.
- **Socket path:** `chat-stream-transport.js` uses it in place of its inline check.
- **HTTP fallback:** an invalid read result is not assigned to `snapshot` and is not passed to `onSnapshot`.
  It reports `onError(copy.invalidSnapshot)`, and the existing retry, backoff and socket reconnect continue.
  The next valid snapshot clears the error.
- **`useChatStream.choose`:** validates its argument as the first statement, before stopping the stream or
  resetting state. If it is invalid, it throws the same message, the running stream continues, and
  `ConversationPicker` shows the message.
- **Copy:** `invalidSnapshot` goes in `web/lib/i18n/{de,en}/chat.js`, imported through
  `web/lib/i18n/messages/chat.js`. EN: "The chat could not be loaded completely. Retrying…"

## 5. Testing

- **Unit:**
  - Image extraction: Claude image block and MCP image item become `[image N]` placeholders plus
    `toolImages`; unsupported MIME types and non-image JSON stay unchanged; `toolImagePath` from
    `file_path`. Add a Read-with-image fixture for `normalizeClaude`.
  - `ToolImageStore` bounds and LRU (shared implementation with `ToolTextStore` is fine).
  - Truncation: the limit boundary, the only-if-smaller rule, head and tail lengths, the surrogate-pair
    boundary, non-tool rows, and the `truncated` metadata.
  - `ToolTextStore`: total and per-entry bounds, LRU eviction, replace accounting, and `forgetSession`.
  - `isChatSnapshot`.
  - The HTTP fallback returning `{}` reports `invalidSnapshot`, never calls `onSnapshot`, keeps the previous
    snapshot, and clears on the next valid socket snapshot.
  - `choose` with an invalid value keeps the stream running.
  - Update `tests/unit/tool-output.test.js` if it is affected.
- **Integration and blackbox:**
  - A fixture session with a 200 KB textual tool output yields a truncated row via `GET /chat`, the WebSocket,
    and `/chat/history`.
  - The text endpoint returns the original, re-derives after the store is cleared, and returns a translated
    404 for an unknown id.
  - A Read-with-image tool row yields `images: [{ id, path }]` and no base64 in `GET /chat`; the image route
    serves the decoded bytes with the correct content type, also after the store is cleared (re-derivation).
  - JSON responses carry `Content-Encoding: gzip` when the client accepts it. A file download does not.
  - The chat WebSocket negotiates `permessage-deflate`.
- **Playwright (Chromium and WebKit):** an expanded tool row with an image shows a thumbnail that opens the full-size dialog. A truncated row shows head, the omission line and tail. "Load full
  output" shows the full text, and the error state shows the translated message. Covered in EN and DE.
- **i18n:** parity tests for all new keys, client and server.

## 6. Documentation

- `docs/mobile-recovery.md`: transport behavior on slow links, invalid response handling, and compression.
- `docs/chat-observability.md` (or `docs/architecture.md`): tool image extraction and serving, the truncation rule, and the
  full-text endpoint.

## Expected effect

Measured on the 2.0 MB example: moving the image payloads out of the chat payload leaves about 95 KB before
compression; gzip reduces this further. Images load only when their tool row is opened.
