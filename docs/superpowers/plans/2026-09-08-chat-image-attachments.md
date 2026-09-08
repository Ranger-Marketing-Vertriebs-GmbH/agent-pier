# Chat Image Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user drop, paste or pick an image in the chat composer so the running CLI agent can read it as context.

**Architecture:** Uploads are stored outside the user's project under `.data/chat-attachments/<accountId>/<sessionId>/`, and each session is granted read access to that directory at launch — `--add-dir` for Claude and Codex, an `opencode.json` `references` entry for OpenCode. On submit the absolute file paths are appended to the message text, which the existing `POST /sessions/:id/input` route types into the CLI through tmux. The upload endpoint is new; the input route is untouched.

**Tech Stack:** Node 20+ ESM, Express 5, React 18 (no build-time JSX transform surprises — follow existing `.jsx`), `node:test` + `fast-check` for backend tests, Playwright for web tests, `jsonc-parser` for OpenCode config edits.

**Spec:** `docs/superpowers/specs/2026-09-08-chat-image-attachments-design.md`

## Global Constraints

- Every source and test file stays at or under **600 lines** (`npm run check:structure`).
- All user-visible German copy lives in `web/lib/i18n/de/chat.js` (client) and `server/lib/i18n/de/chat.js` (server). Never hardcode a user-visible string.
- Attachment limits: **10 MB** per image; **8** attachments per message, enforced in the composer; **64** stored files per session as a storage guard, enforced by the server and mirroring the 64-image cap already in `chat-images.js:132`. Formats **PNG, JPEG, GIF, WebP, AVIF** only. The server cap is deliberately not 8: it counts files accumulated across a whole session, so an 8 there would let a session attach only eight images ever.
- Route body limit for the upload endpoint: **15mb**, mounted before the global 64 kB parser.
- Directories created `0o700`, files `0o600`.
- The client-supplied filename is a display label only and must never reach the filesystem.
- `shell` sessions and `purpose: "login"` sessions never get attachments.
- Run `npm run lint && npm run format:check && npm run check:structure` before each commit; `npx prettier --write <files>` fixes formatting.
- Commit messages follow the repo style: `feat: …`, `fix: …`, `docs: …`, `test: …`.

---

### Task 1: Attachment store

**Files:**

- Create: `server/features/chat/chat-attachments.js`
- Modify: `server/features/chat/chat-images.js:86` (change `function rasterType` to `export function rasterType`)
- Test: `tests/integration/chat-attachments-store.test.js`
- Test: `tests/property/chat-attachment-paths.test.js`

**Interfaces:**

- Consumes: `rasterType(buffer)` from `chat-images.js`, returning an image MIME string or `null`.
- Produces:
  - `attachmentDirectory(dataDir, accountId, sessionId) -> string`
  - `accountAttachmentDirectory(dataDir, accountId) -> string`
  - `class ChatAttachments` with `constructor({ dataDir, sessions })`, `async store(sessionId, { name, data }) -> { name, path }`, `async discard(sessionId) -> void`
  - `MAX_ATTACHMENT_BYTES = 10485760`, `MAX_SESSION_ATTACHMENTS = 64`

- [ ] **Step 1: Add the German server copy**

In `server/lib/i18n/de/chat.js`, add these keys inside the frozen `chat` object, after `imageUnreadable`:

```js
  attachmentInvalidPayload: "Ungültiger Bildanhang.",
  attachmentTooLarge: "Der Bildanhang ist größer als 10 MiB.",
  attachmentUnsupportedFormat:
    "Keine unterstützte Rastergrafik. Erlaubt sind PNG, JPEG, GIF, WebP und AVIF.",
  attachmentLimitReached: "Diese Sitzung hat die Höchstzahl gespeicherter Bildanhänge erreicht.",
  attachmentSessionUnavailable:
    "Bildanhänge sind nur in laufenden Sitzungen mit Bildfreigabe möglich. Bitte die Sitzung neu starten.",
  attachmentWriteFailed: "Der Bildanhang konnte nicht gespeichert werden.",
```

- [ ] **Step 2: Write the failing store test**

Create `tests/integration/chat-attachments-store.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ChatAttachments,
  attachmentDirectory,
} from "../../server/features/chat/chat-attachments.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=",
  "base64",
);

function fixture(t, session = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-attachments-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const record = {
    id: "session-one",
    accountId: "account-one",
    tool: "claude",
    status: "running",
    attachments: {
      directory: attachmentDirectory(dataDir, "account-one", "session-one"),
    },
    ...session,
  };
  const sessions = {
    async get(id) {
      if (id !== record.id) throw Object.assign(new Error("Missing"), { status: 404 });
      return record;
    },
  };
  return { dataDir, record, store: new ChatAttachments({ dataDir, sessions }) };
}

test("a valid image is stored inside the session directory with a generated name", async (t) => {
  const f = fixture(t);
  const stored = await f.store.store("session-one", {
    name: "Screenshot 2026.png",
    data: png.toString("base64"),
  });
  assert.equal(stored.name, "Screenshot 2026.png");
  assert.equal(path.dirname(stored.path), f.record.attachments.directory);
  assert.match(path.basename(stored.path), /^\d{8}T\d{6}-[0-9a-f]{8}\.png$/);
  assert.deepEqual(fs.readFileSync(stored.path), png);
  assert.equal(fs.statSync(stored.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.record.attachments.directory).mode & 0o777, 0o700);
});

test("bytes that are not a supported raster image are rejected whatever the name claims", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    () =>
      f.store.store("session-one", {
        name: "evil.png",
        data: Buffer.from("#!/bin/sh\nrm -rf /\n").toString("base64"),
      }),
    (error) => error.status === 415,
  );
  assert.equal(fs.existsSync(f.record.attachments.directory), false);
});

test("an image beyond the size limit is rejected", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    () =>
      f.store.store("session-one", {
        name: "big.png",
        data: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"),
      }),
    (error) => error.status === 413,
  );
});

test("a session without a grant cannot store attachments", async (t) => {
  const f = fixture(t, { attachments: undefined });
  await assert.rejects(
    () => f.store.store("session-one", { name: "a.png", data: png.toString("base64") }),
    (error) => error.status === 409,
  );
});

test("a stopped session cannot store attachments", async (t) => {
  const f = fixture(t, { status: "stopped" });
  await assert.rejects(
    () => f.store.store("session-one", { name: "a.png", data: png.toString("base64") }),
    (error) => error.status === 409,
  );
});

test("a session that reached the storage guard refuses further attachments", async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 64; index++)
    await f.store.store("session-one", { name: "a.png", data: png.toString("base64") });
  await assert.rejects(
    () => f.store.store("session-one", { name: "a.png", data: png.toString("base64") }),
    (error) => error.status === 409,
  );
});

test("discarding a session removes its attachment directory", async (t) => {
  const f = fixture(t);
  const stored = await f.store.store("session-one", {
    name: "a.png",
    data: png.toString("base64"),
  });
  await f.store.discard("session-one");
  assert.equal(fs.existsSync(stored.path), false);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test:integration -- chat-attachments-store`
Expected: FAIL — cannot resolve `server/features/chat/chat-attachments.js`.

- [ ] **Step 4: Export `rasterType`**

In `server/features/chat/chat-images.js` line 86, change:

```js
function rasterType(bytes) {
```

to:

```js
export function rasterType(bytes) {
```

- [ ] **Step 5: Write the store**

Create `server/features/chat/chat-attachments.js`:

```js
import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { problem } from "../../lib/storage.js";
import { rasterType } from "./chat-images.js";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// Per-session storage guard, not the per-message cap: the composer enforces 8 per message.
export const MAX_SESSION_ATTACHMENTS = 64;
const EXTENSIONS = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
});

export function accountAttachmentDirectory(dataDir, accountId) {
  return path.join(dataDir, "chat-attachments", accountId);
}
export function attachmentDirectory(dataDir, accountId, sessionId) {
  return path.join(accountAttachmentDirectory(dataDir, accountId), sessionId);
}

/** Owns uploaded chat images: validation, generated names and per-session cleanup. */
export class ChatAttachments {
  constructor({ dataDir, sessions }) {
    this.dataDir = dataDir;
    this.sessions = sessions;
  }
  async directoryFor(id) {
    const session = await this.sessions.get(id);
    const directory = session.attachments?.directory;
    // A session started before this feature carries no grant; never fall back into the project.
    if (!directory || session.status !== "running")
      throw problem(serverMessages.chat.attachmentSessionUnavailable, 409);
    return directory;
  }
  async store(id, payload) {
    const directory = await this.directoryFor(id);
    if (
      !payload ||
      typeof payload.data !== "string" ||
      typeof payload.name !== "string" ||
      !payload.name.trim()
    )
      throw problem(serverMessages.chat.attachmentInvalidPayload);
    const body = Buffer.from(payload.data, "base64");
    if (!body.length) throw problem(serverMessages.chat.attachmentInvalidPayload);
    if (body.length > MAX_ATTACHMENT_BYTES)
      throw problem(serverMessages.chat.attachmentTooLarge, 413);
    const type = rasterType(body);
    if (!type) throw problem(serverMessages.chat.attachmentUnsupportedFormat, 415);
    const existing = await fs.readdir(directory).catch(() => []);
    if (existing.length >= MAX_SESSION_ATTACHMENTS)
      throw problem(serverMessages.chat.attachmentLimitReached, 409);
    // The client name is never a path component: the stored name is generated here.
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    const file = path.join(
      directory,
      `${stamp}-${randomBytes(4).toString("hex")}.${EXTENSIONS[type]}`,
    );
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(file, body, { mode: 0o600, flag: "wx" });
    } catch {
      throw problem(serverMessages.chat.attachmentWriteFailed, 500);
    }
    return { name: payload.name.slice(0, 200), path: file };
  }
  async discard(id) {
    const session = await this.sessions.get(id).catch(() => null);
    const directory = session?.attachments?.directory;
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:integration -- chat-attachments-store`
Expected: PASS, 7 tests.

- [ ] **Step 7: Write the failing property test**

Create `tests/property/chat-attachment-paths.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import {
  ChatAttachments,
  attachmentDirectory,
} from "../../server/features/chat/chat-attachments.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=",
  "base64",
);

test("no client-supplied name can place an attachment outside its session directory", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-attachment-names-"));
  const directory = attachmentDirectory(dataDir, "account", "session");
  const store = new ChatAttachments({
    dataDir,
    sessions: {
      async get() {
        return { id: "session", status: "running", attachments: { directory } };
      },
    },
  });
  try {
    // check() is fc.assert(), which returns a promise for an asyncProperty.
    // Without the await this test would pass while asserting nothing.
    await check(
      fc.asyncProperty(fc.string({ maxLength: 300 }), async (name) => {
        fs.rmSync(directory, { recursive: true, force: true });
        let stored;
        try {
          stored = await store.store("session", { name, data: png.toString("base64") });
        } catch {
          return; // A rejected name stores nothing, which satisfies the property.
        }
        const resolved = path.resolve(stored.path);
        assert.equal(path.dirname(resolved), directory);
        assert.equal(resolved.startsWith(directory + path.sep), true);
      }),
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 8: Run the property test**

Run: `npm run test:property -- chat-attachment-paths`
Expected: PASS. `check` is `fc.assert` (see `tests/helpers/property.js`), so the `await` above is required; without it the test asserts nothing.

- [ ] **Step 9: Lint, format and commit**

```bash
npx prettier --write server/features/chat/chat-attachments.js server/features/chat/chat-images.js server/lib/i18n/de/chat.js tests/integration/chat-attachments-store.test.js tests/property/chat-attachment-paths.test.js
npm run lint && npm run check:structure
git add server/features/chat/chat-attachments.js server/features/chat/chat-images.js server/lib/i18n/de/chat.js tests/integration/chat-attachments-store.test.js tests/property/chat-attachment-paths.test.js
git commit -m "feat: store validated chat image attachments outside the project"
```

---

### Task 2: Upload endpoint

**Files:**

- Modify: `server/http/routes/chat.js`
- Modify: `server/app.js:94-98`
- Modify: `server/application/services.js`
- Test: `tests/integration/chat-attachments-route.test.js`

**Interfaces:**

- Consumes: `ChatAttachments` from Task 1.
- Produces: `POST /api/sessions/:id/chat/attachments` accepting `{ name, data }`, responding `201` with `{ name, path }`; service key `chatAttachments`.

- [ ] **Step 1: Write the failing route test**

Create `tests/integration/chat-attachments-route.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { attachmentDirectory } from "../../server/features/chat/chat-attachments.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=",
  "base64",
);

async function fixture(t, overrides = {}) {
  const { root: dir, application: app, url } = await applicationFixture(t);
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const session = {
    id: "one",
    accountId: "local-claude",
    tool: "claude",
    cwd,
    status: "running",
    attachments: {
      directory: attachmentDirectory(app.config.dataDir, "local-claude", "one"),
    },
    ...overrides,
  };
  app.sessions.get = async (id) => {
    if (id !== "one") throw Object.assign(new Error("Missing"), { status: 404 });
    return session;
  };
  return { url, session, dataDir: app.config.dataDir };
}

async function upload(f, body) {
  return fetch(`${f.url}/api/sessions/one/chat/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("uploading an image returns its stored path and display name", async (t) => {
  const f = await fixture(t);
  const response = await upload(f, {
    name: "Bildschirmfoto.png",
    data: png.toString("base64"),
  });
  assert.equal(response.status, 201);
  const stored = await response.json();
  assert.equal(stored.name, "Bildschirmfoto.png");
  assert.equal(path.dirname(stored.path), f.session.attachments.directory);
  assert.deepEqual(fs.readFileSync(stored.path), png);
});

test("a payload above the global 64 kB parser is still accepted", async (t) => {
  const f = await fixture(t);
  // A 1x1 PNG passes even when the route-scoped parser is missing, so it cannot
  // prove the mount. rasterType only reads the header, so padding keeps this a
  // valid PNG while pushing the body past the global 64 kB limit.
  const padded = Buffer.concat([png, Buffer.alloc(1024 * 1024)]);
  const response = await upload(f, {
    name: "large.png",
    data: padded.toString("base64"),
  });
  assert.equal(response.status, 201);
  assert.equal(fs.statSync((await response.json()).path).size, padded.length);
});

test("a shell session cannot receive attachments", async (t) => {
  const f = await fixture(t, { tool: "shell", attachments: undefined });
  assert.equal(
    (await upload(f, { name: "a.png", data: png.toString("base64") })).status,
    409,
  );
});

test("a session started without a grant cannot receive attachments", async (t) => {
  const f = await fixture(t, { attachments: undefined });
  assert.equal(
    (await upload(f, { name: "a.png", data: png.toString("base64") })).status,
    409,
  );
});

test("a payload larger than the route body limit is refused rather than stored", async (t) => {
  const f = await fixture(t);
  const response = await upload(f, {
    name: "huge.png",
    data: Buffer.alloc(16 * 1024 * 1024).toString("base64"),
  });
  assert.equal(response.ok, false);
  assert.equal(fs.existsSync(f.session.attachments.directory), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration -- chat-attachments-route`
Expected: FAIL — the endpoint responds 404.

- [ ] **Step 3: Wire the service**

In `server/application/services.js`, add the import beside the other chat imports:

```js
import { ChatAttachments } from "../features/chat/chat-attachments.js";
```

After the `chatImages` construction, add:

```js
const chatAttachments = new ChatAttachments({ dataDir: config.dataDir, sessions });
```

Add `chatAttachments,` to the returned object, next to `chatImages,`.

- [ ] **Step 4: Add the route**

In `server/http/routes/chat.js`, destructure the new service and add the endpoint before `return router;`:

```js
const { chatImages, chatAttachments, chat } = services;
```

```js
router.post("/sessions/:id/chat/attachments", async (req, res) =>
  res.status(201).json(await chatAttachments.store(req.params.id, req.body)),
);
```

- [ ] **Step 5: Raise the body limit for that route only**

In `server/app.js`, directly above the existing skills limit at line 94, add:

```js
app.use(
  "/api/sessions/:id/chat/attachments",
  express.json({ limit: "15mb", strict: true }),
);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:integration -- chat-attachments-route`
Expected: PASS, 5 tests.

- [ ] **Step 7: Lint, format and commit**

```bash
npx prettier --write server/app.js server/http/routes/chat.js server/application/services.js tests/integration/chat-attachments-route.test.js
npm run lint && npm run check:structure
git add server/app.js server/http/routes/chat.js server/application/services.js tests/integration/chat-attachments-route.test.js
git commit -m "feat: accept chat image uploads on a size-scoped endpoint"
```

---

### Task 3: Per-tool directory grant

**Files:**

- Create: `server/features/sessions/attachment-access.js`
- Test: `tests/matrix/chat-attachment-access.test.js`

**Interfaces:**

- Consumes: `accountAttachmentDirectory`, `attachmentDirectory` from Task 1; `profileLocation` and `documents` from `server/features/cli-profiles/configuration.js`.
- Produces: `grantAttachmentAccess({ tool, dataDir, accountId, sessionId, launch, profile }) -> { directory } | null`, mutating `launch.args` for Claude and Codex and writing the OpenCode `references` entry. `profile` is the object returned by `profileLocation(accounts, accountId)`, or `null` when unavailable.

- [ ] **Step 1: Read the OpenCode config helpers**

Read `server/features/cli-profiles/configuration.js` in full, in particular `profileLocation` (line 8), `documents` (line 23) and the `jsonc-parser` `modify`/`applyEdits` usage. The OpenCode branch must reuse that machinery so unrelated configuration survives; do not write `opencode.json` with `JSON.stringify`.

- [ ] **Step 2: Write the failing matrix test**

Create `tests/matrix/chat-attachment-access.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { grantAttachmentAccess } from "../../server/features/sessions/attachment-access.js";
import {
  accountAttachmentDirectory,
  attachmentDirectory,
} from "../../server/features/chat/chat-attachments.js";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-grant-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const root = path.join(dataDir, "profile");
  fs.mkdirSync(root, { recursive: true });
  return { dataDir, profile: { root, account: { tool: "opencode" } } };
}

for (const tool of ["claude", "codex"])
  test(`${tool} sessions receive --add-dir for the session directory`, (t) => {
    const f = fixture(t);
    const launch = { args: ["--existing"] };
    const granted = grantAttachmentAccess({
      tool,
      dataDir: f.dataDir,
      accountId: "account",
      sessionId: "session",
      launch,
      profile: null,
    });
    const expected = attachmentDirectory(f.dataDir, "account", "session");
    assert.equal(granted.directory, expected);
    assert.deepEqual(launch.args, ["--existing", "--add-dir", expected]);
    assert.equal(fs.statSync(expected).isDirectory(), true);
  });

test("opencode sessions receive an account-scoped references entry and no flag", (t) => {
  const f = fixture(t);
  const launch = { args: ["--existing"] };
  const granted = grantAttachmentAccess({
    tool: "opencode",
    dataDir: f.dataDir,
    accountId: "account",
    sessionId: "session",
    launch,
    profile: f.profile,
  });
  assert.equal(granted.directory, attachmentDirectory(f.dataDir, "account", "session"));
  assert.deepEqual(launch.args, ["--existing"]);
  const config = JSON.parse(
    fs.readFileSync(path.join(f.profile.root, "opencode.json"), "utf8"),
  );
  assert.equal(
    config.references["agentpier-attachments"].path,
    accountAttachmentDirectory(f.dataDir, "account"),
  );
});

test("an existing opencode configuration keeps its unrelated fields and gains one entry", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.profile.root, "opencode.json"),
    JSON.stringify({
      model: "anthropic/claude-sonnet-4",
      references: { docs: { path: "/docs" } },
    }),
  );
  for (const sessionId of ["first", "second"])
    grantAttachmentAccess({
      tool: "opencode",
      dataDir: f.dataDir,
      accountId: "account",
      sessionId,
      launch: { args: [] },
      profile: f.profile,
    });
  const config = JSON.parse(
    fs.readFileSync(path.join(f.profile.root, "opencode.json"), "utf8"),
  );
  assert.equal(config.model, "anthropic/claude-sonnet-4");
  assert.equal(config.references.docs.path, "/docs");
  assert.equal(Object.keys(config.references).length, 2);
});

test("shell sessions receive no grant at all", (t) => {
  const f = fixture(t);
  const launch = { args: ["--existing"] };
  assert.equal(
    grantAttachmentAccess({
      tool: "shell",
      dataDir: f.dataDir,
      accountId: "account",
      sessionId: "session",
      launch,
      profile: null,
    }),
    null,
  );
  assert.deepEqual(launch.args, ["--existing"]);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test:matrix -- chat-attachment-access`
Expected: FAIL — cannot resolve `attachment-access.js`.

- [ ] **Step 4: Write the grant module**

Create `server/features/sessions/attachment-access.js`:

```js
import fs from "node:fs";
import path from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import {
  accountAttachmentDirectory,
  attachmentDirectory,
} from "../chat/chat-attachments.js";

const REFERENCE_ALIAS = "agentpier-attachments";
const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

/** OpenCode has no --add-dir; its references entry is account-scoped so it cannot grow per session. */
function grantOpenCode(profile, directory) {
  if (!profile?.root) return;
  const file = path.join(profile.root, "opencode.json");
  const source = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "{}";
  const edited = applyEdits(
    source,
    modify(source, ["references", REFERENCE_ALIAS], { path: directory }, FORMAT),
  );
  fs.mkdirSync(profile.root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, edited, { mode: 0o600 });
}

export function grantAttachmentAccess({
  tool,
  dataDir,
  accountId,
  sessionId,
  launch,
  profile,
}) {
  if (!["claude", "codex", "opencode"].includes(tool)) return null;
  const directory = attachmentDirectory(dataDir, accountId, sessionId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (tool === "opencode")
    grantOpenCode(profile, accountAttachmentDirectory(dataDir, accountId));
  else launch.args.push("--add-dir", directory);
  return { directory };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:matrix -- chat-attachment-access`
Expected: PASS, 5 tests.

- [ ] **Step 6: Lint, format and commit**

```bash
npx prettier --write server/features/sessions/attachment-access.js tests/matrix/chat-attachment-access.test.js
npm run lint && npm run check:structure
git add server/features/sessions/attachment-access.js tests/matrix/chat-attachment-access.test.js
git commit -m "feat: grant each CLI read access to its session attachment directory"
```

---

### Task 4: Launch and cleanup wiring

**Files:**

- Modify: `server/application/session-lifecycle.js` (inside `launchResolved`, beside `sharedProfiles?.prepare(account, launch)`)
- Modify: `server/features/sessions/session-manager.js:337-348` (persist the grant on the session record)
- Modify: `server/http/routes/sessions.js:33-40` (discard on delete)
- Test: `tests/integration/chat-attachment-launch.test.js`

**Interfaces:**

- Consumes: `grantAttachmentAccess` from Task 3, `chatAttachments.discard` from Task 1.
- Produces: `session.attachments = { directory }` on the persisted session record.

- [ ] **Step 1: Write the failing launch test**

Create `tests/integration/chat-attachment-launch.test.js`. Model the session-launch setup on an existing launching test — read `tests/integration/default-accounts.test.js` first for how accounts and launches are prepared in this repo, and reuse that shape rather than inventing one:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { attachmentDirectory } from "../../server/features/chat/chat-attachments.js";

test("a launched claude session records its attachment directory and passes --add-dir", async (t) => {
  const f = await applicationFixture(t);
  const cwd = path.join(f.root, "project");
  fs.mkdirSync(cwd);
  const session = await f.application.launch({ accountId: "local-claude", cwd });
  const expected = attachmentDirectory(
    f.application.config.dataDir,
    session.accountId,
    session.id,
  );
  assert.equal(session.attachments.directory, expected);
  assert.equal(fs.statSync(expected).isDirectory(), true);
  const launch = JSON.parse(
    fs.readFileSync(
      path.join(f.application.config.dataDir, "sessions", `${session.id}.launch.json`),
      "utf8",
    ),
  );
  assert.equal(launch.args.includes("--add-dir"), true);
  assert.equal(launch.args.includes(expected), true);
});

test("deleting a session removes its attachment directory", async (t) => {
  const f = await applicationFixture(t);
  const cwd = path.join(f.root, "project");
  fs.mkdirSync(cwd);
  const session = await f.application.launch({ accountId: "local-claude", cwd });
  const directory = session.attachments.directory;
  fs.writeFileSync(path.join(directory, "kept.png"), "x");
  const response = await fetch(`${f.url}/api/sessions/${session.id}`, {
    method: "DELETE",
  });
  assert.equal(response.status, 204);
  assert.equal(fs.existsSync(directory), false);
});
```

If `local-claude` is not a usable account id in this fixture, or the launch payload needs a `command`, adapt from the existing launching test you read — do not stub `sessions.get`, this task must exercise the real launch path.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration -- chat-attachment-launch`
Expected: FAIL — `session.attachments` is undefined.

- [ ] **Step 3: Grant access at launch**

In `server/application/session-lifecycle.js`, import the grant:

```js
import { grantAttachmentAccess } from "../features/sessions/attachment-access.js";
import { profileLocation } from "../features/cli-profiles/configuration.js";
```

The grant needs the session id, which is created two lines below `sharedProfiles?.prepare`. Insert it directly after the existing Claude `--session-id` push, so the surrounding code reads:

```js
if (!login) sharedProfiles?.prepare(account, launch);
const id = trusted.id || randomUUID();
if (!login && account.tool === "claude" && !trusted.transformLaunch)
  launch.args.push("--session-id", id);
// NEW: the grant goes here, once `id` exists and before the launch is handed on.
```

Add:

```js
const attachments =
  login || account.tool === "shell"
    ? null
    : grantAttachmentAccess({
        tool: account.tool,
        dataDir: config.dataDir,
        accountId: account.id,
        sessionId: id,
        launch,
        profile:
          account.tool === "opencode" ? profileLocation(accounts, account.id) : null,
      });
```

Pass `...(attachments ? { attachments } : {})` into the options object handed to the session start call further down in the same function. Read the surrounding code to place it beside the other optional options such as `memory` and `nativeRequests`.

- [ ] **Step 4: Persist the grant on the session record**

In `server/features/sessions/session-manager.js`, after the `nativeRequests` block ending at line 348, add:

```js
if (
  options.attachments &&
  typeof options.attachments.directory === "string" &&
  path.isAbsolute(options.attachments.directory) &&
  !options.attachments.directory.includes("\0") &&
  tool !== "shell" &&
  options.purpose !== "login"
)
  session.attachments = { directory: options.attachments.directory };
```

- [ ] **Step 5: Discard on delete**

In `server/http/routes/sessions.js`, destructure `chatAttachments` from `services` alongside the other services, and add inside the `DELETE /sessions/:id` handler, next to `chat.remove(req.params.id);`:

```js
await chatAttachments.discard(req.params.id);
```

Place it **before** `await sessions.remove(req.params.id);` so the session record still carries the directory when it is read.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:integration -- chat-attachment-launch`
Expected: PASS, 2 tests.

- [ ] **Step 7: Run the full backend suite for regressions**

Run: `npm test`
Expected: PASS. Session launch is touched by many tests; investigate any failure before continuing.

- [ ] **Step 8: Lint, format and commit**

```bash
npx prettier --write server/application/session-lifecycle.js server/features/sessions/session-manager.js server/http/routes/sessions.js tests/integration/chat-attachment-launch.test.js
npm run lint && npm run check:structure
git add server/application/session-lifecycle.js server/features/sessions/session-manager.js server/http/routes/sessions.js tests/integration/chat-attachment-launch.test.js
git commit -m "feat: grant and clean up attachment directories with the session"
```

---

### Task 5: Thumbnails for the user's own messages

**Files:**

- Modify: `server/features/chat/chat-images.js:138`
- Test: `tests/integration/chat-images.test.js`

**Interfaces:**

- Consumes: nothing new.
- Produces: `descriptors()` now attaches `images` to `user` messages as well as `assistant` and `tool`.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/chat-images.test.js`, reusing the `fixture`, `listing` and `png` helpers already at the top of that file:

```js
test("an image path the user sent is rendered in their own message", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.cwd, "sent.png"), png);
  f.snapshots.one.messages = [
    { id: "m1", role: "user", text: `Schau dir das an\n${path.join(f.cwd, "sent.png")}` },
  ];
  const body = await listing(f);
  assert.equal(body.messages[0].images.length, 1);
  assert.equal(body.messages[0].images[0].path, path.join(f.cwd, "sent.png"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration -- chat-images`
Expected: FAIL — `images` is an empty array for the `user` role.

- [ ] **Step 3: Include the user role**

In `server/features/chat/chat-images.js` line 138, change:

```js
      if (!["assistant", "tool"].includes(message.role) || !remaining) continue;
```

to:

```js
      if (!["assistant", "tool", "user"].includes(message.role) || !remaining) continue;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:integration -- chat-images`
Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 5: Lint, format and commit**

```bash
npx prettier --write server/features/chat/chat-images.js tests/integration/chat-images.test.js
npm run lint && npm run check:structure
git add server/features/chat/chat-images.js tests/integration/chat-images.test.js
git commit -m "feat: show image previews on the user's own chat messages"
```

---

### Task 6: Composer attachment UI

**Files:**

- Create: `web/features/chat/useChatAttachments.js`
- Create: `web/features/chat/ChatAttachments.jsx`
- Create: `web/features/chat/chat-attachments.css`
- Modify: `web/features/chat/ChatComposer.jsx`
- Modify: `web/features/chat/ChatView.jsx:160-194`
- Modify: `web/features/chat/useChatController.js`
- Modify: `web/lib/i18n/de/chat.js`
- Test: `tests/browser/chat-attachments.spec.js`

**Interfaces:**

- Consumes: `POST /api/sessions/:id/chat/attachments` from Task 2; `session.attachments` from Task 4.
- Produces: `useChatAttachments({ session, request })` returning `{ attachments, add, remove, clear, error, uploading, supported }`, where `attachments` is `[{ key, name, path, previewUrl }]` and `supported` is `Boolean(session.attachments)`.

- [ ] **Step 1: Add the German client copy**

In `web/lib/i18n/de/chat.js`, add a new export beside `chatComposerCopy`:

```js
export const chatAttachmentsCopy = {
  attachAriaLabel: "Bild anhängen",
  attachButton: "Bild",
  dropHint: "Bild hier ablegen",
  removeAriaLabel: (name) => `Anhang ${name} entfernen`,
  listAriaLabel: "Angehängte Bilder",
  uploading: "Bild wird hochgeladen …",
  unsupportedSession:
    "Für Bildanhänge muss die Sitzung neu gestartet werden. Bestehende Sitzungen haben keine Bildfreigabe.",
  tooManyFiles: "Es sind höchstens 8 Bildanhänge pro Nachricht möglich.",
  notAnImage: "Nur Bilddateien können angehängt werden.",
};
```

- [ ] **Step 2: Write the failing browser test**

Create `tests/browser/chat-attachments.spec.js`. The fixture follows the catch-all `page.route("**/api/**")` dispatch used by `tests/browser/chat.spec.js:126`:

```js
import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=",
  "base64",
);
const directory = "/tmp/agentpier-test-attachments/local-claude/chat-demo";

async function fixture(page, { granted = true } = {}) {
  const session = {
    id: "chat-demo",
    name: "AgentPier entwickeln",
    tool: "claude",
    accountId: "local-claude",
    cwd: "/home/test/agentpier",
    status: "running",
    ...(granted ? { attachments: { directory } } : {}),
  };
  const state = {
    tools: [{ id: "claude", name: "Claude Code", installed: true }],
    accounts: [
      { id: "local-claude", name: "Claude · Arbeit", tool: "claude", kind: "local" },
    ],
    sessions: [session],
    home: "/home/test",
    remoteUrl: null,
  };
  const data = {
    availability: "ready",
    providerSessionId: "native-one",
    messages: [],
    tasks: [],
  };
  const uploads = [];
  const inputs = [];
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    let result = {};
    if (p === "/api/state") result = state;
    else if (p.endsWith("/chat/attachments")) {
      const body = route.request().postDataJSON();
      uploads.push(body);
      result = { name: body.name, path: `${directory}/20260908T142233-a3f1b2c4.png` };
    } else if (p.endsWith("/chat")) result = data;
    else if (p.endsWith("/input")) inputs.push(route.request().postDataJSON());
    else if (p.endsWith("/screen")) result = { text: "TUI_STATUS_ONLY" };
    await route.fulfill({ json: result });
  });
  await page.goto(base + "/sessions/chat-demo/chat");
  return { data, uploads, inputs };
}

test("choosing a file uploads it and shows a removable chip", async ({ page }) => {
  const f = await fixture(page);
  await page.setInputFiles('input[type="file"]', {
    name: "screenshot.png",
    mimeType: "image/png",
    buffer: png,
  });
  const chip = page.getByRole("listitem").filter({ hasText: "screenshot.png" });
  await expect(chip).toBeVisible();
  expect(f.uploads).toHaveLength(1);
  expect(f.uploads[0].name).toBe("screenshot.png");
  expect(f.uploads[0].data).toBe(png.toString("base64"));
  await chip.getByRole("button", { name: "Anhang screenshot.png entfernen" }).click();
  await expect(chip).toHaveCount(0);
});

test("dropping an image on the chat panel attaches it", async ({ page }) => {
  await fixture(page);
  const transfer = await page.evaluateHandle(
    (bytes) => {
      const carrier = new DataTransfer();
      carrier.items.add(
        new File([new Uint8Array(bytes)], "dropped.png", { type: "image/png" }),
      );
      return carrier;
    },
    [...png],
  );
  const panel = page.locator(".chat-panel");
  await panel.dispatchEvent("dragover", { dataTransfer: transfer });
  await expect(panel).toHaveAttribute("data-dropping", "true");
  await panel.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(
    page.getByRole("listitem").filter({ hasText: "dropped.png" }),
  ).toBeVisible();
  await expect(panel).not.toHaveAttribute("data-dropping", "true");
});

test("pasting a screenshot into the message field attaches it", async ({ page }) => {
  const f = await fixture(page);
  const transfer = await page.evaluateHandle(
    (bytes) => {
      const carrier = new DataTransfer();
      carrier.items.add(
        new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }),
      );
      return carrier;
    },
    [...png],
  );
  await page.getByLabel("Nachricht").dispatchEvent("paste", { clipboardData: transfer });
  await expect(
    page.getByRole("listitem").filter({ hasText: "pasted.png" }),
  ).toBeVisible();
  expect(f.uploads).toHaveLength(1);
});

test("a session without a grant hides the attachment control and explains why", async ({
  page,
}) => {
  await fixture(page, { granted: false });
  await expect(page.getByText(/Sitzung neu gestartet/)).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx playwright test tests/browser/chat-attachments.spec.js`
Expected: FAIL — no file input exists.

- [ ] **Step 4: Write the hook**

Create `web/features/chat/useChatAttachments.js`:

```js
import { chatAttachmentsCopy as copy } from "../../lib/i18n/de/chat.js";
import { useCallback, useEffect, useRef, useState } from "react";

const MAX_ATTACHMENTS = 8;

/** Owns pending chat image uploads: local previews, server paths and their errors. */
export default function useChatAttachments({ session, request }) {
  const [attachments, setAttachments] = useState([]);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const previews = useRef(new Set());
  const supported = Boolean(session.attachments);

  const release = useCallback((url) => {
    if (previews.current.delete(url)) URL.revokeObjectURL(url);
  }, []);
  useEffect(
    () => () => {
      for (const url of previews.current) URL.revokeObjectURL(url);
      previews.current.clear();
    },
    [],
  );

  const add = useCallback(
    async (files) => {
      const images = [...files].filter((file) => file.type.startsWith("image/"));
      if (!images.length) return setError(copy.notAnImage);
      setError("");
      setUploading(true);
      try {
        for (const file of images) {
          let accepted = true;
          setAttachments((current) => {
            if (current.length >= MAX_ATTACHMENTS) {
              accepted = false;
              setError(copy.tooManyFiles);
            }
            return current;
          });
          if (!accepted) break;
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error(copy.notAnImage));
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.readAsDataURL(file);
          });
          const stored = await request(
            `/sessions/${session.id}/chat/attachments`,
            "POST",
            { name: file.name, data },
          );
          const previewUrl = URL.createObjectURL(file);
          previews.current.add(previewUrl);
          setAttachments((current) => [
            ...current,
            { key: stored.path, name: stored.name, path: stored.path, previewUrl },
          ]);
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setUploading(false);
      }
    },
    [request, session.id],
  );

  const remove = useCallback(
    (key) =>
      setAttachments((current) =>
        current.filter((item) => {
          if (item.key !== key) return true;
          release(item.previewUrl);
          return false;
        }),
      ),
    [release],
  );
  const clear = useCallback(() => {
    setAttachments((current) => {
      for (const item of current) release(item.previewUrl);
      return [];
    });
  }, [release]);

  return { attachments, add, remove, clear, error, uploading, supported };
}
```

- [ ] **Step 5: Write the chips and drop overlay**

Create `web/features/chat/ChatAttachments.jsx`:

```js
import { chatAttachmentsCopy as copy } from "../../lib/i18n/de/chat.js";
import React, { useRef } from "react";

export default function ChatAttachments({
  attachments,
  add,
  remove,
  uploading,
  supported,
  disabled,
  error,
}) {
  const picker = useRef(null);
  if (!supported)
    return <p className="chat-attachments-notice">{copy.unsupportedSession}</p>;
  return (
    <div className="chat-attachments">
      <ul className="chat-attachment-list" aria-label={copy.listAriaLabel}>
        {attachments.map((item) => (
          <li key={item.key} className="chat-attachment-chip">
            <img src={item.previewUrl} alt="" />
            <span className="chat-attachment-name">{item.name}</span>
            <button
              type="button"
              aria-label={copy.removeAriaLabel(item.name)}
              onClick={() => remove(item.key)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="button chat-attachment-add"
        aria-label={copy.attachAriaLabel}
        disabled={disabled || uploading}
        onClick={() => picker.current?.click()}
      >
        {uploading ? copy.uploading : copy.attachButton}
      </button>
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          add(event.target.files);
          event.target.value = "";
        }}
      />
      {error && (
        <p className="chat-attachments-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Style the chips and the drop overlay**

Create `web/features/chat/chat-attachments.css`. Read `web/features/chat/chat-images.css` first and reuse its custom properties and visual language rather than introducing new colours:

```css
.chat-attachments {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.chat-attachment-list {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  list-style: none;
  margin: 0;
  padding: 0;
}
.chat-attachment-chip {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}
.chat-attachment-chip img {
  width: 2rem;
  height: 2rem;
  object-fit: cover;
  border-radius: 0.25rem;
}
.chat-attachment-name {
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-panel[data-dropping="true"]::after {
  content: attr(data-drop-hint);
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--surface) 85%, transparent);
  border: 2px dashed var(--accent);
  border-radius: 0.75rem;
  pointer-events: none;
}
```

If `--border`, `--surface` or `--accent` are not the names used in this project, take the actual custom property names from `web/features/chat/chat.css`.

- [ ] **Step 7: Wire the hook into the controller**

In `web/features/chat/useChatController.js`, import and call the hook, and return its values:

```js
import useChatAttachments from "./useChatAttachments.js";
```

Inside the hook body, after the existing state declarations:

```js
const attachmentState = useChatAttachments({ session, request });
```

Add `attachments: attachmentState,` to the returned object.

- [ ] **Step 8: Render in the composer and accept drops on the panel**

In `web/features/chat/ChatComposer.jsx`, accept an `attachments` prop and render the component between the `<textarea>` and the existing `<div>` that holds the hint and send button:

```jsx
<ChatAttachments
  attachments={attachments.attachments}
  add={attachments.add}
  remove={attachments.remove}
  uploading={attachments.uploading}
  supported={attachments.supported}
  error={attachments.error}
  disabled={requestPending || session.status !== "running"}
/>
```

Add the import, and add paste handling to the existing `<textarea>`:

```jsx
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length) {
            event.preventDefault();
            attachments.add(files);
          }
        }}
```

In `web/features/chat/ChatView.jsx`, pass `attachments` through to `ChatComposer`, and put the drop handling on the chat panel element that wraps the messages and compose area (the `<section>` around lines 100-195). Use a `dropping` state so the overlay appears:

```jsx
        onDragOver={(event) => {
          if (!attachments.supported) return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          if (!attachments.supported) return;
          event.preventDefault();
          setDropping(false);
          attachments.add(event.dataTransfer.files);
        }}
        data-dropping={dropping || undefined}
        data-drop-hint={copy.dropHint}
```

Import `chatAttachmentsCopy` for `dropHint`, declare `const [dropping, setDropping] = useState(false);`, ensure the section carries the `chat-panel` class the test selects and `position: relative` for the overlay, and import the new stylesheet where `chat-images.css` is already imported.

- [ ] **Step 9: Run the browser test to verify it passes**

Run: `npx playwright test tests/browser/chat-attachments.spec.js`
Expected: PASS, 4 tests.

- [ ] **Step 10: Lint, format and commit**

```bash
npx prettier --write web/features/chat web/lib/i18n/de/chat.js tests/browser/chat-attachments.spec.js
npm run lint && npm run check:structure && npm run build
git add web/features/chat web/lib/i18n/de/chat.js tests/browser/chat-attachments.spec.js
git commit -m "feat: attach images in the chat composer by drop, paste or file picker"
```

---

### Task 7: Send attachments with the message

**Files:**

- Modify: `web/features/chat/useChatController.js` (the `submit` function, lines 94-113)
- Test: `tests/browser/chat-attachments.spec.js`

**Interfaces:**

- Consumes: `attachments.attachments` and `attachments.clear` from Task 6.
- Produces: the message body sent to `POST /sessions/:id/input` is `text` followed by one absolute path per line.

- [ ] **Step 1: Write the failing test**

Append to `tests/browser/chat-attachments.spec.js`:

```js
test("sending appends one absolute path per attachment below the text", async ({
  page,
}) => {
  const sent = [];
  await page.route("**/api/sessions/one/input", async (route) => {
    sent.push(JSON.parse(route.request().postData()));
    await route.fulfill({ status: 200, body: "{}" });
  });
  await page.setInputFiles('input[type="file"]', {
    name: "shot.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.getByRole("listitem").filter({ hasText: "shot.png" })).toBeVisible();
  await page.getByLabel("Nachricht").fill("Warum ist das verrutscht?");
  await page.getByRole("button", { name: /senden/i }).click();
  expect(sent).toHaveLength(1);
  const [line, pathLine, ...rest] = sent[0].text.split("\n");
  expect(line).toBe("Warum ist das verrutscht?");
  expect(pathLine.startsWith("/")).toBe(true);
  expect(pathLine).toMatch(/\.png$/);
  expect(rest).toHaveLength(0);
  await expect(page.getByRole("listitem").filter({ hasText: "shot.png" })).toHaveCount(0);
});

test("the sent image appears as a preview on the user's own message", async ({
  page,
}) => {
  const id = "a".repeat(64);
  const f = await fixture(page);
  f.data.messages = [
    {
      id: "u1",
      role: "user",
      text: `Warum ist das verrutscht?\n${directory}/20260908T142233-a3f1b2c4.png`,
      images: [
        {
          id,
          path: `${directory}/20260908T142233-a3f1b2c4.png`,
          url: `/api/sessions/chat-demo/chat/images/${id}`,
        },
      ],
    },
  ];
  await page.reload();
  const preview = page.getByAltText(/^Bildvorschau: /);
  await expect(preview).toBeVisible();
  await expect(preview).toHaveJSProperty("naturalWidth", 1);
});
```

The fixture's catch-all route must serve the bytes for that image path. Extend the `page.route` dispatch in `fixture` with a branch before the `/chat` branch:

```js
    else if (p.includes("/chat/images/"))
      return route.fulfill({ contentType: "image/png", body: png });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test tests/browser/chat-attachments.spec.js -g "appends one absolute path"`
Expected: FAIL — the sent text contains only the typed message.

- [ ] **Step 3: Append the paths on submit**

In `web/features/chat/useChatController.js`, change the guard and body of `submit`. The current first line is `if (session.pipeline?.headless || !text.trim() || busy || modelPending) return;`. Replace the function's opening and the request call so a message consisting only of attachments is still allowed to send:

```js
async function submit(event) {
  event.preventDefault();
  const pending = attachmentState.attachments;
  if (
    session.pipeline?.headless ||
    (!text.trim() && !pending.length) ||
    busy ||
    modelPending
  )
    return;
  const submitted = text;
  // Bare paths, never @mentions: an @ opens the CLI's file autocompletion mid-paste.
  const body = [submitted.trim(), ...pending.map((item) => item.path)]
    .filter(Boolean)
    .join("\n");
  setBusy(true);
  setSent(false);
  try {
    await request(`/sessions/${session.id}/input`, "POST", {
      text: body,
      submit: true,
    });
    setText((current) => (current === submitted ? "" : current));
    attachmentState.clear();
    setError("");
    setSent(true);
  } catch (err) {
    setError(err.message);
  } finally {
    setBusy(false);
  }
}
```

Also update the send button's `disabled` condition in `web/features/chat/ChatComposer.jsx` so an attachment-only message is sendable: replace `!text.trim() ||` with `(!text.trim() && !attachments.attachments.length) ||`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx playwright test tests/browser/chat-attachments.spec.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run every suite**

Run: `npm run check && npx playwright test`
Expected: PASS throughout.

- [ ] **Step 6: Lint, format and commit**

```bash
npx prettier --write web/features/chat tests/browser/chat-attachments.spec.js
git add web/features/chat tests/browser/chat-attachments.spec.js
git commit -m "feat: send attached image paths with the chat message"
```

---

## Notes for the executor

- **OpenCode is not installed on this machine.** `which opencode` finds nothing, so the OpenCode branch of Task 3 is verified against the config fixture only, never against the real CLI. Claude and Codex are installed and their `--add-dir` flags were confirmed from `--help`. Do not claim the OpenCode path was verified end to end.
- **Codex's `--add-dir` is documented as "writable"**, and its `workspace-write` sandbox already permits wide reads. The flag is still passed so the grant is explicit and does not depend on sandbox defaults.
- **Do not touch `POST /sessions/:id/input`.** It is the shared terminal input path with its own guards and a 32000-character limit; this feature composes its body on the client and leaves the route alone.
- **Sessions started before this feature have no grant.** The UI must say so rather than falling back to writing into the user's project.
