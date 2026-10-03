# Chat Session Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switching sessions or reopening the app shows cached chats at once, fetches only deltas, never presents cached state as live, and clears cached data on logout.

**Architecture:**
- **Server:** one shared `ChatSync` serves both WebSocket and HTTP. The WebSocket accepts a base `?cursor=`, and a connection's cursor is parked when it closes.
- **Client transport:** seeded with an initial snapshot, sends its cursor, and reports `"connected"` only after the first accepted frame.
- **Cache:** a new memory + IndexedDB module with generation-based clearing.
- **Chat hooks:** seed synchronously from the cache, mark restored data as not live, and restore scroll by message anchor.

**Tech Stack:** Node.js 22 ES modules, Express 5, ws 8, React 19, IndexedDB, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-03-chat-session-cache-design.md` (binding; read the relevant section for every task).

## Global Constraints

- **WebSocket cursor:** an optional query parameter `cursor`. It is accepted only as a string of at most 64 characters matching `^[A-Za-z0-9-]+$`; anything else is ignored.
- **`ChatSync`:** one instance in services, shared by `chat-websocket.js` and `routes/chat.js`.
  - Defaults: TTL 30 min, `maxEntries` 512, `maxBytes` 16 MiB, per-scope limit 8.
  - Parked cursors: at most 2 per scope, 256 in total, 30 min TTL. They are outside the per-scope limit and count toward `maxBytes`.
  - The HTTP read normalizes `nativeInput: null`.
  - `DELETE /sessions/:id` discards the scope.
- **Transport connection states:** `"disconnected"` (no socket), `"connecting"` (socket open, no frame accepted yet), `"connected"` (after the first accepted frame), `"ended"`. The indicator already has `commonCopy.connecting`.
- **Cache key:** `JSON.stringify([session.id, session.accountId, session.tool, session.createdAt])`.
- **Cache entry:** `{ version: 1, build, key, sessionId, savedAt, accessedAt, size, live, older, cursor, paged, scroll: { anchorId, offset, stick } }`.
  - `nativeInput` is never stored.
  - Entries are cached only when `availability === "ready"` and there are messages.
  - The device layer stores at most 300 older rows. On overflow it stores `older: []`, `cursor: live.history.cursor`, `paged: false`, `stick: true`.
- **Memory layer:** at most 12 entries.
- **Device layer:** IndexedDB `agentpier.chat.cache.v1`, store `sessions`, keyed by `key`.
  - Bounds: at most 12 entries and a total `size` of 8,000,000, evicted by smallest `accessedAt` in one readwrite transaction.
  - Writes happen on hidden, unmount and switch, otherwise at most every 5 s.
  - If IndexedDB is unavailable or throws, the cache is memory-only.
  - `clearChatCache` uses `store.clear()`.
- **Clearing:**
  - A generation counter: writes queued or in flight from an older generation are discarded.
  - `forgetCachedChat` leaves tombstones.
  - Unmount and scroll writes are update-only.
  - Clear on `authenticated === false` in `LoginGate` (at startup, on refresh or focus, and on logout), on `agentpier-login-required`, and on the `agentpier-auth-change` storage event.
  - Prune via `retainCachedChats` on every workspace state update. `forgetCachedChat` runs on session delete in `AppDialogs.jsx`.
- **Restored data:** `nativeInput: null`, `observability.stale = true`, no `clientObservedAt`, `restored: true`.
  - Until the first accepted frame: no native limit warnings, no running subagents, no `nativeDeliveryStates`, no cached `providerSessionId` as reset context, and `loadOlder` disabled.
  - A reset on the first frame sticks to the bottom.
- UI and server strings exist in de and en. Files have at most 600 lines and follow Prettier. Tests never touch real sessions or the default tmux server.
- Commits use English `feat:`/`fix:`/`chore:` prefixes and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A write queued just before logout must not recreate a cache entry after `clearChatCache()`. Pinned in Task 3.
2. Between socket open and the first frame, the indicator must not say "connected". Pinned in Task 2.
3. A running session whose cursor got 8+ newer frames from other tabs still gets a delta on return, via a parked cursor. Pinned in Task 1.
4. A cached chat restored near the top must not auto-trigger `loadOlder` before the first frame. Pinned in Task 5.
5. If IndexedDB is unavailable, as in iOS private mode, the chat works without errors. Pinned in Task 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/features/chat/chat-sync.js` | Parked cursors, new defaults, `discard(sessionId)`, HTTP `nativeInput` normalization |
| `server/app.js` (or services wiring), `server/http/chat-websocket.js`, `server/http/routes/chat.js`, `server/http/routes/sessions.js` | Shared instance, cursor parameter, parking on close, discard on delete |
| `web/features/chat/chat-stream-transport.js` | `initial`, cursor in URL and fallback, `"connecting"` state |
| `web/features/chat/chat-session-cache.js` (new) | Memory + device cache, generation, tombstones, retain, clear, preload |
| `web/features/chat/chat-cache-store.js` (new) | Thin IndexedDB adapter (open, getAll, put, delete, clear, evict), injectable for tests |
| `web/main.jsx`, `web/features/login/LoginGate.jsx`, `web/app/useWorkspaceState.js`, `web/app/AppDialogs.jsx` | Preload, clearing, retain, forget |
| `web/features/chat/useChatStream.js`, `useChatController.js`, `ChatView.jsx` | Seeding, `restored` handling, `loadOlder` gate, writes, scroll anchor |
| `docs/mobile-recovery.md` | Documentation |

---

### Task 1: Server — shared ChatSync, WebSocket base cursor, parked cursors

**Files:**
- Modify: `server/features/chat/chat-sync.js`, `server/http/chat-websocket.js`, `server/http/routes/chat.js`, `server/http/routes/sessions.js`, plus the place where services are assembled (`server/app.js` / `createServices`; find where `chatImages` is created).
- Test: `tests/unit/chat-sync.test.js` (extend), `tests/integration/chat-websocket.test.js` (extend)

**Interfaces:**
- Produces:
  - `services.chatSync`, a `ChatSync`.
  - `ChatSync#park(cursor)`, called when a WebSocket connection closes.
  - `ChatSync#discard(sessionId)`.
  - The WebSocket accepts `?cursor=`.

- [ ] **Step 1: Write failing tests**
  - Unit (`chat-sync.test.js`):
    1. With defaults, an entry is still valid at 29 minutes and expired at 31 minutes. Inject a clock if `ChatSync` supports `now`; read the constructor.
    2. Parked cursor: encode a snapshot (cursor A), `park(A)`, then encode 9 changed snapshots in the same scope. Encoding against A then returns `sync.mode === "delta"` with `base === A`.
    3. Parked bounds: at most 2 per scope (the oldest parked cursor is dropped), and parked cursors expire after 30 minutes.
    4. `read(id, cursor)` normalizes `nativeInput: null`. Two reads of an unchanged snapshot without `nativeInput` return the same cursor, and the second is a delta with zero upserts.
    5. `discard(sessionId)` removes active and parked entries for every scope of that session.
  - Integration (`chat-websocket.test.js`, existing fixtures):
    1. Connect, take the first frame's `data.sync.cursor`, close, reconnect with `?cursor=<that>`. The first frame has `data.sync.mode === "delta"`.
    2. `?cursor=unknown-123` and `?cursor=bad%20value` both get a full first frame.
    3. A cursor issued over the WebSocket gives `GET /api/sessions/:id/chat?cursor=` a delta, and the reverse. Use the shared instance.
- [ ] **Step 2: Run the tests and confirm they fail:** `node --test tests/unit/chat-sync.test.js tests/integration/chat-websocket.test.js`
- [ ] **Step 3: Implement**
  - **`ChatSync`:**
    - New defaults per the constraints.
    - A `parked` map of `cursor → entry` with per-scope ordering.
    - `encode` looks the base up in active entries, then in parked entries.
    - Byte accounting includes parked entries, and eviction drops parked entries first when over `maxBytes`.
    - `discard(sessionId)` matches the `session.id` inside the scope JSON.
    - `read()` encodes `{ ...snapshot, nativeInput: null }`.
  - **Services:** create one `ChatSync({ sessions, chatImages })` and pass it to `attachChatWebSocket` and `chatRoutes`. Neither creates its own any more.
  - **WebSocket:** parse `new URL(req.url, "http://localhost").searchParams.get("cursor")`, validate it, and pass it with the connection. Initialize the per-connection `cursor` from it. On close, call `sync.park(cursor)` when a cursor exists.
  - **`routes/sessions.js` delete:** call `services.chatSync?.discard(req.params.id)`.
- [ ] **Step 4: Run the tests:** the focused files, then `npm run test:unit` and `npm run test:integration` (the known `shell.test.js` environment failure is allowed).
- [ ] **Step 5: Commit** `feat: resume chat streams from a base cursor with a shared sync cache`

---

### Task 2: Client transport — seeded baseline, cursor, honest connection state

**Files:**
- Modify: `web/features/chat/chat-stream-transport.js`, `web/features/chat/useChatStream.js` (only the `read` callback signature: pass the cursor as the `?cursor=` query)
- Test: `tests/unit/chat-stream-transport.test.js` (extend; reuse its fake socket, scheduler and visibility helpers)

**Interfaces:**
- Produces:
  - `createChatStream({ …, initial })`.
  - `read(signal, cursor)` is called with the baseline cursor (or `undefined`).
  - `onConnection` receives `"disconnected" | "connecting" | "connected" | "ended"`.

- [ ] **Step 1: Write failing tests**
  1. With `initial = { messages: [m1], sync: { mode: "full", cursor: "c1" } }`, the first socket URL ends with `?cursor=c1`.
  2. A first frame `{ type: "sync", sequence: 1, data: <delta with base c1> }` applies against the baseline. `onSnapshot` receives the merged messages, and the next reconnect uses the new cursor.
  3. An invalid delta first frame (wrong base) leads to a reconnect whose URL has no cursor.
  4. The fallback `read` is called with `"c1"`, and a delta response is applied.
  5. `onConnection` order: `"disconnected"` before open, `"connecting"` on open, `"connected"` only after the first accepted frame. A socket that opens and closes without a frame never reports `"connected"`.
  6. A visibility reconnect uses the latest cursor.
  7. `initial` without `sync.cursor` behaves exactly as no `initial`.
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement**
  - The baseline `snapshot` starts as `initial` when valid.
  - Build the URL with the cursor per connection.
  - Move `onConnection("connected")` from `onopen` to after the first accepted frame of the connection, and emit `"connecting"` in `onopen`.
  - On a fallback success, emit `"connected"` only if no socket is open; otherwise leave the state to the socket. Keep existing semantics for HTTP-only recovery and choose the minimal consistent rule.
  - Pass the cursor to `read`.
  - In `useChatStream`, the `read` callback appends `?cursor=${encodeURIComponent(cursor)}` when a cursor is given.
  - Check that `SessionWorkspace.jsx` already maps `"connecting"` (it uses `commonCopy.connecting`) and that `useChatStream`'s `onConnection` handler treats `"connecting"` like not connected (`nativeInput` reset).
- [ ] **Step 4: Run the tests:** `node --test tests/unit/chat-stream-transport.test.js`, then `npm run test:unit`, `npm run build`, and `tests/browser/chat-sync.spec.js` in Chromium (`npm run build` first, then `AGENTPIER_TEST_PORT=4397 AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/chat-sync.spec.js`).
- [ ] **Step 5: Commit** `feat: seed the chat stream from a cursor and report connected after the first frame`

---

### Task 3: Chat session cache module

**Files:**
- Create: `web/features/chat/chat-cache-store.js` (IndexedDB adapter), `web/features/chat/chat-session-cache.js`
- Test: `tests/unit/chat-session-cache.test.js`

**Interfaces:**
- Produces, from `chat-session-cache.js`:
  - `chatCacheKey(session) → string`
  - `preloadChatCache() → Promise<void>`
  - `peekCachedChat(key) → entry | null` (synchronous; refreshes memory recency)
  - `writeCachedChat(key, state, { create = true, flush = false } = {})`, where `state` is `{ live, older, cursor, paged, scroll? }`
  - `flushChatCache() → Promise<void>`
  - `forgetCachedChat(sessionId)`
  - `retainCachedChats(validKeys: Set<string>)`
  - `clearChatCache() → Promise<void>`
  - `restoredSnapshot(live) → live'`, which marks a snapshot as restored: `nativeInput: null`, `observability.stale = true`, no `clientObservedAt`, `restored: true`
  - `__setChatCacheStore(adapter)` for tests
- `chat-cache-store.js` exports `openChatCacheStore() → { getAll(), put(entry), delete(key), clear(), evict({ maxEntries, maxSize }) } | null`. Model it on `web/features/chat/chat-upload-store.js` (open, upgrade, blocked, errors).

- [ ] **Step 1: Write failing tests** with an in-memory fake adapter (a Map-backed object with the same async methods, and an option to throw):
  1. The memory LRU holds at most 12: writing a 13th evicts the least recently peeked or written.
  2. Entries with `availability !== "ready"` or no messages are not stored.
  3. Older overflow: `older` with 301 rows stores `older: []`, `cursor === live.history.cursor`, `paged: false`, `scroll.stick: true` on the device layer. The memory layer keeps the full rows.
  4. `nativeInput` is absent from stored entries.
  5. Preload drops entries with a wrong `version`, a mismatched `build` (stub `currentBuild` by injecting a getter), invalid `live`, or duplicate message ids.
  6. Generation: `writeCachedChat(k, s)` followed immediately by `await clearChatCache()` leaves memory and adapter empty after flush.
  7. A tombstone: after `forgetCachedChat("s1")`, a write for a key of session `s1` is dropped.
  8. Update-only: `writeCachedChat(k, s, { create: false })` creates nothing when there is no entry, and merges `scroll` into an existing one.
  9. `retainCachedChats(new Set([k1]))` removes other keys from memory and adapter.
  10. An adapter that throws on open or put leaves memory-only operation working, and nothing rejects.
  11. Device eviction: `evict({ maxEntries: 12, maxSize: 8000000 })` is called after puts, and the fake adapter's implementation evicts by smallest `accessedAt`.
  12. `restoredSnapshot` sets the fields above.
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement**
  - The adapter does eviction inside one readwrite transaction (`getAll`, sort by `accessedAt`, delete until within bounds).
  - The cache module holds the memory `Map`, the generation, the tombstone `Set`, and a write queue with a 5 s throttle.
  - Flush on `document.visibilitychange` to hidden; register this once, guarded for non-browser environments.
  - Call `navigator.storage?.persist?.()` once, best effort, inside try/catch.
  - Wrap all IndexedDB promises; a failure switches to memory-only.
- [ ] **Step 4: Run the tests:** `node --test tests/unit/chat-session-cache.test.js`, then `npm run test:unit`, `npm run lint`.
- [ ] **Step 5: Commit** `feat: add a bounded chat session cache with device persistence`

---

### Task 4: Wire preload and privacy clearing

**Files:**
- Modify: `web/main.jsx` (call `preloadChatCache()` at boot, without awaiting before render), `web/features/login/LoginGate.jsx`, `web/app/useWorkspaceState.js`, `web/app/AppDialogs.jsx:105`
- Test: `tests/browser/chat-session-cache.spec.js` (new; privacy part), plus unit tests where pure

**Interfaces:**
- Consumes Task 3's `preloadChatCache`, `clearChatCache`, `retainCachedChats`, `forgetCachedChat` and `chatCacheKey`.

- [ ] **Step 1: Write failing tests.** Browser, using existing browser fixtures and patterns from `tests/browser/chat-sync.spec.js`:
  1. After a chat has been shown and flushed (trigger `visibilitychange` hidden via `page.evaluate`, or wait 5 s), logging out leaves `indexedDB` `agentpier.chat.cache.v1`/`sessions` empty. Check via `page.evaluate`.
  2. Make `/auth/status` return `authenticated: false` on the next refresh (route mock), then trigger `window` focus. The store becomes empty.
  3. Deleting a session in the UI removes its entry.
  4. A workspace state without session X removes X's entry.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement**
  - `LoginGate`: call `clearChatCache()` whenever a status with `authenticated === false` is set, at startup or refresh, in `expired()` (`agentpier-login-required`), in the `agentpier-auth-change` storage handler, and in `logout()`.
  - `useWorkspaceState`: after `setState(data)`, call `retainCachedChats(new Set(data.sessions.map(chatCacheKey)))`.
  - `AppDialogs`: after a successful session `DELETE`, call `forgetCachedChat(item.id)`.
  - `main.jsx`: `preloadChatCache()` fire-and-forget at boot.
- [ ] **Step 4: Run the tests:** `npm run build`, then the new spec in Chromium and WebKit, `npm run test:unit`, `npm run lint`.
- [ ] **Step 5: Commit** `feat: preload the chat cache and clear it on logout and session removal`

---

### Task 5: Use the cache in the chat (seeding, not-live marking, scroll)

**Files:**
- Modify: `web/features/chat/useChatStream.js`, `web/features/chat/useChatController.js`, `web/features/chat/ChatView.jsx` (and the component rendering limit warnings or subagents if separate)
- Test: extend `tests/browser/chat-session-cache.spec.js`; unit-test pure helpers if you extract any (for example the scroll anchor computation)

**Interfaces:**
- Consumes `peekCachedChat`, `writeCachedChat`, `restoredSnapshot` and `chatCacheKey`, and Task 2's `initial` and connection states.
- Produces `useChatStream` returning a `restored: boolean` flag (true until the first accepted frame after seeding).

- [ ] **Step 1: Write failing browser tests**, with the server's first chat frame held back. Use `page.routeWebSocket` on `**/chat-stream*`, forwarding to the real server and delaying the first server message until released; check that the repo's Playwright version supports `routeWebSocket`, otherwise delay via a test hook route.
  1. Open session A and scroll up to an anchor (not the bottom). Switch to B, then back to A. Before the first frame is released:
     - A's messages are visible;
     - the indicator is not "Connected"/"Verbunden";
     - the observability panel shows its stale label;
     - no native limit warning is shown, even if A's cached snapshot had `nativeInput` with limit info (use a fixture snapshot);
     - the anchor message is at its previous offset (±4 px).
  2. After release, the first frame received by the client is a delta (inspect via the route), the indicator becomes "connected", and the stale label disappears unless the server snapshot is stale.
  3. With the session restored near the top (`scrollTop < 100`), no request to `/chat/history` happens before release.
  4. A page reload shows A's cached messages before the first frame.
  5. If the first frame resets (different `providerSessionId`), the view sticks to the bottom.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement**
  - **`useChatStream`:**
    - Compute `key` via `chatCacheKey(session)`.
    - Seed `state.current` (`live`, `older`, `cursor`, `paged`) and `data` in the initializers from `peekCachedChat(key)`, publishing `restoredSnapshot(live)` merged with `older`.
    - Adapt the `[session.id]` reset effect so it keeps a seed for the same key.
    - Pass `initial: state.current.live` (when it has `sync.cursor`) on every `createChatStream` call.
    - Clear `restored` in `accept`.
    - Block `loadOlder` while `restored`.
    - After `accept` and `loadOlder`, call `writeCachedChat(key, { live, older, cursor, paged })`.
    - On unmount, call `writeCachedChat(key, { scroll }, { create: false, flush: true })`.
  - **`useChatController`:**
    - Compute the scroll anchor (the first fully visible `[data-message-id]` row; add that attribute in the message list if missing) and its offset from the existing `scroll` and `stick` refs.
    - Restore after the first render of seeded data.
    - Do not override a restored `stick` on the first frame unless the frame reset the window.
    - While `restored`, return no `nativeDeliveryStates` and do not pass the cached `providerSessionId` as reset context in `send()`.
  - **`ChatView`:** while `restored`, hide native limit warnings and render subagents as not running. The `stale` observability already does the latter; verify it.
- [ ] **Step 4: Run the tests:**
  - `npm run build`;
  - the new spec plus `tests/browser/chat-sync.spec.js`, `tests/browser/chat.spec.js` and `tests/browser/chat-delivery.spec.js` in Chromium and WebKit;
  - `npm run test:unit`, `npm run lint`.
- [ ] **Step 5: Commit** `feat: restore cached chats instantly without presenting them as live`

---

### Task 6: Documentation and full verification

**Files:** Modify `docs/mobile-recovery.md`.

- [ ] **Step 1:** Document, per spec section 6:
  - the cache layers, their bounds, and invalidation by build and version;
  - the clearing rules;
  - WebSocket base cursors, the shared `ChatSync`, parked cursors, and the 30-minute lifetime;
  - that "connected" means the first frame was accepted;
  - what intentionally survives logout.
- [ ] **Step 2:** Run `npx prettier --write docs/mobile-recovery.md` and `npm run check`. Only the known `tests/integration/shell.test.js` environment failure is allowed.
- [ ] **Step 3: Commit** `chore: document the chat session cache`

The controller then removes the spec and plan, pushes, opens the PR, and runs the local multi-agent review with fixes.
