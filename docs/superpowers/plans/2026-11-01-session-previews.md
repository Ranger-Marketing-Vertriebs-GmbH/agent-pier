# Session Previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A coding session or one of the owner's agents reports a local dev server with `preview_open` / `agentpier_preview`, and the owner opens it in a new tab through AgentPier (own login, own origin per preview port, HMR and SSE intact) over local, Tailscale and network access.

**Architecture:** A `PreviewService` (`server/features/previews/`, in memory) owns a port pool from `config.json` `previews`, binds one plain `http.Server` per slot while previews are enabled, and proxies each slot to its target on loopback after checking the host branch and an owner session per request. Session MCP tools, an agent bridge action, HTTP routes and a live topic all go through the service; a shared Tailscale helper registers the whole range with `tailscale serve` from settings, `npm run tailscale` and every server start (the update path).

**Tech Stack:** Node.js `http`/`net` (no Express, no compression on preview ports), Express routes, zod MCP schemas, React + live topics, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-01-session-previews-design.md` (read it with this plan).

## Global Constraints

- Default range **47100–47109** (10 ports); range validated: start ≥ 1024, end ≤ 65535, at most **50** ports, end ≥ start, no overlap with AgentPier's port, `pipelines.portRange` (default 20100–20999, `server/features/pipelines/run-ports.js`) or the Tailscale HTTPS port (port of `remoteUrl`, 443 when absent).
- Stored in `config.json` as `previews: { enabled, portRangeStart, portRangeEnd }`; **Enable previews is off by default**; existing installations get no tailnet ports unasked. Writes go through `updateStoredConfig(dataDir, patch)` from `server/lib/config.js` (AGENTPIER-300, PR #601); never replace config.json.
- Error codes, stable for agents and localized for the UI: `PREVIEW_NOT_LISTENING`, `PREVIEW_PORT_FORBIDDEN`, `PREVIEW_RANGE_FULL`, `PREVIEW_DISABLED`, `PREVIEW_UNAVAILABLE` (plus internal `PREVIEW_INVALID_INPUT`, `PREVIEW_NOT_FOUND`, `PREVIEW_RANGE_INVALID`).
- Owner only: proxy admits only principal role `owner`; restricted users' agents and sender-facing agents never get the tool; pipeline sessions have no session MCP.
- Upstream `Host: localhost:<target>`; set `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-For`; rewrite `Location` from `http://localhost:<target>` / `http://127.0.0.1:<target>` to the preview origin; strip `agentpier_session` from `Cookie`, `tailscale-*` headers, and upstream `Set-Cookie` named `agentpier_session`; never add AgentPier's CSP or `X-Frame-Options`; no `Clear-Site-Data`; no body size limit beyond Node defaults.
- Agent previews expire **24 hours** after the last proxied request; session previews close with session stop/removal and MCP grant revocation.
- Audit: open, close, expire; session/agent, target port, slot; never URLs with query strings, never headers.
- AGENTS.md: DE + EN for every UI string **and every page the proxy serves**; `npm run i18n:confirm` and commit both `translation-lock.json` files; ui-guide components only (no bespoke dialogs/menus/switches, no new hex colours, no font < 11px, breakpoints from `web/lib/breakpoints.js`); files ≤ 600 lines (`server/application/services.js` 581, `server/features/assistants/team-bridge.js` 585, `assistant-config.js` 587, `assistant-workflows.js` 593, `assistant-service.js` 600 and `server/application/assistant-graph.js` 597 are at the limit — add at most the lines this plan names, never construct new objects there).
- Tests never use real `tailscale`, the real data dir, port 4380, port range 47100–47109 or the default tmux server; use `applicationFixture`, disposable dirs, the `tailscaleRun` seam and `freePortRange()` (Task 2).
- Commits: `feat:`/`fix:`/`chore:`/`docs:` prefixes, English, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Owner opens AgentPier as `localhost` but the link says `127.0.0.1` (or MagicDNS short name vs full name)** — cookies are per host name, so the preview would loop to sign-in. Expected: the UI builds the link from the browser's own `location.hostname`; the proxy's sign-in link uses the request's own host name. Pinned in Task 3 (`signInUrl uses the request host name`) and Task 6 (`previewHref keeps the page's host name`).
2. **Dev server listens only on `::1`** (Vite on current Node resolves `localhost` to `::1`). Expected: `preview_open` succeeds and the proxy forwards to `[::1]`. Pinned in Task 3 (`forwards to ::1 when the target listens only there`) and Task 4 (`open accepts a target listening only on ::1`).
3. **The dev server restarts while the page is open** (HMR socket drops, requests fail for a second). Expected: localized 502 naming the port and label, the preview stays, the next request succeeds. Pinned in Task 3 (`unreachable upstream answers 502 and recovers`).
4. **AgentPier restarts or updates with Tailscale registrations in place.** Expected: on start the listeners are bound again, Serve registrations are re-applied idempotently, and an idle slot answers the localized "no preview on this port" page, not a Tailscale 502. Pinned in Task 4 (`start binds every free slot and serves the idle page`) and Task 8 (`start re-applies registrations only when enabled`).
5. **Owner signs out (or the session expires) while an HMR WebSocket is open through a preview.** Expected: the proxied socket closes at once. Pinned in Task 3 (`revoking the owner session closes proxied sockets`).

---

## File Structure

Create (server):

- `server/features/previews/preview-config.js` — defaults, validation, read/write of `config.json` `previews`.
- `server/features/previews/preview-errors.js` — `previewError(code, status, ...args)`.
- `server/features/previews/preview-slots.js` — slot pool: probing, sticky allocation, slot states.
- `server/features/previews/preview-targets.js` — loopback reachability and forbidden ports.
- `server/features/previews/preview-access.js` — host branch per slot (mirror of `authorizeRequest`) and AgentPier origin for sign-in links.
- `server/features/previews/preview-headers.js` — cookie/header filtering, `Host`/`Origin`/`Location` rewrites.
- `server/features/previews/preview-pages.js` — localized HTML pages (bounce, sign-in, forbidden, idle, unreachable).
- `server/features/previews/preview-proxy.js` — one `http.Server` per slot, streaming HTTP and raw upgrade piping.
- `server/features/previews/preview-service.js` — `PreviewService`.
- `server/features/previews/preview-serve.js` — Tailscale Serve registration for the range.
- `server/features/previews/preview-mcp.js` — session MCP tool entries.
- `server/features/previews/live-topics.js` — `previews` state topic.
- `server/features/remote/tailscale-cli.js` — Tailscale CLI runner shared by the script and the server.
- `server/application/preview-wiring.js` — builds the service from `services` (lazy getters, internal ports, liveness checks).
- `server/http/routes/previews.js` — `/api/previews` routes.
- `server/features/assistants/agent-previews.js` — `agentpier_preview` bridge handler and Telegram notice.
- `server/features/assistants/team-plugin/preview-tool.js` — plugin tool definition.
- `server/features/audit/audit-preview-details.js` — audit detail whitelist.
- `server/lib/i18n/de/previews.js`, `server/lib/i18n/en/previews.js`.

Create (web):

- `web/features/previews/usePreviews.js`, `preview-links.js`, `PreviewRows.jsx`, `SessionPreviews.jsx`, `PreviewSettingsCard.jsx`, `PreviewStrip.jsx`, `previews.css`.
- `web/features/login/preview-return.js`.
- `web/lib/i18n/de/previews.js`, `web/lib/i18n/en/previews.js`, `web/lib/i18n/messages/previews.js`.

Create (tests): `tests/unit/login-several-cookies.test.js`, `tests/integration/api-sibling-origin.test.js`, `tests/unit/preview-config.test.js`, `tests/unit/preview-slots.test.js`, `tests/helpers/preview-ports.js`, `tests/unit/preview-headers.test.js`, `tests/integration/preview-proxy.test.js`, `tests/unit/preview-return.test.js`, `tests/integration/preview-service.test.js`, `tests/integration/preview-mcp.test.js`, `tests/unit/preview-links.test.js`, `tests/browser/session-previews.spec.js`, `tests/blackbox/preview-routes.test.js`, `tests/browser/preview-settings.spec.js`, `tests/unit/preview-serve.test.js`, `tests/integration/agent-previews.test.js`, `tests/browser/agent-previews.spec.js`.

Create (docs): `docs/previews.md` (English).

Modify: `server/http/login.js`, `server/http/security.js`, the six WebSocket attachers in `server/http/*-websocket.js`, `server/http/routes/assistant-talk.js`, `server/http/routes/me-account.js`, `server/application/services.js`, `server/app.js`, `server/application/shutdown.js`, `server/application/live-wiring.js`, `server/features/mcp/tool-service.js`, `server/features/mcp/http-transport.js`, `server/features/mcp/session-integration.js`, `server/features/audit/audit-vocabulary.js`, `server/features/audit/audit-schema.js`, `server/lib/i18n/catalog-de.js`, `catalog-en.js`, `scripts/tailscale.mjs`, `tests/helpers/application.js`, `web/lib/live/live-topics.js`, `web/features/sessions/SessionWorkspace.jsx`, `web/features/remote/RemoteSettings.jsx`, `web/features/login/LoginGate.jsx`, `web/features/assistants/ChatStrips.jsx`, the agent tool lists (Task 9), docs (Task 10).

---

### Task 1: Login tolerates several session cookies; sibling origins cannot call the API

Spec decision 6 and "the builder must confirm no state-changing GET route exists". Rather than auditing every GET route, the API refuses `Sec-Fetch-Site: same-site` requests that are not top-level navigations: AgentPier's own pages are always same-origin, only another port on the same host (a preview) is same-site.

**Files:**

- Modify: `server/http/login.js:11-16` (`sessionToken`), `:96-105`, `:141-170`
- Modify: `server/http/live-websocket.js:43`, `assistant-chat-websocket.js:38`, `chat-websocket.js:21`, `browser-websocket.js:54`, `dictation-websocket.js:28`, `terminal-websocket.js:21,28`, `server/http/routes/assistant-talk.js:40`, `server/http/routes/me-account.js:29`
- Modify: `server/http/security.js:57-58`
- Test: `tests/unit/login-several-cookies.test.js`, `tests/integration/api-sibling-origin.test.js`

**Interfaces:**

- Produces: `sessionTokens(req): string[]` (every `agentpier_session` value, in header order); `sessionToken(req, login): string` — the first value for which `login.session(value)` is truthy, else `""`; throws `TypeError` without `login`. `login` is `Identity` (`server/features/users/identity.js`) or `LoginStore`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/login-several-cookies.test.js` (LoginStore in a mkdtemp dir, configured as in `tests/unit/login-sliding.test.js`):

```js
test("sessionToken picks the valid one of several agentpier_session cookies", () => {
  const valid = store.issue();
  for (const cookie of [`agentpier_session=planted; agentpier_session=${valid}`,
                        `agentpier_session=${valid}; agentpier_session=planted`])
    assert.equal(sessionToken({ headers: { cookie } }, store), valid);
  assert.equal(sessionToken({ headers: { cookie: "agentpier_session=a; agentpier_session=b" } }, store), "");
  assert.deepEqual(sessionTokens({ headers: { cookie: "x=1; agentpier_session=a; agentpier_session=b" } }), ["a", "b"]);
  assert.throws(() => sessionToken({ headers: {} }), TypeError);
});
test("requireLogin admits a request with a planted second cookie and renews only the valid token", ...);
// advance past half the idle window; assert the Set-Cookie carries `agentpier_session=${valid}`
test("every server call of sessionToken passes the login", () => {
  // scan server/**/*.js: no match for /sessionToken\(req\)/
});
```

`tests/integration/api-sibling-origin.test.js` (`applicationFixture`):

```js
test("a planted cookie does not sign the owner out of HTTP or WebSocket", async (t) => {
  const f = await applicationFixture(t);
  const cookie = `agentpier_session=planted; ${f.cookie}`;
  assert.equal((await f.request("/api/remote", { headers: { cookie } })).status, 200);
  // WebSocket /api/live with Origin f.url and the same cookie header opens (ws client)
});
test("same-site requests from a sibling port are refused except navigations", async (t) => {
  // GET /api/sessions with sec-fetch-site: same-site, sec-fetch-mode: cors → 403
  // GET / with sec-fetch-site: same-site, sec-fetch-mode: navigate, sec-fetch-dest: document → 200
  // WebSocket /api/live with Origin http://127.0.0.1:<other port> → refused (existing origin rule)
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/unit/login-several-cookies.test.js tests/integration/api-sibling-origin.test.js`
Expected: FAIL (`sessionTokens` not exported; planted cookie gives 401; same-site GET answers 200).

- [ ] **Step 3: Implement**

`sessionTokens`/`sessionToken(req, login)` in `login.js`; pass `login` (the router's `login`, `requireLogin`'s `login`, each attacher's `login`, `identity` in `assistant-talk.js`, the route's identity in `me-account.js`). In `authorizeRequest` refuse `sec-fetch-site === "same-site"` exactly like `cross-site` (same `openingPage` exception, same `crossSiteAccessDenied` message).

- [ ] **Step 4: Run tests**

Run: `node --test tests/unit/login-several-cookies.test.js tests/integration/api-sibling-origin.test.js tests/unit/security.test.js tests/unit/login-cookie-network.test.js tests/unit/login-sliding.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/http tests/unit/login-several-cookies.test.js tests/integration/api-sibling-origin.test.js
git commit -m "fix: keep the owner signed in when a second session cookie arrives"
```

---

### Task 2: Previews config and the slot pool

**Files:**

- Create: `server/features/previews/preview-config.js`, `preview-errors.js`, `preview-slots.js`, `preview-targets.js`
- Create: `server/lib/i18n/de/previews.js`, `server/lib/i18n/en/previews.js`; Modify: `server/lib/i18n/catalog-de.js`, `catalog-en.js` (register `previews`)
- Create: `tests/helpers/preview-ports.js`
- Test: `tests/unit/preview-config.test.js`, `tests/unit/preview-slots.test.js`

**Interfaces:**

- Consumes: `portAvailable(port)` from `server/features/pipelines/run-ports.js`; `DEFAULT_PORT_RANGE`, `pipelinePorts(saved)`.
- Produces:
  - `DEFAULT_PREVIEW_RANGE = { start: 47100, end: 47109 }`, `MAX_PREVIEW_PORTS = 50`.
  - `normalizePreviewConfig(raw, { hostPort, pipelineRange, tailscaleHttpsPort }): { enabled: boolean, portRangeStart: number, portRangeEnd: number }` — `undefined`/`null` → `{ enabled: false, 47100, 47109 }`; invalid → throws `previewError("PREVIEW_RANGE_INVALID", 400)`; unknown keys refused.
  - `readPreviewConfig(dataDir, constraints)` (invalid stored range falls back to the default, disabled kept), `writePreviewConfig(dataDir, previews)` (via `updateStoredConfig` from AGENTPIER-300).
  - `tailscaleHttpsPort(remoteUrl): number|null` (`new URL(remoteUrl).port || 443`; null without `remoteUrl`).
  - `previewError(code, status = 400, ...args): Error & { code, status }` — message from `serverMessages.previews[code]` (German; English via `agentText`), like `artifactError`.
  - `class PreviewSlots { constructor({ range, probe = portAvailable, file, forbidden = () => new Set() }); slots(): number[]; async allocate({ key }): number; release(slot): void; remember(slot, key): void; busy(): Set<number> }` — `file` is `<dataDir>/previews/slots.json` (0600, `{ "<slot>": "<sha256(key) hex, 16 chars>" }`, at most one entry per slot).
  - `listenerPort(slot): number` — returns `slot` (Task 8 may change it after the spike; every caller uses this function).
  - `targetAddress(port, { timeoutMs = 1000, connect }): Promise<"127.0.0.1"|"::1"|null>`; `forbiddenTarget(port, { hostPort, range, internal }): boolean`.
  - Test helper `freePortRange(count): Promise<{ start, end }>` — random base in 40000–44999 (never 47100–47109), every port `portAvailable`.

- [ ] **Step 1: Write the failing tests**

```js
// preview-config.test.js
test("missing previews config means disabled 47100–47109", () =>
  assert.deepEqual(normalizePreviewConfig(undefined, constraints),
    { enabled: false, portRangeStart: 47100, portRangeEnd: 47109 }));
test("range rules: ≥1024, ≤65535, at most 50 ports, end ≥ start", () => {
  for (const [s, e] of [[1023, 1030], [65530, 65536], [47100, 47150], [47110, 47100]])
    assert.throws(() => normalizePreviewConfig({ enabled: true, portRangeStart: s, portRangeEnd: e }, constraints),
      { code: "PREVIEW_RANGE_INVALID" });
  assert.equal(normalizePreviewConfig({ enabled: true, portRangeStart: 47100, portRangeEnd: 47149 }, constraints).portRangeEnd, 47149);
});
test("range may not contain AgentPier's port, the pipeline range or the Tailscale HTTPS port", () => {
  // hostPort 4380 inside 4380–4389; pipelineRange {20100,20999} vs 20990–21000; tailscaleHttpsPort 8443 inside 8440–8449 → PREVIEW_RANGE_INVALID
});
test("writePreviewConfig keeps every other config.json key", ...); // port, remoteUrl, ownerLogin, network survive
test("a corrupt stored range reads as the default range", ...);

// preview-slots.test.js (probe is a fake: (port) => !taken.has(port))
test("allocation prefers the slot the same key used last", async () => { /* allocate key A → s1, release, allocate key B → not s1 (least recently used free), allocate A again → s1 */ });
test("a slot whose probe fails is skipped; none left → PREVIEW_RANGE_FULL (409)", ...);
test("a slot is reserved before probing so concurrent allocations never share it", ...); // Promise.all of 2 allocations with a slow probe → distinct slots
test("sticky memory survives a new PreviewSlots on the same file and holds no plain key", ...); // file content does not include the project path
test("targetAddress finds a server listening only on ::1", ...); // skip when ::1 is absent (EADDRNOTAVAIL)
test("forbiddenTarget refuses AgentPier's port, the range and internal ports", ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/unit/preview-config.test.js tests/unit/preview-slots.test.js`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement** the modules above. Server catalogs `previews` (DE/EN) hold every `PREVIEW_*` message; `PREVIEW_UNAVAILABLE` names the fix ("Turn on Settings › Remote access › Previews again or run `npm run tailscale`").

- [ ] **Step 4: Run tests and confirm translations**

Run: `node --test tests/unit/preview-config.test.js tests/unit/preview-slots.test.js tests/unit/server-i18n-catalogs.test.js && npm run i18n:confirm -- previews && node --test tests/unit/i18n-translation-lock.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/previews server/lib/i18n tests/unit/preview-*.test.js tests/helpers/preview-ports.js
git commit -m "feat: add the preview port range and slot pool"
```

---

### Task 3: Preview proxy

**Files:**

- Create: `server/features/previews/preview-access.js`, `preview-headers.js`, `preview-pages.js`, `preview-proxy.js`
- Create: `web/features/login/preview-return.js`; Modify: `web/features/login/LoginGate.jsx`
- Modify: `server/lib/i18n/{de,en}/previews.js` (page texts)
- Test: `tests/unit/preview-headers.test.js`, `tests/integration/preview-proxy.test.js`, `tests/unit/preview-return.test.js`

**Interfaces:**

- Consumes: `sessionToken(req, login)` (Task 1), `principalOf` (`server/features/users/identity.js`), `allowedNetworkHosts` (`server/features/remote/network-access.js`), `listenerPort` (Task 2).
- Produces:
  - `previewBranch(req, { slot, effective }): "local"|"tailscale"|"network"` — throws 403. Local: loopback peer, Host `127.0.0.1:<slot>`/`localhost:<slot>`, no proxy markers. Tailscale: loopback peer, Host = `<new URL(remoteUrl).hostname>:<slot>`, non-empty `tailscale-user-login`. Network: `network.enabled`, Host in `allowedNetworkHosts(network, slot, detected)`, no `tailscale-*`.
  - `signInUrl(branch, req, { effective, slot, path }): string` — AgentPier origin with the **request's** host name (`http://<hostname>:<port>` for local/network, `remoteUrl` origin for Tailscale) plus `/?preview=<slot>&path=<encoded>`.
  - `withoutSessionCookie(cookie): string|null`; `upstreamHeaders(req, { target, previewOrigin }): object` (drop `agentpier_session`, `tailscale-*`, incoming `forwarded`/`x-forwarded-*`; `host: localhost:<target>`; `Origin`/`Referer` equal to the preview origin rewritten to `http://localhost:<target>`; add `x-forwarded-host`, `x-forwarded-proto`, `x-forwarded-for`); `downstreamHeaders(headers, { target, previewOrigin }): object` (drop `Set-Cookie` named `agentpier_session`; rewrite `Location` from `http://localhost:<target>`, `http://127.0.0.1:<target>`, `http://[::1]:<target>`).
  - `previewPage(kind, { language, label, target, signInUrl }): { status, html }` — kinds `bounce` (200, same-origin `location.replace(location.href)`), `signIn` (401), `forbidden` (403), `idle` (404, "no preview on this port"), `unreachable` (502, "The server on port <target> is not answering" + label). `pageLanguage(req): "de"|"en"` from `Accept-Language` (`de*` → de, else en). Pages escape label text.
  - `createPreviewListener({ slot, host, port, gate, resolve, touch, effective }): Promise<{ close(): Promise<void>, server }>` — `gate(req) → { branch, principal, session }` or throws `{ status, page }`; `resolve(slot) → { preview, address } | null`; `touch(preview)` on each forwarded request. Per request: branch → owner session → preview alive → forward. Without a valid cookie: navigations with `sec-fetch-site: cross-site` get `bounce`, other navigations `signIn`, sub-requests plain 401. Upgrades: same gate, then raw pipe of the upgrade request to the upstream socket; `login.watch(session, destroy)` closes HTTP and upgraded sockets on revocation.
  - Web: `previewReturn(search, location): string|null` — `?preview=<int 1024–65535>&path=/…` → `${protocol}//${hostname}:${slot}${path}`; refuses `//`, control characters, other hosts. `LoginGate` replaces the location once authenticated and removes the parameters first (`history.replaceState`).

- [ ] **Step 1: Write the failing tests**

```js
// preview-headers.test.js
test("the session cookie never reaches the app", () =>
  assert.equal(withoutSessionCookie("a=1; agentpier_session=x; b=2; agentpier_session=y"), "a=1; b=2"));
test("upstream sees localhost:<target> and the forwarded origin", () => {
  const h = upstreamHeaders(req({ host: "box.ts.net:47100", "tailscale-user-login": "o@x", origin: "https://box.ts.net:47100" }),
    { target: 5173, previewOrigin: "https://box.ts.net:47100" });
  assert.equal(h.host, "localhost:5173");
  assert.equal(h.origin, "http://localhost:5173");
  assert.equal(h["x-forwarded-host"], "box.ts.net:47100");
  assert.equal(h["x-forwarded-proto"], "https");
  assert.ok(!Object.keys(h).some((k) => k.startsWith("tailscale-")));
});
test("Location rewrite and Set-Cookie filter", () => {
  const h = downstreamHeaders({ location: "http://localhost:5173/admin?x=1",
    "set-cookie": ["agentpier_session=evil; Path=/", "app=1"] }, { target: 5173, previewOrigin: "http://127.0.0.1:47100" });
  assert.equal(h.location, "http://127.0.0.1:47100/admin?x=1");
  assert.deepEqual(h["set-cookie"], ["app=1"]);
});

// preview-proxy.test.js — LoginStore in mkdtemp, upstream http + ws servers on port 0,
// listener on a freePortRange() slot, gate built from previewBranch + sessionToken
test("forwards method, path, query, body and streams SSE unbuffered", ...); // first SSE event arrives before the upstream ends
test("pipes a WebSocket upgrade both ways", ...); // ws echo through the slot
test("forwards to ::1 when the target listens only there", ...);
test("refuses without an owner session; a cross-site navigation gets the bounce page", ...);
// status 401 + html contains location.replace; same request with sec-fetch-site: same-origin → signIn page with signInUrl
test("signInUrl uses the request host name", ...); // Host localhost:<slot> → http://localhost:<port>/?preview=<slot>&path=%2F
test("a restricted user's session is refused with the forbidden page", ...);
test("wrong Host, tailscale markers on the local branch, or Tailscale without identity → 403", ...);
test("network mode accepts a configured network host with the slot port and refuses tailscale headers there", ...);
test("unreachable upstream answers 502 and recovers", ...); // en page contains "The server on port <target> is not answering" and the label; restart upstream → 200
test("revoking the owner session closes proxied sockets", ...); // open ws, login.revoke(token) → ws closes
test("an idle slot answers the localized no-preview page", ...); // resolve → null, Accept-Language de → German text, status 404
test("the agentpier_session cookie and tailscale headers never reach the upstream", ...);

// preview-return.test.js
test("returns to the preview on the same host name only", () => {
  assert.equal(previewReturn("?preview=47100&path=%2Fadmin", { protocol: "http:", hostname: "localhost" }), "http://localhost:47100/admin");
  for (const bad of ["?preview=80&path=/", "?preview=47100&path=%2F%2Fevil.com", "?preview=x"])
    assert.equal(previewReturn(bad, { protocol: "http:", hostname: "localhost" }), null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/unit/preview-headers.test.js tests/integration/preview-proxy.test.js tests/unit/preview-return.test.js`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement** the modules (`http.request` with the upstream address from `resolve`, `res.flushHeaders()` and `pipe` both ways, no compression; upgrades via `net.connect` writing the rewritten request head and `head`, then piping). Page texts and the web `previewReturn` copy go into the DE/EN catalogs.

- [ ] **Step 4: Run tests and i18n**

Run: `node --test tests/unit/preview-headers.test.js tests/integration/preview-proxy.test.js tests/unit/preview-return.test.js && npm run i18n:confirm -- previews && node --test tests/unit/i18n-translation-lock.test.js tests/unit/server-i18n-catalogs.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/previews server/lib/i18n web/features/login tests/unit/preview-*.test.js tests/integration/preview-proxy.test.js
git commit -m "feat: proxy a preview port to a local server for the signed-in owner"
```

---

### Task 4: PreviewService, lifecycle hooks and audit

**Files:**

- Create: `server/features/previews/preview-service.js`, `server/application/preview-wiring.js`, `server/features/audit/audit-preview-details.js`
- Modify: `server/application/services.js:148` (`let artifacts, sessionSecrets, sshAgents, previews;`), `:150-165` (one line each in `onRemoving` and `onStopped`: `await previews?.closeSession(session.id, "session")`), end of `createServices` (`services.previews = previews = createPreviewService(services);`) — at most 5 lines in total
- Modify: `server/app.js` (`server.once("listening", () => services.previews.start())`), `server/application/shutdown.js` (`await services.previews?.shutdown()`), `server/features/mcp/session-integration.js` `revoke(id)` (`this.services.previews?.closeSession(id, "revoked")`)
- Modify: `server/features/audit/audit-vocabulary.js` (resource `preview`), `server/features/audit/audit-schema.js:~517` (`previewAuditDetails(details, event)`; `"preview"` in the `kind` list)
- Modify: `tests/helpers/application.js` (`configuration.tailscaleRun ??= refuseTailscale`)
- Test: `tests/integration/preview-service.test.js`

**Interfaces:**

- Consumes: Tasks 2–3.
- Produces:
  - `class PreviewService extends EventEmitter` — `constructor({ dataDir, effective, bindHost, detected, identity, audit, live, sessionAlive, agentAlive, internalPorts, probe, tailscaleRun, now = Date.now, idleMs = 24 * 60 * 60 * 1000 })`; emits `changed`.
  - `settings(): { enabled, portRangeStart, portRangeEnd }`
  - `async start(): void` — when enabled: probe and bind every slot (`createPreviewListener`, host `bindHost()` = `services.networkState.bind`: `network.bind` in network mode, else `127.0.0.1`), start the idle sweep timer (`unref`).
  - `async open({ owner, port, label, path }): { id, url, port, label }` — `owner` is `{ kind: "session", sessionId, project }` or `{ kind: "agent", assistantId, conversationId, project }` (`project`: session `cwd` / assistant id; sticky key `${project}\0${port}`). Order: `PREVIEW_DISABLED` (409) → input (`PREVIEW_INVALID_INPUT` 400: port integer 1–65535, label 1–80 chars without control characters, path `^/(?!/)` ≤ 2048 without control characters) → `forbiddenTarget` (`PREVIEW_PORT_FORBIDDEN` 403) → `targetAddress` (`PREVIEW_NOT_LISTENING` 409) → idempotent per (session or conversation, port): same id, label/path updated → `allocate` (`PREVIEW_RANGE_FULL` 409).
  - `previewUrl({ slot, path }): string` — `remoteUrl` host → `https://<host>:<slot>`; else first network URL host → `http://<host>:<slot>`; else `http://127.0.0.1:<slot>`; then `path`.
  - `async close(id, { reason, source }): { closed: true }` (`PREVIEW_NOT_FOUND` 404), `closeSession(sessionId, reason)`, `closeConversation(conversationId, reason)`.
  - `list(filter = {}): Preview[]` (`{ sessionId? , conversationId? }`); `Preview = { id, slot, target, label, path, owner: { kind, sessionId?, assistantId?, conversationId? }, createdAt, lastUsedAt }` (no `project` exposed).
  - `async view(): { settings, previews: Preview[], slots: [{ port, state: "free"|"taken"|"preview" }], serve: null }` (Task 8 fills `serve`).
  - `async shutdown(): void` — closes listeners and sockets, keeps Serve registrations.
  - `createPreviewService(services): PreviewService` in `preview-wiring.js` — lazy `effective`/`identity`/`live`/`bindHost`/`detected` (`services.networkState`); `sessionAlive(id)` = `activeSessionGrant(dataDir, id) !== null`; `agentAlive({ assistantId, conversationId })` = conversation exists, not deleted, agent not archived; `internalPorts()` = AgentPier port, team bridge port (`TeamBridge#connection`), Gateway port (`RuntimeSupervisor`), adapter listener ports (`createAdapterListener().port`), agent browser CDP ports (`agent-browsers.js` `cdpPort`) — add a getter where one is missing.
  - Audit: `preview.started` / `preview.stopped` / `preview.expired`, `resourceType: "preview"`, `resourceId` = preview id, `sessionId` for sessions, `source` `mcp`|`agent`|`user`|`system`, `details: { kind: "preview", owner: "session"|"agent", targetPort, slot, reason }` (`reason` ∈ `tool, owner, session, revoked, conversation, disabled, range, expired`). `previewAuditDetails` whitelists exactly these.

- [ ] **Step 1: Write the failing tests** (`applicationFixture` with `prepareDataDir` writing `config.json` `previews: { enabled: true, ...freePortRange(4) }`, upstream on port 0)

```js
test("open answers id, url, port and label; the same session and port reuse the preview", ...);
// url === `http://127.0.0.1:${slot}/admin`, second open with label "B" → same id, label "B"
test("two sessions of one project on the same target port get two slots", ...);
test("open refuses AgentPier's own port, a port in the range and a closed port", ...);
// codes PREVIEW_PORT_FORBIDDEN, PREVIEW_PORT_FORBIDDEN, PREVIEW_NOT_LISTENING
test("open accepts a target listening only on ::1", ...);
test("disabled previews answer PREVIEW_DISABLED and bind nothing", ...);
test("the range full answers PREVIEW_RANGE_FULL", ...); // range of 1 port, second target
test("stopping, removing the session or revoking its MCP grant closes its previews", ...);
// issue() from tests/helpers/session-mcp.js; sessions.stop → list({sessionId}) empty; slot answers idle page
test("an agent preview expires 24 hours after its last request", ...); // fake now, idleMs; audit preview.expired
test("start binds every free slot and serves the idle page", ...); // a slot occupied by a foreign server → view().slots state "taken"
test("open, close and expire are audited without URLs or headers", ...);
// audit rows: action preview.started/stopped/expired; JSON has no "?" query string, no "cookie"
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/integration/preview-service.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** the service, wiring, hooks and audit details; `live()?.invalidate("previews")` on every change (topic defined in Task 6 — guard with `?.`).

- [ ] **Step 4: Run tests and structure check**

Run: `node --test tests/integration/preview-service.test.js tests/unit/audit*.test.js && npm run check:structure`
Expected: PASS; `services.js` ≤ 600 lines.

- [ ] **Step 5: Commit**

```bash
git add server tests/integration/preview-service.test.js tests/helpers/application.js
git commit -m "feat: run previews for sessions and agents and end them with their owner"
```

---

### Task 5: Session MCP tools and instructions

**Files:**

- Create: `server/features/previews/preview-mcp.js`
- Modify: `server/features/mcp/tool-service.js:31-50` (merge like `artifactTools`), `server/features/mcp/http-transport.js:103-118` (instructions, `idempotentHint` gains `preview_open`, error result gains `code` when `/^[A-Z_]+$/`)
- Test: `tests/integration/preview-mcp.test.js`, update `tests/integration/mcp-agent-english.test.js` if it lists tools

**Interfaces:**

- Consumes: `PreviewService.open/close/list` (Task 4); `services.sessionMcp.grantFor(sessionId)`.
- Produces:
  - `previewTools = { preview_open: { description, schema, readOnly: false }, preview_close: {...readOnly: false}, preview_list: {...readOnly: true} }` — zod: `preview_open` `z.strictObject({ port: z.number().int().min(1).max(65535), label: z.string().min(1).max(80).optional(), path: z.string().min(1).max(2048).optional() })`; `preview_close` `z.strictObject({ id: z.string().max(80).optional(), port: z.number().int().min(1).max(65535).optional() })` (exactly one, else `PREVIEW_INVALID_INPUT`); `preview_list` `z.strictObject({})`.
  - `previewToolEntries(grant, context): [name, tool][]` — non-empty only with `context?.sessionId`.
  - `callPreviewTool(services, name, input, context): Promise<object>` — re-checks `services.sessionMcp.grantFor(context.sessionId)` on every call (403 `PREVIEW_UNAVAILABLE`-free: plain 403 "AgentPier access revoked or session unavailable."), `owner = { kind: "session", sessionId, project: session.cwd }`, audit `source: "mcp"`. `preview_list` → `{ items: [{ id, url, port, label }] }`.
  - Description of `preview_open` and the server instructions append exactly: "When you start a server for the user to look at or test, call `preview_open` with its port and give the user the returned link instead of a localhost URL. Bind the server to 127.0.0.1 or localhost. Close it with `preview_close` when it is no longer needed."

- [ ] **Step 1: Write the failing tests** (`issue(f, { tool, choices: true })`, `connect` from `tests/helpers/session-mcp.js`; previews enabled with `freePortRange`)

```js
for (const tool of ["codex", "claude", "opencode"])
  test(`${tool} opens, lists and closes a preview through native MCP`, ...);
// listTools has preview_open/close/list; open → url http://127.0.0.1:<slot>/; fetch(url, { headers: { cookie: f.cookie } }) → upstream body
test("preview tools are absent without a session context", ...); // mcpTools.list({ allResources: true, scopes: [] }) has none
test("errors carry stable codes for agents", ...); // closed port → isError, JSON { code: "PREVIEW_NOT_LISTENING", status: 409, error: /not/i English }
test("server instructions tell sessions to use preview_open instead of localhost URLs", ...);
test("a revoked grant refuses the next call and closes the preview", ...);
```

- [ ] **Step 2: Run to verify they fail** — `node --test tests/integration/preview-mcp.test.js` → FAIL.
- [ ] **Step 3: Implement** the tool module and the three edits; non-read-only calls through `services.mutationBarrier.run` like artifacts.
- [ ] **Step 4: Run tests** — `node --test tests/integration/preview-mcp.test.js tests/integration/artifact-mcp.test.js tests/integration/session-mcp.test.js tests/integration/mcp-agent-english.test.js` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/features/previews/preview-mcp.js server/features/mcp tests/integration
git commit -m "feat: let coding sessions open previews through AgentPier MCP"
```

---

### Task 6: Session Previews panel and live topic

**Files:**

- Create: `server/features/previews/live-topics.js`; Modify: `server/application/live-wiring.js:~108` (`hub.define(previewsTopic(services))`)
- Modify: `web/lib/live/live-topics.js` (entry `previews`)
- Create: `web/features/previews/usePreviews.js`, `preview-links.js`, `PreviewRows.jsx`, `SessionPreviews.jsx`, `previews.css`; `web/lib/i18n/{de,en}/previews.js`, `web/lib/i18n/messages/previews.js`
- Modify: `web/features/sessions/SessionWorkspace.jsx:143-160` (a `<details className="session-previews">` beside **Artifacts**, only while the session has previews)
- Test: `tests/unit/preview-links.test.js`, `tests/unit/live-topics.test.js` (existing parity), `tests/browser/session-previews.spec.js`

**Interfaces:**

- Consumes: `PreviewService.view()`, `close(id, { reason, source })`.
- Produces:
  - Server topic `previews`: `{ name: "previews", mode: "state", authorize: owner, scopeKey: () => "owner", read: () => services.previews.view() }`; `previewsChanged(hub)` = `hub?.invalidate("previews")`.
  - Web topic `previews: { mode: "state", path: () => "/previews", interval: 5000 }`.
  - `usePreviews(): { data, error, written }` (`useLiveTopic("previews")`).
  - `previewHref(preview, location = window.location): string` — `${protocol}//${hostname}:${slot}${path || "/"}`, IPv6 host in brackets.
  - `<PreviewRows previews onStop? />` — per preview a `ListRow` (label, sub line "Port <target>" / session or agent name), **Open preview** link (`target="_blank" rel="noopener noreferrer"`), optional **Stop** button (`DELETE /api/previews/:id`).
  - `<SessionPreviews sessionId />` — `usePreviews()` filtered by `owner.sessionId`; text "Previews" / "Vorschauen".

- [ ] **Step 1: Write the failing tests**

```js
// preview-links.test.js
test("previewHref keeps the page's host name", () => {
  assert.equal(
    previewHref(
      { slot: 47100, path: "/admin" },
      { protocol: "https:", hostname: "box.tail1.ts.net" },
    ),
    "https://box.tail1.ts.net:47100/admin",
  );
  assert.equal(
    previewHref({ slot: 47101 }, { protocol: "http:", hostname: "::1" }),
    "http://[::1]:47101/",
  );
});
```

`tests/browser/session-previews.spec.js` (route mocks like `tests/browser/artifacts.spec.js`; de-DE and en-GB): the session view shows **Previews** with "Shop start page", "Port 5173" and an **Open preview** link whose `href` is `http://127.0.0.1:47100/` and `target` `_blank`; **Stop** sends `DELETE /previews/<id>`; a session without previews shows no Previews section.

- [ ] **Step 2: Run to verify they fail** — `node --test tests/unit/preview-links.test.js tests/unit/live-topics.test.js && AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/session-previews.spec.js` → FAIL.
- [ ] **Step 3: Implement**, including `server/http/routes/previews.js` with `GET /api/previews` (REST fallback of the topic) and `DELETE /api/previews/:id` (**Stop** in the session panel; 204, `reason: "owner"`, `source: "user"`), mounted in `server/app.js`. Task 7 adds the settings route.
- [ ] **Step 4: Run tests and i18n** — same commands plus `npm run i18n:confirm -- previews && node --test tests/unit/i18n-catalogs.test.js tests/unit/i18n-translation-lock.test.js tests/unit/ui-guide-rules.test.js` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server web tests
git commit -m "feat: show a session's previews beside its artifacts"
```

---

### Task 7: Settings › Remote access › Previews card and routes

**Files:**

- Modify: `server/http/routes/previews.js` (settings route)
- Create: `web/features/previews/PreviewSettingsCard.jsx`; Modify: `web/features/remote/RemoteSettings.jsx` (render the card after the network card)
- Test: `tests/blackbox/preview-routes.test.js`, `tests/browser/preview-settings.spec.js`

**Interfaces:**

- Consumes: `PreviewService.view/configure/close`, `remoteLocked(req)` from `server/http/routes/remote.js`.
- Produces:
  - `PUT /api/previews/settings` body `{ enabled, portRangeStart, portRangeEnd }` → `view()`. All preview routes owner only (route-access default). From the network branch only `{ ...saved, enabled: false }` is accepted, otherwise 403 `settings.networkLocked` (same rule as `/remote`).
  - `PreviewService.configure(next, { source }): Promise<view>` — validate (Task 2), write, close previews with `reason: "disabled"` or, for slots that leave the range, `"range"`, rebind listeners; audit `setting.updated` `resourceId: "previews"` with `{ enabled, count }`.
  - Card: `ToggleRow` **Enable previews** / **Vorschauen einschalten**, `NumberRow` range start and end, save through the settings pattern, port list (`ListRow` per slot, status `ok` free, `warn` taken by another program, value "Preview" for used), active previews via `<PreviewRows onStop>`; locked inputs when `network.locked`.

- [ ] **Step 1: Write the failing tests**

```js
// preview-routes.test.js
test("the owner switches previews on and sets the range; config.json keeps its other keys", ...);
test("a range over 50 ports or containing AgentPier's port answers 400", ...);
test("a network-branch request may only switch previews off", ...); // Host = network host, trustBranch network
test("a restricted user reaches none of the preview routes", ...);
test("DELETE stops a preview and audits preview.stopped with reason owner", ...);
```

Browser (de-DE, en-GB, 390×844 and desktop): switch on, set 47120–47129, save → `PUT /previews/settings` body `{ enabled: true, portRangeStart: 47120, portRangeEnd: 47129 }`; a taken port shows "Used by another program" / "Von einem anderen Programm belegt"; **Stop** sends `DELETE /previews/<id>`.

- [ ] **Step 2: Run to verify they fail** — `node --test tests/blackbox/preview-routes.test.js && AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/preview-settings.spec.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and i18n** — same plus `npm run i18n:confirm -- previews && node --test tests/blackbox/user-route-denial.test.js tests/unit/ui-guide-rules.test.js tests/unit/i18n-translation-lock.test.js` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server web tests
git commit -m "feat: let the owner switch previews on and stop them in Remote access"
```

---

### Task 8: Tailscale Serve registration, `npm run tailscale` and the update path

The update path is the server start: every release activation restarts the service, and `PreviewService.start()` re-applies the registrations idempotently, only when previews are enabled and `remoteUrl` is set.

**Files:**

- Create: `server/features/remote/tailscale-cli.js`, `server/features/previews/preview-serve.js`
- Modify: `scripts/tailscale.mjs` (use `runTailscale`; after writing config, apply previews when `previews.enabled`; keep `selectServePort` exported)
- Modify: `server/features/previews/preview-service.js` (`start`, `configure`, `view().serve`), `web/features/previews/PreviewSettingsCard.jsx` (Tailscale row: registered / error with commands)
- Test: `tests/unit/preview-serve.test.js`, extend `tests/integration/preview-service.test.js`

**Interfaces:**

- Produces:
  - `tailscaleArgs(args, env = process.env): string[]` (socket handling of `AGENTPIER_TAILSCALE_SOCKET`, absolute path, no control characters — moved from `scripts/tailscale.mjs` `run`); `runTailscale(args, { env, execFile }): Promise<string>` (async, timeout 30000); the script's `main` becomes `async`.
  - `previewServeOwned(serveStatus, httpsPort, listener): boolean` (same rule as `selectServePort`: one Web entry `:<port>`, one handler `/` proxying `http://127.0.0.1:<listener>`).
  - `applyPreviewServe({ run, range, previousRange = null }): Promise<{ registered: number[], failed: [{ port, reason }], commands: string[] }>` — reads `serve status --json`; for each slot not owned and not occupied (`TCP[port]` or foreign `Web`): `serve --bg --https=<slot> http://127.0.0.1:<listenerPort(slot)>`; for slots of `previousRange` outside `range` that are owned: `serve --https=<slot> off`. `removePreviewServe({ run, range })` unregisters owned slots only.
  - `serveCommands(range): string[]` — the exact `tailscale serve --bg --https=<slot> http://127.0.0.1:<listener>` lines shown on failure.
  - `view().serve`: `null` without `remoteUrl`, else `{ registered: number[], failed: [...], commands: string[] }`.
  - `open()` gains `PREVIEW_UNAVAILABLE` (503) after the target check: only when `remoteUrl` is set, the allocated slot is not in `serve.registered` and network mode is off (the owner has no way to reach it); the message names the fix.
  - `createApplication` config seam `tailscaleRun` (default `runTailscale`); fixtures refuse it (Task 4).

- [ ] **Step 1: Spike (no commit):** with a disposable AgentPier instance (own data dir and tmux, never the live service) on macOS and Linux, register one slot with Serve and bind `127.0.0.1:<slot>` in the same process; record whether both coexist and whether `portAvailable(slot)` stays true for our own listener's wildcard probe. If they conflict, change only `listenerPort(slot)` to a derived loopback range and document it in `docs/previews.md` (Task 10).

- [ ] **Step 2: Write the failing tests**

```js
// preview-serve.test.js — run is a fake recording args and returning canned serve status JSON
test("registers every free slot of the range once", ...); // args include ["serve","--bg","--https=47100","http://127.0.0.1:47100"]
test("an owned slot is left alone; a foreign Web or TCP entry is reported as failed", ...);
test("a range change removes only AgentPier's own old registrations", ...); // "--https=47100","off" for owned only
test("a failing CLI yields the exact commands to run", ...); // failed[0].reason, commands[0] === "tailscale serve --bg --https=47100 http://127.0.0.1:47100"
test("the socket variable must be absolute", () => assert.throws(() => tailscaleArgs(["status"], { AGENTPIER_TAILSCALE_SOCKET: "rel" })));
// preview-service.test.js additions (remoteUrl in config.json, fake tailscaleRun)
test("start re-applies registrations only when enabled", ...); // disabled → zero run calls
test("switching previews off removes the registrations; open answers PREVIEW_UNAVAILABLE while Serve failed and network mode is off", ...);
```

- [ ] **Step 3: Run to verify they fail** — `node --test tests/unit/preview-serve.test.js tests/integration/preview-service.test.js` → FAIL.
- [ ] **Step 4: Implement**, then extend `tests/unit/remote-script.test.js`-style coverage for `scripts/tailscale.mjs` only through exported pure functions (never spawn the real CLI).
- [ ] **Step 5: Run tests** — same command plus `node --test tests/unit/remote-script.test.js` and `npm run i18n:confirm -- previews` → PASS.
- [ ] **Step 6: Commit**

```bash
git add server scripts web tests
git commit -m "feat: register the preview range with Tailscale Serve"
```

---

### Task 9: Agent bridge action, agent chat strip, Telegram link and bootstrap guidance

**Files:**

- Create: `server/features/assistants/agent-previews.js`, `server/features/assistants/team-plugin/preview-tool.js`, `web/features/previews/PreviewStrip.jsx`
- Modify: `team-bridge-actions.js` (`actions`, `bridgeTool` list, `personalActions` gain `"preview"`), `team-bridge.js` (one import, one dispatch line: `if (action === "preview") return invokePreview(this.assistants.workflows, invocation, input);`), `team-plugin/index.js` (`ownTools`, `toolTimeouts.preview = 15000`, `...previewDefinition`), `team-plugin/openclaw.plugin.json` (`agentpier_preview`), `runtime-config.js` `nativeTools`, `native-capabilities.js` (`profileTools`: `...(nativeReady && mayOpenPreviews(assistant) ? ["agentpier_preview"] : [])`; `lockedTools` and `senderLockedTools` gain it), `goal-turns.js` (`mayOpenPreviews`), `assistant-config.js:~314` (`previews: nativeReady && mayOpenPreviews(assistant, senderFacing)`), `assistant-bootstrap.js` (`previewGuidance` section), `chat-removal.js` `forgetChat` (`assistants.workflows?.s?.previews?.closeConversation(conversation.id, "conversation")`), `web/features/assistants/ChatStrips.jsx` (`<PreviewStrip conversationId />`)
- Modify: `server/lib/i18n/{de,en}/previews.js` (Telegram text)
- Test: `tests/integration/agent-previews.test.js`, `tests/unit/assistant-native-capabilities.test.js`, `tests/unit/assistant-bootstrap.test.js`, `tests/unit/openclaw-config-characterization.test.js`, `tests/browser/agent-previews.spec.js`

**Interfaces:**

- Consumes: `PreviewService.open/close/list` (owner `{ kind: "agent", assistantId, conversationId, project: assistantId }`), `AgentShares#turn(invocation)` and `#target(origin)` (`assistants.shares`) for the calling chat and its Telegram target.
- Produces:
  - `mayOpenPreviews(agent, senderFacing = false): boolean` = `goalAgent(agent) && !senderFacing`.
  - `invokePreview(workflows, invocation, input): Promise<object>` — `input.action` `open|close|list` with `port`, `label`, `path`, `id`; refuses a user's conversation (`conversation.userId`) and routine/hook runs (`assistantProblem("invalid", 403)`); `PreviewService` errors answer `{ error: <PREVIEW_*>, reason: <English text> }` in the bridge's error shape; result `{ id, url, port, label, note }` with `note` "Give the owner this link; it opens the server through AgentPier."
  - `notifyAgentPreview(workflows, agent, target, preview): void` — when the turn came from the owner's Telegram chat and `url` is not `127.0.0.1`: `channels.outbox.enqueue({ key: \`agent-preview:${id}\`, source: target, kind: "agent-preview", localized: true, text })`with the label and URL (pattern of`notifyAgentProject`in`agent-project-notes.js`); failures logged, never fail the call.
  - `previewDefinition = { preview: { description, parameters } }` (JSON schema: `action` enum, `port` 1–65535, `label` ≤ 80, `path` ≤ 2048, `id` ≤ 80; description carries the instruction text of Task 5).
  - Bootstrap: option `previews` → section `## Previews` with "- When you start a server for the owner to look at or test, call agentpier_preview (action open) with its port and give the owner the returned link instead of a localhost URL. Bind the server to 127.0.0.1 or localhost. Close it with action close when it is no longer needed."
  - `<PreviewStrip conversationId />` — `usePreviews()` filtered by `owner.conversationId`, renders `<PreviewRows>` in a compact strip; nothing when empty.

- [ ] **Step 1: Write the failing tests**

```js
// assistant-native-capabilities.test.js
test("agentpier_preview: own agents and permanent members only, never user agents, sender-facing agents or routines", ...);
// mirror of the agentpier_project test: tools(own) includes, task member / user agent / archived exclude,
// lockedTools, senderLockedTools and nativeTools include it, routineTools does not
// assistant-bootstrap.test.js
test("the preview guidance appears only with the preview tool", ...);
// agent-previews.test.js (agent bridge fixture as in tests/integration/agent-projects-wiring.test.js)
test("an own agent opens a preview for its chat and deleting the chat closes it", ...);
test("a Telegram turn queues the preview link to the owner's Telegram chat", ...); // outbox kind agent-preview, text contains https://box.ts.net:<slot>/
test("a user's conversation and a routine run are refused", ...);
test("errors reach the agent as PREVIEW_* codes", ...);
```

Browser: an agent chat with an active preview of that conversation shows the strip with **Open preview**; another chat shows none.

- [ ] **Step 2: Run to verify they fail** — `node --test tests/unit/assistant-native-capabilities.test.js tests/unit/assistant-bootstrap.test.js tests/integration/agent-previews.test.js` → FAIL.
- [ ] **Step 3: Implement**; keep `team-bridge.js` and `assistant-config.js` within 600 lines.
- [ ] **Step 4: Run tests** — same plus `node --test tests/unit/openclaw-config-characterization.test.js tests/integration/user-agent-tool-guard.test.js && AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/agent-previews.spec.js && npm run i18n:confirm -- previews && npm run check:structure` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server web tests
git commit -m "feat: let the owner's agents hand him previews in chat and Telegram"
```

---

### Task 10: Documentation and the full check

**Files:**

- Create: `docs/previews.md` (English): what previews are, enabling, range and its rules, one port per preview and the sticky-slot caveat (service workers, localStorage and cookies of an earlier app carry over on the same slot; no `Clear-Site-Data`), the three access paths and the Tailscale registration (including the Task 8 listener layout), sign-in from another app (bounce page), owner-only, lifetime (session end, grant revocation, 24 h for agents, restart ends all), troubleshooting (Serve error and commands, `::1`-only servers, `Host` checks of dev servers), security notes.
- Modify: `docs/remote-access.md` (German, short section "Vorschauen" linking `previews.md`; `npm run tailscale` registers the range when previews are on), `docs/ssh-access.md` (one sentence: a tunnel's local end can be opened with `preview_open`), `README.md` and `README.de.md` (feature list and docs table), `docs/mcp.md` (session tools list), `docs/assistant-workflows.md` and `docs/assistant-gateway.md` (`agentpier_preview`), `docs/login.md` (several session cookies; same-site API refusal), `docs/ui-guide.md` only if a primitive was added.
- Delete before opening the PR: `docs/superpowers/specs/2026-11-01-session-previews-design.md` and this plan.

- [ ] **Step 1:** Write and update the docs; check every quoted UI label against the catalogs (Settings › Remote access › Previews, **Enable previews**, **Open preview**, **Stop**).
- [ ] **Step 2:** Run `npm run check` → PASS (lint, format, structure, build, all Node suites).
- [ ] **Step 3:** Run `AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/session-previews.spec.js tests/browser/preview-settings.spec.js tests/browser/agent-previews.spec.js tests/browser/remote-settings.spec.js` → PASS; restore `docs/screenshots/pipeline-permissions.png` if a run rewrote it.
- [ ] **Step 4: Commit**

```bash
git add docs README.md README.de.md
git commit -m "docs: describe session previews"
```

- [ ] **Step 5:** `git rm docs/superpowers/specs/2026-11-01-session-previews-design.md docs/superpowers/plans/2026-11-01-session-previews.md` and commit `chore: remove the session previews working documents` before the PR.
