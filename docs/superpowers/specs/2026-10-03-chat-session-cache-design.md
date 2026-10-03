# Chat session cache and delta reload

## Problem

Switching sessions reloads the whole chat every time.

- `App.jsx:242` keys `SessionWorkspace` by session id, and `ChatView` is keyed by `[id, accountId, tool, createdAt]`. Every switch therefore unmounts the chat state: the live snapshot, the older pages loaded with `loadOlder`, and the scroll position.
- The chat WebSocket (`server/http/chat-websocket.js`) starts every connection with a full snapshot. Its per-connection `cursor` begins undefined, and the client never sends a base cursor.
- `GET /api/sessions/:id/chat?cursor=` supports deltas, but the client never uses it.
- WebSocket and HTTP each create their own `ChatSync`. Cursors expire after 120 s, and each scope keeps at most 8. In practice a running session's cursor is evicted within seconds.
- After a PWA resume or restart, the chat loads a full snapshot again.

## Goals

1. Switching back to a recently used session shows its chat at once — messages, loaded older pages and scroll position — and only fetches new or changed messages.
2. Reopening the app after iOS terminated the PWA shows recently used chats from the device as soon as the workspace can render. That still waits for `/auth/status` and `/api/state`. The client then applies the delta.
3. Cached content never pretends to be live. The connection indicator reads "connected" only after the first server frame has been accepted. Live-only state (native prompts, running subagents, running tools) is never shown from cache. Sending is never blocked.
4. Cached chat data is bounded, and it is removed on logout, on login expiry (including expiry detected at startup or on refresh), on a login change in another tab, and when a session no longer exists.

Non-goals:
- Server-side persistence of delta cursors across server restarts. After a restart the first frame is full.
- Caching terminal or files views, model lists or conversation choices.
- Offline chat use.
- Clearing drafts, outbox, uploads, or the browser HTTP cache of immutable tool images on logout. Those have their own lifecycle; it is documented, not changed, here.

## 1. Server: base cursors

**WebSocket base cursor**
- `attachChatWebSocket` reads an optional `cursor` query parameter from the upgrade URL. It is accepted only as a string of at most 64 characters matching `^[A-Za-z0-9-]+$`; anything else is ignored.
- The per-connection `cursor` starts with this value, so the first frame is `ChatSync.encode(session, snapshot, cursor)`:
  - a delta when the cursor is known for the same scope;
  - otherwise a full frame.
- Sequence numbering still starts at 1 per connection.

**Shared `ChatSync`**
- A single `ChatSync` instance lives in the application services, built with `{ sessions, chatImages }`. The WebSocket handler and `routes/chat.js` both use it.
- `ChatSync.read` (HTTP) normalizes `nativeInput: null` into the snapshot before encoding. Identical rows then hash identically over HTTP and WebSocket, and a needless new cursor is avoided.

**Parked cursors**
- When a WebSocket connection closes, its last cursor is "parked": it moves to a separate parked map, keyed by cursor and holding the same entry, and it does not count against the 8-per-scope limit.
- The parked map holds at most 2 cursors per scope and 256 in total, expiring after 30 minutes.
- `encode` checks active entries first, then parked ones.
- Parked entries count toward `maxBytes`.

**Bounds**
- `maxBytes` rises from 4 MiB to 16 MiB.
- TTL rises from 120 s to 30 min.
- `maxEntries` rises from 128 to 512.
- The per-scope limit stays at 8.

**Cleanup:** `DELETE /sessions/:id` discards the session's `ChatSync` entries, active and parked.

## 2. Client transport

**Seeded start.** `createChatStream` (`web/features/chat/chat-stream-transport.js`) accepts an optional `initial` snapshot. It is used only if it passes `isChatSnapshot` and has a string `sync.cursor`. The transport keeps it as its baseline `snapshot`.
- Every socket connection, including reconnects after failures and visibility changes, appends `?cursor=<baseline sync.cursor>` when a baseline cursor exists.
- A delta first frame is applied with `applyChatSync` against the baseline. A full frame replaces the baseline.
- If a delta fails validation, the baseline cursor is dropped and the transport reconnects without a cursor, as today.

**HTTP fallback.** The fallback `read(signal, cursor)` receives the baseline cursor and requests `GET /chat?cursor=`. A delta response is applied against the baseline, with the existing revision guard. A full response replaces the baseline.

**Connection state.**
- `onConnection("connected")` fires only after the first frame of a connection has been accepted, from the socket or from the fallback.
- From socket open until that point the transport reports `"connecting"`, a new state. Before the socket opens it reports `"disconnected"`, as today.
- The workspace indicator (`SessionWorkspace.jsx:256-264`) maps `"connecting"` to the existing non-connected presentation. If a distinct label is added, it is translated in both languages.

## 3. Client chat session cache

`web/features/chat/chat-session-cache.js` provides:
- `preloadChatCache()`
- `peekCachedChat(key)` (synchronous, memory)
- `writeCachedChat(key, entry, { create })`
- `forgetCachedChat(sessionId)`
- `retainCachedChats(validKeys)`
- `clearChatCache()`

**Key.** `JSON.stringify([session.id, session.accountId, session.tool, session.createdAt])`.

**Entry.**
```
{ version: 1, build, key, sessionId, savedAt, accessedAt, size,
  live, older, cursor, paged, scroll: { anchorId, offset, stick } }
```
- **`live`:** the latest accepted snapshot, with `nativeInput` removed before storing.
- **`build`:** `currentBuild()` from `web/lib/build-check.js`.
- **`size`:** `JSON.stringify(entry).length` computed once at write time.
- **Restorable entries only:** snapshots with `availability !== "ready"` or no messages are not cached.

**Older rows bound.**
- If more than 300 rows have been loaded (`older`), the entry stores `older: []`, `cursor: live.history.cursor`, `paged: false`, and `scroll.stick: true`. Pagination is never left with a gap.
- The memory layer keeps the full in-session state, so this reset applies only to the device layer.

**Memory layer.** A module-level `Map` in LRU order, at most 12 sessions. It is filled by `preloadChatCache()` and by every write.

**Device layer.** IndexedDB database `agentpier.chat.cache.v1`, object store `sessions`, keyed by `key`. It follows the open/upgrade/blocked handling of `chat-upload-store.js`.
- **Preload.** `preloadChatCache()` runs at app boot, in parallel with the auth check. It loads valid entries into the memory layer. Entries are dropped if `version !== 1`, if `build` differs from `currentBuild()` (when both exist), if `live` is invalid, or if message ids are not unique.
- **Eviction.** Inside a single readwrite transaction, keep at most 12 entries and a total `size` of at most 8 MB, evicting by smallest `accessedAt`.
- **Write timing.** Writes go to the device:
  - on `visibilitychange` to hidden;
  - on chat unmount;
  - on session switch;
  - otherwise at most every 5 s.

  `pagehide` is not relied on.
- **Unavailable storage.** All access is wrapped. If IndexedDB is unavailable, blocked or throws, the cache is memory-only.
- **Persistent storage.** `navigator.storage?.persist?.()` is requested once, best effort.

**Privacy: generation and tombstones**
- The cache has a generation counter. `clearChatCache()` increments it, empties the memory layer, and runs `store.clear()`. Every queued or in-flight write captured under an older generation is discarded.
- `forgetCachedChat(sessionId)` deletes that session's entries and records an in-memory tombstone. Later writes for that session are dropped until a new mount with a fresh, accepted server frame.
- **Update-only writes.** Unmount and scroll writes pass `create: false`: they merge into an existing record and never create one.
- **When the cache is cleared** (`clearChatCache()`):
  - whenever `LoginGate` sees `authenticated === false`, including at startup and on periodic or focus refresh;
  - on `agentpier-login-required`;
  - on the `agentpier-auth-change` storage event;
  - on logout.
- **Pruning.** On each workspace state update (`/api/state`), `retainCachedChats` keeps only keys of sessions that still exist. This covers deletions from other devices, released sessions, and account switches. Session deletion in this client also calls `forgetCachedChat`.

## 4. Using the cache in the chat

**Seeding**
- `useChatStream` seeds synchronously: the `useState`/`useRef` initializers read `peekCachedChat(key)`.
- The `[session.id]` reset effect (`useChatStream.js:80-95`) must not wipe a seed taken for the same key, and must not override a restored `stick`.
- No asynchronous wait happens on mount. Preload has already filled memory, or the chat connects without a cache.

**Restored data is marked as not live.** The seeded `data` is published with:
- `nativeInput: null`;
- `observability: { ...observability, stale: true }`, which makes `ChatObservability` show its existing "stale" label and stops `ChatTranscript` from treating the snapshot as live;
- `clientObservedAt` left undefined;
- a client-only `restored: true`.

**Effects of `restored`**
- Until the first accepted frame:
  - `ChatView` does not render native limit warnings;
  - `ChatView` does not show running subagents as running;
  - `useChatController` does not derive `nativeDeliveryStates`.
- `send()` does not pass a cached `providerSessionId` as reset context before the first accepted frame.
- `loadOlder` is disabled until the first accepted frame, including the automatic trigger near the top.

**First accepted frame**
- The existing `accept` rules apply: a changed provider or generation, a disjoint window, or empty messages reset `older` and `paged`.
- On a reset the chat sticks to the bottom instead of restoring the scroll position.
- `restored` is cleared and the transport reports `"connected"`.

**Transport re-creation.** The stream effect re-creates the transport when `session.status`, `restartGeneration` or `restart` changes. On every creation it passes `initial: state.current.live` if that has a `sync.cursor`, so re-creation does not force a full frame.

**Writing**
- After each accepted frame and each `loadOlder`, the memory layer is updated and a device write is scheduled per the policy above.
- Tombstoned or cleared generations are respected.

**Scroll.** `useChatController` stores `{ anchorId, offset, stick }`:
- `anchorId` is the id of the first fully visible message row;
- `offset` is its distance from the viewport top;
- `stick` comes from the existing ref.

On restore, `stick: true` scrolls to the bottom. Otherwise the view scrolls the anchor row into position with `offset`; if the anchor is missing, it sticks to the bottom.

## 5. Testing

**Unit**
- Cache store, with an injected fake IndexedDB adapter:
  - memory LRU of 12;
  - device eviction by `accessedAt` within entry and size bounds;
  - version, build, key and id-uniqueness validation;
  - the older-overflow reset;
  - `nativeInput` stripped before storing;
  - generation discard: a write queued before `clearChatCache` is dropped;
  - tombstones;
  - update-only writes;
  - `retainCachedChats`;
  - unavailable storage falls back to memory-only.
- Transport:
  - `initial` puts the cursor in the socket URL;
  - reconnects use the latest cursor;
  - a delta first frame is applied;
  - an invalid delta reconnects without a cursor;
  - the fallback sends the cursor and applies a delta;
  - `"connected"` fires only after the first accepted frame, with `"connecting"` in between;
  - re-creation with `initial` keeps the cursor.
- Server `ChatSync`:
  - a parked cursor survives 8+ later frames in the same scope and yields a delta;
  - parked bounds and TTL;
  - `nativeInput` normalization keeps the HTTP cursor stable;
  - deletion discards the scope.

**Integration**
- The WebSocket gives a delta first frame for a known `?cursor=`, and a full frame for an unknown or malformed one.
- A WebSocket-issued cursor works for `GET /chat?cursor=` and the reverse.
- A cursor parked on connection close still yields a delta after other connections have produced 8+ frames.

**Playwright (Chromium and WebKit)**
- Switching A → B → A shows A immediately. The server's first frame is held back with `page.routeWebSocket` or by delaying the chat stream route.
- While the first frame is held back:
  - the indicator is not "connected";
  - no native limit warning is shown;
  - the observability panel shows its stale label.
- After the frame, the first frame was a delta and the scroll anchor is restored.
- A page reload shows the cached chat before the first frame.
- Logout, and login expiry detected on refresh, both leave no cached chat. Check IndexedDB via `page.evaluate`.
- The existing `chat-sync.spec.js` keeps passing.

**i18n:** parity for any new copy (for example a "connecting" label).

## 6. Documentation

`docs/mobile-recovery.md`:
- the memory and device cache layers, their bounds, build and version invalidation, and the clearing rules;
- the WebSocket base cursor, the shared `ChatSync`, parked cursors, and the 30-minute lifetime;
- that "connected" means the first frame was accepted;
- what intentionally survives logout: drafts, outbox, uploads, and the HTTP cache of immutable tool images.
