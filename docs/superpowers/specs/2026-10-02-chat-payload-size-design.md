# Chat payload size and slow-network resilience

## Problem

On a slow mobile connection, a Claude Code session became unusable. The chat stayed empty and showed
`undefined is not an object (evaluating 'e.messages.length')`.

Root cause chain, verified on installed release 1.21.12:

1. **The snapshot is large.** The live chat snapshot holds only the newest 50 messages, but tool rows
   carry their full input and output. One saved snapshot is 2.0 MB. Seven tool rows are 109–366 KB each,
   and 2.0 MB of the total is tool `text`. Nothing is compressed: the chat WebSocket uses
   `perMessageDeflate: false`, and there is no HTTP compression.
2. **The socket gives up.** On a slow link, the first WebSocket snapshot does not arrive within
   `FIRST_SNAPSHOT_TIMEOUT` (30 s). The client falls back to `GET /api/sessions/:id/chat`.
3. **The body can arrive broken.** An interrupted or unparsable 2xx body becomes `{}` in `web/lib/api.js`
   (`response.json().catch(() => ({}))`).
4. **The fallback does not validate.** Socket snapshots are checked with `Array.isArray(next.messages)`,
   but the HTTP fallback (`chat-stream-transport.js` `fallback`) and `choose()` (conversation binding)
   pass the value to `useChatStream.accept` unchecked. `accept` reads `next.messages.length` and throws.

## Goals

1. A broken or invalid chat response never crashes the chat. It counts as a failed attempt, the user
   sees an explanation, and the chat recovers on the next valid snapshot.
2. Chat snapshots stay small regardless of tool output size. The full output is available on demand.
3. API responses and chat WebSocket frames are compressed.

Non-goals:
- Changing `api()`'s handling of unparsable bodies, which affects many callers.
- Changing the 50-message window, transport timeouts, or terminal WebSocket compression.
- Delta reload on session switch. That is a separate follow-up.

## 1. Invalid snapshot handling (client)

- A shared validator, `isChatSnapshot(value)` in `web/features/chat/chat-sync.js`, returns true for a
  non-null object with an array `messages`.
- **Socket path:** `chat-stream-transport.js` uses the validator instead of its inline check.
- **HTTP fallback:** the read result must pass the validator. If it fails, the transport reports
  `onError(copy.invalidSnapshot)` and does not call `onSnapshot`. The existing retry and backoff then
  continue, and the next valid snapshot clears the error, as the socket path already does.
- **`useChatStream.choose`:** rejects an invalid bind response with the same message. `ConversationPicker`
  shows it in its existing error slot.
- **Copy:** `invalidSnapshot`, in German and English. EN: "The chat could not be loaded completely. Retrying…"

## 2. Tool output truncation (server and client)

**Where.** In `ChatImages.decorate` (`server/features/chat/chat-images.js`). Every client-bound chat
payload passes through it: live read, WebSocket stream, delta encoding, and history pages
(`decoratePage`). Persisted server snapshots and provider parsing are unchanged.

**Rule.** Applies to rows with `role: "tool"` whose `text` exceeds `TOOL_TEXT_LIMIT` = 16 KiB, measured in
UTF-16 code units (`text.length`):
- The text becomes the first 12 KiB, a marker line, and the last 4 KiB.
- The marker is the literal `\n… [agentpier:truncated] …\n`, and the client renders it with localized text.
  Cuts never split a surrogate pair.
- The row gains `truncated: { length: <original text.length> }`.
- Rows at or below the limit, and all non-tool rows, are untouched. `fileChanges` is unaffected, because it
  is derived from tool input.

**Full text store.** A new module `server/features/chat/tool-text-store.js`:
- Holds the full text of truncated rows in an in-memory map, keyed by `JSON.stringify([sessionId, messageId])`
  with the value `{ text, providerSessionId }`.
- Is bounded at 32 MiB total, counting `text.length * 2` bytes, and evicts least recently used entries.
  A single text larger than the bound is not stored.
- Is not persisted.
- `decorate` stores each truncated row's full text.

**Endpoint.** `GET /api/sessions/:id/chat/messages/:messageId/text`, behind `requireLogin` like all `/api`
routes:
- Returns `{ text }` with `no-store`.
- Returns 404 with code `CHAT_TEXT_UNAVAILABLE` and a translated server message when the entry is
  missing, evicted, or from another provider session than the session's current binding.

**Client.**
- A truncated tool row renders the preview and a localized marker in place of the literal marker line.
  It also shows a button "Load full output (366 KB)", sized from `truncated.length`.
- Clicking it fetches the endpoint and renders the full text with the existing `ToolOutput` (preview lines,
  "more output"). The fetched text is kept in component state for that row.
- On error, the server's translated message replaces the button. The button stays available for retry.
- The raw view in `ToolChanges` uses the same component.
- `ToolOutput`'s leading-JSON block parse falls back to plain text when the JSON is cut, which is
  acceptable for a preview.

**Expected effect.** The 2.0 MB example snapshot drops to about 150 KB before compression.

## 3. Compression

**HTTP.**
- Add the `compression` npm dependency and mount it in `server/app.js` after the security, build and
  authentication middleware, before routes and static files.
- A filter compresses only when `compression.filter` accepts the response and the response does not set
  `Content-Disposition: attachment`. File downloads, archives, and image and octet-stream responses stay
  uncompressed.
- Threshold 1 KiB. This also compresses static JS and CSS.
- `Cache-Control` headers are not changed.

**Chat WebSocket.**
- `server/http/chat-websocket.js` enables `perMessageDeflate` with `threshold: 1024`,
  `serverNoContextTakeover: true`, `clientNoContextTakeover: true`, and `zlibDeflateOptions: { level: 6 }`.
- The terminal WebSocket stays `perMessageDeflate: false`.

**Provisioning.** `compression` is a regular dependency installed by `npm ci` and the release build. No
installer change is needed. Verify that the release archive includes production dependencies.

## 4. Testing

- **Unit:**
  - `isChatSnapshot`.
  - Transport: the HTTP fallback returning `{}` calls `onError(invalidSnapshot)` and never `onSnapshot`.
    A later valid socket snapshot clears the error.
  - `choose` rejects an invalid bind response.
  - The truncation function covers the limit boundary, head and tail, the marker, the surrogate-pair
    boundary, non-tool rows, and that the `truncated.length` metadata is set.
  - `ToolTextStore` covers the byte bound, LRU eviction, a single oversized text, and provider-session
    mismatch.
- **Integration/blackbox:**
  - A fixture session with a 200 KB tool output yields a truncated row via `GET /chat`, the WebSocket,
    and `/chat/history`.
  - The text endpoint returns the original. An unknown message id gets a 404 `CHAT_TEXT_UNAVAILABLE`.
  - JSON API responses carry `Content-Encoding: gzip` when the client accepts it. A file download does not.
  - The chat WebSocket negotiates `permessage-deflate`.
- **Playwright (Chromium and WebKit):** opening a truncated tool row, loading the full output, and the error
  state, in English and German.
- **i18n:** parity tests for the new keys.

## 5. Documentation

Update `docs/chat-observability.md` or the most fitting chat doc with the truncation rule, the full-text
endpoint, and the compression settings.
