# Agent Capability Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner grant each eligible agent web search, web fetch, an isolated browser and document reading, with a global web search provider setting.

**Architecture:** Capabilities extend the assistant record; `profileTools` grants tools per eligible agent; `compileOpenClawConfig` emits the global allow list, `tools.web`, the `browser` block and the search provider configuration only when some agent uses them, all inside the locked core. A small settings store holds the search provider and a Brave key; a detector finds an installed Chromium-based browser. Live changes go through `patchConfig`.

**Tech Stack:** Node.js 22 ES modules, `node:test`, `node:sqlite` via `privateDatabase`, React (Vite) with reactive i18n catalogs, Playwright, OpenClaw 2026.9.8 Gateway RPC.

**Spec:** `docs/superpowers/specs/2026-10-11-agent-capability-profiles-design.md`

## Global Constraints

- All new capabilities default to off; stored records without them read as false.
- Eligibility = `personalCapabilities`: personal agents and permanent team members, never archived agents; temporary members get none of the new tools.
- Browser: only the `openclaw` profile; never configure the `user` profile; `evaluateEnabled: false`; private network blocked for browser and web fetch.
- Web search provider default `duckduckgo`; optional `perplexity` (key of a chosen OpenRouter provider connection) and `brave` (own key). Keys never appear in HTTP responses or logs.
- `tools`, `browser`, `plugins` stay locked; their content is computed from profiles and settings, never from owner overrides.
- Every UI text in German and English with matching keys (`web/lib/i18n/de|en`), reactive imports from `web/lib/i18n/messages/`; usable at 390 px width.
- Team plugin, team tools and write guard unchanged; team contract and qualification tests pass.
- No browser installation by AgentPier.
- Files ≤ 600 lines; commits in English with conventional prefixes and a `Co-Authored-By` trailer for the authoring model.
- Tests never touch the user's instance, `~/.openclaw`, port 4380 or the default tmux server.

## Review Focus

- An agent saved with only `{memory, reminders}` (an older client) keeps its new capabilities unchanged instead of resetting them — pinned in Task 2.
- Switching the search provider to Brave without a key, or to Perplexity with a deleted OpenRouter connection, falls back to a clear "not configured" state and never breaks the Gateway start — pinned in Tasks 4 and 5.
- No agent uses the browser: the `browser` block stays `{ enabled: false }` exactly as today — pinned in Task 5.
- A browser executable that disappears after detection (uninstalled) makes the switch unavailable on the next detection and does not crash the start — pinned in Task 3.
- A temporary team member whose parent has every capability still receives none of the new tools — pinned in Task 2.

---

### Task 1: Probe the native configuration keys live

**Files:**

- Modify: `tests/integration/assistant-native-interfaces-contract.test.js`
- Create: `docs/assistant-web-tools-qualification.md`

**Interfaces:**

- Consumes: the contract's existing supervisor setup, `patchConfig`, `assistantModelServer({ tool })` from `tests/helpers/assistant-model-server.js`.
- Produces: verified facts recorded in the doc, used by Tasks 4–5: the exact config for (a) `tools.web.search.provider: "duckduckgo"`, (b) Perplexity key placement (plugin config vs `OPENROUTER_API_KEY`/`PERPLEXITY_API_KEY`), (c) Brave key placement, (d) `tools.web.fetch.ssrfPolicy` field names, (e) the `browser` block with `defaultProfile: "openclaw"`, `executablePath`, `evaluateEnabled: false`, `ssrfPolicy`, and whether a root `browser` block needs a `plugins.allow` entry; (f) `config.schema.lookup` reload kind for each path.

- [ ] **Step 1: Add a probe test**

Add a test `"web tools and the isolated browser accept AgentPier's configuration"` to the contract (same skip rule and runtime variable). It patches, through `patchConfig`, a configuration with `tools.allow` including `web_fetch`, `web_search`, `browser`, `pdf`, `view_image`, `tools.web.search.provider: "duckduckgo"`, `tools.web.fetch.ssrfPolicy` blocking private networks, and a `browser` block with `enabled: true`, `defaultProfile: "openclaw"`, `evaluateEnabled: false`, `ssrfPolicy` blocking private networks and `executablePath` from `process.env.AGENTPIER_TEST_BROWSER_PATH` when set. It records `config.schema.lookup` for `tools.web.search.provider`, `tools.web.fetch`, `browser.enabled`, `browser.executablePath` via `t.diagnostic`, then asserts the patch is accepted (no throw) and that `config.get` returns the values. If the Gateway rejects a key, read the schema (`config.schema`) for the correct shape, fix the patch, and record the difference.

- [ ] **Step 2: Exercise web fetch with the fake model**

Start a local HTTP server on 127.0.0.1 serving a page with a marker string. Use `assistantModelServer({ tool: { name: "web_fetch", arguments: { url: <public-looking URL> } } })` — because 127.0.0.1 is private and must be refused, first assert a fetch of `http://127.0.0.1:<port>/` is refused (tool result contains an SSRF/blocked error). Record the tool result shape.

- [ ] **Step 3: Browser when available**

If `AGENTPIER_TEST_BROWSER_PATH` is set (or a browser is found in `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, `/usr/bin/chromium`, `/usr/bin/google-chrome`), have the fake model call `browser` with `{ action: "status" }` (or the minimal action the docs name) and assert it reports the `openclaw` profile. Otherwise `t.skip("no Chromium-based browser installed")` for this sub-check only.

- [ ] **Step 4: Run and document**

Run the contract with the provisioned runtime (see `docs/assistant-native-interface-qualification.md` "Running the contract"). Write `docs/assistant-web-tools-qualification.md` (sections as in the memory qualification doc) with the exact verified configuration for (a)–(f).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/assistant-native-interfaces-contract.test.js tests/helpers/assistant-model-server.js docs/assistant-web-tools-qualification.md
git commit -m "test: qualify OpenClaw web tools and the isolated browser"
```

---

### Task 2: Capability fields, validation and tool grants

**Files:**

- Modify: `server/features/assistants/assistant-validation.js:36-47`
- Modify: `server/features/assistants/native-capabilities.js`
- Test: `tests/unit/assistant-native-capabilities.test.js`, `tests/unit/openclaw-agent-entry.test.js`

**Interfaces:**

- Produces: `capabilityKeys = ["memory","reminders","webSearch","webFetch","browser","documents"]`; `personalCapabilities(assistant) -> { memory, reminders, webSearch, webFetch, browser, documents }` (all false when ineligible or missing); `capabilityTools = { webSearch: ["web_search"], webFetch: ["web_fetch"], browser: ["browser"], documents: ["pdf", "view_image"] }`; `profileTools(assistant, teamsReady, nativeReady, writeGuard, available = {})` appends granted tools after today's list when `nativeReady`; `available.browser === false` withholds `browser`.

- [ ] **Step 1: Failing tests**

```js
test("new capabilities default to off and are validated as booleans", () => {
  assert.deepEqual(
    validateDefinition({ capabilities: { memory: true, reminders: false } }, true)
      .capabilities,
    {
      memory: true,
      reminders: false,
    },
  );
  assert.deepEqual(
    validateDefinition(
      {
        capabilities: { memory: false, reminders: false, webSearch: true, browser: true },
      },
      true,
    ).capabilities,
    { memory: false, reminders: false, webSearch: true, browser: true },
  );
  assert.throws(
    () =>
      validateDefinition(
        { capabilities: { memory: false, reminders: false, webSearch: "yes" } },
        true,
      ),
    { status: 400 },
  );
  assert.throws(
    () =>
      validateDefinition(
        { capabilities: { memory: false, reminders: false, shell: true } },
        true,
      ),
    { status: 400 },
  );
});

test("eligible agents get granted web and document tools, temporary members none", () => {
  const caps = {
    memory: false,
    reminders: false,
    webSearch: true,
    webFetch: true,
    browser: true,
    documents: true,
  };
  const personal = { id: "a", capabilities: caps };
  assert.deepEqual(profileTools(personal, true, true, false).slice(-5), [
    "web_search",
    "web_fetch",
    "browser",
    "pdf",
    "view_image",
  ]);
  const temporary = { id: "m", teamMemberId: "t", lifetime: "task", capabilities: caps };
  assert.ok(!profileTools(temporary, true, true, false).includes("web_search"));
  assert.ok(
    !profileTools(personal, true, true, false, { browser: false }).includes("browser"),
  );
  assert.ok(
    !profileTools({ ...personal, archivedAt: "x" }, true, true, false).includes(
      "web_fetch",
    ),
  );
});
```

(`validateDefinition` is the existing exported validator in `assistant-validation.js`; check its exact name and partial-flag signature first and adapt the calls.)

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/unit/assistant-native-capabilities.test.js`
Expected: FAIL (new keys rejected; tools missing).

- [ ] **Step 3: Implement**

In `assistant-validation.js`, replace the capabilities block:

```js
if ("capabilities" in input) {
  const c = input.capabilities;
  if (
    !c ||
    Array.isArray(c) ||
    Object.keys(c).some((k) => !capabilityKeys.includes(k)) ||
    typeof c.memory !== "boolean" ||
    typeof c.reminders !== "boolean" ||
    Object.values(c).some((v) => typeof v !== "boolean")
  )
    throw assistantProblem("invalid");
  result.capabilities = Object.fromEntries(
    capabilityKeys.filter((k) => k in c).map((k) => [k, c[k]]),
  );
}
```

Import `capabilityKeys` from `native-capabilities.js` (avoid an import cycle: if `native-capabilities.js` imports validation, move `capabilityKeys` into a new tiny module `assistant-capabilities.js` and import it from both).

Where an update merges a patch into the stored record (`assistant-store.js` `updateAssistant` or `AssistantService.update`), merge `capabilities` shallowly over the stored value so an older client sending only `{memory, reminders}` keeps the new keys. Add a unit test for that merge in `tests/unit/assistant-native-capabilities.test.js`.

In `native-capabilities.js`:

```js
export const capabilityTools = {
  webSearch: ["web_search"],
  webFetch: ["web_fetch"],
  browser: ["browser"],
  documents: ["pdf", "view_image"],
};
export function personalCapabilities(assistant) {
  const eligible =
    !assistant.archivedAt &&
    (!assistant.teamMemberId || assistant.lifetime === "permanent");
  return Object.fromEntries(
    capabilityKeys.map((key) => [
      key,
      eligible && assistant.capabilities?.[key] === true,
    ]),
  );
}
```

and append in `profileTools`, after the workspace entry:

```js
    ...(nativeReady
      ? Object.entries(capabilityTools).flatMap(([key, tools]) =>
          capabilities[key] && !(key === "browser" && available.browser === false)
            ? tools
            : [],
        )
      : []),
```

with the new `available = {}` parameter.

- [ ] **Step 4: Run focused and assistant unit tests**

Run: `node --test tests/unit/assistant-native-capabilities.test.js tests/unit/openclaw-*.test.js tests/unit/*assistant*.test.js`
Expected: PASS (characterisation tests unchanged: no agent has new capabilities).

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: add web, browser and document capabilities to agent profiles"
```

---

### Task 3: Browser detection

**Files:**

- Create: `server/features/assistants/browser-detection.js`
- Test: `tests/unit/assistant-browser-detection.test.js`

**Interfaces:**

- Produces: `detectBrowser({ platform = process.platform, exists = fs.existsSync, home = os.homedir() } = {}) -> { available: boolean, executablePath?: string, name?: string }`.

- [ ] **Step 1: Failing test**

```js
test("the first installed Chromium-based browser is chosen per platform", () => {
  const mac = new Set(["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"]);
  assert.deepEqual(
    detectBrowser({ platform: "darwin", exists: (p) => mac.has(p), home: "/Users/x" }),
    {
      available: true,
      name: "Brave",
      executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    },
  );
  assert.deepEqual(
    detectBrowser({
      platform: "linux",
      exists: (p) => p === "/usr/bin/chromium",
      home: "/home/x",
    }).name,
    "Chromium",
  );
  assert.deepEqual(
    detectBrowser({ platform: "darwin", exists: () => false, home: "/Users/x" }),
    { available: false },
  );
});
```

- [ ] **Step 2: Run to fail**, then **Step 3: Implement**

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const candidates = {
  darwin: (home) =>
    [
      ["Chrome", "Google Chrome.app/Contents/MacOS/Google Chrome"],
      ["Brave", "Brave Browser.app/Contents/MacOS/Brave Browser"],
      ["Edge", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      ["Chromium", "Chromium.app/Contents/MacOS/Chromium"],
    ].flatMap(([name, app]) => [
      [name, path.join("/Applications", app)],
      [name, path.join(home, "Applications", app)],
    ]),
  linux: () => [
    ["Chrome", "/usr/bin/google-chrome"],
    ["Chrome", "/usr/bin/google-chrome-stable"],
    ["Brave", "/usr/bin/brave-browser"],
    ["Edge", "/usr/bin/microsoft-edge"],
    ["Chromium", "/usr/bin/chromium"],
    ["Chromium", "/usr/bin/chromium-browser"],
    ["Chromium", "/snap/bin/chromium"],
  ],
};
// AgentPier installs no browser; OpenClaw drives an installed one with its own
// isolated profile. The Gateway runs with a private HOME, so the path is explicit.
export function detectBrowser({
  platform = process.platform,
  exists = fs.existsSync,
  home = os.homedir(),
} = {}) {
  for (const [name, executablePath] of candidates[platform]?.(home) || [])
    if (exists(executablePath)) return { available: true, name, executablePath };
  return { available: false };
}
```

- [ ] **Step 4: Run, Step 5: Commit**

```bash
git add server/features/assistants/browser-detection.js tests/unit/assistant-browser-detection.test.js
git commit -m "feat: detect an installed Chromium-based browser for agents"
```

---

### Task 4: Web search settings store and route

**Files:**

- Create: `server/features/assistants/web-search-settings.js`
- Modify: the route module that serves `/assistant-speech` (`server/http/routes/assistant-channels.js`) — add `GET/PUT /assistant-web-search` behind the same owner middleware
- Modify: `server/application/assistant-graph.js` (construct the store, pass it to routes and to the supervisor's config inputs)
- Test: `tests/unit/assistant-web-search-settings.test.js`, `tests/blackbox/assistant-channel-routes.test.js` (or a new blackbox file following it)

**Interfaces:**

- Consumes: provider connections (`server/features/providers/provider-connections.js`: list records and `secret(id)`; check the exact API) to resolve a Perplexity key from an OpenRouter connection.
- Produces: `WebSearchSettings({ dataDir, connections })` with `get() -> { revision, provider: "duckduckgo"|"perplexity"|"brave", connectionId?, hasBraveKey, ready: boolean }`, `save({ revision, provider, connectionId?, braveKey? })` (revision-checked; `braveKey: null` deletes), `resolve() -> { provider, key? }` for the compiler (`ready: false` → `{ provider: "duckduckgo" }` fallback is NOT silent: `get().ready` reports false and `resolve()` returns `{ provider, unavailable: true }`).

- [ ] **Step 1: Failing unit tests** covering: default `duckduckgo` ready; save `brave` with key → `hasBraveKey`, `resolve()` returns the key, `get()` never contains it; save `brave` without key → `ready: false`; `perplexity` with a missing connection → `ready: false`; stale revision → 409; unknown provider → 400.

- [ ] **Step 2: Run to fail; Step 3: Implement** with `privateDatabase(path.join(dataDir, "assistants"), "web-search.sqlite")`, tables `settings(id=1, revision, provider, connection_id)` and `credentials(id=1, brave_key)`, following `speech-connections.js`. Route handlers return `get()` only.

- [ ] **Step 4: Blackbox test** for `GET/PUT /assistant-web-search`: owner-only, no key in any response.

- [ ] **Step 5: Run and commit**

```bash
git commit -am "feat: store the agents' web search provider"
```

---

### Task 5: Compile web tools, browser and search provider

**Files:**

- Modify: `server/features/assistants/runtime-config.js` (`compileOpenClawConfig`, `freshDefaults` untouched)
- Modify: `server/features/assistants/openclaw-config/locked-core.js` (comment that `tools`/`browser`/`plugins` content now also derives from profiles)
- Modify: `server/features/assistants/runtime-supervisor.js` and `server/application/assistant-graph.js` (pass `webTools: { search: webSearchSettings.resolve(), browser: detectBrowser() }` into the compile inputs, e.g. through `teamConfiguration` or a new `configInputs()` callback)
- Test: `tests/unit/openclaw-web-tools-config.test.js`; keep `tests/unit/openclaw-config-characterization.test.js` green

**Interfaces:**

- Consumes: `profileTools(..., available)`, `capabilityTools`, `detectBrowser`, `WebSearchSettings.resolve()`; the verified keys from `docs/assistant-web-tools-qualification.md` (Task 1).
- Produces: `compileOpenClawConfig({ ..., webTools: { search, browser } })`; `usedCapabilities(profiles) -> Set<key>`.

- [ ] **Step 1: Failing tests**

```js
test("no agent with web tools leaves tools and browser exactly as before", () => {
  /* compile with profiles lacking new caps; assert config.browser deepEqual { enabled: false }, no tools.web, global allow unchanged */
});
test("an agent with web fetch adds the tool globally with a private-network block", () => {
  /* assert global tools.allow includes web_fetch; tools.web.fetch.ssrfPolicy per the qualification doc */
});
test("web search uses the configured provider and its key", () => {
  /* duckduckgo: provider only; brave: key placed as verified; perplexity: key from the connection */
});
test("an unavailable provider keeps web_search out of every tool list", () => {
  /* resolve() -> unavailable: global and per-agent lists lack web_search */
});
test("the browser block uses only the isolated profile without JavaScript evaluation", () => {
  /* enabled true, defaultProfile openclaw, executablePath, evaluateEnabled false, ssrfPolicy; no 'user' profile key */
});
test("a missing browser withholds the tool even when an agent has the capability", () => {
  /* webTools.browser.available false: no browser tool, browser.enabled false */
});
```

Write each body fully with concrete inputs (two profiles: one personal with the capabilities, one temporary member) and exact expected objects taken from the qualification doc.

- [ ] **Step 2: Run to fail; Step 3: Implement**

In `compileOpenClawConfig`, after the global `tools.allow` is set (native branch):

```js
const used = usedCapabilities(teams?.profiles || []);
const search = webTools?.search;
const browser = webTools?.browser;
const extra = Object.entries(capabilityTools).flatMap(([key, tools]) =>
  used.has(key) &&
  !(key === "browser" && !browser?.available) &&
  !(key === "webSearch" && search?.unavailable)
    ? tools
    : [],
);
config.tools.allow = [...config.tools.allow, ...extra];
// tools.web / browser / provider keys exactly as verified in Task 1
```

and pass `available: { browser: !!browser?.available, webSearch: !search?.unavailable }` into `agentEntry`'s `profileTools` (extend `agentEntry` options with `available`, defaulting to `{}`; update its unit tests). Keep `browser` `{ enabled: false }` when no agent uses it.

- [ ] **Step 4: Run** `node --test tests/unit/openclaw-*.test.js tests/unit/*assistant*.test.js`; characterisation unchanged.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: compile web tools, the isolated browser and the search provider"
```

---

### Task 6: Apply changes live

**Files:**

- Modify: `server/features/assistants/assistant-config.js` (after the agent entry patch, patch the global `tools`, `browser` and search provider paths computed by the same compiler helpers when they differ)
- Modify: the web search settings route handler (after `save`, trigger the same global patch, or a Gateway restart when `config.schema.lookup` reports `restart` for a changed path)
- Test: `tests/unit/assistant-config-web-tools.test.js` with a fake client

**Interfaces:**

- Consumes: `patchConfig`, the compiler helpers from Task 5, `client.call("config.schema.lookup", { path })`.
- Produces: `applyWebTools(client, inputs) -> { restartRequired: boolean }`, used by `AssistantConfig.applyOnce` and the settings route; the route response includes `restartRequired`.

- [ ] **Step 1: Failing tests**: enabling `webFetch` on an agent when no agent had it patches `tools.allow` (global, `replacePaths: ["tools.allow"]`) and `tools.web` before the entry patch; nothing is patched when unchanged; a lookup reporting `restart` yields `restartRequired: true` and no patch for that path.

- [ ] **Step 2–4: Implement, run** `node --test tests/unit/assistant-config-web-tools.test.js tests/unit/*assistant*.test.js tests/integration/*assistant*.test.js`.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: apply agent web tool changes to the running Gateway"
```

---

### Task 7: Settings UI

**Files:**

- Modify: `web/features/assistants/AssistantSettings.jsx` (capability fieldset over all keys, grouped: Memory & reminders / Web & documents; browser switch disabled with reason when unavailable)
- Create: `web/features/assistants/WebSearchSettings.jsx` (provider radio group, OpenRouter connection select for Perplexity, Brave key field with "stored" state, not-configured notice); mount it next to `SpeechSettings` in `web/features/accounts/AccountsPage.jsx`
- Modify: `web/features/assistants/assistant-api.js` (get/save web search settings; agent capability availability from a `GET /assistants/capabilities` or by extending an existing assistants payload with `browserAvailable` — choose the existing payload if one is already fetched by the settings page)
- Modify: `web/lib/i18n/en/assistants.js`, `web/lib/i18n/de/assistants.js`, and the reactive messages module
- Test: `tests/browser/assistant-web-tools.spec.js` (Chromium and WebKit; desktop and 390×844 touch)

- [ ] **Step 1: Failing browser spec** using the existing assistant browser fixtures (`tests/helpers/assistant-browser-fixture.js`, `fulfillEnabledAssistantFeature`): toggling Web search/Web fetch/Documents sends them in the PATCH body; the Browser switch is disabled with the "no browser found" explanation when unavailable and enabled otherwise; the web search settings save Brave with a key (field cleared afterwards, "stored" shown) and show "not configured" for Brave without a key; all labels in English with `agentpier-language=en`, and German labels present in the German catalog (catalog parity test).

- [ ] **Step 2–4: Implement, run** `npm run build && AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/assistant-web-tools.spec.js tests/browser/assistant-settings.spec.js` and the same with `webkit`; run the i18n parity unit tests.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: show web, browser and document capabilities in agent settings"
```

---

### Task 8: Live contract on the compiled configuration, docs, cleanup

**Files:**

- Modify: `tests/integration/assistant-native-interfaces-contract.test.js` (replace Task 1's manual patch with a supervisor start whose profiles include one agent with all new capabilities and the default DuckDuckGo provider; assert the compiled config is accepted and the tools behave as recorded)
- Modify: `docs/assistant-web-tools-qualification.md` (final results), `docs/assistant-release-qualification.md` (row), `docs/adr/0002-managed-openclaw-assistants.md` (coupling rows for `tools.web.*`, `browser.*`, web search provider keys), `docs/assistant-gateway.md` (capabilities section: what each switch grants, browser rules, provider setting)
- Delete: this plan and its spec in the final cleanup commit

- [ ] **Step 1: Update and run the contract** with the provisioned runtime; then run the team plugin, runtime and runtime-update contracts.
- [ ] **Step 2: `npm run check`**, report any unrelated local failure separately.
- [ ] **Step 3: Commit docs and contract**

```bash
git commit -am "test: qualify compiled web tools against the live Gateway"
```

- [ ] **Step 4: Cleanup commit**

```bash
git rm docs/superpowers/specs/2026-10-11-agent-capability-profiles-design.md docs/superpowers/plans/2026-10-11-agent-capability-profiles.md
git commit -m "chore: remove completed capability profile working documents"
```
