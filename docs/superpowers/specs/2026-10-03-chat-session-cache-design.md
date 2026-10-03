# Chat session cache and delta reload

## Problem

Switching sessions reloads the whole chat every time.

- `App.jsx:241` keys `SessionWorkspace` by session id. `ChatView` is also keyed by `[id, accountId, tool, createdAt]`. Every switch therefore unmounts the chat state: the live snapshot, the older pages loaded with `loadOlder`, and the scroll position.
- The chat WebSocket (`server/http/chat-websocket.js`) starts every connection with a full snapshot, because its per-connection `cursor` begins undefined. The client never sends a base cursor.
- `GET /api/sessions/:id/chat?cursor=` already supports deltas, but the client never uses it.
- WebSocket and HTTP each create their own `ChatSync`, so a cursor from one is unknown to the other. `ChatSync` forgets cursors after 120 s.
- After a PWA resume or restart, the chat loads a full snapshot again.

## Goals

1. Switching back to a recently used session shows its chat immediately: the messages, the loaded older pages, and the scroll position. Only new or changed messages are fetched.
2. Reopening the app after iOS has terminated the PWA shows recently used chats immediately from the device, then applies the delta.
3. Cached content never pretends to be live. The connection indicator stays truthful until the server has confirmed. Sending stays possible at all times.
4. Cached chat data is removed on logout, on a login change in another tab, and when a session is deleted. It is bounded in size.

Non-goals:
- Server-side persistence of delta cursors across server restarts. After a restart, the first frame is a full snapshot.
- Caching for terminal or files views, model lists or conversation choices.
- Offline chat use. Without a server, the existing offline behavior applies.

## 1. Server: base cursor for the chat WebSocket

- **Base cursor.** `attachChatWebSocket` reads an optional `cursor` query parameter from the upgrade URL. The current regex matches only the pathname. Accept the parameter only if it is a string of at most 64 characters matching `^[A-Za-z0-9-]+$`; otherwise ignore it.
- **First frame.** The per-connection `cursor` starts with that value, so the first frame is `ChatSync.encode(session, snapshot, cursor)`:
  - a delta when the cursor is known for the same scope;
  - otherwise a full snapshot, as today.
- **Sequence.** Numbering still starts at 1 per connection.
- **One shared `ChatSync`.** Create a single `ChatSync` instance in the application services and use it in both the WebSocket handler and `routes/chat.js`. Cursors then work across both transports.
- **Cursor lifetime.** Raise `ChatSync`'s default TTL from 120 s to 30 min.
  - Keep `maxBytes` (4 MiB) as the bound. Entries hold only per-message hashes.
  - Raise `maxEntries` from 128 to 512.
  - Keep the 8-per-scope limit.

## 2. Client: transport seeded from a cache

`createChatStream` (`web/features/chat/chat-stream-transport.js`) accepts an optional `initial` snapshot, which must pass `isChatSnapshot` and carry a `sync.cursor`.

- The transport stores it as its baseline `snapshot`.
- The socket URL includes `?cursor=<initial.sync.cursor>` for the first connection.
- **Reconnects.** Each reconnect, including the one after a visibility change, uses the cursor of the latest accepted snapshot. A first frame that is a delta is applied with the existing `applyChatSync` against the baseline. A full frame replaces the baseline.
- **Invalid delta.** If a delta fails validation (for example after a server restart where the server sent a full frame, or a base mismatch), the transport drops the baseline cursor and reconnects without a cursor, as today.
- **HTTP fallback.** The fallback read sends `?cursor=` with the baseline cursor and applies a delta response the same way. A full response replaces the baseline.

## 3. Client: chat session cache

A new module `web/features/chat/chat-session-cache.js` exposes:
- `readCachedChat(key) → Promise<entry | null>`
- `writeCachedChat(key, entry)`
- `forgetCachedChat(sessionId)`
- `clearChatCache()`

**Key.** `JSON.stringify([session.id, session.accountId, session.tool, session.createdAt])`, the same identity `ChatView` is keyed by.

**Entry.**
```
{ version: 1, savedAt, live, older, cursor, paged, scroll: { top, stick } }
```
- `live` is the latest accepted snapshot, including `sync.cursor`.
- `older` holds at most the newest 200 rows that rolled out of or were paged before the live window.
- `cursor` and `paged` are the history pagination state.

**Memory layer.** A module-level `Map`, kept in least-recently-used order, holding at most 12 sessions. Switching within one page load is served synchronously from it.

**Device layer.** IndexedDB database `agentpier-chat-cache`, store `sessions`.
- Bounded to 12 entries and about 8 MB, measured as the `JSON.stringify` length of the stored entries. The least recently used entries are evicted first.
- Writes are debounced (500 ms) and also flushed on `pagehide` and `visibilitychange` to hidden.
- Reads validate `version === 1`, the key, and `isChatSnapshot(live)`. Invalid entries are deleted.
- All IndexedDB access is wrapped. If IndexedDB is unavailable, blocked or throws (for example in private mode), the cache silently becomes memory-only, and nothing else breaks.

**What is stored.** Only what the chat payload already contains:
- Truncated tool text stays truncated.
- Tool images are stored as references only; the bytes are not stored.
- Nothing from drafts, outbox or uploads is stored. They keep their own storage.

**Clearing.**
- **Logout:** `LoginGate` logout and the `agentpier-login-required` expiry call `clearChatCache()`.
- **Login change in another tab:** the existing `agentpier-auth-change` storage event also clears the cache.
- **Session deletion:** removing a session in the UI calls `forgetCachedChat(id)`.

## 4. Client: using the cache in the chat

**On mount.** `useChatStream`:
1. Reads the memory layer synchronously. On a miss it reads the device layer asynchronously before connecting, with a 300 ms budget; if the budget runs out, it connects without a cache.
2. On a hit, seeds `state.current` with `live`, `older`, `cursor` and `paged`, publishes `data` immediately, and passes `initial: live` to `createChatStream`.

The existing `accept` invalidation rules still apply to the first server frame:
- a changed `providerSessionId`
- a changed `history.generation`
- a disjoint window
- empty messages

Any of these resets `older` and `paged`, as today, and the cache entry is overwritten by the new state.

**Writing.** After every `accept` and every `loadOlder`, the hook writes the current `live`, the newest 200 `older` rows, `cursor` and `paged` to the cache. On unmount it also writes the scroll state.

**Scroll restore.** `useChatController` saves `{ top, stick }` from its existing `scroll` and `stick` refs. When the chat is restored from the cache:
- with `stick: true`, it scrolls to the bottom (the existing behavior);
- otherwise it restores `top` after the first render. The existing anchor logic for older pages stays unchanged.

**Connection state.** A cached chat shows the existing connection indicator, which reads "connecting" or "disconnected" until the socket is open and the first frame has been accepted. Composer behavior is unchanged: sending is never blocked.

**Older pages after a restart.** The cached history `cursor` may be unknown to the server after a server restart. The existing `readOlderPage` already handles a 409 by retrying from the live cursor and skipping known rows. A new test covers that this still works with cached `older` rows.

## 5. Testing

**Unit**
- `chat-session-cache`:
  - memory LRU of 12;
  - device bounds on entries and bytes, with eviction order;
  - version, key and snapshot validation;
  - `clearChatCache` and `forgetCachedChat`;
  - IndexedDB unavailable or throwing falls back to memory-only. Use a fake IndexedDB, or inject the storage adapter.
- Transport:
  - `initial` puts the cursor in the socket URL;
  - a delta first frame is applied against the baseline;
  - an invalid delta reconnects without a cursor;
  - the fallback read sends the cursor and applies a delta;
  - reconnects after a visibility change use the latest cursor.
- Server `ChatSync`: the 30-minute TTL and the new `maxEntries` default.

**Integration**
- The chat WebSocket with a known `?cursor=` sends a delta first frame. An unknown or invalid cursor gets a full frame. A malformed cursor is ignored.
- A cursor issued over WebSocket works for `GET /chat?cursor=` and the other way round, because the `ChatSync` is shared.

**Playwright (Chromium and WebKit)**
- Switching from session A to B and back to A shows A's messages immediately, before any new frame. The first frame after the switch is a delta. The scroll position is restored when not at the bottom.
- A page reload shows the chat from IndexedDB before the socket frame arrives.
- Logout leaves no cached chat after logging in again.
- The existing `chat-sync.spec.js` keeps passing.

**i18n:** no new copy is expected. If any is added, both catalogs get it.

## 6. Documentation

Extend `docs/mobile-recovery.md`:
- the session cache: the memory and device layers, their bounds, and when they are cleared;
- WebSocket base cursors, and the shared 30-minute `ChatSync`.
