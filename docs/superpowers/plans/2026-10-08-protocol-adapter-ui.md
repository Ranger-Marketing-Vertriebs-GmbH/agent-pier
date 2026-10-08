# Protocol Adapter UI, Auto Routes, Doctor and Docs (PR 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the protocol adapter: let `auto` fall back to adapter routes, let users choose and understand routes, capabilities, image support and `<think>` extraction in the connection dialog, label adapter and SDK routes wherever a connection or session appears, report adapter sessions in the doctor, document the feature, and retire the spec.

**Architecture:** The server API from PR 2 stays as it is (`routing`, `adapterCapabilities`, `thinkTagExtraction`, model `images`, `toolRoutes`, test result `capabilities`, `provider.route` on sessions, `<id>.adapter.json`). PR 3 flips `ADAPTER_AUTO_ROUTES`, adds a pure web mirror of route resolution (`endpoint-routes.js`, pinned to the server by an exhaustive parity test) so the dialog shows the resolved route before saving, extends the draft model, and adds small components. The doctor gains a read-only module that turns each running adapter session's snapshot into one check. The session reload status gains `routeChange`. Lasting guidance moves from the spec into `docs/protocol-adapter.md` and `docs/providers.md`; the spec is deleted at the end.

**Tech Stack:** React 18 + Vite (JSX, ES modules), Express, `node:test` + `node:assert/strict`, Playwright (Chromium and WebKit), the reactive i18n catalogs in `web/lib/i18n/{de,en}/` and `web/lib/i18n/messages/`.

**Spec:** `docs/superpowers/specs/2026-10-07-protocol-adapter-design.md` (binding, Amendments 1–20; PR 3 = "Delivery" item 3, "UI", "Observability", plus Amendments 18–20 hand-offs). UI decisions: taken by the human on 2026-10-08 and recorded in `.superpowers/sdd/protocol-adapter-ui/progress.md`; each decision point is marked **[Decision n]** below.

## Global Constraints

- Base: `main` after PR 2 (`feat/protocol-adapter-runtime`) is merged. Branch `feat/protocol-adapter-ui` in `.worktrees/protocol-adapter-ui`; never push to `main`.
- Platforms macOS and Linux, Node.js 22.13+; no new npm dependency; no new runtime tool.
- Every source and test file ≤ 600 lines (`npm run check:structure`). `tests/integration/endpoint-connections.test.js` is at 522 lines: new tests go into new files.
- Every UI text in **both** `web/lib/i18n/de/` and `web/lib/i18n/en/` with identical keys and identical function arities; components import only from `web/lib/i18n/messages/`. Run `node --test tests/unit/i18n-catalogs.test.js` after every catalog change.
- Doctor `summary`/`remedy` strings stay English (diagnostic evidence, like every existing doctor check); only the check label (`checkLabel`) is translated.
- Browser specs: `test.use({ locale: "en-GB" })`, English strings in locators, `exact: true`; no `waitForTimeout` or fixed sleeps — wait on state (`expect(...).toBeVisible()`, `toHaveValue`, `expect.poll`). Run each new spec in Chromium and WebKit (`AGENTPIER_TEST_BROWSER=webkit`).
- Route ids: `"messages" | "responses" | "chatCompletions"`; routing values verbatim: `claude: "auto" | "native" | "adapter:responses" | "adapter:chatCompletions" | "off"`, `codex: "auto" | "native" | "adapter:messages" | "adapter:chatCompletions" | "off"`, `opencode: "auto" | "messages" | "responses" | "chatCompletions" | "off"`. `auto`: native if enabled; else Claude Code/Codex take the first enabled of Responses > Messages > Chat; OpenCode the first enabled of Chat > Responses > Messages.
- Capability defaults verbatim (spec table): Messages `promptCache: true`, `thinkingBudget: false`; Responses `promptCacheKey: false`, `reasoningEffort: true`, `parallelToolCalls: false`; Chat `promptCacheKey: false`, `streamUsage: true`, `reasoningEffort: false`, `parallelToolCalls: false`, `reasoningReplay: false`, `systemMessages: "merge" | "inline"`, `maxTokensField: "max_tokens" | "max_completion_tokens"`.
- Diagnostics never show prompt, completion, key or token content; the doctor reads only counters and fixed enums from `<id>.adapter.json`, and ignores a snapshot whose `generation` differs from the session record's `adapterGeneration` (Amendment 19). The doctor never writes files.
- Screenshots: captured only behind an env flag (`CAPTURE_ADAPTER_SCREENSHOTS=1`), English UI, into `docs/screenshots/`. Other specs may overwrite unrelated screenshots (`pipelines-profiles.spec` rewrites `docs/screenshots/pipeline-permissions.png`): `git restore` any screenshot this PR did not intend to change.
- Never mention external projects as sources in code, docs, commits or the PR.
- Commits: English, `feat:` / `fix:` / `test:` / `docs:` / `chore:`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Detected models after a new connection test lose their image flag** — `mergeModels` in `endpoint-draft.js` rebuilds detected models from scratch; once the UI sends `images`, a re-test would silently reset "No" to `null`. Expected: the user's choice survives a test. → test in Task 3.
2. **Toggling protocols in the dialog while a CLI is set to an explicit route that becomes unavailable** (e.g. Claude Code `adapter:responses`, then Responses unchecked). Expected: the select keeps the explicit choice, shows "Not available: protocol not enabled", the resolved line says "Not offered", and saving is allowed (server stores it, `toolRoutes.claude` is `null`). → test in Task 2 (pure) and Task 4 (browser).
3. **Mobile width (390 px) with the extra "Images" column and the routing section** — the existing spec asserts no horizontal overflow of page, dialog and `.endpoint-model-scroll`. Expected: still none. → assertion in Task 6.
4. **A stale snapshot from a previous launch generation or a stopped session** must not produce a doctor card or a false "adapter stopped" failure after a reload. → test in Task 8.
5. **Saving an untouched existing connection** must send back exactly the stored `routing`, `adapterCapabilities`, `thinkTagExtraction` and per-model `images` (no reset to defaults, no added default-valued keys). → test in Task 3.

---

## File Structure

**Create**

| File                                                           | Responsibility                                                                                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `web/features/provider-connections/endpoint-routes.js`         | Pure mirror of server route resolution; route options with unavailability reasons; capability field table; adapter sources in use |
| `web/features/provider-connections/route-label.js`             | `routeLabel(route)` / `protocolShortName(source)` shared by list, launch dialog and session header                                |
| `web/features/provider-connections/EndpointRouting.jsx`        | "CLIs and routes" section of the connection dialog                                                                                |
| `web/features/provider-connections/EndpointAdapterOptions.jsx` | Adapter options per source (capabilities, proposal markers, reset) and the `<think>` checkbox                                     |
| `server/features/operations/adapter-doctor.js`                 | `adapterSessionChecks(dataDir)` and `adapterCheck(session, snapshot)`                                                             |
| `tests/unit/endpoint-routes-parity.test.js`                    | Web mirror ≡ server `resolveRoute`/`CAPABILITY_DEFAULTS` over all inputs                                                          |
| `tests/unit/endpoint-draft-adapter.test.js`                    | Draft model: routing, capabilities, images, proposal, payload                                                                     |
| `tests/unit/adapter-doctor.test.js`                            | Doctor checks from snapshots                                                                                                      |
| `tests/unit/session-reload-route.test.js`                      | `routeChange` in the reload status                                                                                                |
| `tests/integration/endpoint-doctor-routes.test.js`             | Doctor connection summary with routes and the Azure note                                                                          |
| `tests/browser/endpoint-routing.spec.js`                       | Routing section, proposals, images, `<think>` in English                                                                          |
| `tests/browser/endpoint-route-labels.spec.js`                  | Labels in list, launch dialog, session header; reload warning                                                                     |
| `tests/browser/operations-adapter-diagnostics.spec.js`         | Doctor adapter cards                                                                                                              |
| `docs/protocol-adapter.md`                                     | Lasting architecture and operating guide (moved from the spec)                                                                    |

**Modify**

| File                                                                                                                                                                                                                                                                                                                               | Change                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `server/features/providers/endpoint-routing.js`                                                                                                                                                                                                                                                                                    | `ADAPTER_AUTO_ROUTES = true`                                                             |
| `tests/unit/endpoint-routing.test.js`, `tests/unit/endpoint-config.test.js`, `tests/integration/endpoint-pipeline-snapshot.test.js`, `tests/matrix/endpoint-adapter-launch.test.js`, `tests/integration/endpoint-connections.test.js`, `tests/blackbox/endpoint-adapter-session.test.js`, `tests/matrix/adapter-cli-smoke.test.js` | Pin the new `auto` behavior; drop "PR 2" wording                                         |
| `web/features/provider-connections/endpoint-draft.js`                                                                                                                                                                                                                                                                              | Adapter fields in draft, proposal and payload; `images` kept on merge                    |
| `web/features/provider-connections/ConnectionDialog.jsx`                                                                                                                                                                                                                                                                           | Mount the two new sections                                                               |
| `web/features/provider-connections/EndpointModelTable.jsx`                                                                                                                                                                                                                                                                         | "Images" tri-state column                                                                |
| `web/features/provider-connections/ProviderConnections.jsx`                                                                                                                                                                                                                                                                        | Route label per compatible CLI                                                           |
| `web/features/provider-connections/connections.css`                                                                                                                                                                                                                                                                                | Styles for routing rows, proposal marker, route badge                                    |
| `web/features/sessions/LaunchAccessFields.jsx`                                                                                                                                                                                                                                                                                     | Route label in the connection option                                                     |
| `web/features/sessions/SessionWorkspace.jsx`                                                                                                                                                                                                                                                                                       | Route badge in the session title                                                         |
| `web/features/sessions/SessionReloadDialog.jsx`                                                                                                                                                                                                                                                                                    | Route-change warning                                                                     |
| `web/features/operations/diagnostic-labels.js`                                                                                                                                                                                                                                                                                     | Label for `adapter-session.*`                                                            |
| `server/features/sessions/session-reload.js`                                                                                                                                                                                                                                                                                       | `routeChange` in `inspect()`                                                             |
| `server/features/sessions/provider-configuration.js`, `server/features/sessions/session-replacement.js`                                                                                                                                                                                                                            | A reload records the route it actually launched (`reloadedProvider`)                     |
| `tests/unit/endpoint-draft.test.js`                                                                                                                                                                                                                                                                                                | Payload key list gains the adapter fields                                                |
| `docs/session-reload.md`                                                                                                                                                                                                                                                                                                           | Route-change warning                                                                     |
| `server/features/operations/doctor.js`                                                                                                                                                                                                                                                                                             | Adapter session checks; routes and Azure note in the endpoint summary                    |
| `web/lib/i18n/{de,en}/connections.js`, `sessions.js`, `operations.js`                                                                                                                                                                                                                                                              | New keys                                                                                 |
| `tests/browser/providers-fixture.js`                                                                                                                                                                                                                                                                                               | Compute `toolRoutes`/`tools` with the web mirror                                         |
| `docs/providers.md`, `docs/research/provider-compatibility.md`, `docs/sandbox.md`, `docs/architecture.md`, `docs/research/protocol-adapter-facts.md`                                                                                                                                                                               | Adapter documentation; links to `docs/protocol-adapter.md`                               |
| `server/features/adapter-runtime/adapter-request.js`, `server/features/protocol-adapter/translate.js`, `server/features/protocol-adapter/capabilities.js`                                                                                                                                                                          | Replace "spec Amendment n" comments with `docs/protocol-adapter.md` references (Task 12) |

**Delete (Task 12):** `docs/superpowers/specs/2026-10-07-protocol-adapter-design.md`, and this plan if it was committed.

---

### Task 1: Let `auto` fall back to adapter routes

**[Decision 1]** decided: flip for all connections, existing ones included — existing single-protocol connections offer adapter routes under `auto`, clearly labeled (Task 7). No migration.

**Files:**

- Modify: `server/features/providers/endpoint-routing.js:23-28`
- Test: `tests/unit/endpoint-routing.test.js`, `tests/unit/endpoint-config.test.js:123-143`, `tests/integration/endpoint-pipeline-snapshot.test.js:193-198`, `tests/matrix/endpoint-adapter-launch.test.js:13-16,215-222`, `tests/integration/endpoint-connections.test.js:459-499`, comments in `tests/blackbox/endpoint-adapter-session.test.js:17` and `tests/matrix/adapter-cli-smoke.test.js:79`

**Interfaces:**

- Produces: `ADAPTER_AUTO_ROUTES === true`; `resolveRoute(endpoint, tool, { adapterAuto })` keeps the option as a test seam (default `ADAPTER_AUTO_ROUTES`). `toolRoutes`/`endpointTools` now include adapter routes under `auto`.

- [ ] **Step 1: Rewrite the tests that pin the PR 2 default**

In `tests/unit/endpoint-routing.test.js` replace the first test and rename the third:

```js
test("auto prefers native routes and falls back to the adapter", () => {
  assert.equal(ADAPTER_AUTO_ROUTES, true);
  const all = endpoint({ messages: true, responses: true, chatCompletions: true });
  assert.deepEqual(resolveRoute(all, "claude"), { mode: "native", source: "messages" });
  assert.deepEqual(resolveRoute(all, "codex"), { mode: "native", source: "responses" });
  const chat = endpoint({ chatCompletions: true });
  assert.deepEqual(resolveRoute(chat, "claude"), {
    mode: "adapter",
    source: "chatCompletions",
  });
  assert.deepEqual(resolveRoute(chat, "codex"), {
    mode: "adapter",
    source: "chatCompletions",
  });
  assert.deepEqual(resolveRoute(chat, "opencode"), {
    mode: "native",
    source: "chatCompletions",
  });
});

test("the adapterAuto seam still turns the fallback off", () => {
  const chat = endpoint({ chatCompletions: true });
  assert.equal(resolveRoute(chat, "claude", { adapterAuto: false }), null);
  assert.equal(resolveRoute(chat, "codex", { adapterAuto: false }), null);
});
```

Rename `"explicit adapter routes work while auto adapter routes are off"` to `"explicit adapter routes resolve to their source"` and `"flipping the flag (PR 3) makes auto fall back to Responses > Messages > Chat"` to `"auto falls back in the order Responses > Messages > Chat"`, dropping its `on` option (call `resolveRoute(x, tool)`). In `"records without routing behave as auto"` change `assert.equal(resolveRoute(legacy, "claude"), null);` to `assert.deepEqual(resolveRoute(legacy, "claude"), { mode: "adapter", source: "responses" });` and delete the `{ adapterAuto: true }` assertion below it.

In `tests/unit/endpoint-config.test.js` ("endpointTools follows the resolved routes"):

```js
assert.deepEqual(
  endpointTools(chatOnly),
  ["codex", "claude", "opencode"],
  "auto offers Codex and Claude Code through the adapter",
);
const explicit = validateEndpoint({
  ...base,
  protocols,
  routing: { claude: "adapter:chatCompletions", codex: "off" },
});
assert.deepEqual(endpointTools(explicit), ["claude", "opencode"]);
const off = validateEndpoint({
  ...base,
  protocols,
  routing: { claude: "adapter:chatCompletions", codex: "off", opencode: "off" },
});
assert.deepEqual(endpointTools(off), ["claude"]);
```

In `tests/integration/endpoint-pipeline-snapshot.test.js` replace the last test:

```js
test("auto moving a pipeline's CLI onto an adapter route invalidates its snapshot", (t) => {
  const { launch, edit } = setup(t, "codex");
  launch();
  edit({ protocols: { messages: false, responses: false, chatCompletions: true } });
  // codex now resolves to adapter:chatCompletions; the frozen route was native:responses.
  assert.throws(() => launch(), changed);
});
```

In `tests/matrix/endpoint-adapter-launch.test.js` replace the comment at lines 13–14 with `// \`via(tool, source)\` enables exactly that source and routes the tool to it explicitly.` and the test at line 215:

```js
test("auto on a Chat-only endpoint launches Claude Code and Codex through the adapter", (t) => {
  const claude = launch(t, "claude", endpoint({ chatCompletions: true })).result;
  assert.equal(claude.adapter.clientProtocol, "messages");
  assert.equal(claude.adapter.upstreamProtocol, "chat");
  const codex = launch(t, "codex", endpoint({ chatCompletions: true })).result;
  assert.equal(codex.adapter.clientProtocol, "responses");
  assert.equal(codex.adapter.upstreamProtocol, "chat");
});
```

In `tests/integration/endpoint-connections.test.js` ("stored PR #176 records …") replace the `toolRoutes`/`tools` assertions:

```js
assert.deepEqual(loaded.toolRoutes, {
  claude: { mode: "adapter", source: "chatCompletions" },
  codex: { mode: "adapter", source: "chatCompletions" },
  opencode: { mode: "native", source: "chatCompletions" },
});
assert.deepEqual(loaded.tools, ["codex", "claude", "opencode"]);
```

Update the two comments (`endpoint-adapter-session.test.js:17`, `adapter-cli-smoke.test.js:79`) to say the explicit route keeps the test independent of `auto`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/endpoint-routing.test.js tests/unit/endpoint-config.test.js tests/integration/endpoint-pipeline-snapshot.test.js tests/integration/endpoint-connections.test.js tests/matrix/endpoint-adapter-launch.test.js`
Expected: FAIL — `ADAPTER_AUTO_ROUTES` is `false`; Chat-only `auto` resolves `null`.

- [ ] **Step 3: Flip the flag**

```js
/**
 * Whether `auto` may fall back to an adapter route. On since the UI labels adapter routes
 * ("via adapter") in the connection list, launch dialog and session header. The
 * `adapterAuto` option of `resolveRoute` stays as a test seam.
 */
export const ADAPTER_AUTO_ROUTES = true;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command. Expected: PASS. If the pipeline test fails with status 400 instead of 409, the access check (`connectionToolUnsupported`) runs before the snapshot comparison — that would mean Codex is not offered; check that `endpointTools` now lists Codex, do not weaken the assertion.

- [ ] **Step 5: Run the whole backend suite**

Run: `npm test`
Expected: PASS (except the known environment-dependent `shell.test.js`). Any other failure is a test that silently relied on `auto` → native only; fix it the same way (explicit expectation of the adapter route).

- [ ] **Step 6: Commit**

```bash
git add server/features/providers/endpoint-routing.js tests/
git commit -m "feat: let auto fall back to protocol adapter routes"
```

---

### Task 2: Web mirror of route resolution and capability fields

**Files:**

- Create: `web/features/provider-connections/endpoint-routes.js`
- Test: `tests/unit/endpoint-routes-parity.test.js`

**Interfaces:**

- Consumes: server `resolveRoute`, `ROUTE_CHOICES`, `libraryProtocol` (`server/features/providers/endpoint-routing.js`), `CAPABILITY_DEFAULTS` (`server/features/protocol-adapter/capabilities.js`) — tests only.
- Produces:
  - `ROUTE_TOOLS: ["claude", "codex", "opencode"]`, `ROUTE_CHOICES` (same values as server), `DEFAULT_ROUTING`
  - `resolveDraftRoute(endpoint, tool) → { mode: "native" | "adapter" | "sdk", source } | null`
  - `routeOptions(endpoint, tool) → { choice, source: string | null, available: boolean, reason: "protocolOff" | "anthropicUrlMissing" | null }[]`
  - `adapterSources(endpoint) → string[]` (sources used by resolved `adapter` routes, route-id order)
  - `CAPABILITY_FIELDS: { [source]: { name, default, choices?: string[] }[] }`

- [ ] **Step 1: Write the failing parity test**

```js
// tests/unit/endpoint-routes-parity.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveRoute,
  ROUTE_CHOICES as SERVER_CHOICES,
  libraryProtocol,
} from "../../server/features/providers/endpoint-routing.js";
import { CAPABILITY_DEFAULTS } from "../../server/features/protocol-adapter/capabilities.js";
import {
  ROUTE_CHOICES,
  ROUTE_TOOLS,
  CAPABILITY_FIELDS,
  adapterSources,
  resolveDraftRoute,
  routeOptions,
} from "../../web/features/provider-connections/endpoint-routes.js";

const SOURCES = ["messages", "responses", "chatCompletions"];
function* endpoints() {
  for (let mask = 0; mask < 8; mask++)
    for (const anthropicBaseUrl of ["https://llm.example", ""])
      for (const claude of ROUTE_CHOICES.claude)
        for (const codex of ROUTE_CHOICES.codex)
          for (const opencode of ROUTE_CHOICES.opencode)
            yield {
              openaiBaseUrl: "https://llm.example/v1",
              anthropicBaseUrl,
              protocols: Object.fromEntries(
                SOURCES.map((s, i) => [s, !!(mask & (1 << i))]),
              ),
              routing: { claude, codex, opencode },
            };
}

test("route choices equal the server's", () => {
  assert.deepEqual(ROUTE_CHOICES, SERVER_CHOICES);
});

test("the draft route equals the server route for every protocol set and choice", () => {
  for (const endpoint of endpoints())
    for (const tool of ROUTE_TOOLS)
      assert.deepEqual(
        resolveDraftRoute(endpoint, tool),
        resolveRoute(
          { ...endpoint, anthropicBaseUrl: endpoint.anthropicBaseUrl || null },
          tool,
        ),
        JSON.stringify({ tool, endpoint }),
      );
});

test("capability fields mirror the library defaults and choices", () => {
  for (const source of SOURCES) {
    const fields = CAPABILITY_FIELDS[source];
    assert.deepEqual(
      Object.fromEntries(fields.map((f) => [f.name, f.default])),
      { ...CAPABILITY_DEFAULTS[libraryProtocol(source)] },
      source,
    );
  }
  const chat = Object.fromEntries(
    CAPABILITY_FIELDS.chatCompletions.map((f) => [f.name, f]),
  );
  assert.deepEqual(chat.systemMessages.choices, ["merge", "inline"]);
  assert.deepEqual(chat.maxTokensField.choices, ["max_tokens", "max_completion_tokens"]);
});

test("route options explain why a choice is unavailable (Review Focus 2)", () => {
  const chatOnly = {
    openaiBaseUrl: "https://llm.example/v1",
    anthropicBaseUrl: "",
    protocols: { messages: true, responses: false, chatCompletions: true },
    routing: { claude: "adapter:responses", codex: "auto", opencode: "auto" },
  };
  const options = Object.fromEntries(
    routeOptions(chatOnly, "claude").map((o) => [o.choice, o]),
  );
  assert.deepEqual(options.native, {
    choice: "native",
    source: "messages",
    available: false,
    reason: "anthropicUrlMissing",
  });
  assert.equal(options["adapter:responses"].reason, "protocolOff");
  assert.equal(options["adapter:chatCompletions"].available, true);
  assert.equal(options.auto.available, true);
  assert.equal(options.off.available, true);
  assert.equal(resolveDraftRoute(chatOnly, "claude"), null);
  assert.deepEqual(adapterSources(chatOnly), ["chatCompletions"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/endpoint-routes-parity.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the mirror**

```js
// web/features/provider-connections/endpoint-routes.js
// Mirrors server/features/providers/endpoint-routing.js (pinned by
// tests/unit/endpoint-routes-parity.test.js) so the dialog shows routes before saving.
export const ROUTE_TOOLS = ["claude", "codex", "opencode"];
export const NATIVE_SOURCE = { claude: "messages", codex: "responses" };
export const ROUTE_CHOICES = {
  claude: ["auto", "native", "adapter:responses", "adapter:chatCompletions", "off"],
  codex: ["auto", "native", "adapter:messages", "adapter:chatCompletions", "off"],
  opencode: ["auto", "messages", "responses", "chatCompletions", "off"],
};
export const DEFAULT_ROUTING = { claude: "auto", codex: "auto", opencode: "auto" };
const ADAPTER_ORDER = ["responses", "messages", "chatCompletions"];
const OPENCODE_ORDER = ["chatCompletions", "responses", "messages"];
const filled = (value) => typeof value === "string" && value.trim() !== "";

function unavailable(endpoint, source) {
  if (source === "messages" && !filled(endpoint.anthropicBaseUrl))
    return "anthropicUrlMissing";
  if (source !== "messages" && !filled(endpoint.openaiBaseUrl)) return "protocolOff";
  return endpoint.protocols?.[source] === true ? null : "protocolOff";
}
const enabled = (endpoint, source) => unavailable(endpoint, source) === null;

/** The source a choice names, or null for "auto" and "off". */
export function choiceSource(tool, choice) {
  if (choice === "auto" || choice === "off") return null;
  if (tool === "opencode") return choice;
  return choice === "native" ? NATIVE_SOURCE[tool] : choice.slice("adapter:".length);
}

export function resolveDraftRoute(endpoint, tool) {
  const choice = endpoint?.routing?.[tool] ?? "auto";
  if (choice === "off" || !ROUTE_CHOICES[tool]) return null;
  if (tool === "opencode") {
    const source =
      choice === "auto" ? OPENCODE_ORDER.find((s) => enabled(endpoint, s)) : choice;
    if (!source || !enabled(endpoint, source)) return null;
    return { mode: source === "chatCompletions" ? "native" : "sdk", source };
  }
  const native = NATIVE_SOURCE[tool];
  if (choice === "native" || choice === "auto") {
    if (enabled(endpoint, native)) return { mode: "native", source: native };
    if (choice === "native") return null;
    const source = ADAPTER_ORDER.find((s) => s !== native && enabled(endpoint, s));
    return source ? { mode: "adapter", source } : null;
  }
  const source = choiceSource(tool, choice);
  return enabled(endpoint, source) ? { mode: "adapter", source } : null;
}

export const routeOptions = (endpoint, tool) =>
  ROUTE_CHOICES[tool].map((choice) => {
    const source = choiceSource(tool, choice);
    const reason = source ? unavailable(endpoint, source) : null;
    return { choice, source, available: reason === null, reason };
  });

export const adapterSources = (endpoint) => {
  const used = new Set(
    ["claude", "codex"]
      .map((tool) => resolveDraftRoute(endpoint, tool))
      .filter((route) => route?.mode === "adapter")
      .map((route) => route.source),
  );
  return ["messages", "responses", "chatCompletions"].filter((s) => used.has(s));
};

const flag = (name, value) => ({ name, default: value });
export const CAPABILITY_FIELDS = {
  messages: [flag("promptCache", true), flag("thinkingBudget", false)],
  responses: [
    flag("promptCacheKey", false),
    flag("reasoningEffort", true),
    flag("parallelToolCalls", false),
  ],
  chatCompletions: [
    flag("promptCacheKey", false),
    flag("streamUsage", true),
    flag("reasoningEffort", false),
    flag("parallelToolCalls", false),
    flag("reasoningReplay", false),
    { name: "systemMessages", default: "merge", choices: ["merge", "inline"] },
    {
      name: "maxTokensField",
      default: "max_tokens",
      choices: ["max_tokens", "max_completion_tokens"],
    },
  ],
};
```

Note: the server's `enabled()` checks `!!endpoint.openaiBaseUrl` for non-Messages sources; `validateEndpoint` makes `openaiBaseUrl` mandatory, so the parity test always fills it. The `"protocolOff"` reason for an empty OpenAI URL is UI-only (the dialog's URL field is `required`).

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/unit/endpoint-routes-parity.test.js`
Expected: PASS (the generator covers 8 × 2 × 125 endpoints × 3 tools).

- [ ] **Step 5: Commit**

```bash
git add web/features/provider-connections/endpoint-routes.js tests/unit/endpoint-routes-parity.test.js
git commit -m "feat: mirror endpoint route resolution in the web client"
```

---

### Task 3: Adapter fields in the endpoint draft

**Files:**

- Modify: `web/features/provider-connections/endpoint-draft.js`
- Test: `tests/unit/endpoint-draft-adapter.test.js`

**Interfaces:**

- Consumes: `DEFAULT_ROUTING`, `CAPABILITY_FIELDS` from Task 2.
- Produces (all pure, return a new draft):
  - draft gains `routing`, `adapterCapabilities` (`{ [source]: { [name]: value } }`), `thinkTagExtraction: boolean`, `capabilityProposal` (`{ [source]: { [name]: value } }`, UI-only, never sent), models gain `images: boolean | null`
  - `setRoute(draft, tool, choice)`, `setCapability(draft, source, name, value)`, `resetCapabilities(draft, source)`, `setModelImages(draft, modelId, images)`
  - `applyProposal(draft, proposal)` additionally merges `proposal.capabilities` into `adapterCapabilities` and stores it as `capabilityProposal`
  - `endpointPayload(draft)` adds `routing`, `adapterCapabilities`, `thinkTagExtraction`, model `images`

**[Decision 2]** decided: test proposals are applied to the draft automatically, marked ("suggested by the test") and stay editable. No "Apply suggestions" button.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/endpoint-draft-adapter.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyProposal,
  endpointPayload,
  initialEndpoint,
  resetCapabilities,
  setCapability,
  setModelImages,
  setRoute,
  withoutTest,
} from "../../web/features/provider-connections/endpoint-draft.js";

const model = (modelId, extra = {}) => ({
  modelId,
  label: modelId,
  contextTokens: 32768,
  outputTokens: null,
  source: "detected",
  contextEdited: false,
  ...extra,
});
const stored = {
  id: "c1",
  endpoint: {
    preset: "custom",
    openaiBaseUrl: "https://llm.example/v1",
    anthropicBaseUrl: null,
    protocols: { messages: false, responses: false, chatCompletions: true },
    authHeader: null,
    models: [model("qwen3", { images: false }), model("gemma", { images: null })],
    lastTest: null,
    routing: { claude: "adapter:chatCompletions", codex: "off", opencode: "auto" },
    adapterCapabilities: { chatCompletions: { reasoningEffort: true } },
    thinkTagExtraction: true,
  },
};

test("an untouched stored connection round-trips its adapter fields (Review Focus 5)", () => {
  const payload = endpointPayload(initialEndpoint(stored));
  assert.deepEqual(payload.routing, stored.endpoint.routing);
  assert.deepEqual(payload.adapterCapabilities, stored.endpoint.adapterCapabilities);
  assert.equal(payload.thinkTagExtraction, true);
  assert.deepEqual(
    payload.models.map((m) => m.images),
    [false, null],
  );
  assert.equal("capabilityProposal" in payload, false);
});

test("new drafts start with auto routing, no capabilities and no think extraction", () => {
  const draft = initialEndpoint(null);
  assert.deepEqual(draft.routing, { claude: "auto", codex: "auto", opencode: "auto" });
  assert.deepEqual(draft.adapterCapabilities, {});
  assert.equal(draft.thinkTagExtraction, false);
  assert.deepEqual(draft.capabilityProposal, {});
});

test("records without adapter fields load as auto with defaults", () => {
  const { routing, adapterCapabilities, thinkTagExtraction, ...legacy } = stored.endpoint;
  const draft = initialEndpoint({ id: "c2", endpoint: legacy });
  assert.deepEqual(draft.routing, { claude: "auto", codex: "auto", opencode: "auto" });
  assert.deepEqual(draft.adapterCapabilities, {});
  assert.equal(draft.thinkTagExtraction, false);
});

test("a re-test keeps the image choice of detected models (Review Focus 1)", () => {
  const draft = initialEndpoint(stored);
  const next = applyProposal(draft, {
    listed: true,
    protocols: {
      messages: "unsupported",
      responses: "unsupported",
      chatCompletions: "ok",
    },
    reasons: {},
    models: [model("qwen3"), model("gemma"), model("new")],
    capabilities: {},
  });
  assert.deepEqual(
    next.models.map((m) => [m.modelId, m.images]),
    [
      ["qwen3", false],
      ["gemma", null],
      ["new", null],
    ],
  );
});

test("capability proposals are applied, marked, and cleared with the test", () => {
  const draft = initialEndpoint(stored);
  const next = applyProposal(draft, {
    listed: false,
    protocols: {
      messages: "unsupported",
      responses: "unsupported",
      chatCompletions: "ok",
    },
    reasons: {},
    models: [],
    capabilities: { chatCompletions: { reasoningEffort: false, streamUsage: true } },
  });
  assert.deepEqual(next.adapterCapabilities.chatCompletions, {
    reasoningEffort: false,
    streamUsage: true,
  });
  assert.deepEqual(next.capabilityProposal, {
    chatCompletions: { reasoningEffort: false, streamUsage: true },
  });
  const edited = setCapability(next, "chatCompletions", "reasoningEffort", true);
  assert.equal(edited.adapterCapabilities.chatCompletions.reasoningEffort, true);
  assert.deepEqual(withoutTest(edited).capabilityProposal, {});
  assert.equal(
    withoutTest(edited).adapterCapabilities.chatCompletions.reasoningEffort,
    true,
  );
  assert.equal(
    "chatCompletions" in resetCapabilities(edited, "chatCompletions").adapterCapabilities,
    false,
  );
});

test("route and image setters change only their field", () => {
  const draft = initialEndpoint(stored);
  assert.equal(setRoute(draft, "codex", "auto").routing.codex, "auto");
  assert.equal(
    setRoute(draft, "codex", "auto").routing.claude,
    "adapter:chatCompletions",
  );
  const images = setModelImages(draft, "gemma", true);
  assert.equal(images.models[1].images, true);
  assert.equal(
    images.models[1].contextEdited,
    false,
    "images do not mark the context edited",
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/endpoint-draft-adapter.test.js`
Expected: FAIL — `setRoute` is not exported; payload lacks `routing`.

- [ ] **Step 3: Implement**

In `endpoint-draft.js`:

```js
import { DEFAULT_ROUTING } from "./endpoint-routes.js";

const adapterFields = (endpoint) => ({
  routing: { ...DEFAULT_ROUTING, ...(endpoint?.routing || {}) },
  adapterCapabilities: structuredClone(endpoint?.adapterCapabilities || {}),
  thinkTagExtraction: endpoint?.thinkTagExtraction === true,
  capabilityProposal: {},
});
```

- `initialEndpoint`: for a stored connection spread `...adapterFields(connection.endpoint)` after the cloned endpoint and map models to `{ ...model, images: model.images ?? null }`; for a new draft spread `...adapterFields(null)`.
- `withoutTest`: add `capabilityProposal: {}`.
- `mergeModels`: in the `detected` mapping add `images: old?.images ?? null,`.
- `applyProposal`: after `lastTest`, add

```js
    adapterCapabilities: mergeCapabilities(draft.adapterCapabilities, proposal.capabilities),
    capabilityProposal: structuredClone(proposal.capabilities || {}),
```

with

```js
const mergeCapabilities = (current = {}, proposed = {}) =>
  Object.fromEntries(
    [...new Set([...Object.keys(current), ...Object.keys(proposed)])].map((source) => [
      source,
      { ...(current[source] || {}), ...(proposed[source] || {}) },
    ]),
  );
```

- New setters:

```js
export const setRoute = (draft, tool, choice) => ({
  ...draft,
  routing: { ...draft.routing, [tool]: choice },
});
export const setCapability = (draft, source, name, value) => ({
  ...draft,
  adapterCapabilities: {
    ...draft.adapterCapabilities,
    [source]: { ...(draft.adapterCapabilities[source] || {}), [name]: value },
  },
});
export const resetCapabilities = (draft, source) => {
  const { [source]: _removed, ...rest } = draft.adapterCapabilities;
  const { [source]: _proposed, ...proposal } = draft.capabilityProposal || {};
  return { ...draft, adapterCapabilities: rest, capabilityProposal: proposal };
};
export const setModelImages = (draft, modelId, images) => ({
  ...draft,
  models: draft.models.map((m) => (m.modelId === modelId ? { ...m, images } : m)),
});
```

- `modelPayload`: add `images: model.images ?? null,`.
- `endpointPayload`: add `routing: draft.routing, adapterCapabilities: draft.adapterCapabilities, thinkTagExtraction: draft.thinkTagExtraction,`.

Check the file stays ≤ 600 lines (it grows from 192 to about 250).

In `tests/unit/endpoint-draft.test.js` ("payload carries only server-known fields") the exact key lists now include the adapter fields; replace the two expected arrays (do not loosen the assertion):

```js
assert.deepEqual(Object.keys(payload).sort(), [
  "adapterCapabilities",
  "anthropicBaseUrl",
  "authHeader",
  "lastTest",
  "models",
  "openaiBaseUrl",
  "preset",
  "protocols",
  "routing",
  "thinkTagExtraction",
]);
assert.deepEqual(Object.keys(payload.models[0]).sort(), [
  "contextEdited",
  "contextHint",
  "contextTokens",
  "images",
  "label",
  "modelId",
  "outputTokens",
  "source",
]);
```

`capabilityProposal` must not appear in the first list (it is UI-only).

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test tests/unit/endpoint-draft-adapter.test.js tests/unit/endpoint-draft.test.js tests/unit/endpoint-draft-rules.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/features/provider-connections/endpoint-draft.js tests/unit/endpoint-draft-adapter.test.js tests/unit/endpoint-draft.test.js
git commit -m "feat: carry routing, adapter capabilities and image support in the endpoint draft"
```

---

### Task 4: "CLIs and routes" section in the connection dialog

**Files:**

- Create: `web/features/provider-connections/EndpointRouting.jsx`, `web/features/provider-connections/route-label.js`
- Modify: `web/features/provider-connections/ConnectionDialog.jsx:206-211`, `web/features/provider-connections/connections.css`, `web/lib/i18n/de/connections.js`, `web/lib/i18n/en/connections.js`, `tests/browser/providers-fixture.js:147-163`
- Test: `tests/browser/endpoint-routing.spec.js`

**Interfaces:**

- Consumes: `routeOptions`, `resolveDraftRoute`, `ROUTE_TOOLS` (Task 2); `setRoute` (Task 3).
- Produces:
  - `<EndpointRouting draft setDraft />`
  - `protocolShortName(source) → string` and `routeLabel(route) → string` in `route-label.js` (used by Task 7):
    `native` → `copy.routes.native` ("native"); `adapter` → `copy.routes.adapter(short)` ("via adapter · Chat Completions"); `sdk` → short protocol name; `null` → `copy.routes.notOffered`.
  - i18n `connectionCopy.endpoint.routing` and `connectionCopy.routes` (below).

- [ ] **Step 1: Add the catalog keys (both languages)**

English (`web/lib/i18n/en/connections.js`), top level of `connectionCopy`:

```js
  routes: {
    native: "native",
    adapter: (protocol) => `via adapter · ${protocol}`,
    notOffered: "not offered",
    shortNames: {
      messages: "Messages",
      responses: "Responses",
      chatCompletions: "Chat Completions",
    },
  },
```

inside `endpoint`:

```js
    routing: {
      title: "CLIs and routes",
      help: "Automatic uses the CLI's native protocol and otherwise the protocol adapter (Responses before Messages before Chat Completions).",
      select: (cli) => `Route for ${cli}`,
      choices: {
        auto: "Automatic",
        native: (protocol) => `Native (${protocol})`,
        adapter: (protocol) => `Via adapter (${protocol})`,
        sdk: (protocol) => protocol,
        off: "Off",
      },
      resolved: (route) => `Uses: ${route}`,
      unavailable: (reason) => `Not available: ${reason}`,
      reasons: {
        protocolOff: "protocol not enabled",
        anthropicUrlMissing: "Anthropic-compatible base URL missing",
      },
    },
```

German (`web/lib/i18n/de/connections.js`), same keys and arities:

```js
  routes: {
    native: "nativ",
    adapter: (protocol) => `über Adapter · ${protocol}`,
    notOffered: "nicht angeboten",
    shortNames: {
      messages: "Messages",
      responses: "Responses",
      chatCompletions: "Chat Completions",
    },
  },
```

```js
    routing: {
      title: "CLIs und Routen",
      help: "Automatisch nutzt das native Protokoll der CLI, sonst den Protokoll-Adapter (Responses vor Messages vor Chat Completions).",
      select: (cli) => `Route für ${cli}`,
      choices: {
        auto: "Automatisch",
        native: (protocol) => `Nativ (${protocol})`,
        adapter: (protocol) => `Über Adapter (${protocol})`,
        sdk: (protocol) => protocol,
        off: "Aus",
      },
      resolved: (route) => `Verwendet: ${route}`,
      unavailable: (reason) => `Nicht verfügbar: ${reason}`,
      reasons: {
        protocolOff: "Protokoll nicht aktiviert",
        anthropicUrlMissing: "Anthropic-kompatible Basis-URL fehlt",
      },
    },
```

The existing URL help texts name only the native users and become wrong once `auto` uses the adapter; replace them in both catalogs (keys unchanged):

- en `endpoint.openaiHelp`: `"Usually ends with /v1. Used for the Responses and Chat Completions protocols."`; `endpoint.anthropicHelp`: `"Used for the Anthropic Messages protocol. Leave empty if the server has no Anthropic Messages API."`
- de `endpoint.openaiHelp`: `"Endet meist auf /v1. Wird für die Protokolle Responses und Chat Completions verwendet."`; `endpoint.anthropicHelp`: `"Wird für das Protokoll Anthropic Messages verwendet. Leer lassen, wenn der Server keine Anthropic-Messages-API hat."`

Run: `node --test tests/unit/i18n-catalogs.test.js` → PASS.

- [ ] **Step 2: Update the browser fixture to compute routes like the server**

In `tests/browser/providers-fixture.js` add the import

```js
import {
  resolveDraftRoute,
  ROUTE_TOOLS,
} from "../../web/features/provider-connections/endpoint-routes.js";
```

and, in the POST/PATCH branch, compute the routes right after `const existing = …;`:

```js
const endpointBlock = body.endpoint || existing.endpoint;
// Same rule as the server's toolRoutes/endpointTools (pinned by the parity test).
const toolRoutes = endpointBlock
  ? Object.fromEntries(
      ROUTE_TOOLS.map((tool) => [tool, resolveDraftRoute(endpointBlock, tool)]),
    )
  : null;
```

Replace the whole `tools:` property of `connection` (the protocol-based endpoint branch and the catalog branch) with

```js
        tools: toolRoutes
          ? ["codex", "claude", "opencode"].filter((tool) => toolRoutes[tool])
          : body.providerId === "openrouter" ||
              existing.providerId === "openrouter" ||
              (body.responsesAccess ?? existing.responsesAccess)
            ? ["codex", "claude", "opencode"]
            : ["claude", "opencode"],
        ...(toolRoutes ? { toolRoutes } : {}),
```

Seeded `state.providerConnections` entries in existing specs keep their literal `tools` (and get no `toolRoutes` until they are saved through the fixture).

Run: `AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/endpoint-connections.spec.js tests/browser/endpoint-model-editing.spec.js tests/browser/endpoint-picker-hints.spec.js`
Expected: PASS except the first test of `endpoint-connections.spec.js`, which now sees Codex offered for the Ollama connection (Responses unsupported, Messages ok → Codex via the adapter from Messages). Change its assertion `await expect(access.locator('option[value="provider:connection-one"]')).toHaveCount(0);` to `toHaveCount(1)` and add `await expect(access.locator('option[value="provider:connection-one"]')).toContainText("via adapter · Messages");` in Task 7 Step 8, once labels exist; make only the count change now.

- [ ] **Step 3: Write the failing browser test**

```js
// tests/browser/endpoint-routing.spec.js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

async function openNewEndpoint(page) {
  const controls = await fixture(page);
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("button", { name: "Add provider connection", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Connection name", { exact: true }).fill("GPU box");
  await dialog.getByLabel("API provider", { exact: true }).selectOption("endpoint");
  await dialog.getByLabel("Server type", { exact: true }).selectOption("llamacpp");
  return { controls, dialog };
}

test("routes resolve live and explain unavailable choices", async ({ page }) => {
  const { controls, dialog } = await openNewEndpoint(page);
  const routing = dialog.getByRole("group", { name: "CLIs and routes", exact: true });
  const uses = (text) => routing.getByText(`Uses: ${text}`, { exact: true });
  // llama.cpp preset: only Chat Completions is enabled.
  await expect(uses("via adapter · Chat Completions")).toHaveCount(2);
  await expect(uses("native")).toHaveCount(1);
  const claude = routing.getByLabel("Route for Claude Code", { exact: true });
  await expect(claude.locator('option[value="native"]')).toBeDisabled();
  await expect(claude.locator('option[value="adapter:responses"]')).toBeDisabled();
  const responses = dialog.getByRole("checkbox", { name: /OpenAI Responses/ });
  await responses.check();
  await claude.selectOption("adapter:responses");
  await expect(uses("via adapter · Responses")).toBeVisible();
  // Review Focus 2: the explicit choice survives when its protocol is switched off again.
  await responses.uncheck();
  await expect(claude).toHaveValue("adapter:responses");
  await expect(
    routing.getByText("Not available: protocol not enabled", { exact: true }),
  ).toBeVisible();
  await expect(uses("not offered")).toBeVisible();
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const created = controls.calls
    .filter((call) => call.path === "/api/provider-connections" && call.method === "POST")
    .at(-1).body;
  expect(created.endpoint.protocols.responses).toBe(false);
  expect(created.endpoint.routing).toEqual({
    claude: "adapter:responses",
    codex: "auto",
    opencode: "auto",
  });
});
```

The label "Server type" and the protocol checkbox names ("OpenAI Responses · Codex") come from the existing catalog (`preset`, `protocolNames`, `enables`). `AnchoredSelect` renders a native `<select>` with `<option disabled>`, so `toBeDisabled()` on the option works; Playwright's `selectOption` refuses disabled options, which is why the test enables Responses before choosing `adapter:responses` and only then switches it off.

- [ ] **Step 4: Run it to verify it fails**

Run: `AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/endpoint-routing.spec.js`
Expected: FAIL — no group "CLIs and routes".

- [ ] **Step 5: Implement**

`route-label.js`:

```js
import { connectionCopy } from "../../lib/i18n/messages/connections.js";

export const protocolShortName = (source) =>
  connectionCopy.routes.shortNames[source] || source;

export function routeLabel(route) {
  const copy = connectionCopy.routes;
  if (!route) return copy.notOffered;
  if (route.mode === "native") return copy.native;
  if (route.mode === "adapter") return copy.adapter(protocolShortName(route.source));
  return protocolShortName(route.source);
}
```

`EndpointRouting.jsx`:

```jsx
import React from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import { names } from "../../lib/providers.js";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { resolveDraftRoute, routeOptions, ROUTE_TOOLS } from "./endpoint-routes.js";
import { protocolShortName, routeLabel } from "./route-label.js";
import { setRoute } from "./endpoint-draft.js";

function choiceLabel(tool, option) {
  const copy = connectionCopy.endpoint.routing.choices;
  if (option.choice === "auto") return copy.auto;
  if (option.choice === "off") return copy.off;
  const protocol = protocolShortName(option.source);
  if (tool === "opencode") return copy.sdk(protocol);
  return option.choice === "native" ? copy.native(protocol) : copy.adapter(protocol);
}

export default function EndpointRouting({ draft, setDraft }) {
  const copy = connectionCopy.endpoint.routing;
  return (
    <fieldset className="endpoint-routing">
      <legend>{copy.title}</legend>
      <p className="field-description">{copy.help}</p>
      {ROUTE_TOOLS.map((tool) => {
        const options = routeOptions(draft, tool);
        const selected = options.find((o) => o.choice === draft.routing[tool]);
        return (
          <div className="endpoint-route" key={tool}>
            <label>
              {names[tool]}
              <AnchoredSelect
                label={copy.select(names[tool])}
                value={draft.routing[tool]}
                onChange={(choice) =>
                  setDraft((current) => setRoute(current, tool, choice))
                }
                options={options.map((option) => ({
                  value: option.choice,
                  label: choiceLabel(tool, option),
                  disabled: !option.available && option.choice !== draft.routing[tool],
                }))}
              />
            </label>
            <small>{copy.resolved(routeLabel(resolveDraftRoute(draft, tool)))}</small>
            {selected && !selected.available && (
              <small role="status">
                {copy.unavailable(copy.reasons[selected.reason])}
              </small>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
```

The currently selected choice stays selectable even when unavailable (Review Focus 2), so a stored explicit route never disappears from the select.

In `ConnectionDialog.jsx` render `<EndpointRouting draft={draft} setDraft={setDraft} />` between `<EndpointTestResult …/>` and `<EndpointModelTable …/>`. In `connections.css` add `.endpoint-routing .endpoint-route { display: grid; gap: 4px; }` and make the select full width at the file's existing mobile breakpoint (`@media (max-width: 700px) { .endpoint-route select { width: 100%; } }`).

- [ ] **Step 6: Run the specs (Chromium and WebKit)**

Run: `AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/endpoint-routing.spec.js tests/browser/endpoint-connections.spec.js`
Run: `AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/endpoint-routing.spec.js tests/browser/endpoint-connections.spec.js`
Expected: PASS in both.

- [ ] **Step 7: Commit**

```bash
git add web/features/provider-connections/ web/lib/i18n/de/connections.js web/lib/i18n/en/connections.js tests/browser/providers-fixture.js tests/browser/endpoint-routing.spec.js tests/browser/endpoint-connections.spec.js
git commit -m "feat: choose the route per CLI in the endpoint connection dialog"
```

---

### Task 5: Adapter options, test proposals and `<think>` extraction

**Files:**

- Create: `web/features/provider-connections/EndpointAdapterOptions.jsx`
- Modify: `web/features/provider-connections/ConnectionDialog.jsx`, `web/features/provider-connections/connections.css`, `web/lib/i18n/{de,en}/connections.js`
- Test: `tests/browser/endpoint-routing.spec.js` (second test)

**Interfaces:**

- Consumes: `CAPABILITY_FIELDS`, `adapterSources` (Task 2); `setCapability`, `resetCapabilities` (Task 3); test result `capabilities` (already applied to the draft by `applyProposal`).
- Produces: `<EndpointAdapterOptions draft setDraft />` rendered inside a `<details>` "Adapter options" below the routing section; only sources from `adapterSources(draft)` get a capability block; the `<think>` checkbox is always shown, with a hint that it applies to Chat Completions adapter routes.

- [ ] **Step 1: Add catalog keys**

English, inside `endpoint`:

```js
    adapter: {
      title: "Adapter options",
      none: "No CLI uses the protocol adapter with these settings.",
      source: (protocol) => `Adapter options · ${protocol}`,
      reset: "Restore defaults",
      proposed: "suggested by the test",
      standard: "default",
      capabilities: {
        promptCache: "Set prompt cache breakpoints",
        thinkingBudget: "Send thinking as a token budget (models without adaptive thinking)",
        promptCacheKey: "Send prompt_cache_key",
        reasoningEffort: "Send reasoning effort",
        parallelToolCalls: "Forward parallel_tool_calls",
        streamUsage: "Request token usage in the stream",
        reasoningReplay: "Send reasoning text back (DeepSeek, GLM, Kimi thinking modes)",
        systemMessages: "System messages in the middle of a conversation",
        maxTokensField: "Output limit field",
      },
      choices: {
        merge: "Merge into the next user message",
        inline: "Keep as system messages",
        max_tokens: "max_tokens",
        max_completion_tokens: "max_completion_tokens",
      },
      think: "Read <think> tags as reasoning",
      thinkHelp: "Only for adapter routes over Chat Completions, for models that write their reasoning into the answer text.",
    },
```

German: same keys —

```js
    adapter: {
      title: "Adapter-Optionen",
      none: "Mit diesen Einstellungen nutzt keine CLI den Protokoll-Adapter.",
      source: (protocol) => `Adapter-Optionen · ${protocol}`,
      reset: "Standard wiederherstellen",
      proposed: "vom Test vorgeschlagen",
      standard: "Standard",
      capabilities: {
        promptCache: "Prompt-Cache-Breakpoints setzen",
        thinkingBudget: "Reasoning als Token-Budget senden (Modelle ohne adaptives Denken)",
        promptCacheKey: "prompt_cache_key senden",
        reasoningEffort: "Reasoning-Stufe senden",
        parallelToolCalls: "parallel_tool_calls weitergeben",
        streamUsage: "Token-Verbrauch im Stream anfordern",
        reasoningReplay: "Reasoning-Text zurücksenden (Denkmodi von DeepSeek, GLM, Kimi)",
        systemMessages: "System-Nachrichten mitten im Verlauf",
        maxTokensField: "Feld für das Ausgabelimit",
      },
      choices: {
        merge: "In die nächste Nutzernachricht einbetten",
        inline: "Als System-Nachrichten belassen",
        max_tokens: "max_tokens",
        max_completion_tokens: "max_completion_tokens",
      },
      think: "<think>-Tags als Reasoning auswerten",
      thinkHelp: "Nur für Adapter-Routen über Chat Completions, für Modelle, die ihr Reasoning in den Antworttext schreiben.",
    },
```

Run: `node --test tests/unit/i18n-catalogs.test.js` → PASS.

- [ ] **Step 2: Write the failing browser test**

Append to `tests/browser/endpoint-routing.spec.js`:

```js
test("test proposals fill adapter options that stay editable", async ({ page }) => {
  const { controls, dialog } = await openNewEndpoint(page);
  controls.endpointProposal = {
    ...controls.endpointProposal,
    protocols: {
      messages: "unsupported",
      responses: "unsupported",
      chatCompletions: "ok",
    },
    reasons: { messages: "notFound", responses: "notFound" },
    capabilities: {
      chatCompletions: { reasoningEffort: false, systemMessages: "inline" },
    },
    warnings: [],
  };
  await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
  await dialog.getByText("Adapter options", { exact: true }).click();
  const options = dialog.getByRole("group", {
    name: "Adapter options · Chat Completions",
    exact: true,
  });
  const effort = options.getByRole("checkbox", { name: /Send reasoning effort/ });
  await expect(effort).not.toBeChecked();
  await expect(options.getByText("suggested by the test")).toHaveCount(2);
  await effort.check();
  await expect(
    options.getByLabel("Keep as system messages", { exact: true }),
  ).toBeChecked();
  await dialog.getByRole("checkbox", { name: "Read <think> tags as reasoning" }).check();
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const created = controls.calls
    .filter((call) => call.path === "/api/provider-connections" && call.method === "POST")
    .at(-1).body;
  expect(created.endpoint.adapterCapabilities).toEqual({
    chatCompletions: { reasoningEffort: true, systemMessages: "inline" },
  });
  expect(created.endpoint.thinkTagExtraction).toBe(true);
});
```

(The llama.cpp preset has only Chat enabled, so Claude Code and Codex resolve to the Chat adapter and the Chat block is the only one shown.)

- [ ] **Step 3: Run it to verify it fails**

Run: `AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/endpoint-routing.spec.js -g "test proposals"`
Expected: FAIL — no "Adapter options".

- [ ] **Step 4: Implement `EndpointAdapterOptions.jsx`**

```jsx
import React from "react";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { adapterSources, CAPABILITY_FIELDS } from "./endpoint-routes.js";
import { resetCapabilities, setCapability } from "./endpoint-draft.js";
import { protocolShortName } from "./route-label.js";

export default function EndpointAdapterOptions({ draft, setDraft }) {
  const copy = connectionCopy.endpoint.adapter;
  const sources = adapterSources(draft);
  return (
    <details className="endpoint-adapter">
      <summary>{copy.title}</summary>
      {!sources.length && <p className="field-description">{copy.none}</p>}
      {sources.map((source) => {
        const stored = draft.adapterCapabilities[source] || {};
        const proposed = draft.capabilityProposal?.[source] || {};
        const change = (name, value) =>
          setDraft((current) => setCapability(current, source, name, value));
        return (
          <fieldset key={source}>
            <legend>{copy.source(protocolShortName(source))}</legend>
            {CAPABILITY_FIELDS[source].map((field) => {
              const value = stored[field.name] ?? field.default;
              const marker =
                field.name in proposed
                  ? copy.proposed
                  : field.name in stored
                    ? null
                    : copy.standard;
              if (field.choices)
                return (
                  <fieldset key={field.name} className="endpoint-capability-choice">
                    <legend>{copy.capabilities[field.name]}</legend>
                    {field.choices.map((choice) => (
                      <label key={choice} className="provider-check">
                        <input
                          type="radio"
                          name={`${source}-${field.name}`}
                          checked={value === choice}
                          onChange={() => change(field.name, choice)}
                        />
                        <span>{copy.choices[choice]}</span>
                      </label>
                    ))}
                    {marker && <small>{marker}</small>}
                  </fieldset>
                );
              return (
                <label key={field.name} className="provider-check">
                  <input
                    type="checkbox"
                    checked={value === true}
                    onChange={(event) => change(field.name, event.target.checked)}
                  />
                  <span>
                    {copy.capabilities[field.name]}
                    {marker && <small>{marker}</small>}
                  </span>
                </label>
              );
            })}
            <button
              type="button"
              className="button secondary"
              onClick={() => setDraft((current) => resetCapabilities(current, source))}
            >
              {copy.reset}
            </button>
          </fieldset>
        );
      })}
      <label className="provider-check">
        <input
          type="checkbox"
          checked={draft.thinkTagExtraction}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              thinkTagExtraction: event.target.checked,
            }))
          }
        />
        <span>
          {copy.think}
          <small>{copy.thinkHelp}</small>
        </span>
      </label>
    </details>
  );
}
```

The "suggested by the test" marker stays after the user edits the value (it explains where the starting value came from); `withoutTest` clears it when the address or key changes. Mount it in `ConnectionDialog.jsx` directly after `<EndpointRouting …/>`.

- [ ] **Step 5: Run the specs (Chromium and WebKit)**

Run: `AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/endpoint-routing.spec.js` and the same with `webkit`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/features/provider-connections/ web/lib/i18n/de/connections.js web/lib/i18n/en/connections.js tests/browser/endpoint-routing.spec.js
git commit -m "feat: edit adapter capabilities and think tag extraction with test suggestions"
```

---

### Task 6: Per-model image support

**Files:**

- Modify: `web/features/provider-connections/EndpointModelTable.jsx`, `web/features/provider-connections/connections.css`, `web/lib/i18n/{de,en}/connections.js`
- Test: `tests/browser/endpoint-routing.spec.js` (third test), `tests/browser/endpoint-connections.spec.js` (overflow assertion already present)

**Interfaces:**

- Consumes: `setModelImages` (Task 3).
- Produces: an "Images" column with a select per row (`""` = automatic → `null`, `"yes"` → `true`, `"no"` → `false`); accessible name `Images <modelId>`.

- [ ] **Step 1: Catalog keys**

English, inside `endpoint`:

```js
    images: "Images",
    imagesFor: (id) => `Images ${id}`,
    imageChoices: { auto: "Automatic", yes: "Yes", no: "No" },
    imagesHelp:
      "No makes the adapter refuse image input for this model, and Codex lists it without image input.",
```

German, same keys:

```js
    images: "Bilder",
    imagesFor: (id) => `Bilder ${id}`,
    imageChoices: { auto: "Automatisch", yes: "Ja", no: "Nein" },
    imagesHelp:
      "Nein lässt den Adapter Bild-Eingaben für dieses Modell ablehnen; Codex führt es ohne Bildeingang.",
```

Run: `node --test tests/unit/i18n-catalogs.test.js` → PASS.

- [ ] **Step 2: Write the failing test**

```js
test("image support per model is saved as a tri-state", async ({ page }) => {
  const { controls, dialog } = await openNewEndpoint(page);
  await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
  const images = dialog.getByLabel("Images qwen3:8b", { exact: true });
  await expect(images).toHaveValue("");
  await images.selectOption("no");
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const created = controls.calls
    .filter((call) => call.path === "/api/provider-connections" && call.method === "POST")
    .at(-1).body;
  expect(created.endpoint.models.find((m) => m.modelId === "qwen3:8b").images).toBe(
    false,
  );
  expect(
    created.endpoint.models.find((m) => m.modelId === "llama3:8b").images,
  ).toBeNull();
});
```

(`qwen3:8b` and `llama3:8b` are the two detected models of the fixture's default `endpointProposal`; a model without context does not block saving.)

- [ ] **Step 3: Run it to verify it fails**

Run: `AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/endpoint-routing.spec.js -g "image support"`
Expected: FAIL — no "Images qwen3:8b".

- [ ] **Step 4: Implement**

In `EndpointModelTable.jsx` import `setModelImages` from `./endpoint-draft.js`, add `<th>{copy.images}</th>` after the "Source" header, and per row, after the source cell:

```jsx
<td className="endpoint-model-images" data-label={copy.images}>
  <select
    aria-label={copy.imagesFor(model.modelId)}
    value={model.images === true ? "yes" : model.images === false ? "no" : ""}
    onChange={(event) => {
      const value = event.target.value;
      setDraft((current) =>
        setModelImages(current, model.modelId, value === "" ? null : value === "yes"),
      );
    }}
  >
    <option value="">{copy.imageChoices.auto}</option>
    <option value="yes">{copy.imageChoices.yes}</option>
    <option value="no">{copy.imageChoices.no}</option>
  </select>
</td>
```

Use a native `<select>` (the table cells already use native inputs; `AnchoredSelect` is for form-level selects). Do **not** route through the table's `update()` helper — it sets `contextEdited: true`. Add `<p className="field-description">{copy.imagesHelp}</p>` under the table. In `connections.css`:

```css
.endpoint-models .endpoint-model-images select {
  min-width: 0;
  max-width: 7.5rem;
}
@media (max-width: 700px) {
  /* Card layout: Context and Output share row 3; Images gets its own row. */
  .endpoint-models td.endpoint-model-images {
    grid-column: 1 / 3;
    grid-row: 4;
  }
  .endpoint-models .endpoint-model-images select {
    max-width: none;
    width: 100%;
  }
}
```

The second block must come after the existing `td[data-label] { grid-row: 3; }` rule so it wins.

- [ ] **Step 5: Run the specs incl. the mobile overflow check (Review Focus 3)**

Run: `AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/endpoint-routing.spec.js tests/browser/endpoint-connections.spec.js tests/browser/endpoint-model-editing.spec.js` and the same with `webkit`.
Expected: PASS, including `overflow.scroller <= 0` and `overflow.dialog === 0` at 390 px in `endpoint-connections.spec.js` (that test now also renders the routing section and the Images cell). Fix overflow in CSS; never relax the assertion.

- [ ] **Step 6: Commit**

```bash
git add web/features/provider-connections/ web/lib/i18n/de/connections.js web/lib/i18n/en/connections.js tests/browser/endpoint-routing.spec.js
git commit -m "feat: mark image support per endpoint model"
```

---

### Task 7: "Via adapter" labels in the connection list, launch dialog and session header; reload warning

**[Decision 4]** decided: labels in the session header, connection list and launch dialog, not in the sidebar. **[Decision 3]** decided: an adapter give-up is visible only in the doctor (Task 8); no health indicator in the session header. "Cross-route resume warning" = a warning in the reload dialog when the route changed since the session started (ledger interpretation).

**Files:**

- Modify: `web/features/provider-connections/ProviderConnections.jsx:51-55`, `web/features/sessions/LaunchAccessFields.jsx:57-61`, `web/features/sessions/SessionWorkspace.jsx:95-106`, `web/features/sessions/SessionReloadDialog.jsx`, `server/features/sessions/session-reload.js:43-74`, `server/features/sessions/provider-configuration.js`, `server/features/sessions/session-replacement.js:66-67`, `web/lib/i18n/{de,en}/connections.js`, `web/lib/i18n/{de,en}/sessions.js`, `web/features/sessions/workspace.css`
- Test: `tests/unit/session-reload-route.test.js`, `tests/browser/endpoint-route-labels.spec.js`, `tests/browser/endpoint-connections.spec.js` (text assertion deferred from Task 4)

**Interfaces:**

- Consumes: `routeLabel` (Task 4); public connection `toolRoutes`; session `provider.route` (set at creation by `publicProviderConfiguration`, endpoint sessions only); `services.providerConnections.get(id)` (synchronous, public view with `toolRoutes`, throws 404 for a missing id); the reload launch's `provider.route` (`prepareProviderLaunch` metadata).
- Produces: reload status field `routeChange: { from: Route, to: Route | null } | null` (`Route = { mode, source }`); `reloadedProvider(current, launched)` in `provider-configuration.js`; i18n `connectionCopy.compatibleRoute(cli, route)`, `sessionWorkspaceCopy.routeTitle`, `sessionReloadCopy.routeChanged(from, to)`.

- [ ] **Step 1: Write the failing server test**

```js
// tests/unit/session-reload-route.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { SessionReload } from "../../server/features/sessions/session-reload.js";

function reloadWith(session, toolRoutes) {
  const services = {
    sessions: { get: async () => structuredClone(session), list: async () => [] },
    activity: { read: async () => ({ state: "idle" }) },
    bindings: { resolve: async () => ({ id: "native" }) },
    providerConnections: {
      get: (id) => {
        if (id !== "c1") throw Object.assign(new Error("gone"), { status: 404 });
        return { id, toolRoutes };
      },
    },
  };
  return new SessionReload({ services, pollMs: 0 });
}
const base = {
  id: "s1",
  tool: "claude",
  status: "running",
  access: { providerConnectionId: "c1" },
  provider: { route: { mode: "native", source: "messages" } },
};

test("an unchanged route reports no route change", async () => {
  const status = await reloadWith(base, {
    claude: { mode: "native", source: "messages" },
  }).status("s1");
  assert.equal(status.routeChange, null);
});

test("a changed route reports from and to", async () => {
  const to = { mode: "adapter", source: "chatCompletions" };
  const status = await reloadWith(base, { claude: to }).status("s1");
  assert.deepEqual(status.routeChange, { from: base.provider.route, to });
});

test("a route that is no longer offered reports to: null", async () => {
  const status = await reloadWith(base, { claude: null }).status("s1");
  assert.deepEqual(status.routeChange, { from: base.provider.route, to: null });
});

test("native accounts, missing connections and route-less sessions report nothing", async () => {
  for (const session of [
    { ...base, access: undefined },
    { ...base, access: { providerConnectionId: "gone" } },
    { ...base, provider: {} },
  ])
    assert.equal((await reloadWith(session, {}).status("s1")).routeChange, null);
});

test("a reload records the route it launched, so the warning does not outlive it", () => {
  const to = { mode: "adapter", source: "chatCompletions" };
  assert.deepEqual(reloadedProvider(base.provider, { route: to, cliModelId: "x" }), {
    route: to,
  });
  assert.deepEqual(
    reloadedProvider(
      { requestedModelId: "qwen3", route: base.provider.route },
      { route: { ...to, extra: "dropped" } },
    ),
    { requestedModelId: "qwen3", route: to },
  );
  // Catalog launches carry no route; invalid routes are ignored.
  assert.deepEqual(reloadedProvider(base.provider, {}), base.provider);
  assert.deepEqual(
    reloadedProvider(base.provider, { route: { mode: "x", source: "messages" } }),
    base.provider,
  );
  assert.equal(reloadedProvider(undefined, { route: to }), undefined);
});
```

with the additional import `import { reloadedProvider } from "../../server/features/sessions/provider-configuration.js";`. `accountSwitchTargets` reads only `services.accounts?.list()`, so the stub needs no accounts.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/session-reload-route.test.js`
Expected: FAIL — `routeChange` is `undefined`.

- [ ] **Step 3: Implement `routeChange`**

In `session-reload.js`:

```js
const sameRoute = (a, b) => !!a && !!b && a.mode === b.mode && a.source === b.source;

/** The route a reload would use differs from the running one (reasoning carriers of the
 * old route are dropped on the new one). Null when unknown or unchanged. */
function routeChange(services, session) {
  const from = session.provider?.route;
  const id = session.access?.providerConnectionId;
  if (!from || !id || !services.providerConnections) return null;
  let to;
  try {
    to = services.providerConnections.get(id).toolRoutes?.[session.tool] ?? null;
  } catch {
    return null;
  }
  return sameRoute(from, to) ? null : { from, to };
}
```

and add `routeChange: routeChange(this.services, session),` to the `value` object in `inspect()`. `services.providerConnections` is the `ProviderConnections` instance (`server/application/services.js:239`, passed to `new SessionReload` in `server/app.js:92`).

A reload resolves the route anew, but today only session creation writes `session.provider`; without the next change the header keeps the old route and the warning stays after a successful reload. In `provider-configuration.js` (which already imports `ROUTE_MODES` and `PROTOCOLS`):

```js
/** The provider record after a reload: the route the new launch actually uses. */
export function reloadedProvider(current, launched) {
  const route = launched?.route;
  if (
    !current ||
    !route ||
    !ROUTE_MODES.includes(route.mode) ||
    !PROTOCOLS.includes(route.source)
  )
    return current;
  return { ...current, route: { mode: route.mode, source: route.source } };
}
```

In `session-replacement.js` import it and, directly after the two `adapterGeneration` lines (before the `manager.save(session)` that follows them), add:

```js
// The route may differ from the first launch (connection edited since).
if (session.provider)
  session.provider = reloadedProvider(session.provider, launch.provider);
```

`launch.provider` is the `prepareProviderLaunch` metadata that `session-reload-lifecycle.js:66-71` already reads; the reload preparation chain spreads `launch`, so it is still present here. The blackbox test `tests/blackbox/endpoint-adapter-session.test.js` ("reload starts a new adapter …") already asserts `current.provider.route` after a reload and must stay green.

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/unit/session-reload-route.test.js tests/unit/session-reload.test.js tests/unit/session-reload-lifecycle.test.js tests/blackbox/endpoint-adapter-session.test.js`
Expected: PASS.

- [ ] **Step 5: Catalog keys**

`web/lib/i18n/en/connections.js` and `web/lib/i18n/de/connections.js`, top level of `connectionCopy` (identical in both languages; the route label itself is translated):

```js
  compatibleRoute: (cli, route) => `${cli} (${route})`,
```

`web/lib/i18n/en/sessions.js`:

```js
// in sessionWorkspaceCopy
  routeTitle: "Connection route",
// in sessionReloadCopy
  routeChanged: (from, to) =>
    `The route changed since this session started (before: ${from}, now: ${to}). Reasoning data from the earlier conversation cannot be carried over.`,
```

`web/lib/i18n/de/sessions.js`:

```js
// in sessionWorkspaceCopy
  routeTitle: "Verbindungsroute",
// in sessionReloadCopy
  routeChanged: (from, to) =>
    `Die Route hat sich seit dem Start geändert (vorher: ${from}, jetzt: ${to}). Reasoning-Daten der bisherigen Unterhaltung können nicht übernommen werden.`,
```

Run: `node --test tests/unit/i18n-catalogs.test.js` → PASS.

- [ ] **Step 6: Write the failing browser test**

```js
// tests/browser/endpoint-route-labels.spec.js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

const chatOnly = {
  id: "gpu",
  name: "GPU box",
  providerId: "endpoint",
  hasSecret: false,
  launchable: true,
  tools: ["codex", "claude", "opencode"],
  toolRoutes: {
    claude: { mode: "adapter", source: "chatCompletions" },
    codex: { mode: "adapter", source: "chatCompletions" },
    opencode: { mode: "native", source: "chatCompletions" },
  },
  endpoint: {
    openaiBaseUrl: "http://gpu.example:8080/v1",
    anthropicBaseUrl: "",
    authHeader: "",
    protocols: { messages: false, responses: false, chatCompletions: true },
    routing: { claude: "auto", codex: "auto", opencode: "auto" },
    adapterCapabilities: {},
    thinkTagExtraction: false,
    models: [],
  },
};

test("connection list and launch dialog label adapter routes", async ({ page }) => {
  const controls = await fixture(page);
  controls.state.providerConnections = [chatOnly];
  await page.goto(baseURL + "/accounts");
  await expect(
    page.getByText(
      "Compatible CLIs: Codex (via adapter · Chat Completions), Claude Code (via adapter · Chat Completions), OpenCode (native)",
    ),
  ).toBeVisible();
  await page.goto(baseURL + "/");
  await page.getByRole("button", { name: "New session", exact: true }).first().click();
  await page.getByLabel("CLI", { exact: true }).selectOption("claude");
  await expect(
    page
      .getByLabel("Connection", { exact: true })
      .locator('option[value="provider:gpu"]'),
  ).toContainText("via adapter · Chat Completions");
});

const adapterSession = {
  id: "adapter-session",
  name: "Adapter session",
  tool: "claude",
  accountId: "internal-isolated-profile",
  cwd: "/fixture",
  status: "running",
  access: {
    providerConnectionId: "gpu",
    providerConnectionName: "GPU box",
    providerId: "endpoint",
    providerModelId: "qwen3",
  },
  provider: {
    requestedModelId: "qwen3",
    modelChangeRequiresRestart: true,
    route: { mode: "adapter", source: "chatCompletions" },
  },
};

test("the session header shows the route of endpoint sessions only", async ({ page }) => {
  await fixture(page, { session: adapterSession });
  await page.goto(baseURL + "/sessions/adapter-session/chat");
  await expect(page.locator(".session-title .route-badge")).toHaveText(
    "via adapter · Chat Completions",
  );
});

test("native account sessions have no route badge", async ({ page }) => {
  await fixture(page, {
    session: {
      id: "native-session",
      name: "Native session",
      tool: "codex",
      accountId: "local-codex",
      cwd: "/fixture",
      status: "running",
    },
  });
  await page.goto(baseURL + "/sessions/native-session/chat");
  await expect(page.locator(".session-title h1")).toHaveText("Native session");
  await expect(page.locator(".session-title .route-badge")).toHaveCount(0);
});

test("the reload dialog warns when the route changed since the start", async ({
  page,
}) => {
  await fixture(page, { session: adapterSession });
  // Registered after the fixture, so it takes precedence over its catch-all route
  // (which throws on unknown requests).
  await page.route("**/api/sessions/adapter-session/reload", (route) =>
    route.fulfill({
      json: {
        eligible: true,
        reason: null,
        nativeId: "native-fixture",
        accountTargets: [],
        activity: { state: "idle" },
        state: "idle",
        error: null,
        requestId: null,
        routeChange: {
          from: { mode: "native", source: "messages" },
          to: { mode: "adapter", source: "chatCompletions" },
        },
      },
    }),
  );
  await page.goto(baseURL + "/sessions/adapter-session/chat");
  await page.getByRole("button", { name: "Reload & resume", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByText(
        "The route changed since this session started (before: native, now: via adapter · Chat Completions). Reasoning data from the earlier conversation cannot be carried over.",
        { exact: true },
      ),
  ).toBeVisible();
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/endpoint-route-labels.spec.js`
Expected: FAIL.

- [ ] **Step 8: Implement the labels**

All three files import `routeLabel` from `../provider-connections/route-label.js` (`ProviderConnections.jsx`: `./route-label.js`).

`ProviderConnections.jsx` — replace the "Compatible CLIs" paragraph:

```jsx
<p>
  {copy.compatible}:{" "}
  {connection.tools
    .map((tool) =>
      connection.toolRoutes
        ? copy.compatibleRoute(names[tool], routeLabel(connection.toolRoutes[tool]))
        : names[tool],
    )
    .join(", ") || copy.noCompatible}
</p>
```

`LaunchAccessFields.jsx` — the connection option label gains the route of the selected CLI (same order as before: name · provider · route · key missing):

```jsx
...access.connections.map((connection) => {
  const route = connection.toolRoutes?.[access.tool];
  return {
    value: `provider:${connection.id}`,
    label: [
      connection.name,
      copy.providerNames[connection.providerId] || connection.providerId,
      ...(route ? [routeLabel(route)] : []),
      ...(connection.launchable ? [] : [copy.keyMissing]),
    ].join(" · "),
    disabled: !connection.launchable,
  };
}),
```

`SessionWorkspace.jsx` — the subtitle paragraph of `.session-title` becomes:

```jsx
<p>
  {names[session.tool]}
  <span> / </span>
  {session.access?.providerConnectionName ||
    account?.name ||
    copy.sessionTitleDescription}
  {session.provider?.route && (
    <span className="route-badge" title={copy.routeTitle}>
      {routeLabel(session.provider.route)}
    </span>
  )}
</p>
```

`workspace.css` — `.session-title p > span` already styles the separator span (color, padding), so the badge needs a more specific rule placed after it (the file uses literal colors, there is no border token):

```css
.session-title p > .route-badge {
  margin-left: 6px;
  padding: 0 6px;
  border: 1px solid #404145;
  border-radius: 999px;
  color: #9a9b9f;
  white-space: nowrap;
}
```

`SessionReloadDialog.jsx` — the `{data && (…)}` fragment gains the warning as its first child (shown with its surrounding fragment so the snippet stays valid JSX):

```jsx
<div className="session-reload-dialog">
  {/* existing hints, terminal button, loading/error/submitting lines unchanged */}
  {data && (
    <>
      {data.routeChange && (
        <p role="status">
          {copy.routeChanged(
            routeLabel(data.routeChange.from),
            routeLabel(data.routeChange.to),
          )}
        </p>
      )}
      {/* existing children of the fragment follow unchanged */}
    </>
  )}
  {/* rest of the dialog unchanged */}
</div>
```

Then add the deferred assertion to `endpoint-connections.spec.js` (Task 4 Step 2), directly after the `toHaveCount(1)` line:

```js
await expect(access.locator('option[value="provider:connection-one"]')).toContainText(
  "via adapter · Messages",
);
```

- [ ] **Step 9: Run the specs (Chromium and WebKit) and the catalogs test**

Run: `node --test tests/unit/i18n-catalogs.test.js`
Run: `AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/endpoint-route-labels.spec.js tests/browser/endpoint-connections.spec.js tests/browser/session-reload.spec.js tests/browser/launch-modes.spec.js` and the same with `webkit`.
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/features/sessions/session-reload.js server/features/sessions/provider-configuration.js server/features/sessions/session-replacement.js web/ tests/unit/session-reload-route.test.js tests/browser/endpoint-route-labels.spec.js tests/browser/endpoint-connections.spec.js
git commit -m "feat: label adapter routes and warn when a reload changes the route"
```

---

### Task 8: Doctor diagnostics for adapter sessions

**Files:**

- Create: `server/features/operations/adapter-doctor.js`
- Modify: `server/features/operations/doctor.js:183-227`, `web/features/operations/diagnostic-labels.js`, `web/lib/i18n/{de,en}/operations.js` (`diagnosticCopy`)
- Test: `tests/unit/adapter-doctor.test.js`, `tests/integration/endpoint-doctor-routes.test.js`, `tests/browser/operations-adapter-diagnostics.spec.js`

**Interfaces:**

- Consumes: session records `sessions/<id>.json` (`status`, `tool`, `name`, `adapterGeneration`, `provider.route`); snapshots `sessions/<id>.adapter.json` (`version: 1`, `generation`, `restarts`, `requests`, `errors`, `upstreamStatus`, `dropped`, `compactionDropped`, `capabilityFallbacks: { [name]: { kept, reverted } }`, `estimatedUsage`, `cacheReadTokens`, `capabilities`, `supervisor: { restarts, lastReason, gaveUpAt } | { startFailed, at }`); `toolRoutes` (`endpoint-routing.js`).
- Produces: `adapterSessionChecks(dataDir) → Check[]`, `adapterCheck(session, snapshot | null) → Check` with `Check = { id: "adapter-session.<sessionId>", status: "ok" | "warn" | "fail", summary, remedy?, details? }`.

- [ ] **Step 1: Write the failing unit tests**

```js
// tests/unit/adapter-doctor.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  adapterCheck,
  adapterSessionChecks,
} from "../../server/features/operations/adapter-doctor.js";

const session = {
  id: "s1",
  name: "Refactor API",
  tool: "claude",
  status: "running",
  adapterGeneration: "g2",
  provider: { route: { mode: "adapter", source: "chatCompletions" } },
};
const snapshot = (extra = {}) => ({
  version: 1,
  generation: "g2",
  restarts: 0,
  requests: { "/v1/messages": 40, "/v1/messages/count_tokens": 3 },
  errors: {},
  upstreamStatus: { "2xx": 40 },
  dropped: {},
  compactionDropped: 0,
  capabilityFallbacks: {},
  estimatedUsage: 0,
  cacheReadTokens: 0,
  capabilities: {},
  ...extra,
});

test("a healthy adapter session is ok and counts requests", () => {
  const check = adapterCheck(session, snapshot());
  assert.equal(check.id, "adapter-session.s1");
  assert.equal(check.status, "ok");
  assert.match(check.summary, /Refactor API/);
  assert.match(check.summary, /Claude Code via adapter \(chatCompletions\)/);
  assert.match(check.summary, /43 request\(s\)/);
});

test("restarts, errors and dropped compaction items warn", () => {
  assert.equal(adapterCheck(session, snapshot({ restarts: 1 })).status, "warn");
  assert.equal(
    adapterCheck(session, snapshot({ errors: { rateLimit: 2 } })).status,
    "warn",
  );
  const compaction = adapterCheck(session, snapshot({ compactionDropped: 2 }));
  assert.equal(compaction.status, "warn");
  assert.match(compaction.summary, /compacted history/);
});

test("a supervisor give-up or start failure fails with a reload remedy", () => {
  const gaveUp = adapterCheck(
    session,
    snapshot({
      supervisor: {
        restarts: 3,
        lastReason: "exited",
        gaveUpAt: "2026-10-08T10:00:00.000Z",
      },
    }),
  );
  assert.equal(gaveUp.status, "fail");
  assert.match(gaveUp.summary, /stopped after 3 restart\(s\)/);
  assert.match(gaveUp.summary, /HTTP 503/);
  assert.match(gaveUp.remedy, /Reload the session/);
  const failed = adapterCheck(session, {
    version: 1,
    generation: "g2",
    supervisor: { startFailed: "timeout", at: "2026-10-08T10:00:00.000Z" },
  });
  assert.equal(failed.status, "fail");
  assert.match(failed.summary, /failed to start \(timeout\)/);
});

test("details hold counters only", () => {
  const { details } = adapterCheck(session, snapshot({ secret: "x", prompt: "y" }));
  assert.equal("secret" in details, false);
  assert.equal("prompt" in details, false);
  assert.deepEqual(details.requests, snapshot().requests);
});

test("only running sessions of the current generation are reported (Review Focus 4)", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-doctor-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const dir = path.join(dataDir, "sessions");
  fs.mkdirSync(dir);
  const write = (name, value) =>
    fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  write("s1.json", session);
  write(
    "s1.adapter.json",
    snapshot({
      generation: "g1",
      supervisor: { gaveUpAt: "x", restarts: 3, lastReason: "exited" },
    }),
  );
  write("s2.json", { ...session, id: "s2", status: "stopped" });
  write(
    "s2.adapter.json",
    snapshot({ supervisor: { gaveUpAt: "x", restarts: 3, lastReason: "exited" } }),
  );
  write("s3.json", { ...session, id: "s3", adapterGeneration: undefined });
  write("s1.outcome.json", { unrelated: true });
  const before = fs.readdirSync(dir).sort();
  const checks = adapterSessionChecks(dataDir);
  assert.deepEqual(
    checks.map((c) => [c.id, c.status]),
    [["adapter-session.s1", "ok"]],
  );
  assert.match(checks[0].summary, /no requests recorded/);
  assert.deepEqual(fs.readdirSync(dir).sort(), before, "the doctor writes nothing");
  assert.deepEqual(adapterSessionChecks(path.join(dataDir, "missing")), []);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/adapter-doctor.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `adapter-doctor.js`**

```js
import fs from "node:fs";
import path from "node:path";

// Doctor checks for running protocol adapter sessions. Reads counters and fixed enums from
// `sessions/<id>.adapter.json` only; a snapshot of another launch generation is ignored.
const TOOLS = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
const DETAIL_KEYS = [
  "startedAt",
  "updatedAt",
  "route",
  "restarts",
  "requests",
  "unauthorized",
  "upstreamStatus",
  "errors",
  "forbidden",
  "clientDisconnects",
  "shutdownAborts",
  "dropped",
  "adjustments",
  "compactionDropped",
  "capabilityFallbacks",
  "capabilities",
  "estimatedUsage",
  "cacheReadTokens",
  "supervisor",
];
const RELOAD = "Reload the session to restart the protocol adapter.";

const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const count = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value).reduce((sum, item) => sum + count(item), 0)
      : 0;
const details = (snapshot) =>
  Object.fromEntries(
    DETAIL_KEYS.filter((key) => key in snapshot).map((key) => [key, snapshot[key]]),
  );

export function adapterCheck(session, snapshot) {
  const id = `adapter-session.${session.id}`;
  const head = `"${session.name ?? session.id}": ${TOOLS[session.tool] ?? session.tool} via adapter (${
    session.provider?.route?.source ?? "unknown"
  })`;
  if (!snapshot)
    return { id, status: "ok", summary: `${head}: no requests recorded yet.` };
  const supervisor = snapshot.supervisor || {};
  if (supervisor.gaveUpAt)
    return {
      id,
      status: "fail",
      summary: `${head}: the protocol adapter stopped after ${count(supervisor.restarts)} restart(s) (${supervisor.lastReason ?? "exited"}) at ${supervisor.gaveUpAt}; every request of the CLI now gets HTTP 503.`,
      remedy: RELOAD,
      details: details(snapshot),
    };
  if (supervisor.startFailed)
    return {
      id,
      status: "fail",
      summary: `${head}: the protocol adapter failed to start (${supervisor.startFailed}) at ${supervisor.at ?? "an unknown time"}.`,
      remedy: `${RELOAD} If it fails again, test the connection and check its address.`,
      details: details(snapshot),
    };
  const requests = count(snapshot.requests);
  const errors = count(snapshot.errors);
  const restarts = count(snapshot.restarts);
  const compaction = count(snapshot.compactionDropped);
  const fallbacks = count(snapshot.capabilityFallbacks);
  const estimated = count(snapshot.estimatedUsage);
  return {
    id,
    status: restarts || errors || compaction ? "warn" : "ok",
    summary:
      `${head}: ${requests} request(s), ${errors} error(s), ${restarts} restart(s), ` +
      `${fallbacks} capability fallback(s), ${estimated} estimated usage report(s), ` +
      `${compaction} compaction item(s) dropped.` +
      (compaction
        ? " Remotely compacted history was dropped on this route; start a new session if the model lacks earlier context."
        : ""),
    details: details(snapshot),
  };
}

export function adapterSessionChecks(dataDir) {
  const directory = path.join(dataDir, "sessions");
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const checks = [];
  for (const name of names
    .filter((n) => n.endsWith(".json") && n.split(".").length === 2)
    .sort()) {
    const session = read(path.join(directory, name));
    if (!session?.adapterGeneration || session.status !== "running") continue;
    const snapshot = read(path.join(directory, name.replace(/\.json$/, ".adapter.json")));
    const current =
      snapshot?.version === 1 && snapshot.generation === session.adapterGeneration
        ? snapshot
        : null;
    checks.push(adapterCheck(session, current));
  }
  return checks;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test tests/unit/adapter-doctor.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing integration test (doctor wiring, routes, Azure note)**

```js
// tests/integration/endpoint-doctor-routes.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { Doctor } from "../../server/features/operations/doctor.js";

const azureLike = {
  preset: "custom",
  openaiBaseUrl: "https://llm.example/v1",
  anthropicBaseUrl: null,
  protocols: { messages: false, responses: true, chatCompletions: true },
  authHeader: "api-key",
  models: [],
  lastTest: null,
  routing: { opencode: "responses" },
};

function setup(t) {
  const dataDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-doctor-routes-")),
  );
  fs.chmodSync(dataDir, 0o700);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, connections: new ProviderConnections({ dataDir }) };
}
const run = (dataDir) =>
  new Doctor({
    dataDir,
    command: async () => ({ code: 0, stdout: "fixture 1.0.0" }),
    ptyCheck: async () => true,
  }).run({ scope: "host" });

test("endpoint summaries list the resolved routes and the unverified Azure header case", async (t) => {
  const { dataDir, connections } = setup(t);
  const { id } = connections.create({
    name: "Azure",
    providerId: "endpoint",
    endpoint: azureLike,
  });
  const check = (await run(dataDir)).checks.find(
    (c) => c.id === `provider-connection.${id}`,
  );
  assert.match(
    check.summary,
    /routes claude=adapter:responses, codex=native:responses, opencode=sdk:responses/,
  );
  assert.match(check.summary, /blank Authorization header next to api-key/);
});

test("running adapter sessions appear in the host report", async (t) => {
  const { dataDir } = setup(t);
  const dir = path.join(dataDir, "sessions");
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, "s1.json"),
    JSON.stringify({
      id: "s1",
      name: "Nightly",
      tool: "codex",
      status: "running",
      adapterGeneration: "g1",
      provider: { route: { mode: "adapter", source: "chatCompletions" } },
    }),
  );
  const checks = (await run(dataDir)).checks;
  assert.equal(checks.find((c) => c.id === "adapter-session.s1").status, "ok");
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node --test tests/integration/endpoint-doctor-routes.test.js`
Expected: FAIL — no `routes` in the summary; no adapter check.

- [ ] **Step 7: Wire the doctor**

In `doctor.js` import `{ toolRoutes }` from `../providers/endpoint-routing.js` and `{ adapterSessionChecks }` from `./adapter-doctor.js`. In the endpoint branch keep the validated endpoint instead of discarding it (routes must be resolved on the normalized value, which fills `routing` defaults):

```js
        let endpoint = null;
        try {
          endpoint = validateEndpoint(connection.endpoint);
        } catch {
          endpoint = null;
        }
        if (!endpoint) {
          add(
            `provider-connection.${connection.id}`,
            "warn",
            `Custom endpoint settings are invalid; the connection is hidden and cannot be launched until provider-connections.json is repaired. Key ${keyed ? "configured" : "not configured"}.`,
          );
          continue;
        }
        const routes = toolRoutes(endpoint);
        const routeText = Object.entries(routes)
          .map(([tool, route]) => `${tool}=${route ? `${route.mode}:${route.source}` : "off"}`)
          .join(", ");
        const blankAuthorization =
          endpoint.authHeader && routes.opencode?.mode === "sdk"
            ? ` OpenCode sends a blank Authorization header next to ${endpoint.authHeader} on its ${routes.opencode.source} route; whether Azure OpenAI accepts that is unverified.`
            : "";
```

(this replaces the existing `let valid = true; try { … } catch { … } if (!valid) { … }` block; the warning text is unchanged). In the existing summary template replace the tail `` `; ${missing} model(s) without context. No network check was performed.` `` with `` `; ${missing} model(s) without context; routes ${routeText}. No network check was performed.${blankAuthorization}` ``. The substrings the older tests match (`never tested`, `1 model(s) without context`, `last test …: messages=ok, …`) stay intact. After the provider-connection loop add:

```js
for (const check of adapterSessionChecks(this.dataDir))
  add(check.id, check.status, check.summary, check.remedy, check.details);
```

- [ ] **Step 8: Run backend tests**

Run: `node --test tests/integration/endpoint-doctor-routes.test.js tests/integration/endpoint-connections.test.js tests/matrix/operations-doctor.test.js tests/blackbox/operations.test.js tests/unit/adapter-doctor.test.js`
Expected: PASS.

- [ ] **Step 9: Web label, catalog and browser test**

`diagnosticCopy` — en: `adapterSession: "Adapter session"`; de: `adapterSession: "Adapter-Sitzung"`. `diagnostic-labels.js`:

```js
if (id.startsWith("adapter-session.")) return `${copy.adapterSession}: ${id.slice(16)}`;
```

(`"adapter-session.".length === 16`; the id stays the raw session id, the session name is in the summary.)

`tests/browser/operations-adapter-diagnostics.spec.js` (doctor route mocked like `operations-diagnostics-project.spec.js`; the route registered after `operationsFixture` takes precedence over its own doctor handler; `DiagnosticsPage.jsx` renders one `article.operations-card` per check with the label and status in its `header` and the details in a `<details>`):

```js
import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";
import { baseURL } from "../helpers/browser.js";

test.use({ locale: "en-GB" });

const report = {
  version: "0.0.0-test",
  generatedAt: "2026-10-08T10:00:00.000Z",
  checks: [
    {
      id: "adapter-session.s1",
      status: "fail",
      summary:
        '"Nightly": Codex via adapter (chatCompletions): the protocol adapter stopped after 3 restart(s) (exited) at 2026-10-08T09:59:00.000Z; every request of the CLI now gets HTTP 503.',
      remedy: "Reload the session to restart the protocol adapter.",
      details: {
        restarts: 3,
        supervisor: {
          restarts: 3,
          lastReason: "exited",
          gaveUpAt: "2026-10-08T09:59:00.000Z",
        },
      },
    },
    {
      id: "adapter-session.s2",
      status: "warn",
      summary:
        '"Refactor": Claude Code via adapter (responses): 12 request(s), 1 error(s), 0 restart(s), 0 capability fallback(s), 0 estimated usage report(s), 0 compaction item(s) dropped.',
      details: { requests: { "/v1/messages": 12 }, errors: { rateLimit: 1 } },
    },
  ],
};

test("adapter session checks show label, status, remedy and collapsed details", async ({
  page,
}) => {
  await operationsFixture(page);
  await page.route("**/api/operations/doctor", (route) =>
    route.fulfill({
      json: { report: route.request().method() === "GET" ? null : report },
    }),
  );
  await page.goto(baseURL + "/settings/diagnostics");
  await page.getByRole("button", { name: "Run checks", exact: true }).click();
  const card = (label) =>
    page.locator("article.operations-card").filter({
      has: page.getByText(label, { exact: true }),
    });
  const failed = card("Adapter session: s1");
  await expect(failed.locator("header")).toContainText("Failed");
  await expect(
    failed.getByText("Reload the session to restart the protocol adapter.", {
      exact: true,
    }),
  ).toBeVisible();
  const details = failed.locator("details");
  await expect(details.locator("pre")).toBeHidden();
  await details.locator("summary").click();
  await expect(details.locator("pre")).toContainText('"gaveUpAt"');
  await expect(card("Adapter session: s2").locator("header")).toContainText("Notice");
});
```

Run: `node --test tests/unit/i18n-catalogs.test.js` and `AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/operations-adapter-diagnostics.spec.js` plus `webkit`.
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/features/operations/ web/features/operations/diagnostic-labels.js web/lib/i18n/de/operations.js web/lib/i18n/en/operations.js tests/unit/adapter-doctor.test.js tests/integration/endpoint-doctor-routes.test.js tests/browser/operations-adapter-diagnostics.spec.js
git commit -m "feat: report protocol adapter sessions and endpoint routes in the doctor"
```

---

### Task 9: Screenshots for the PR

**Files:**

- Modify: `tests/browser/endpoint-routing.spec.js`, `tests/browser/endpoint-route-labels.spec.js`, `tests/browser/operations-adapter-diagnostics.spec.js`
- Create (generated): `docs/screenshots/endpoint-routing-desktop.png`, `docs/screenshots/endpoint-routing-mobile.png`, `docs/screenshots/endpoint-adapter-options.png`, `docs/screenshots/session-adapter-route.png`, `docs/screenshots/diagnostics-adapter-session.png`

- [ ] **Step 1: Add env-gated captures** following `artifacts.spec.js:74-90`. In the first test of `endpoint-routing.spec.js`, directly after `await expect(uses("via adapter · Responses")).toBeVisible();` (before Responses is unchecked again):

```js
if (process.env.CAPTURE_ADAPTER_SCREENSHOTS) {
  await dialog.screenshot({
    path: "docs/screenshots/endpoint-routing-desktop.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(routing).toBeInViewport({ ratio: 0.1 });
  await dialog.screenshot({
    path: "docs/screenshots/endpoint-routing-mobile.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1280, height: 720 });
}
```

In the "test proposals" test, after `await effort.check();`, capture `options` (already visible) to `endpoint-adapter-options.png`; in "the session header shows the route …" capture `page.locator(".session-title")` to `session-adapter-route.png` after its `toHaveText` assertion; in the diagnostics spec call `page.screenshot({ path: "docs/screenshots/diagnostics-adapter-session.png", animations: "disabled" })` after the last assertion (the opened details stay in the shot). Every capture waits on an asserted state, never on a timeout.

- [ ] **Step 2: Capture**

Run: `CAPTURE_ADAPTER_SCREENSHOTS=1 AGENTPIER_TEST_BROWSER=chromium npx playwright test tests/browser/endpoint-routing.spec.js tests/browser/endpoint-route-labels.spec.js tests/browser/operations-adapter-diagnostics.spec.js`
Then: `git status --short docs/screenshots` — only the five new files may appear; `git restore` anything else. Open each PNG and check it shows English text and no clipped controls.

- [ ] **Step 3: Commit**

```bash
git add tests/browser/endpoint-routing.spec.js tests/browser/endpoint-route-labels.spec.js tests/browser/operations-adapter-diagnostics.spec.js docs/screenshots/endpoint-routing-desktop.png docs/screenshots/endpoint-routing-mobile.png docs/screenshots/endpoint-adapter-options.png docs/screenshots/session-adapter-route.png docs/screenshots/diagnostics-adapter-session.png
git commit -m "docs: add protocol adapter UI screenshots"
```

---

### Task 10: Documentation

**Files:**

- Create: `docs/protocol-adapter.md`
- Modify: `docs/providers.md:38-99`, `docs/research/provider-compatibility.md`, `docs/sandbox.md:143-150`, `docs/architecture.md`, `docs/session-reload.md`

**Interfaces:** none (docs). Every statement must match code on this branch; quote numbers from the code, not from memory.

- [ ] **Step 1: `docs/providers.md` "Custom endpoints"** — replace the table and the sentence "A CLI is offered only when its protocol is enabled on the connection. There is no protocol translation." with:

  - the routing table from the spec ("How each CLI reaches each protocol"), headed "Routes";
  - "**Routing.** Each CLI has a route: Automatic, Native, Via adapter (protocol) or Off; OpenCode chooses among its built-in providers (Chat Completions, Responses, Messages) and never needs the adapter. Automatic takes the native protocol when enabled, otherwise the adapter from the first enabled of Responses, Messages, Chat Completions (OpenCode: Chat Completions, Responses, Messages). The dialog shows the resolved route and why a choice is unavailable. Running sessions and pipeline profiles keep the route they started with; a pipeline profile whose CLI would now take another route is refused until it is saved again.";
  - "**Adapter options.**" the capability table (name, default, effect) from the spec, the probe ("Test connection" sends one extra request per option and pre-fills its result; nothing is saved before _Save connection_), the runtime one-shot retry, `<think>` extraction, the per-model Images setting;
  - "**Labels.**" connection list, launch dialog, session header; reload warning when the route changed (reasoning data of the earlier conversation is not carried over);
  - "**Limits.**" no upstream HTTP(S) proxy for adapter routes (endpoints reachable only through a proxy do not work; the CLI keeps its proxy settings with `127.0.0.1,localhost` in `NO_PROXY`); request bodies up to 64 MiB; hosted tools (web search etc.) are dropped on targets without them; `previous_response_id` is rejected; after 3 adapter restarts within 60 s the CLI gets HTTP 503 until the session is reloaded; with a custom auth header, OpenCode's Messages/Responses providers send a blank `Authorization` header next to it — whether Azure OpenAI accepts this is unverified;
  - "**Doctor.**" extend the existing paragraph: routes per connection, one entry per running adapter session (requests, errors, restarts, capability fallbacks, estimated usage, dropped compaction items; failed when the adapter gave up or failed to start). Still no network calls.
  - Link to `protocol-adapter.md` for internals; embed `screenshots/endpoint-routing-desktop.png`.

- [ ] **Step 2: Create `docs/protocol-adapter.md`** (lasting guidance from the spec; English; ≤ 600 lines): sections "Purpose", "Process model" (launcher → supervisor owns `127.0.0.1:0`, hands sockets over IPC; restart budget; give-up 503; start failure exit 127; release references), "Security" (session token, Host/Origin checks, key only in payload and adapter, no proxy, CA variables, address policy re-checked per connection, body and event caps), "Translation overview" (IR summary, four directions, reasoning carriers `ap1.<origin>.<payload>`, usage mapping, stop-reason table, context-overflow messages per client, keep-alives and the 240 s idle timeout, Amendment 16 timing for Claude Code), "Capabilities" (table, probe, runtime retry rule), "Diagnostics file" (path `sessions/<id>.adapter.json`, mode 0600, ≤ 1 write per 5 s, fields list, `generation` ownership, `supervisor` record), "Testing" (where golden fixtures, property tests, CLI smoke matrix and nono tests live, and how to run them). Do not copy the amendment numbering; state the resulting rules directly.

- [ ] **Step 3: `docs/research/provider-compatibility.md`** — add a dated section "Protocol adapter routes (2026-10-08)" with the CLI × upstream matrix and which combinations the CLI smoke matrix verified (from `tests/matrix/adapter-cli-smoke.test.js` rows and the CLI versions recorded in `docs/research/protocol-adapter-facts.md`); note the unverified Azure blank-Authorization case and the unverified Linux `network.block` nono case.

- [ ] **Step 4: `docs/sandbox.md`** — keep the adapter paragraph; add a link to `protocol-adapter.md#security`. `docs/architecture.md` — add `server/features/protocol-adapter/` and `server/features/adapter-runtime/` with one line each and a link. `docs/session-reload.md` — add one paragraph: for provider-connection sessions the reload dialog warns when the connection's route for the CLI changed since the session started (before/now labels; reasoning data of the earlier conversation is not carried over); after the reload the session records and shows the new route.

- [ ] **Step 5: Format and check**

Run: `npx prettier --check docs/providers.md docs/protocol-adapter.md docs/research/provider-compatibility.md docs/sandbox.md docs/architecture.md docs/session-reload.md` (fix with `--write`), then `npm run check:structure`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -m "docs: document protocol adapter routes, options, limits and diagnostics"
```

---

### Task 11: Whole-branch verification

**Files:** none new.

- [ ] **Step 1: Full check**

Run: `npm run check`
Expected: PASS (lint, format, structure, build, backend tests; `shell.test.js` may fail for environment reasons only — confirm it also fails on `main`).

- [ ] **Step 2: All browser specs in both engines**

Run: `npm run build && AGENTPIER_TEST_BROWSER=chromium npm run test:e2e` and `AGENTPIER_TEST_BROWSER=webkit npm run test:e2e`.
Expected: PASS. A WebKit flake is acceptable only if it passes on rerun and is unrelated to changed files. Afterwards `git status --short docs/screenshots` and restore unintended screenshot changes.

- [ ] **Step 3: Manual English pass**

Run `npm run build && npm start` with a disposable `AGENTPIER_DATA_DIR` (see `docs/installation.md` for the variable), switch the UI to English, create a llama.cpp-preset connection against a local fake (any port; the test needs no real model), and confirm: routing lines, disabled choices with reasons, adapter options, images column, connection list labels, launch dialog label. Then switch to German and confirm no English leaks.

- [ ] **Step 4: Commit fixes, if any**, with `fix:` messages naming the behavior.

---

### Task 12: Final cleanup — retire the spec

**Files:**

- Delete: `docs/superpowers/specs/2026-10-07-protocol-adapter-design.md` and this plan, `docs/superpowers/plans/2026-10-08-protocol-adapter-ui.md` (committed in 401c4bb2; AGENTS.md: completed plans and specs go in the final cleanup commit)
- Modify: comments that cite "spec Amendment n": `server/features/adapter-runtime/adapter-request.js:124`, `server/features/protocol-adapter/translate.js:77`, `server/features/protocol-adapter/capabilities.js:14,19,30,219,231` (and its "PR 2" mention at line 3); `docs/research/protocol-adapter-facts.md` (its link to the spec)

- [ ] **Step 1: Find every reference**

Run: `git grep -n -e "protocol-adapter-design" -e "Amendment [0-9]" -e "spec Amendment"`
Expected: only the files listed above plus the spec and this plan themselves (both deleted in Step 4).

- [ ] **Step 2: Replace references** — each comment states the rule itself and points to the matching `docs/protocol-adapter.md` section, e.g. `(see docs/protocol-adapter.md, "Capabilities")`. In `protocol-adapter-facts.md` link to `../protocol-adapter.md` instead of the spec.

- [ ] **Step 3: Check that nothing lasting is lost** — skim the spec sections "Non-goals", "Security", "Observability", "Risks" and Amendments 16–20 against `docs/protocol-adapter.md` and `docs/providers.md`; add any missing rule before deleting.

- [ ] **Step 4: Delete and verify**

```bash
git rm docs/superpowers/specs/2026-10-07-protocol-adapter-design.md
git rm docs/superpowers/plans/2026-10-08-protocol-adapter-ui.md
git grep -n -e "protocol-adapter-design" -e "Amendment [0-9]"
```

Expected: no matches. Run `npm run lint`, `npm run format:check` and `npm run check:structure` (one command each).

- [ ] **Step 5: Commit**

```bash
git add -A docs server
git commit -m "chore: remove the completed protocol adapter spec and plan"
```

- [ ] **Step 6: Open the PR** from `feat/protocol-adapter-ui`: title `feat: protocol adapter UI, auto routes and diagnostics`; body with problem (adapter routes needed explicit API choices and were invisible), resulting behavior (auto fallback, routing section, adapter options with test suggestions, images, `<think>`, labels, reload warning, doctor, docs), the behavior change for existing Chat-, Messages- or Responses-only connections (**[Decision 1]**), validation (suites, both browsers, manual English pass), the five screenshots, known limitations (no upstream proxy; Azure blank `Authorization` unverified; Linux `network.block` nono unverified; adapter give-up needs a reload), and the attribution line.

---

## Self-Review Notes

- Spec coverage: routing select with resolved result (Task 4), capability checkboxes pre-filled by the test (Tasks 3, 5), `thinkTagExtraction` under Advanced/adapter options (Task 5), per-model images tri-state (Task 6), labels in connection list, launch dialog and session view (Task 7), doctor latest summary incl. `supervisor` and generation check (Task 8), compaction-drop visibility (Task 8), cross-route resume warning (Task 7), Azure note in docs and doctor (Tasks 8, 10), `docs/providers.md` and `provider-compatibility.md` (Task 10), English browser tests (Tasks 4–8), flag flip with the pinned tests (Task 1), spec removal (Task 12).
- Pipelines: snapshots already freeze `route` (PR 2); no pipeline UI change is planned. If reviewers want the route shown in the pipeline profile editor, that is a follow-up.
- Decision points: [Decision 1] Task 1, [Decision 2] Task 3/5, [Decision 3] Task 7/8, [Decision 4] Task 7.
