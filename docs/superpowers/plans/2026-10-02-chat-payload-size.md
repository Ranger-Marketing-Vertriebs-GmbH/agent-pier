# Chat Payload Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep chat payloads small on slow networks. Tool images are still shown, but loaded on demand instead of being inlined as base64. Large tool text is capped and its full text loads on demand. HTTP and the chat WebSocket are compressed. An invalid chat response no longer crashes the chat.

**Architecture:**
- Parsers take image payloads out of serialized tool text into a server-internal `toolImages` field.
- `ChatImages.decorate`, the single client-bound choke point, turns `toolImages` into `images: [{ id, path }]` references served by the existing chat image route.
- `decorate` also caps long tool text into `text` + `textTail` + `truncated` metadata, keeping full texts and images in bounded stores. A new text endpoint serves the full text.
- `compression` middleware covers `/api` and static files; `permessage-deflate` covers the chat socket.
- The client validates every chat snapshot before accepting it.

**Tech Stack:** Node.js 22 ES modules, Express 5.2, ws 8, React 19, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-chat-payload-size-design.md`

## Global Constraints

- Tool images: only `image/png`, `image/jpeg`, `image/gif` and `image/webp` are extracted, from Claude image blocks (`source.data`) and MCP/Codex image items (`data`, `mimeType`).
  - The text placeholder is `[image N]`, with N starting at 1 per row.
  - Server-internal row fields are `toolImages: [{ mime, data }]` and an optional `toolImagePath`.
  - The client-bound row gets `images: [{ id, path }]`. `id` is 64 hex characters, a sha256 of `JSON.stringify([sessionId, providerSessionId, messageId, N, sha256hex(data)])`. `path` is `basename(toolImagePath) + " · N"` when present, otherwise `image N`.
  - Base64 never appears in client-bound chat payloads.
- `TOOL_TEXT_LIMIT = 16384`, `TOOL_TEXT_HEAD = 12288`, `TOOL_TEXT_TAIL = 4096`, all counted in UTF-16 code units.
  - Truncate only `role: "tool"` rows, and only when `text.length > TOOL_TEXT_LIMIT`.
  - Cuts never split a surrogate pair.
- Truncated row shape: `text` = head, `textTail` = tail, `truncated: { length, bytes }` with `bytes = Buffer.byteLength(original, "utf8")`. No marker string is inserted into the content.
- Stores (`ToolTextStore` class, two instances: tool texts keyed by `[sessionId, messageId]`, tool images keyed by `[sessionId, imageId]`):
  - Bounds: 32 MiB total and 4 MiB per entry, counted as `string.length * 2`.
  - Eviction: LRU. Replacing a key subtracts the old size first.
  - Not persisted.
- Text endpoint: `GET /api/sessions/:id/chat/messages/:messageId/text` returns `{ text }`. Images use the existing `GET /api/sessions/:id/chat/images/:imageId`. Unavailable text or image returns 404 with a translated server message and no `code` field.
- Compression:
  - HTTP: `compression` 1.8.x, threshold 1024. Mount it after `requireLogin` and before `fileTransferStreams`, and exclude `Content-Disposition: attachment`.
  - Chat WebSocket: `perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true }`.
  - The terminal WebSocket is unchanged.
- The client never assigns or accepts a chat value that fails `isChatSnapshot`. `choose` validates before stopping the stream.
- Every UI and server string exists in German and English with matching keys. Client components import from `web/lib/i18n/messages/`.
- Files are at most 600 lines and follow Prettier. Tests never touch real sessions or the default tmux server.
- Commits use `feat:`/`fix:`/`chore:` in English and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A running tool row that grows past the limit while open must show fresh content. The full-text state resets when `truncated.length` changes. Pinned in Task 4.
2. A tool result containing both text and an image keeps its text and shows the image, with no duplicated text. Pinned in Task 1.
3. Emoji or CJK text at the head/tail cut produces no lone surrogates. Pinned in Task 2.
4. After a server restart, the stores are empty, yet the full text and tool images of live-window rows still load via re-derivation. Pinned in Task 3.
5. An invalid HTTP fallback keeps the previously shown chat visible instead of blanking it. Pinned in Task 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/features/chat/tool-images.js` (new) | `extractToolImages`, `imagePlaceholders`, `TOOL_IMAGE_TYPES` |
| `server/features/chat/history-parsers.js` (modify) | Builds `toolImages` and `toolImagePath`; `[image N]` in text |
| `server/features/chat/tool-text.js` (new) | `truncateToolRow(row)` → `{ row, full }`, plus constants |
| `server/features/chat/tool-text-store.js` (new) | `ToolTextStore` with `remember`, `lookup`, `forgetSession` |
| `server/features/chat/chat-images.js` (modify) | `decorate` turns tool images into references and truncates text; adds `fullText(id, messageId)`; `file()` serves tool images |
| `server/http/routes/chat.js`, `server/http/routes/sessions.js` (modify) | Text endpoint; `forgetSession` on session removal |
| `server/lib/i18n/{de,en}` chat catalogs (modify) | `toolTextUnavailable` |
| `web/features/chat/TruncatedToolOutput.jsx` (new) | Head, omission line, tail, load-full button, then the full text |
| `web/features/chat/ChatMessage.jsx`, `ToolChanges.jsx` (modify) | Tool images via `ChatImages`; `TruncatedToolOutput` when `truncated` is set |
| `web/features/chat/chat-sync.js`, `chat-stream-transport.js`, `useChatStream.js` (modify) | `isChatSnapshot` and validation |
| `web/lib/i18n/{de,en}/chat.js`, `web/lib/i18n/messages/chat.js` (modify) | Client copy |
| `server/app.js`, `server/http/chat-websocket.js`, `package.json`, `package-lock.json` (modify) | Compression |
| `docs/mobile-recovery.md`, `docs/chat-observability.md` (modify) | Documentation |

---

### Task 1: Extract tool images from tool text (parsers)

**Files:**
- Create: `server/features/chat/tool-images.js`
- Modify: `server/features/chat/history-parsers.js` (`show` at L34-35 and the tool row builders at ~L174-217, ~L270-280, ~L385-430, ~L455-465)
- Test: `tests/unit/tool-images.test.js`; extend `tests/unit/history.test.js` (570 lines). If adding there would exceed 600 lines, put the parser fixture test in a new `tests/unit/history-tool-images.test.js`.

**Interfaces:**
- Produces:
  - `extractToolImages(value, images: Array<{mime, data}>) → unknown`. Returns a deep copy of `value` in which every supported image payload is replaced by the string `[image N]`. N is `images.length` after pushing `{ mime, data }` onto the shared `images` array. The input is never mutated.
  - `imagePlaceholders(value, images) → string`: runs `extractToolImages`, then returns only the newly added placeholders, joined by `"\n"` (`""` when there are none).
  - `TOOL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])`.
  - Parser tool rows that contained images get `toolImages: [{ mime, data }]`, plus `toolImagePath: <input.file_path>` when the tool input has a string `file_path`. Rows without images have neither field.

- [ ] **Step 1: Write the failing tests**

`tests/unit/tool-images.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { extractToolImages } from "../../server/features/chat/tool-images.js";

test("claude and mcp image payloads become numbered placeholders", () => {
  const images = [];
  const value = [
    { type: "text", text: "kept" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    { type: "image", mimeType: "image/webp", data: "BBBB" },
  ];
  const copy = extractToolImages(value, images);
  assert.deepEqual(copy, [{ type: "text", text: "kept" }, "[image 1]", "[image 2]"]);
  assert.deepEqual(images, [
    { mime: "image/png", data: "AAAA" },
    { mime: "image/webp", data: "BBBB" },
  ]);
  assert.equal(value[1].source.data, "AAAA", "input not mutated");
});

test("numbering continues across calls sharing one array", () => {
  const images = [{ mime: "image/png", data: "X" }];
  assert.equal(
    extractToolImages({ type: "image", source: { media_type: "image/jpeg", data: "Y" } }, images),
    "[image 2]",
  );
});

test("unsupported types, strings and plain json are unchanged", () => {
  const images = [];
  const value = { a: "data:image/png;base64,AAAA", b: { type: "image", mimeType: "image/svg+xml", data: "S" }, n: 1 };
  assert.deepEqual(extractToolImages(value, images), value);
  assert.deepEqual(images, []);
  assert.equal(extractToolImages("plain", images), "plain");
  assert.equal(extractToolImages(null, images), null);
});
```

Parser test: a `normalizeClaude` `Read` `tool_use` with `input: { file_path: "/tmp/shot.png" }`, whose matching `tool_result.content` is `[{ type: "image", source: { type: "base64", media_type: "image/png", data: "<100 KB of base64 'A'>" } }]`, produces a tool row with:
- `text` containing `[image 1]`, without the base64, and shorter than 1,000 characters
- `toolImages` equal to `[{ mime: "image/png", data: <that base64> }]`
- `toolImagePath` equal to `"/tmp/shot.png"`

Model the records on the existing Claude fixtures in `tests/unit/history.test.js`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/tool-images.test.js`
Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement `server/features/chat/tool-images.js`**

```js
export const TOOL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const payload = (value) => {
  if (!record(value) || value.type !== "image") return null;
  if (record(value.source) && typeof value.source.data === "string")
    return { mime: value.source.media_type, data: value.source.data };
  if (typeof value.data === "string")
    return { mime: value.mimeType || value.mime_type, data: value.data };
  return null;
};
// Images leave the serialized tool text so chat payloads stay small; the chat
// serves them separately and shows them as real images on demand.
export function extractToolImages(value, images) {
  const image = payload(value);
  if (image && TOOL_IMAGE_TYPES.has(image.mime)) {
    images.push(image);
    return `[image ${images.length}]`;
  }
  if (Array.isArray(value)) return value.map((entry) => extractToolImages(entry, images));
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, extractToolImages(entry, images)]),
  );
}
export function imagePlaceholders(value, images) {
  const start = images.length;
  extractToolImages(value, images);
  return images
    .slice(start)
    .map((_, index) => `[image ${start + index + 1}]`)
    .join("\n");
}
```

- [ ] **Step 4: Use it in the parsers**

In `server/features/chat/history-parsers.js`:
- Change `show` to take an optional images array: `const show = (value, images) => { const safe = images ? extractToolImages(value, images) : value; return typeof safe === "string" ? safe : safe == null ? "" : JSON.stringify(safe, null, 2); };`
- Add a helper `const withImages = (row, images, input) => images.length ? { ...row, toolImages: images, ...(typeof object(parse(input)).file_path === "string" ? { toolImagePath: object(parse(input)).file_path } : {}) } : row;`.
- In each tool row builder, create `const images = [];`, pass it to every `show(...)` call that serializes that row's input or output, and wrap the built row with `withImages(row, images, <tool input>)`. The builders are:
  - Claude `tool_use` (~L174)
  - Claude orphan `tool_result` (~L208)
  - Codex `mcpToolCall`/`dynamicToolCall`/`functionCallOutput`/`imageView` (~L270-310)
  - legacy Codex records (~L385-430), where the row is created first and its text extended later. Keep one images array per call id, for example on a side map, and apply `withImages` when the output is joined.
  - OpenCode tool parts (~L455-465)
- `text(...)` already drops non-text blocks, so in the `text(x) || show(x)` pattern images are only extracted when the content has no text blocks. Use `const out = text(x);` and then `out ? join(out, imagePlaceholders(x, images)) : show(x, images)`. A tool result with both text and an image then keeps its text and adds `[image N]` without duplicating text. Cover this mixed case in the parser test: a text block plus an image block gives the text, `[image 1]` and one `toolImages` entry.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/unit/tool-images.test.js tests/unit/history.test.js`, then `npm run test:unit`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/features/chat/tool-images.js server/features/chat/history-parsers.js tests/unit
git commit -m "feat: extract tool images from serialized tool text"
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

### Task 3: Tool image references, truncation in chat payloads, and the full-text endpoint

**Files:**
- Modify: `server/features/chat/chat-images.js`:
  - `constructor`
  - `decorate` (~L164)
  - `file` (the image lookup behind `GET /chat/images/:imageId`)
  - a new `fullText`

  Also modify the service wiring that constructs `ChatImages` if a store has to be passed in; find it with `grep -rn "new ChatImages" server`.
- Modify: `server/http/routes/chat.js` (new route), `server/http/routes/sessions.js:64` (forget on removal)
- Modify: `server/lib/i18n/de/chat.js` and the English server catalog (find it with `grep -rln "historyUnavailable" server/lib/i18n`)
- Test: `tests/integration/chat-tool-text.test.js` (new). Use existing chat integration fixtures; `tests/integration/chat-images.test.js` and `tests/integration/chat-websocket.test.js` show how a session with a provider history file is set up.

**Interfaces:**
- Consumes: `truncateToolRow` and `ToolTextStore` from Task 2. Parser rows with `toolImages: [{ mime, data }]` and an optional `toolImagePath` from Task 1.
- Produces:
  - `chatImages.toolTexts` and `chatImages.toolImages`, two `ToolTextStore` instances. The image store holds base64 strings keyed by `[sessionId, imageId]`, with the store's `providerSessionId` slot holding `JSON.stringify([providerSessionId, mime])`.
  - Client-bound tool rows carry `images: [{ id, path }]` and no `toolImages` or `toolImagePath`.
  - `chatImages.file(id, imageId)` also resolves tool images and returns `{ type: mime, body: Buffer }`.
  - `chatImages.fullText(id, messageId) → Promise<string>`, which throws `problem(serverMessages.chat.toolTextUnavailable, 404)` when the text is unavailable.
  - Route `GET /api/sessions/:id/chat/messages/:messageId/text` → `{ text }`.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/chat-tool-text.test.js`. Build a fixture session whose provider history contains a tool row with 200,000 characters of plain text output, following the setup pattern in `tests/integration/chat-images.test.js`. Assert:
1. `chatImages.read(id)` gives that row `text.length === 12288`, `textTail.length === 4096`, and `truncated.length === 200000+` (its exact original length).
2. `chatImages.fullText(id, rowId)` resolves to the original text.
3. After `chatImages.toolTexts.forgetSession(id)`, `fullText` still resolves by re-deriving from `chat.read(id)`.
4. `fullText(id, "unknown")` rejects with status 404, and its message equals the German catalog `toolTextUnavailable`.
5. `chatImages.decoratePage(id, page)` truncates history rows the same way.
7. A fixture tool row with an image (Claude `Read` `tool_result` with a small valid PNG as base64; a 1×1 PNG is fine) yields client-bound `images: [{ id: <64 hex>, path: "shot.png · 1" }]`. `JSON.stringify(row)` does not contain the base64 string, and the row has no `toolImages` or `toolImagePath`.
8. `chatImages.file(id, imageId)` returns `{ type: "image/png", body }`, and `body` equals the decoded PNG bytes. It still does so after `chatImages.toolImages.forgetSession(id)`, via re-derivation. An unknown image id behaves as before (the existing missing-image error).
9. Through HTTP, `GET /api/sessions/:id/chat/images/:imageId` serves the PNG with `content-type: image/png`. This can live in the route-level test if the full fixture is impractical.
6. Through the HTTP app (`applicationFixture` from `tests/helpers/application.js` with `fixtureFetch`), `GET /api/sessions/:id/chat/messages/:rowId/text` returns `{ text }` with `cache-control: no-store`, and an unknown id returns 404 JSON with `messageKey`.

If wiring a provider history into the HTTP fixture is impractical, keep assertions 1–5 at the service level. Cover assertion 6 with a route-level test that stubs `chatImages.fullText`, and explain the choice in the report.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/integration/chat-tool-text.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `ChatImages`:
- Create `this.toolTexts = new ToolTextStore()` and `this.toolImages = new ToolTextStore()` in the constructor, or accept injected stores.
- Add a helper `toolImageRefs(id, providerSessionId, row)` that returns `{ images, entries }`:
  - For each `row.toolImages[i]` with `N = i + 1`, compute `imageId = sha256hex(JSON.stringify([id, providerSessionId, row.id, N, sha256hex(data)]))` and `path = row.toolImagePath ? \`${path.basename(row.toolImagePath)} · ${N}\` : \`image ${N}\``.
  - `images` is `[{ id: imageId, path }]`.
  - `entries` is `[{ imageId, mime, data }]`.
- In `decorate(id, snapshot)`, after building the message list, process each tool row:
  1. If it has `toolImages`, call `toolImageRefs`. Remember each entry with `this.toolImages.remember(id, imageId, JSON.stringify([snapshot.providerSessionId ?? null, mime]), data)`; the provider session and mime are packed into the providerSessionId slot, decoded on lookup. Then replace the row with `{ ...rest, images }`, dropping `toolImages` and `toolImagePath`.
  2. Map the row through `truncateToolRow`. When `full` is returned, call `this.toolTexts.remember(id, row.id, snapshot.providerSessionId ?? null, full)`.

  Keep the existing user-image handling for non-tool rows unchanged. Verify that `descriptors()` and `uploadedInput.decorate` ignore tool rows (they do today); the new `images` on tool rows must not be re-processed or stripped by them.
- In `file(id, imageId)`, before the existing lookup:
  1. Try `this.toolImages.lookup(id, imageId)`. On a hit whose packed provider session matches the current `chat.read(id)` snapshot's `providerSessionId`, return `{ type: mime, body: Buffer.from(data, "base64") }`.
  2. On a miss, re-derive: run `toolImageRefs` over the tool rows of `await this.chat.read(id)`. If an entry with this `imageId` exists, remember it and return it.
  3. Otherwise fall through to the existing code path unchanged.

  Only call `chat.read` when the id was not found by the existing fast paths, if that ordering is cheaper; read the existing `file()` first and keep its error behavior for unknown ids.
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

`chat.read(id)` returns untruncated rows that still carry `toolImages`, because truncation and image references happen only in `decorate`. Image placeholders `[image N]` are already in the text. Import `problem` and `serverMessages` the way neighbouring server modules do.

Route in `server/http/routes/chat.js`:

```js
  router.get("/sessions/:id/chat/messages/:messageId/text", async (req, res) =>
    res.json({ text: await chatImages.fullText(req.params.id, req.params.messageId) }),
  );
```

`securityHeaders` already sets `no-store`. In `server/http/routes/sessions.js`, next to `chat.remove(req.params.id)`, add `services.chatImages?.toolTexts.forgetSession(req.params.id); services.chatImages?.toolImages.forgetSession(req.params.id);`, using whatever name the services object exposes.

Server copy:
- DE: `toolTextUnavailable: "Diese Ausgabe ist nicht mehr verfügbar. Lade den Chat neu, um sie erneut zu laden."`
- EN: `toolTextUnavailable: "This output is no longer available. Reload the chat to load it again."`

- [ ] **Step 4: Run the tests**

Run: `node --test tests/integration/chat-tool-text.test.js tests/integration/chat-images.test.js tests/integration/chat-websocket.test.js`, then `npm run test:integration`.
Expected: PASS. Fix any existing test that asserted full tool text through `decorate`, and note it in the report.

- [ ] **Step 5: Commit**

```bash
git add server tests
git commit -m "feat: reference tool images and cap tool text in chat payloads"
```

---

### Task 4: Client rendering of tool images and truncated tool output

**Files:**
- Create: `web/features/chat/TruncatedToolOutput.jsx`
- Modify:
  - `web/features/chat/ChatMessage.jsx:31-36`
  - `web/features/chat/ToolChanges.jsx:105`
  - `web/lib/i18n/de/chat.js`, `web/lib/i18n/en/chat.js` (`chatMessageCopy`)
- Test: `tests/browser/tool-output-truncated.spec.js`

**Interfaces:**
- Consumes:
  - the row fields `text`, `textTail`, `truncated: { length, bytes }`
  - `images: [{ id, path }]` on tool rows
  - the endpoint and image route from Task 3
- Produces: `<TruncatedToolOutput message sessionId />`. Expanded tool rows render `<ChatImages images={message.images} sessionId={sessionId} />` above their output when `message.images?.length`.

**Tool images:** In `ChatMessage.jsx`, inside `{toolOpen && …}`, render the existing `ChatImages` component (already imported in that file) before the output or changes block when `message.images?.length`. Browser test: a tool row with `images: [{ id: "a".repeat(64), path: "shot.png · 1" }]` and `**/api/sessions/*/chat/images/*` routed to a 1×1 PNG. Before opening the row, no image request is made; assert this by counting route hits. After opening, the thumbnail is visible and opens the full-size dialog. Put this test in `tests/browser/tool-output-truncated.spec.js` or a sibling file.

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
git commit -m "feat: show tool images and load full tool output on demand"
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
- Images in tool output (png, jpeg, gif, webp) are taken out of the tool text, which keeps an `[image N]` placeholder. They are served on demand through `/api/sessions/:id/chat/images/:imageId` and shown as thumbnails in the expanded tool row. A server restart is covered by re-derivation for live-window rows.
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
