# Asset Caching and Clean Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cache content-hashed Vite assets for a year while HTML and API stay uncached, and tell open clients when the server runs a newer build.

**Architecture:** A cache-policy module sets `Cache-Control` for static files. A build ID is computed at build time, embedded as a meta tag, and sent by the server as `X-AgentPier-Build` on every response. A shared client helper compares the two and raises one window event, which shows a non-modal banner and switches `RecoveryView` to update copy.

**Tech Stack:** Node.js 22 ES modules, Express 5 (`express.static`/`send`), Vite 8 plugin hooks, React 19, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-asset-caching-design.md`

## Global Constraints

- App documents (`/`, `/index.html`, SPA routes, `/artifacts/view/:id`) stay `Cache-Control: no-store`.
- Hashed assets: exactly `max-age=31536000, immutable` (no `public`).
- Unhashed static files (root files and unhashed `/assets/*`): `no-cache`.
- `/api/*`, `/auth/*`, all 404 and error responses: `no-store`.
- Header name `X-AgentPier-Build`; meta tag `<meta name="agentpier-build" content="<id>">`; window event `agentpier-update-available`.
- The service worker (`public/sw.js`) is not changed. No `vite:preloadError` handler. The app never reloads on its own.
- Every UI string exists in `web/lib/i18n/de/` and `web/lib/i18n/en/` with matching keys; components import reactive copy from `web/lib/i18n/messages/`.
- Source and test files stay at or below 600 lines. Prettier: two spaces, double quotes, semicolons, trailing commas, 90 columns.
- Tests must not touch real user sessions or the default tmux server; reuse `tests/helpers/` fixtures.
- Commits use `feat:`/`fix:`/`chore:` prefixes in English and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A conditional or range request for a hashed asset that fails (412, 416) must not leave `immutable` on the error response. Pinned in Task 1.
2. `GET /` and `GET /index.html` served by `express.static` must stay `no-store` even though they are static files. Pinned in Task 1.
3. Rebuilding `dist/` while the server runs must update the header without a restart; a missing or meta-less `index.html` must omit the header, not crash. Pinned in Task 3.
4. A client without a meta tag (development) or a response without the header must never show the banner. Pinned in Task 4.
5. A 401 from `/api` (expired login) and a 403 from the origin check must still carry the build header, so a logged-out PWA learns about updates. Pinned in Task 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/http/cache-policy.js` (new) | Pure mapping from a `dist`-relative file path to a `Cache-Control` value. |
| `server/http/responses.js` (modify) | Apply the policy to `express.static`; force `no-store` on 404/error handlers. |
| `scripts/startup-plugin.mjs` (modify) | Compute the build ID and insert the meta tag. |
| `server/http/build-identity.js` (new) | Read and cache the build ID from `dist/index.html`; middleware that sets the header. |
| `server/app.js` (modify) | Mount the build header middleware right after `securityHeaders`. |
| `web/lib/build-check.js` (new) | Compare response header with the page meta tag; raise the event once. |
| `web/lib/api.js`, `web/features/login/login-api.js`, `web/features/files/file-api.js`, `web/features/operations/RestoreForm.jsx`, `web/features/ssh/SshKeyCard.jsx` (modify) | Pass every response through `observeBuild`. |
| `web/features/updates/UpdateNotice.jsx`, `web/features/updates/update-notice.css` (new) | The banner. |
| `web/main.jsx`, `web/app/AppErrorBoundary.jsx` (modify) | Mount the banner; update copy in `RecoveryView`. |
| `web/lib/i18n/{de,en}/app.js`, `web/lib/i18n/messages/app.js` (modify) | New copy. |
| `docs/startup-loading.md` (modify) | "Caching and updates" section. |

---

### Task 1: Static cache policy

**Files:**
- Create: `server/http/cache-policy.js`
- Modify: `server/http/responses.js:12-55`
- Test: `tests/integration/static-cache-policy.test.js`

**Interfaces:**
- Produces: `cacheControlFor(relativePath: string): string` and the constant `IMMUTABLE = "max-age=31536000, immutable"` exported from `server/http/cache-policy.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/static-cache-policy.test.js`. It follows the release-copy pattern of `tests/integration/installed-navigation.test.js`, so `projectDir` resolves to the temporary release:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";

async function releaseServer(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-cache-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const project = path.resolve(import.meta.dirname, "../..");
  const release = path.join(temporary, "release");
  await fs.mkdir(path.join(release, "dist/assets"), { recursive: true });
  await fs.cp(path.join(project, "server"), path.join(release, "server"), {
    recursive: true,
  });
  await fs.symlink(path.join(project, "node_modules"), path.join(release, "node_modules"));
  await fs.writeFile(path.join(release, "package.json"), '{"type":"module"}');
  const dist = path.join(release, "dist");
  await fs.writeFile(path.join(dist, "index.html"), "<!doctype html><title>App</title>");
  await fs.writeFile(path.join(dist, "sw.js"), "// worker");
  await fs.writeFile(path.join(dist, "manifest.webmanifest"), "{}");
  await fs.writeFile(path.join(dist, "assets/index-D5b101IB.js"), "export default 1;");
  await fs.writeFile(path.join(dist, "assets/startup-0123456789ab.js"), "1;");
  await fs.writeFile(path.join(dist, "assets/App-Cu84xoQz.css"), "a{}");
  await fs.writeFile(path.join(dist, "assets/logo.png"), "png");
  const { registerResponses } = await import(
    pathToFileURL(path.join(release, "server/http/responses.js")).href
  );
  const { securityHeaders } = await import(
    pathToFileURL(path.join(release, "server/http/security.js")).href
  );
  const app = express();
  app.use(securityHeaders);
  registerResponses(app);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const html = { headers: { accept: "text/html" } };

test("hashed assets are immutable without public", async (t) => {
  const base = await releaseServer(t);
  for (const route of [
    "/assets/index-D5b101IB.js",
    "/assets/startup-0123456789ab.js",
    "/assets/App-Cu84xoQz.css",
  ]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get("cache-control"), "max-age=31536000, immutable");
  }
});

test("unhashed static files revalidate", async (t) => {
  const base = await releaseServer(t);
  for (const route of ["/sw.js", "/manifest.webmanifest", "/assets/logo.png"]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get("cache-control"), "no-cache", route);
    assert.ok(response.headers.get("etag"), route);
  }
});

test("app documents are never stored", async (t) => {
  const base = await releaseServer(t);
  for (const route of ["/", "/index.html", "/sessions/x/chat", "/artifacts/view/abc"]) {
    const response = await fetch(base + route, html);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get("cache-control"), "no-store", route);
  }
  const unknown = await fetch(base + "/unknown", html);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get("cache-control"), "no-store");
});

test("missing assets and failed conditional or range requests are never cached", async (t) => {
  const base = await releaseServer(t);
  const missing = await fetch(base + "/assets/missing-AAAAAAAA.js");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  for (const headers of [{ "if-match": '"nope"' }, { range: "bytes=999999-" }]) {
    const response = await fetch(base + "/assets/index-D5b101IB.js", { headers });
    assert.ok(response.status >= 400, JSON.stringify(headers));
    assert.equal(response.headers.get("cache-control"), "no-store", JSON.stringify(headers));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/integration/static-cache-policy.test.js`
Expected: FAIL. Hashed assets report `no-store`, and unhashed files report `no-store` instead of `no-cache`.

- [ ] **Step 3: Write the policy module**

Create `server/http/cache-policy.js`:

```js
// Vite emits content-hashed names (`name-XXXXXXXX.ext`); the startup plugin emits
// `startup-<12 hex>.js`. Only these may be frozen; everything else revalidates.
const hashedAsset = /^assets\/(?:startup-[a-f0-9]{12}|[^/]+-[A-Za-z0-9_-]{8})\.[a-z0-9]+$/;
export const IMMUTABLE = "max-age=31536000, immutable";
export function cacheControlFor(relativePath) {
  const file = relativePath.split("\\").join("/");
  if (file === "index.html") return "no-store";
  return hashedAsset.test(file) ? IMMUTABLE : "no-cache";
}
```

- [ ] **Step 4: Apply it in `server/http/responses.js`**

Replace the `express.static` block and the two terminal handlers:

```js
import { cacheControlFor } from "./cache-policy.js";
// …
  const dist = path.join(projectDir, "dist");
  app.use(
    express.static(dist, {
      dotfiles: "deny",
      index: "index.html",
      setHeaders: (res, file) =>
        res.setHeader("Cache-Control", cacheControlFor(path.relative(dist, file))),
    }),
  );
```

In the SPA fallback, replace `path.join(projectDir, "dist")` with `dist`. Make the last two handlers reset the header, because `send` applies `setHeaders` before its conditional and range checks:

```js
  app.use((_req, res) => res.set("Cache-Control", "no-store").status(404).json(notFound));
  app.use((error, _req, res, _next) => {
    res.setHeader("Cache-Control", "no-store");
    let status = error.status || error.statusCode || 400;
    // … unchanged …
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/integration/static-cache-policy.test.js tests/integration/installed-navigation.test.js`
Expected: PASS. If the 412/416 case returns a status below 400 (a `send` version that ignores the header), keep the cache assertion and change the status assertion to match the observed behavior. Note the reason in a comment.

- [ ] **Step 6: Commit**

```bash
git add server/http/cache-policy.js server/http/responses.js tests/integration/static-cache-policy.test.js
git commit -m "feat: cache content-hashed assets immutably"
```

---

### Task 2: Build ID meta tag

**Files:**
- Modify: `scripts/startup-plugin.mjs:47-58`
- Test: `tests/unit/startup-build-id.test.js`

**Interfaces:**
- Produces: the built `index.html` contains `<meta name="agentpier-build" content="<16 lowercase hex>">` inside `<head>`. Task 3 parses it with `/<meta name="agentpier-build" content="([a-f0-9]{16})">/`, and Task 4 reads it with `document.querySelector('meta[name="agentpier-build"]')`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/startup-build-id.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { startupPlugin } from "../../scripts/startup-plugin.mjs";

const document =
  '<!doctype html><html><head><title>A</title></head><body><div id="root"></div>' +
  '<script type="module" src="/assets/index-AAAAAAAA.js"></script></body></html>';

function build(lazyName) {
  const bundle = {
    "index.html": { source: document },
    "assets/index-AAAAAAAA.js": {},
    [`assets/${lazyName}.js`]: {},
  };
  startupPlugin().generateBundle.handler.call({ emitFile() {} }, {}, bundle);
  const source = String(bundle["index.html"].source);
  const id = /<meta name="agentpier-build" content="([a-f0-9]{16})">/.exec(source)?.[1];
  return { source, id };
}

test("the app document carries a build id in its head", () => {
  const { source, id } = build("Lazy-BBBBBBBB");
  assert.ok(id);
  assert.ok(source.indexOf("agentpier-build") < source.indexOf("</head>"));
});

test("the build id is stable and changes when only a lazy chunk changes", () => {
  assert.equal(build("Lazy-BBBBBBBB").id, build("Lazy-BBBBBBBB").id);
  assert.notEqual(build("Lazy-BBBBBBBB").id, build("Lazy-CCCCCCCC").id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/startup-build-id.test.js`
Expected: FAIL. There is no meta tag, so `id` is `undefined`.

- [ ] **Step 3: Implement**

In `scripts/startup-plugin.mjs`, after `this.emitFile(...)`, replace the `html.source = …` assignment:

```js
        // Any emitted file name change (including lazy chunks) or markup change
        // yields a new build identity for update detection.
        const build = createHash("sha256")
          .update(JSON.stringify([...Object.keys(bundle), fileName].sort()))
          .update(source)
          .digest("hex")
          .slice(0, 16);
        html.source = source
          .replace("</head>", `<meta name="agentpier-build" content="${build}"></head>`)
          .replace("</body>", `<script defer src="/${fileName}"></script></body>`);
```

- [ ] **Step 4: Verify**

Run: `node --test tests/unit/startup-build-id.test.js && npm run build && grep -o 'agentpier-build" content="[a-f0-9]*"' dist/index.html`
Expected: tests PASS; the grep prints one meta tag.

Run: `AGENTPIER_TEST_PORT=4397 AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/startup.spec.js`
Expected: PASS. The startup screen is unaffected.

- [ ] **Step 5: Commit**

```bash
git add scripts/startup-plugin.mjs tests/unit/startup-build-id.test.js
git commit -m "feat: embed a build identity in the app document"
```

---

### Task 3: Server build header

**Files:**
- Create: `server/http/build-identity.js`
- Modify: `server/app.js:126-127` (imports at the top, mount after `app.use(securityHeaders)`)
- Test: `tests/unit/build-identity.test.js`, `tests/blackbox/build-header.test.js`

**Interfaces:**
- Consumes: the meta tag format from Task 2.
- Produces: `buildIdentity(file?: string): () => string`, which returns `""` when no ID is available, and `buildHeader(read?: () => string): express middleware`. `createApplication(config)` accepts an optional `config.buildDocument` (absolute path) that overrides `dist/index.html` for tests.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/build-identity.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIdentity } from "../../server/http/build-identity.js";

const meta = (id) => `<head><meta name="agentpier-build" content="${id}"></head>`;

test("build identity follows rebuilds and tolerates missing metadata", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-build-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "index.html");
  const read = buildIdentity(file);
  assert.equal(read(), "");
  await fs.writeFile(file, meta("aaaaaaaaaaaaaaaa"));
  assert.equal(read(), "aaaaaaaaaaaaaaaa");
  await fs.writeFile(file, meta("bbbbbbbbbbbbbbbb"));
  const later = new Date(Date.now() + 5000);
  await fs.utimes(file, later, later);
  assert.equal(read(), "bbbbbbbbbbbbbbbb");
  await fs.writeFile(file, "<head></head>");
  await fs.utimes(file, new Date(Date.now() + 10000), new Date(Date.now() + 10000));
  assert.equal(read(), "");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/build-identity.test.js`
Expected: FAIL. The module does not exist yet.

- [ ] **Step 3: Implement `server/http/build-identity.js`**

```js
import fs from "node:fs";
import path from "node:path";
import { projectDir } from "../lib/config.js";
const pattern = /<meta name="agentpier-build" content="([a-f0-9]{16})">/;
// Source checkouts rebuild dist/ in place while the server runs; re-read on change.
export function buildIdentity(file = path.join(projectDir, "dist", "index.html")) {
  let cached = { key: "", id: "" };
  return () => {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return "";
    }
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (key !== cached.key) {
      let id = "";
      try {
        id = pattern.exec(fs.readFileSync(file, "utf8"))?.[1] || "";
      } catch {
        // An unreadable document only disables update detection.
      }
      cached = { key, id };
    }
    return cached.id;
  };
}
export function buildHeader(read = buildIdentity()) {
  return (_req, res, next) => {
    const id = read();
    if (id) res.setHeader("X-AgentPier-Build", id);
    next();
  };
}
```

- [ ] **Step 4: Mount it in `server/app.js`**

```js
import { buildHeader, buildIdentity } from "./http/build-identity.js";
// …
  app.use(securityHeaders);
  app.use(buildHeader(buildIdentity(config.buildDocument)));
```

`buildIdentity(undefined)` falls back to the default path.

- [ ] **Step 5: Write the blackbox test**

Create `tests/blackbox/build-header.test.js`. Read the remainder of `tests/helpers/application.js` for the fixture's returned fields (`url`, plus cleanup via `t`). Use `applicationFixture(t, { buildDocument })`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

test("every response class carries the build header, including auth failures", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-build-doc-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const buildDocument = path.join(dir, "index.html");
  await fs.writeFile(
    buildDocument,
    '<head><meta name="agentpier-build" content="0123456789abcdef"></head>',
  );
  const app = await applicationFixture(t, { buildDocument });
  const status = await fetch(`${app.url}/auth/status`);
  assert.equal(status.headers.get("x-agentpier-build"), "0123456789abcdef");
  assert.equal(status.headers.get("cache-control"), "no-store");
  const unauthenticated = await fetch(`${app.url}/api/workspace`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("x-agentpier-build"), "0123456789abcdef");
  const crossOrigin = await fetch(`${app.url}/api/workspace`, {
    method: "POST",
    headers: { origin: "http://evil.example" },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.get("x-agentpier-build"), "0123456789abcdef");
});
```

If `/api/workspace` is not the right unauthenticated route name, pick any existing `GET /api/...` route mounted behind `requireLogin` (see `server/app.js:150-190`). If the fixture exposes the URL under another property name, use that name.

- [ ] **Step 6: Run the tests**

Run: `node --test tests/unit/build-identity.test.js tests/blackbox/build-header.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/http/build-identity.js server/app.js tests/unit/build-identity.test.js tests/blackbox/build-header.test.js
git commit -m "feat: announce the served build on every response"
```

---

### Task 4: Client build check

**Files:**
- Create: `web/lib/build-check.js`
- Modify: `web/lib/api.js:23-37`, `web/features/login/login-api.js:3-10`, `web/features/files/file-api.js:134-162`, `web/features/operations/RestoreForm.jsx:10-14`, `web/features/ssh/SshKeyCard.jsx:40-43`
- Test: `tests/unit/build-check.test.js`

**Interfaces:**
- Consumes: the meta tag from Task 2 and the header from Task 3.
- Produces, in `web/lib/build-check.js`:
  - `UPDATE_EVENT = "agentpier-update-available"`
  - `currentBuild(): string`
  - `observeBuild(response: Response, own?: string): Response` (returns its argument)
  - `updateDetected(): boolean`
  - `resetBuildCheck(): void` (tests only)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/build-check.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  UPDATE_EVENT,
  observeBuild,
  resetBuildCheck,
  updateDetected,
} from "../../web/lib/build-check.js";

const served = (id) => new Response("{}", { headers: id ? { "x-agentpier-build": id } : {} });

test("a differing build header raises one update event", (t) => {
  const target = new EventTarget();
  globalThis.window = target;
  t.after(() => {
    delete globalThis.window;
    resetBuildCheck();
  });
  let events = 0;
  target.addEventListener(UPDATE_EVENT, () => events++);
  observeBuild(served("aaaaaaaaaaaaaaaa"), "aaaaaaaaaaaaaaaa");
  assert.equal(events, 0);
  observeBuild(served(""), "aaaaaaaaaaaaaaaa");
  observeBuild(served("bbbbbbbbbbbbbbbb"), "");
  assert.equal(events, 0);
  assert.equal(updateDetected(), false);
  observeBuild(served("bbbbbbbbbbbbbbbb"), "aaaaaaaaaaaaaaaa");
  observeBuild(served("cccccccccccccccc"), "aaaaaaaaaaaaaaaa");
  assert.equal(events, 1);
  assert.equal(updateDetected(), true);
});

test("every client fetch passes through the build check", () => {
  const root = path.resolve(import.meta.dirname, "../../web");
  const offenders = [];
  for (const entry of fs.readdirSync(root, { recursive: true })) {
    if (!/\.(?:js|jsx)$/.test(entry) || entry.includes("i18n")) continue;
    const source = fs.readFileSync(path.join(root, entry), "utf8");
    if (/\bfetch\(/.test(source) && !source.includes("observeBuild"))
      offenders.push(entry);
  }
  assert.deepEqual(offenders, []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/build-check.test.js`
Expected: FAIL. The module is missing, and the guard lists the five callers.

- [ ] **Step 3: Implement `web/lib/build-check.js`**

```js
export const UPDATE_EVENT = "agentpier-update-available";
let detected = false;
export function currentBuild() {
  return (
    globalThis.document?.querySelector('meta[name="agentpier-build"]')?.content || ""
  );
}
// Compares the server's build with this page's build; reports a mismatch once.
export function observeBuild(response, own = currentBuild()) {
  const served = response?.headers?.get?.("x-agentpier-build") || "";
  if (!detected && own && served && own !== served) {
    detected = true;
    globalThis.window?.dispatchEvent(new Event(UPDATE_EVENT));
  }
  return response;
}
export function updateDetected() {
  return detected;
}
export function resetBuildCheck() {
  detected = false;
}
```

`web/startup/` does not use `fetch`. If it ever does, the guard test flags it.

- [ ] **Step 4: Wire the five callers**

- `web/lib/api.js`: add `import { observeBuild } from "./build-check.js";` and wrap the request: `const response = observeBuild(await fetch(\`/api${path}\`, { … }));`
- `web/features/login/login-api.js`: add `import { observeBuild } from "../../lib/build-check.js";` and wrap: `const response = observeBuild(await fetch(\`/auth/${action}\`, { … }));`
- `web/features/files/file-api.js`: add the import and wrap each of the three `await fetch(...)` calls at lines 134, 140 and 156 as `observeBuild(await fetch(...))`. Wrap the PUT fetch above line 115 too if it calls `fetch`.
- `web/features/operations/RestoreForm.jsx`: add `import { observeBuild } from "../../lib/build-check.js";` and use `const response = observeBuild(await fetch("/api/operations/restore/upload", { … }));`
- `web/features/ssh/SshKeyCard.jsx`: add the same import and use `const response = observeBuild(await fetch(\`/api/ssh-keys/…/download\`, { method: "POST" }));`

- [ ] **Step 5: Run the tests**

Run: `node --test tests/unit/build-check.test.js tests/unit/login-api.test.js && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/lib/build-check.js web/lib/api.js web/features/login/login-api.js web/features/files/file-api.js web/features/operations/RestoreForm.jsx web/features/ssh/SshKeyCard.jsx tests/unit/build-check.test.js
git commit -m "feat: detect a newer server build from responses"
```

---

### Task 5: Update notice and recovery copy

**Files:**
- Create: `web/features/updates/UpdateNotice.jsx`, `web/features/updates/update-notice.css`
- Modify: `web/main.jsx:17-30`, `web/app/AppErrorBoundary.jsx:16-30`, `web/lib/i18n/de/app.js`, `web/lib/i18n/en/app.js`, `web/lib/i18n/messages/app.js`
- Test: `tests/browser/update-notice.spec.js`

**Interfaces:**
- Consumes: `UPDATE_EVENT` and `updateDetected` from `web/lib/build-check.js` (Task 4).
- Produces: `updateNoticeCopy` with keys `message`, `reload` and `dismiss`, and new `appRecoveryCopy` keys `updateTitle` and `updateDescription`.

- [ ] **Step 1: Write the failing browser test**

Create `tests/browser/update-notice.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

async function announceNewBuild(page) {
  await page.route("**/auth/status", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "x-agentpier-build": "ffffffffffffffff" },
    });
  });
}

test("a newer server build shows a dismissible reload notice", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await announceNewBuild(page);
  await page.goto(baseURL);
  const notice = page.getByRole("status").filter({ hasText: "New version available" });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toBeHidden();
});

test("reload in the notice reloads the page", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await announceNewBuild(page);
  await page.goto(baseURL);
  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await reloaded;
});

test("the artifact viewer also shows the notice", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await announceNewBuild(page);
  await page.goto(baseURL + "/artifacts/view/missing-artifact");
  await expect(page.getByText("New version available")).toBeVisible();
});

test("a failed lazy module after an update explains the new version", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await announceNewBuild(page);
  await page.route("**/assets/SettingsPage-*.js", (route) => route.abort());
  await page.goto(baseURL);
  await expect(page.getByText("New version available")).toBeVisible();
  await page.goto(baseURL + "/settings");
  await expect(page.getByRole("heading", { name: "A new version is available" })).toBeVisible();
});
```

Check `tests/helpers/browser.js` and `playwright.config.*` for how the suite authenticates and which language key it uses. Copy the language setup from an existing English spec if `agentpier-language` is not the stored key. If `SettingsPage` is not a lazy chunk name, take any lazy chunk named in `web/app/App.jsx:18-25` and its route.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && AGENTPIER_TEST_PORT=4397 AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/update-notice.spec.js`
Expected: FAIL. The notice text is not found.

- [ ] **Step 3: Add copy**

In `web/lib/i18n/en/app.js`, extend `appRecoveryCopy` and add a new export:

```js
export const appRecoveryCopy = {
  title: "View unavailable",
  description: "The app could not load this view. Please reload it.",
  reload: "Reload view",
  updateTitle: "A new version is available",
  updateDescription: "AgentPier was updated. Reload to continue with the new version.",
};
export const updateNoticeCopy = {
  message: "New version available",
  reload: "Reload",
  dismiss: "Dismiss",
};
```

In `web/lib/i18n/de/app.js`:

```js
export const appRecoveryCopy = {
  title: "Ansicht nicht verfügbar",
  description: "Die App konnte diese Ansicht nicht laden. Bitte lade sie erneut.",
  reload: "Ansicht neu laden",
  updateTitle: "Eine neue Version ist verfügbar",
  updateDescription: "AgentPier wurde aktualisiert. Lade neu, um mit der neuen Version weiterzuarbeiten.",
};
export const updateNoticeCopy = {
  message: "Neue Version verfügbar",
  reload: "Neu laden",
  dismiss: "Ausblenden",
};
```

In `web/lib/i18n/messages/app.js`:

```js
export const updateNoticeCopy = localizedCopy(de.updateNoticeCopy, en.updateNoticeCopy);
```

- [ ] **Step 4: Create the banner**

`web/features/updates/UpdateNotice.jsx`:

```jsx
import React, { useEffect, useState } from "react";
import useLanguage from "../../lib/i18n/useLanguage.js";
import { updateNoticeCopy as copy } from "../../lib/i18n/messages/app.js";
import { UPDATE_EVENT, updateDetected } from "../../lib/build-check.js";
import "./update-notice.css";

export default function UpdateNotice() {
  useLanguage();
  const [visible, setVisible] = useState(updateDetected);
  useEffect(() => {
    const show = () => setVisible(true);
    window.addEventListener(UPDATE_EVENT, show);
    if (updateDetected()) setVisible(true);
    return () => window.removeEventListener(UPDATE_EVENT, show);
  }, []);
  if (!visible) return null;
  return (
    <div className="update-notice" role="status">
      <span>{copy.message}</span>
      <button
        className="button primary"
        type="button"
        onClick={() => window.location.reload()}
      >
        {copy.reload}
      </button>
      <button
        className="update-notice-dismiss"
        type="button"
        aria-label={copy.dismiss}
        onClick={() => setVisible(false)}
      >
        ×
      </button>
    </div>
  );
}
```

`web/features/updates/update-notice.css`. It sits at the top, below the iOS safe area, and never at the bottom where the keyboard-anchored session controls live:

```css
.update-notice {
  position: fixed;
  top: calc(env(safe-area-inset-top) + 8px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100vw - 32px);
  padding: 6px 6px 6px 14px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
  box-shadow: 0 6px 24px rgb(0 0 0 / 40%);
}
.update-notice-dismiss {
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 18px;
  line-height: 1;
  padding: 4px 8px;
  cursor: pointer;
}
```

- [ ] **Step 5: Mount the banner and switch the recovery copy**

`web/main.jsx`: add `import UpdateNotice from "./features/updates/UpdateNotice.jsx";` and render it as a sibling before `LoginGate`, inside `AppErrorBoundary`:

```jsx
    <AppErrorBoundary>
      <UpdateNotice />
      <LoginGate>
```

`web/app/AppErrorBoundary.jsx`, `RecoveryView`:

```jsx
import { updateDetected } from "../lib/build-check.js";
// …
function RecoveryView() {
  useLanguage();
  const updated = updateDetected();
  return (
    <main className="app-recovery" role="alert">
      <h1>{updated ? copy.updateTitle : copy.title}</h1>
      <p>{updated ? copy.updateDescription : copy.description}</p>
      …unchanged button…
```

- [ ] **Step 6: Run the tests**

Run:
```bash
npm run build
AGENTPIER_TEST_PORT=4397 AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/update-notice.spec.js tests/browser/app-recovery.spec.js
AGENTPIER_TEST_PORT=4397 AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/update-notice.spec.js tests/browser/app-recovery.spec.js
npm run test:unit
```
Expected: all PASS, including the i18n catalog parity tests in the unit suite.

- [ ] **Step 7: Screenshot for the PR**

Take a 390×844 (iPhone) English screenshot of the notice with Playwright and save it under the scratchpad for the PR description. Do not commit it.

- [ ] **Step 8: Commit**

```bash
git add web/features/updates web/main.jsx web/app/AppErrorBoundary.jsx web/lib/i18n/de/app.js web/lib/i18n/en/app.js web/lib/i18n/messages/app.js tests/browser/update-notice.spec.js
git commit -m "feat: offer a reload when a new version is available"
```

---

### Task 6: Documentation, full verification, cleanup, PR

**Files:**
- Modify: `docs/startup-loading.md` (append a section)
- Delete: `docs/superpowers/specs/2026-10-02-asset-caching-design.md`, `docs/superpowers/plans/2026-10-02-asset-caching.md`

- [ ] **Step 1: Document**

Append to `docs/startup-loading.md`:

```markdown
## Caching and updates

| Resource | `Cache-Control` |
|---|---|
| Content-hashed `/assets/*` | `max-age=31536000, immutable` |
| Other static files (`sw.js`, icons, manifest, unhashed assets) | `no-cache` |
| App documents, `/api`, `/auth`, errors | `no-store` |

App documents stay `no-store` so a disconnected device never shows a cached shell
that looks connected; the service worker keeps serving `offline.html` for failed
navigations. The production build writes a build ID into
`<meta name="agentpier-build">`. The server sends the ID of the files it currently
serves as `X-AgentPier-Build` on every response and re-reads it when
`dist/index.html` changes. When the two differ, the app shows a non-modal "New
version available" notice and never reloads on its own. A lazy view that fails to
load after an update shows the recovery view with update copy.

Caching helps between updates. An update usually renames most chunks, so the first
launch after an update downloads the start files again. Artifact links opened from
the iOS home-screen app may use Safari's separate cache.
```

- [ ] **Step 2: Full verification**

Run: `npm run check`
Expected: PASS (lint, format, structure, build, backend tests).

- [ ] **Step 3: Remove the temporary spec and plan, then commit**

```bash
git rm docs/superpowers/specs/2026-10-02-asset-caching-design.md docs/superpowers/plans/2026-10-02-asset-caching.md
git add docs/startup-loading.md
git commit -m "chore: document asset caching and remove working documents"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/asset-caching
gh pr create --title "feat: cache hashed assets and announce new versions" --body-file <scratchpad body>
```

The PR body (English) covers:
- **Problem:** global `no-store` re-downloaded every asset on each PWA launch and artifact link.
- **Behavior:** the cache table, build header, and update notice.
- **Validation:** commands run with their results, and the screenshot.
- **Manual check still open:** on an iPhone PWA (Safari Web Inspector), the second launch should transfer no `/assets/*`. Also check an artifact link opened from the PWA.

End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
