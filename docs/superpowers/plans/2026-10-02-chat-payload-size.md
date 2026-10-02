# Chat Payload Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep chat payloads small on slow networks: no inlined base64 images, capped large tool text with an on-demand full-text endpoint, compressed HTTP and chat WebSocket, and no crash on invalid chat responses.

**Architecture:**
- Parsers replace image payloads with descriptors before tool text is built.
- `ChatImages.decorate`, the single client-bound choke point, caps long tool text into `text` + `textTail` + `truncated` metadata. It keeps the full text in a bounded `ToolTextStore`, and a new endpoint serves it.
- `compression` middleware covers `/api` and static files. `permessage-deflate` covers the chat socket.
- The client validates every chat snapshot before accepting it.

**Tech Stack:** Node.js 22 ES modules, Express 5.2, ws 8, React 19, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-chat-payload-size-design.md`

## Global Constraints

- Image descriptor format: `[image <mime>, <size>]`. Size is the decoded bytes `floor(base64Length * 3 / 4)`, formatted as `<n> KB` (integer, 1 KB = 1024 B, minimum 1) below 1 MiB, else `<n.n> MB`.
- Data URLs are replaced only when they match `^data:[^;,]+;base64,` and are longer than 1,024 characters.
- `TOOL_TEXT_LIMIT = 16384`, `TOOL_TEXT_HEAD = 12288`, `TOOL_TEXT_TAIL = 4096`. All three count UTF-16 code units. Truncate only `role: "tool"` rows, and only when `text.length > TOOL_TEXT_LIMIT`. Cuts never split a surrogate pair.
- Truncated row shape: `text` = head, `textTail` = tail, `truncated: { length, bytes }`, where `bytes = Buffer.byteLength(original, "utf8")`. No marker string goes into the content.
- `ToolTextStore`: 32 MiB total and 4 MiB per entry, counted as `text.length * 2`. LRU eviction; replacing a key subtracts the old size first. Not persisted.
- Endpoint: `GET /api/sessions/:id/chat/messages/:messageId/text` returns `{ text }`. It returns 404 with a translated server message and no `code` field.
- Compression: `compression` 1.8.x, threshold 1024. Mounted after `requireLogin`, before `fileTransferStreams`. Responses with `Content-Disposition: attachment` are excluded. Chat WebSocket: `perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true }`. The terminal WebSocket stays unchanged.
- The client never assigns or accepts a chat value that fails `isChatSnapshot`. `choose` validates before stopping the stream.
- Every UI and server string exists in German and English with matching keys. Client components import from `web/lib/i18n/messages/`.
- Files stay at or below 600 lines. Prettier style. Tests never touch real sessions or the default tmux server.
- Commits use `feat:`/`fix:`/`chore:` prefixes in English and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A running Codex or Claude tool row that grows past the limit while open must show fresh content. The full-text state resets when `truncated.length` changes. Pinned in Task 4.
2. A tool output that legitimately contains the text `data:image/png;base64,` in prose shorter than 1,024 characters must stay unchanged. Pinned in Task 1.
3. Emoji or CJK at the head/tail cut must not produce lone surrogates. Pinned in Task 2.
4. After a server restart, the store is empty and the full-text request for a live-window row still succeeds via re-derivation. Pinned in Task 3.
5. An invalid HTTP fallback must keep the previously shown chat visible, not blank it. Pinned in Task 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/features/chat/image-payload.js` (new) | `describeImagePayloads(value)`: deep-copies JSON values with image payloads replaced by descriptors. `imageDescriptor(mime, base64Length)`. |
| `server/features/chat/history-parsers.js` (modify) | `show()` uses `describeImagePayloads`. |
| `server/features/chat/tool-text.js` (new) | `truncateToolRow(row)` → `{ row, full }`, plus the constants. |
| `server/features/chat/tool-text-store.js` (new) | `ToolTextStore` with `remember`, `lookup`, `forgetSession`. |
| `server/features/chat/chat-images.js` (modify) | `decorate` truncates rows and stores full texts. Adds `fullText(id, messageId)`. |
| `server/http/routes/chat.js`, `server/http/routes/sessions.js` (modify) | The endpoint, and `forgetSession` on session removal. |
| `server/lib/i18n/{de,en}/chat.js` (modify) | The `toolTextUnavailable` message. |
| `web/features/chat/TruncatedToolOutput.jsx` (new) | Renders head, omission line, tail, and the load-full button; then the full text via `ToolOutput`. |
| `web/features/chat/ChatMessage.jsx`, `ToolChanges.jsx` (modify) | Use `TruncatedToolOutput` when `message.truncated` is set. |
| `web/features/chat/chat-sync.js`, `chat-stream-transport.js`, `useChatStream.js` (modify) | `isChatSnapshot` and validation. |
| `web/lib/i18n/{de,en}/chat.js`, `web/lib/i18n/messages/chat.js` (modify) | Client copy. |
| `server/app.js`, `server/http/chat-websocket.js`, `package.json`, `package-lock.json` (modify) | Compression. |
| `docs/mobile-recovery.md`, `docs/chat-observability.md` (modify) | Documentation. |

---

### Task 1: Image descriptors in tool text

**Files:**
- Create: `server/features/chat/image-payload.js`
- Modify: `server/features/chat/history-parsers.js:34-35` (`show`)
- Test: `tests/unit/image-payload.test.js`; extend the existing parser tests (find them with `grep -rln normalizeClaude tests/unit`)

**Interfaces:**
- Produces:
  - `describeImagePayloads(value: unknown): unknown`. Returns a new value; never mutates its input.
  - `imageDescriptor(mime: string, base64Length: number): string`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/image-payload.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { describeImagePayloads, imageDescriptor } from "../../server/features/chat/image-payload.js";

const b64 = (bytes) => "A".repeat(Math.ceil((bytes * 4) / 3));

test("image descriptor sizes", () => {
  assert.equal(imageDescriptor("image/png", 4), "[image image/png, 1 KB]");
  assert.equal(imageDescriptor("image/png", Math.ceil((245 * 1024 * 4) / 3)), "[image image/png, 245 KB]");
  assert.equal(imageDescriptor("image/jpeg", Math.ceil((1.5 * 1048576 * 4) / 3)), "[image image/jpeg, 1.5 MB]");
});

test("claude image blocks, mcp image items and long data urls become descriptors", () => {
  const value = [
    { type: "text", text: "kept" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: b64(2048) } },
    { type: "image", mimeType: "image/webp", data: b64(4096) },
    { note: `data:image/gif;base64,${b64(2048)}` },
  ];
  const copy = describeImagePayloads(value);
  assert.deepEqual(copy[0], { type: "text", text: "kept" });
  assert.equal(copy[1], "[image image/png, 2 KB]");
  assert.equal(copy[2], "[image image/webp, 4 KB]");
  assert.equal(copy[3].note, "[image image/gif, 2 KB]");
  assert.equal(value[1].source.data.length > 1000, true, "input not mutated");
});

test("short data urls, prose and non-image json stay unchanged", () => {
  const value = { text: "see data:image/png;base64,AAAA here", short: "data:image/png;base64,AAAA", n: 1 };
  assert.deepEqual(describeImagePayloads(value), value);
  assert.equal(describeImagePayloads("plain"), "plain");
  assert.equal(describeImagePayloads(null), null);
});
```

Add a parser test: a `normalizeClaude` Read `tool_use` whose `tool_result.content` is `[{ type: "image", source: { type: "base64", media_type: "image/png", data: <100 KB base64> } }]` produces a tool row whose `text` contains `[image image/png,` and is shorter than 2,000 characters. Model the fixture records on the existing Claude parser tests.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/image-payload.test.js`
Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement `server/features/chat/image-payload.js`**

```js
const DATA_URL = /^data:([^;,]+);base64,/;
export function imageDescriptor(mime, base64Length) {
  const bytes = Math.floor((base64Length * 3) / 4);
  const size =
    bytes < 1048576
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
  return `[image ${mime || "image"}, ${size}]`;
}
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
// Provider tool output may embed screenshots as base64; chat payloads carry a
// short descriptor instead so snapshots stay small on slow connections.
export function describeImagePayloads(value) {
  if (typeof value === "string") {
    const match = value.length > 1024 && DATA_URL.exec(value);
    return match ? imageDescriptor(match[1], value.length - match[0].length) : value;
  }
  if (Array.isArray(value)) return value.map(describeImagePayloads);
  if (!record(value)) return value;
  if (value.type === "image") {
    if (record(value.source) && typeof value.source.data === "string")
      return imageDescriptor(value.source.media_type, value.source.data.length);
    if (typeof value.data === "string")
      return imageDescriptor(value.mimeType || value.mime_type, value.data.length);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, describeImagePayloads(entry)]),
  );
}
```

- [ ] **Step 4: Use it in `show()`**

In `server/features/chat/history-parsers.js`:

```js
import { describeImagePayloads } from "./image-payload.js";
// …
const show = (value) => {
  const safe = describeImagePayloads(value);
  return typeof safe === "string" ? safe : safe == null ? "" : JSON.stringify(safe, null, 2);
};
```

Then check every `text(...)` helper path at lines 274–276, 390, 408 and 460–462. `text()` already drops non-text blocks, so images only reach the output through `show()`. Codex `aggregatedOutput` and plain strings go through `show()` or stay as strings; strings get the data-URL rule.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/unit/image-payload.test.js` plus the parser test files, then `npm run test:unit`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/features/chat/image-payload.js server/features/chat/history-parsers.js tests/unit
git commit -m "fix: describe images in tool output instead of inlining base64"
```

---

### Task 2: Tool text truncation and store (pure modules)

**Files:**
- Create: `server/features/chat/tool-text.js`, `server/features/chat/tool-text-store.js`
- Test: `tests/unit/tool-text.test.js`, `tests/unit/tool-text-store.test.js`

**Interfaces:**
- Produces:
  - `TOOL_TEXT_LIMIT`, `TOOL_TEXT_HEAD`, `TOOL_TEXT_TAIL`.
  - `truncateToolRow(row) → { row, full: string | null }`. Returns the same row object and `full: null` when nothing is cut.
  - `class ToolTextStore({ maxBytes = 32 * 1048576, maxEntryBytes = 4 * 1048576 } = {})` with:
    - `remember(sessionId, messageId, providerSessionId, text)`
    - `lookup(sessionId, messageId) → { text, providerSessionId } | null`, which refreshes recency
    - `forgetSession(sessionId)`
    - `get bytes()`

- [ ] **Step 1: Write the failing tests**

`tests/unit/tool-text.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { truncateToolRow, TOOL_TEXT_LIMIT, TOOL_TEXT_HEAD, TOOL_TEXT_TAIL } from "../../server/features/chat/tool-text.js";

const tool = (text) => ({ id: "t1", role: "tool", toolName: "Bash", status: "completed", text });

test("short tool rows and non-tool rows are untouched", () => {
  const short = tool("x".repeat(TOOL_TEXT_LIMIT));
  assert.deepEqual(truncateToolRow(short), { row: short, full: null });
  const assistant = { id: "a", role: "assistant", text: "y".repeat(50000) };
  assert.deepEqual(truncateToolRow(assistant), { row: assistant, full: null });
});

test("long tool rows keep head, tail and metadata", () => {
  const original = "h".repeat(20000) + "é".repeat(5000) + "t".repeat(10000);
  const { row, full } = truncateToolRow(tool(original));
  assert.equal(full, original);
  assert.equal(row.text, original.slice(0, TOOL_TEXT_HEAD));
  assert.equal(row.textTail, original.slice(-TOOL_TEXT_TAIL));
  assert.deepEqual(row.truncated, { length: original.length, bytes: Buffer.byteLength(original) });
  assert.equal(row.id, "t1");
  assert.equal(row.toolName, "Bash");
});

test("cuts never split surrogate pairs", () => {
  const emoji = "😀";
  const original = "a".repeat(TOOL_TEXT_HEAD - 1) + emoji + "b".repeat(8000) + emoji + "c".repeat(TOOL_TEXT_TAIL - 1);
  const { row } = truncateToolRow(tool(original));
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.doesNotMatch(row.text, lone);
  assert.doesNotMatch(row.textTail, lone);
});
```

`tests/unit/tool-text-store.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { ToolTextStore } from "../../server/features/chat/tool-text-store.js";

test("store bounds, lru, replace accounting and forgetSession", () => {
  const store = new ToolTextStore({ maxBytes: 100, maxEntryBytes: 40 });
  store.remember("s", "a", "p", "x".repeat(20)); // 40 bytes
  store.remember("s", "b", "p", "x".repeat(20));
  assert.equal(store.bytes, 80);
  store.lookup("s", "a"); // a is now most recent
  store.remember("s", "c", "p", "x".repeat(20)); // evicts b
  assert.equal(store.lookup("s", "b"), null);
  assert.equal(store.lookup("s", "a").text.length, 20);
  store.remember("s", "a", "p", "x".repeat(10)); // replace subtracts old
  assert.equal(store.bytes, 60);
  store.remember("s", "huge", "p", "x".repeat(21)); // 42 > maxEntryBytes
  assert.equal(store.lookup("s", "huge"), null);
  store.remember("other", "a", "p", "y");
  store.forgetSession("s");
  assert.equal(store.lookup("s", "a"), null);
  assert.equal(store.lookup("other", "a").text, "y");
  assert.equal(store.bytes, 2);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/tool-text.test.js tests/unit/tool-text-store.test.js`
Expected: FAIL, because the modules are missing.

- [ ] **Step 3: Implement**

`server/features/chat/tool-text.js`:

```js
export const TOOL_TEXT_LIMIT = 16384;
export const TOOL_TEXT_HEAD = 12288;
export const TOOL_TEXT_TAIL = 4096;
const high = (code) => code >= 0xd800 && code <= 0xdbff;
const headEnd = (text, end) => (high(text.charCodeAt(end - 1)) ? end - 1 : end);
const tailStart = (text, start) => (high(text.charCodeAt(start - 1)) ? start + 1 : start);
// Long tool output stays reachable through the full-text endpoint; payloads carry
// only a head and tail so slow connections receive chats quickly.
export function truncateToolRow(row) {
  if (row?.role !== "tool" || typeof row.text !== "string" || row.text.length <= TOOL_TEXT_LIMIT)
    return { row, full: null };
  const full = row.text;
  return {
    row: {
      ...row,
      text: full.slice(0, headEnd(full, TOOL_TEXT_HEAD)),
      textTail: full.slice(tailStart(full, full.length - TOOL_TEXT_TAIL)),
      truncated: { length: full.length, bytes: Buffer.byteLength(full, "utf8") },
    },
    full,
  };
}
```

`server/features/chat/tool-text-store.js`:

```js
export class ToolTextStore {
  constructor({ maxBytes = 32 * 1048576, maxEntryBytes = 4 * 1048576 } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntryBytes = maxEntryBytes;
    this.entries = new Map();
    this.size = 0;
  }
  get bytes() {
    return this.size;
  }
  key(sessionId, messageId) {
    return JSON.stringify([sessionId, messageId]);
  }
  drop(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.size -= entry.text.length * 2;
    this.entries.delete(key);
  }
  remember(sessionId, messageId, providerSessionId, text) {
    const key = this.key(sessionId, messageId);
    this.drop(key);
    if (text.length * 2 > this.maxEntryBytes) return;
    this.entries.set(key, { sessionId, text, providerSessionId });
    this.size += text.length * 2;
    while (this.size > this.maxBytes) this.drop(this.entries.keys().next().value);
  }
  lookup(sessionId, messageId) {
    const key = this.key(sessionId, messageId);
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { text: entry.text, providerSessionId: entry.providerSessionId };
  }
  forgetSession(sessionId) {
    for (const [key, entry] of this.entries) if (entry.sessionId === sessionId) this.drop(key);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/unit/tool-text.test.js tests/unit/tool-text-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/chat/tool-text.js server/features/chat/tool-text-store.js tests/unit/tool-text.test.js tests/unit/tool-text-store.test.js
git commit -m "feat: cap long tool text with a bounded full-text store"
```

---

### Task 3: Wire truncation into chat payloads and the full-text endpoint

**Files:**
- Modify: `server/features/chat/chat-images.js` (`constructor`, `decorate` at ~L164, a new `fullText`). Also modify the service wiring that constructs `ChatImages` if a store instance has to be passed in; find it with `grep -rn "new ChatImages" server`.
- Modify: `server/http/routes/chat.js` (new route), `server/http/routes/sessions.js:64` (forget on removal)
- Modify: `server/lib/i18n/de/chat.js` and the English server catalog (find it with `grep -rln "historyUnavailable" server/lib/i18n`)
- Test: `tests/integration/chat-tool-text.test.js` (new). Use existing chat integration fixtures; `tests/integration/chat-images.test.js` and `tests/integration/chat-websocket.test.js` show how a session with a provider history file is set up.

**Interfaces:**
- Consumes: `truncateToolRow` and `ToolTextStore` from Task 2.
- Produces:
  - `chatImages.toolTexts`, a `ToolTextStore` instance.
  - `chatImages.fullText(id, messageId) → Promise<string>`, which throws `problem(serverMessages.chat.toolTextUnavailable, 404)` when the text is unavailable.
  - Route `GET /api/sessions/:id/chat/messages/:messageId/text` → `{ text }`.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/chat-tool-text.test.js`. Build a fixture session whose provider history contains a tool row with 200,000 characters of plain text output, following the setup pattern in `tests/integration/chat-images.test.js`. Assert:
1. `chatImages.read(id)` gives that row `text.length === 12288`, `textTail.length === 4096`, and `truncated.length === 200000+` (its exact original length).
2. `chatImages.fullText(id, rowId)` resolves to the original text.
3. After `chatImages.toolTexts.forgetSession(id)`, `fullText` still resolves by re-deriving from `chat.read(id)`.
4. `fullText(id, "unknown")` rejects with status 404, and its message equals the German catalog `toolTextUnavailable`.
5. `chatImages.decoratePage(id, page)` truncates history rows the same way.
6. Through the HTTP app (`applicationFixture` from `tests/helpers/application.js` with `fixtureFetch`), `GET /api/sessions/:id/chat/messages/:rowId/text` returns `{ text }` with `cache-control: no-store`, and an unknown id returns 404 JSON with `messageKey`.

If wiring a provider history into the HTTP fixture is impractical, keep assertions 1–5 at the service level. Cover assertion 6 with a route-level test that stubs `chatImages.fullText`, and explain the choice in the report.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/integration/chat-tool-text.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `ChatImages`:
- Create `this.toolTexts = new ToolTextStore()` in the constructor, or accept an injected store.
- In `decorate(id, snapshot)`, after building the message list, map each message through `truncateToolRow`. When `full` is returned, call `this.toolTexts.remember(id, row.id, snapshot.providerSessionId ?? null, full)`.
- Add `fullText`:

```js
  async fullText(id, messageId) {
    const snapshot = await this.chat.read(id);
    const current = snapshot.providerSessionId ?? null;
    const stored = this.toolTexts.lookup(id, messageId);
    if (stored && stored.providerSessionId === current) return stored.text;
    const row = snapshot.messages?.find((message) => message.id === messageId);
    if (row?.role === "tool" && typeof row.text === "string") return row.text;
    throw problem(serverMessages.chat.toolTextUnavailable, 404);
  }
```

`chat.read(id)` returns image-described but untruncated rows, because truncation happens only in `decorate`. Import `problem` and `serverMessages` the way neighbouring server modules do.

Route in `server/http/routes/chat.js`:

```js
  router.get("/sessions/:id/chat/messages/:messageId/text", async (req, res) =>
    res.json({ text: await chatImages.fullText(req.params.id, req.params.messageId) }),
  );
```

`securityHeaders` already sets `no-store`. In `server/http/routes/sessions.js`, next to `chat.remove(req.params.id)`, add `services.chatImages?.toolTexts.forgetSession(req.params.id);`, using whatever name the services object exposes.

Server copy:
- DE: `toolTextUnavailable: "Diese Ausgabe ist nicht mehr verfügbar. Lade den Chat neu, um sie erneut zu laden."`
- EN: `toolTextUnavailable: "This output is no longer available. Reload the chat to load it again."`

- [ ] **Step 4: Run the tests**

Run: `node --test tests/integration/chat-tool-text.test.js tests/integration/chat-images.test.js tests/integration/chat-websocket.test.js`, then `npm run test:integration`.
Expected: PASS. Fix any existing test that asserted full tool text through `decorate`, and note it in the report.

- [ ] **Step 5: Commit**

```bash
git add server tests
git commit -m "feat: serve capped tool output with an on-demand full-text endpoint"
```

---

### Task 4: Client rendering of truncated tool output

**Files:**
- Create: `web/features/chat/TruncatedToolOutput.jsx`
- Modify: `web/features/chat/ChatMessage.jsx:31-36`, `web/features/chat/ToolChanges.jsx:105`, `web/lib/i18n/de/chat.js`, `web/lib/i18n/en/chat.js` (`chatMessageCopy`)
- Test: `tests/browser/tool-output-truncated.spec.js`

**Interfaces:**
- Consumes: the row fields `text`, `textTail`, `truncated: { length, bytes }`, and the endpoint from Task 3.
- Produces: `<TruncatedToolOutput message sessionId />`.

- [ ] **Step 1: Write the failing browser test**

`tests/browser/tool-output-truncated.spec.js`. Model the chat fixture routing on `tests/browser/tool-output.spec.js`, which shows how a session with tool rows is served via `page.route`. Serve a session whose chat contains a tool row:
- `text: "HEAD-START\n" + "h".repeat(12000)`
- `textTail: "t".repeat(4000) + "\nTAIL-END"`
- `truncated: { length: 300000, bytes: 300000 }`

Route `**/api/sessions/*/chat/messages/*/text` to `{ text: "FULL-OUTPUT-MARKER" }`. In English:
1. Open the tool row (click its summary).
2. Expect the text `HEAD-START`, an omission line matching `/KB omitted/`, the text `TAIL-END`, and a button named `/Load full output \(293 KB\)/`.
3. Click it, then expect `FULL-OUTPUT-MARKER`.

Add a second test where the route returns 404 with `{ error: "This output is no longer available. Reload the chat to load it again." }`. Expect that message visible and the button still present. Add a German run asserting the German button label (`/Vollständige Ausgabe laden/`).

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && AGENTPIER_TEST_PORT=4397 AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/tool-output-truncated.spec.js`
Expected: FAIL.

- [ ] **Step 3: Add copy**

In `chatMessageCopy`:
- EN:
  - `outputOmitted: (size) => \`… ${size} omitted …\``
  - `loadFullOutput: (size) => \`Load full output (${size})\``
- DE:
  - `outputOmitted: (size) => \`… ${size} ausgelassen …\``
  - `loadFullOutput: (size) => \`Vollständige Ausgabe laden (${size})\``

Sizes are formatted with `formatSize(bytes)` inside the component: KB below 1 MiB (integer), else MB with one decimal.

- [ ] **Step 4: Implement `web/features/chat/TruncatedToolOutput.jsx`**

```jsx
import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import { chatMessageCopy as copy } from "../../lib/i18n/messages/chat.js";
import useLanguage from "../../lib/i18n/useLanguage.js";
import ToolOutput from "./ToolOutput.jsx";

const formatSize = (bytes) =>
  bytes < 1048576
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;
const utf8 = (value) => new TextEncoder().encode(value).length;

export default function TruncatedToolOutput({ message, sessionId }) {
  useLanguage();
  const [full, setFull] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setFull(null);
    setError("");
  }, [message.id, message.truncated.length]);
  if (full !== null) return <ToolOutput text={full} toolName={message.toolName} />;
  const omitted =
    message.truncated.bytes - utf8(message.text) - utf8(message.textTail || "");
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api(
        `/sessions/${encodeURIComponent(sessionId)}/chat/messages/${encodeURIComponent(message.id)}/text`,
      );
      if (typeof result.text !== "string") throw new Error(copy.loadFullOutputFailed);
      setFull(result.text);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tool-output-truncated">
      <ToolOutput text={message.text} toolName={message.toolName} />
      <p className="tool-output-omitted">{copy.outputOmitted(formatSize(Math.max(omitted, 0)))}</p>
      <ToolOutput text={message.textTail || ""} toolName={message.toolName} />
      {error && <p className="tool-output-error" role="alert">{error}</p>}
      <button type="button" className="button" disabled={busy} onClick={load}>
        {copy.loadFullOutput(formatSize(message.truncated.bytes))}
      </button>
    </div>
  );
}
```

Add `loadFullOutputFailed` to both catalogs:
- EN: "The full output could not be loaded."
- DE: "Die vollständige Ausgabe konnte nicht geladen werden."

Add minimal styles to `web/features/chat/tool-output.css` (`.tool-output-omitted`: muted, small, centered; `.tool-output-error`: error color). Match existing tokens.

`ChatMessage.jsx`: in the non-`fileChanges` branch, render `message.truncated ? <TruncatedToolOutput message={message} sessionId={sessionId} /> : <ToolOutput … />`. `ToolChanges.jsx:105`: use the same switch for its raw view, passing `sessionId` through from its parent if it is not available there.

- [ ] **Step 5: Run the tests**

Run:
```bash
npm run build
AGENTPIER_TEST_PORT=4397 AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/tool-output-truncated.spec.js tests/browser/tool-output.spec.js tests/browser/chat-code-diffs.spec.js
AGENTPIER_TEST_PORT=4397 AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/tool-output-truncated.spec.js tests/browser/tool-output.spec.js tests/browser/chat-code-diffs.spec.js
npm run test:unit
npm run lint
```
Expected: PASS, including the i18n parity tests.

- [ ] **Step 6: Commit**

```bash
git add web tests/browser/tool-output-truncated.spec.js
git commit -m "feat: load full tool output on demand in the chat"
```

---

### Task 5: Invalid chat response handling

**Files:**
- Modify: `web/features/chat/chat-sync.js` (add `isChatSnapshot`), `web/features/chat/chat-stream-transport.js:47-68,107-115`, `web/features/chat/useChatStream.js:193-205`, `web/lib/i18n/{de,en}/chat.js`, `web/lib/i18n/messages/chat.js` (only if a new copy group is needed)
- Test: `tests/unit/chat-stream-transport.test.js` and `tests/unit/chat-sync.test.js` (extend)

**Interfaces:**
- Produces: `isChatSnapshot(value): boolean` from `web/features/chat/chat-sync.js`.

- [ ] **Step 1: Write the failing tests**

Read `tests/unit/chat-stream-transport.test.js` first and reuse its fake socket, scheduler and visibility helpers. Add:
1. **Fallback `{}` keeps the old chat.** A transport that delivered a valid snapshot over the socket, then fails the socket, and whose `read` resolves `{}`: `onSnapshot` is called only for the valid snapshot. `onError` receives the English `invalidSnapshot` copy (set the language to English in the test as `tests/unit/login-api.test.js` does). A subsequent valid socket snapshot calls `onError("")`.
2. **`isChatSnapshot`:** true for `{ messages: [] }`; false for `{}`, `null`, `{ messages: "x" }` and `[]`.

`choose` lives in a React hook. If the repo has no hook test harness, extract the validation into a small pure helper, `assertChatSnapshot(value)` in `chat-sync.js`, that throws `new Error(copy.invalidSnapshot)`. Unit-test it, and call it as the first statement of `choose`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/chat-stream-transport.test.js tests/unit/chat-sync.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `chat-sync.js`:

```js
export const isChatSnapshot = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.messages);
```

  plus `assertChatSnapshot` as described in Step 1.
- `chat-stream-transport.js`:
  - Socket path: replace `if (!next || !Array.isArray(next.messages))` with `if (!isChatSnapshot(next))`.
  - Fallback, after `if (!current()) return;`, add `if (!isChatSnapshot(next)) return onError(copy.invalidSnapshot);`, before `snapshot = next`.
- `useChatStream.js` `choose`: make `assertChatSnapshot(next);` its first line.
- Copy, in the chat group used by the transport (import through `web/lib/i18n/messages/chat.js`):
  - EN `invalidSnapshot`: "The chat could not be loaded completely. Retrying…"
  - DE `invalidSnapshot`: "Der Chat konnte nicht vollständig geladen werden. Neuer Versuch läuft …"

- [ ] **Step 4: Run the tests**

Run: `node --test tests/unit/chat-stream-transport.test.js tests/unit/chat-sync.test.js && npm run test:unit && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web tests/unit
git commit -m "fix: keep the chat usable when a response is incomplete"
```

---

### Task 6: Compression

**Files:**
- Modify: `package.json`, `package-lock.json` (`npm install compression@^1.8.1`), `server/app.js` (after `app.use("/api", requireLogin(...))`), `server/http/chat-websocket.js:8-12`
- Test: `tests/blackbox/compression.test.js` (new), and extend `tests/integration/chat-websocket.test.js`

**Interfaces:**
- Produces: compressed `/api` JSON, static assets and SPA document responses ≥ 1 KiB. Chat socket frames ≥ 1 KiB are deflated.

- [ ] **Step 1: Write the failing tests**

`tests/blackbox/compression.test.js` uses `applicationFixture` and `fixtureFetch` from `tests/helpers/application.js`:
1. `GET /api/state` with `accept-encoding: gzip` returns `content-encoding: gzip` when the body is ≥ 1 KiB. If the state is smaller, pick any authenticated JSON route with a body over 1 KiB, or create enough fixture data. Node's fetch decompresses transparently, so assert on the header.
2. A file download route returns no `content-encoding`. Model its setup on `tests/blackbox/file-transfers.test.js`.
3. `GET /auth/status` returns no `content-encoding`, because it is mounted before compression.

`tests/integration/chat-websocket.test.js`: add a case where a `ws` client connecting with `perMessageDeflate: true` sees `client.extensions` include `permessage-deflate`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/blackbox/compression.test.js tests/integration/chat-websocket.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

```bash
npm install compression@^1.8.1
```

`server/app.js`:

```js
import compression from "compression";
// …
  app.use("/api", requireLogin(services.login, effective));
  // Slow mobile links benefit most; downloads stream raw bytes uncompressed.
  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) =>
        !/^attachment/i.test(String(res.getHeader("Content-Disposition") || "")) &&
        compression.filter(req, res),
    }),
  );
  app.use(auditHttp(...)); // unchanged order below
```

Keep the mount directly after `requireLogin`, as the constraints require. `server/http/chat-websocket.js`: `perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true }`.

Check whether a third-party license file is generated from production dependencies (`grep -rn "third-party" scripts package.json vite.config.js`). If it is, make sure `npm run build` still succeeds and includes `compression`.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/blackbox/compression.test.js tests/integration/chat-websocket.test.js && npm run test:blackbox && npm run test:integration`
Expected: PASS, apart from the known environment failure `tests/integration/shell.test.js` (login-shell Unicode).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json server/app.js server/http/chat-websocket.js tests
git commit -m "feat: compress API responses and chat stream frames"
```

---

### Task 7: Documentation and full verification

**Files:**
- Modify: `docs/mobile-recovery.md`, `docs/chat-observability.md`

- [ ] **Step 1: Document**

`docs/mobile-recovery.md`, a new section "Slow connections":
- Chat snapshots validate before use; an incomplete response shows a retry notice and keeps the previous chat.
- If the first socket snapshot takes longer than 30 s, the HTTP fallback and a reconnect compete for bandwidth, which is why payloads are kept small.
- API responses ≥ 1 KiB and chat frames ≥ 1 KiB are compressed (gzip, permessage-deflate). Downloads and the terminal stream are not.

`docs/chat-observability.md`, a new section "Tool output size":
- Image payloads in tool output become `[image <mime>, <size>]`.
- Tool rows over 16,384 characters carry a 12,288-character head and a 4,096-character tail, plus `truncated` metadata.
- The full text is served by `GET /api/sessions/:id/chat/messages/:messageId/text`, from a bounded in-memory store (32 MiB, 4 MiB per entry) with re-derivation from the live window. History rows need a chat reload after a server restart.

- [ ] **Step 2: Full verification**

Run: `npx prettier --write docs/mobile-recovery.md docs/chat-observability.md docs/superpowers && npm run check`
Expected: lint, format, structure and build pass. In tests, only the known `tests/integration/shell.test.js` environment failure is allowed.

- [ ] **Step 3: Commit**

```bash
git add docs
git commit -m "chore: document chat payload limits and compression"
```

The controller removes the spec and plan, pushes, opens the PR and runs the multi-agent review after the final review.
