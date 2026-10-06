# Custom Endpoint Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users add self-hosted or third-party model servers (Ollama, llama.cpp, any OpenAI/Anthropic-compatible URL incl. Azure OpenAI) as central provider connections and launch Claude Code, Codex and OpenCode against them.

**Architecture:** A new registry provider `endpoint` whose connection record carries base URLs, protocol flags, auth header and its own model list. Provider ternaries in the launch path are replaced by a per-provider launch description; OpenRouter/Z.ai produce their existing constants, `endpoint` produces values from the connection. An owner-only test route probes protocols and models through a pinned-address HTTP client and returns a proposal the UI saves.

**Tech Stack:** Node.js 22 ES modules, Express, `node:http`/`node:https`/`node:dns`, `smol-toml`, React + Vite, `node:test` + fast-check, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-06-custom-endpoint-providers-design.md`

## Global Constraints

- Worktree: `.worktrees/custom-endpoint-providers`, branch `feat/custom-endpoint-providers`. Never touch the main checkout.
- Commit prefixes `feat:`, `fix:`, `chore:`, `docs:`, `test:`; English messages; end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Source and test files ≤ 600 lines (`npm run check:structure`).
- Prettier: 2 spaces, double quotes, semicolons, trailing commas, 90 columns. Run `npx prettier --write <files>` before each commit.
- Every UI text change: German and English catalogs in the same commit, matching keys and function arity (`tests/unit/i18n-catalogs.test.js`, `tests/unit/server-i18n-catalogs.test.js`). Server messages: `server/lib/i18n/{de,en}/providers.js`; code throws `serverMessages.providers.<key>` (German module `server/lib/i18n/de.js`).
- No new npm dependencies.
- The existing matrix test `tests/matrix/providers-launch.test.js` must pass **without modification** after every task.
- Keys never in argv, written config files, logs, audit entries or API responses.
- Endpoint `http:` allowed only to loopback `127.0.0.0/8`, `::1`; private `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`; link-local `169.254/16`, `fe80::/10`; CGNAT `100.64/10`. Always reject `0.0.0.0/8`, `::`, multicast (`224/4`, `ff00::/8`), broadcast `255.255.255.255`. IPv4-mapped IPv6 normalized first.
- Limits: ≤ 200 models per connection; `contextTokens`/`outputTokens` `null` or integer 1024–10 000 000 with `outputTokens <= contextTokens`; URL ≤ 2048 chars; `authHeader` RFC 7230 token ≤ 64 chars, not `host|content-length|transfer-encoding|connection|cookie`.
- Probe timeouts: 10 s listings, 90 s protocol probes, 180 s total; 1 MB per response; no redirects; one test globally at a time (429 otherwise).
- Claude Code: endpoint models always use the non-Claude path (≥ 2.1.193); custom auth header requires ≥ 2.1.227.
- Fallback output limit everywhere: `outputTokens ?? Math.min(Math.floor(contextTokens / 4), 32000)`.

## Review Focus

1. A user edits a saved endpoint URL to a different host without retyping the key → the save is refused (409), the key is never sent to the new host by test or launch. (Task 5, Task 10 tests.)
2. Ollama model without `num_ctx` → context stays empty, launch is refused with a clear message until the user enters a value; the model maximum is only a hint. (Task 9, Task 7 tests.)
3. Keyless local connection → it is selectable and launchable in the launch dialog and pipeline editor, and restore does not report it as needing login. (Task 12, Task 13, Task 14 tests.)
4. Endpoint unreachable or returning garbage during test → the dialog shows per-protocol failure reasons, previously detected models remain, nothing is saved implicitly. (Task 9, Task 10 tests.)
5. Model ID containing `claude-` served by a LiteLLM endpoint → launched through the non-Claude path with explicit context, never the `[1m]` branch. (Task 7 test.)

---

## File Structure

**Create (server):**

- `server/features/providers/endpoint-config.js` — validation/normalization of the `endpoint` block, presets, origins, tools, model lookup.
- `server/features/providers/endpoint-address.js` — address classification and async target resolution.
- `server/features/providers/endpoint-http.js` — pinned-address bounded JSON HTTP client.
- `server/features/providers/endpoint-models.js` — model listing (generic, Ollama, llama.cpp) and merge.
- `server/features/providers/endpoint-probe.js` — protocol probes, classification, test orchestration.
- `server/features/providers/endpoint-tester.js` — global lock + draft/key resolution for the route.
- `server/features/providers/launch-description.js` — per-provider launch description.
- `server/features/providers/endpoint-launch.js` — Codex/OpenCode config builders for `endpoint`.

**Modify (server):** `provider-definitions.js`, `provider-catalog.js`, `provider-connections.js`, `provider-access.js`, `provider-environment.js`, `provider-launch.js`, `claude-provider.js`, `native-config.js`, `server/features/accounts/account-store.js`, `server/features/pipelines/profile-validation.js`, `server/features/pipelines/native-profile.js`, `server/application/session-lifecycle.js`, `server/application/session-reload-lifecycle.js`, `server/application/services.js`, `server/http/routes/providers.js`, `server/http/routes/provider-connections.js`, `server/features/audit/audit-http.js`, `server/features/mcp/tool-service.js`, `server/features/operations/doctor.js`, `server/features/operations/restore.js`, `server/lib/i18n/{de,en}/providers.js`.

**Create (web):** `web/features/providers/useConnectionModels.js`, `web/features/provider-connections/EndpointFields.jsx`, `EndpointTestResult.jsx`, `EndpointModelTable.jsx`, `useEndpointTest.js`, `endpoint-draft.js`.

**Modify (web):** `ConnectionDialog.jsx`, `ProviderConnections.jsx`, `web/features/sessions/useLaunchAccess.js`, `LaunchAccessFields.jsx`, `web/features/pipelines/ProfileProviderFields.jsx`, `ProfileEditor.jsx`, `web/features/providers/ProviderFields.jsx`, `useAccountProvider.js`, `web/lib/i18n/{de,en}/connections.js`.

**Tests:** new `tests/unit/endpoint-config.test.js`, `tests/property/endpoint-address.test.js`, `tests/unit/endpoint-models.test.js`, `tests/integration/endpoint-probe.test.js`, `tests/integration/endpoint-connections.test.js`, `tests/matrix/endpoint-launch.test.js`, `tests/blackbox/endpoint-routes.test.js`, `tests/browser/endpoint-connections.spec.js`; helper `tests/helpers/endpoint-servers.js`.

**Docs:** `docs/providers.md`, `docs/research/provider-compatibility.md`.

---

### Task 1: Verify OpenCode bundles the OpenAI-compatible SDK

Evidence so far: the installed OpenCode 1.18.33 binary (`~/.opencode/bin/opencode`) contains 281 occurrences of `@ai-sdk/openai-compatible`, which indicates bundling. This task confirms with a real offline launch and records the result.

**Files:**

- Modify: `docs/research/provider-compatibility.md` (append section)

- [ ] **Step 1: Start a fake chat-completions server**

```bash
node -e '
require("http").createServer((q,s)=>{let b="";q.on("data",c=>b+=c);q.on("end",()=>{
console.error(q.method,q.url,q.headers.authorization||"");
s.setHeader("content-type","application/json");
if(q.url.endsWith("/models")) return s.end(JSON.stringify({data:[{id:"fake"}]}));
s.end(JSON.stringify({id:"x",object:"chat.completion",created:0,model:"fake",choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:"pong"}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));});
}).listen(18080,"127.0.0.1")' &
```

- [ ] **Step 2: Run OpenCode against it with npm registry blocked**

```bash
TMP=$(mktemp -d); export XDG_CONFIG_HOME=$TMP/c XDG_DATA_HOME=$TMP/d XDG_STATE_HOME=$TMP/s XDG_CACHE_HOME=$TMP/k
export AGENTPIER_ENDPOINT_API_KEY=probe-key npm_config_registry=http://127.0.0.1:9/
export OPENCODE_CONFIG_CONTENT='{"model":"agentpier-endpoint/fake","provider":{"agentpier-endpoint":{"npm":"@ai-sdk/openai-compatible","name":"Probe","options":{"baseURL":"http://127.0.0.1:18080/v1","apiKey":"{env:AGENTPIER_ENDPOINT_API_KEY}","headers":{"x-probe":"{env:AGENTPIER_ENDPOINT_API_KEY}"}},"models":{"fake":{"name":"fake","limit":{"context":8192,"output":2048}}}}}}'
timeout 60 opencode run --model agentpier-endpoint/fake "say pong"; echo "exit=$?"
```

Expected: output contains `pong`; the fake server logs `POST /v1/chat/completions Bearer probe-key`. Also check the request carried `x-probe: probe-key` by adding `q.headers["x-probe"]` to the log line if unclear.

- [ ] **Step 3: Record result**

Append to `docs/research/provider-compatibility.md`:

```markdown
## OpenCode with OpenAI-compatible endpoints (verified 2026-10-06)

OpenCode 1.18.33 bundles `@ai-sdk/openai-compatible`. A launch with the npm registry
unreachable succeeded against a local Chat Completions server. `{env:NAME}` substitution
works in `options.apiKey` and `options.headers`. No provisioning through installation
scripts is required.
```

If Step 2 fails because the package is fetched from npm, STOP and report to the human partner: the spec then requires provisioning through `scripts/` install and update paths, which is a plan change.

- [ ] **Step 4: Kill the fake server and commit**

```bash
kill %1
git add docs/research/provider-compatibility.md
git commit -m "docs: record OpenCode openai-compatible bundling check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Registry kinds, catalog-provider subset and tool/protocol table

**Files:**

- Modify: `server/features/providers/provider-definitions.js:4-23`
- Modify: `server/features/providers/provider-catalog.js:35-100`
- Modify: `server/http/routes/providers.js:13-19`
- Test: `tests/unit/provider-registry.test.js` (create)

**Interfaces:**

- Produces:
  - `PROVIDERS[id]` fields: `id, name, kind: "catalog"|"endpoint", tools, keyRequired: boolean, responsesGate: boolean`, catalog entries additionally `catalogUrl`, `endpoints: { messages, responses }`, `keyEnv: { codex, opencode }`, `codexName`.
  - `CATALOG_PROVIDERS` (frozen object of catalog entries only).
  - `TOOL_PROTOCOL = { claude: "messages", codex: "responses", opencode: "chatCompletions" }`.
  - `catalogProviderDefinition(id)` — throws `unknownProvider` unless kind `catalog`.
  - `ProviderCatalog.providers()` returns `{id, name, kind, tools}` for all providers.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/provider-registry.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDERS,
  CATALOG_PROVIDERS,
  TOOL_PROTOCOL,
  catalogProviderDefinition,
} from "../../server/features/providers/provider-definitions.js";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";

test("registry separates catalog providers from the endpoint provider", () => {
  assert.equal(PROVIDERS.endpoint.kind, "endpoint");
  assert.equal(PROVIDERS.endpoint.keyRequired, false);
  assert.deepEqual(Object.keys(CATALOG_PROVIDERS), [
    "openrouter",
    "zai",
    "zai-coding-plan",
  ]);
  assert.equal(PROVIDERS.zai.responsesGate, true);
  assert.equal(PROVIDERS.openrouter.responsesGate, false);
  assert.deepEqual(TOOL_PROTOCOL, {
    claude: "messages",
    codex: "responses",
    opencode: "chatCompletions",
  });
  assert.throws(() => catalogProviderDefinition("endpoint"));
});

test("catalog starts with the endpoint provider registered and never lists it", () => {
  const catalog = new ProviderCatalog();
  assert.equal(Object.hasOwn(catalog.status(), "endpoint"), false);
  assert.ok(catalog.list().every((model) => model.providerId !== "endpoint"));
  assert.deepEqual(
    catalog.providers().find((provider) => provider.id === "endpoint"),
    {
      id: "endpoint",
      name: "Custom endpoint",
      kind: "endpoint",
      tools: ["codex", "claude", "opencode"],
    },
  );
  assert.throws(() => catalog.list({ providerId: "endpoint" }), { status: 400 });
  assert.throws(() => catalog.refresh("endpoint"), { status: 400 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/unit/provider-registry.test.js`
Expected: FAIL (`CATALOG_PROVIDERS` not exported).

- [ ] **Step 3: Implement registry**

Replace `PROVIDERS` and add exports in `provider-definitions.js`:

```js
const TOOLS = ["codex", "claude", "opencode"];
export const PROVIDERS = Object.freeze({
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    kind: "catalog",
    tools: TOOLS,
    keyRequired: true,
    responsesGate: false,
    catalogUrl: "https://openrouter.ai/api/v1/models",
    codexName: "OpenRouter",
    endpoints: {
      messages: "https://openrouter.ai/api",
      responses: "https://openrouter.ai/api/v1",
    },
    keyEnv: { codex: "OPENROUTER_API_KEY", opencode: "OPENROUTER_API_KEY" },
  },
  zai: {
    id: "zai",
    name: "Z.ai API",
    kind: "catalog",
    tools: TOOLS,
    keyRequired: true,
    responsesGate: true,
    catalogUrl: "https://models.dev/api.json",
    codexName: "Z.ai",
    endpoints: {
      messages: "https://api.z.ai/api/anthropic",
      responses: "https://api.z.ai/api/v1",
    },
    keyEnv: { codex: "ZAI_API_KEY", opencode: "ZHIPU_API_KEY" },
  },
  "zai-coding-plan": {
    id: "zai-coding-plan",
    name: "Z.ai Coding Plan",
    kind: "catalog",
    tools: TOOLS,
    keyRequired: true,
    responsesGate: true,
    catalogUrl: "https://models.dev/api.json",
    codexName: "Z.ai",
    endpoints: {
      messages: "https://api.z.ai/api/anthropic",
      responses: "https://api.z.ai/api/v1",
    },
    keyEnv: { codex: "ZAI_API_KEY", opencode: "ZHIPU_API_KEY" },
  },
  endpoint: {
    id: "endpoint",
    name: "Custom endpoint",
    kind: "endpoint",
    tools: TOOLS,
    keyRequired: false,
    responsesGate: false,
  },
});
export const CATALOG_PROVIDERS = Object.freeze(
  Object.fromEntries(
    Object.entries(PROVIDERS).filter(([, value]) => value.kind === "catalog"),
  ),
);
export const TOOL_PROTOCOL = Object.freeze({
  claude: "messages",
  codex: "responses",
  opencode: "chatCompletions",
});
export function catalogProviderDefinition(id) {
  const definition = providerDefinition(id);
  if (definition.kind !== "catalog")
    throw problem(serverMessages.providers.unknownProvider);
  return definition;
}
```

Keep `TOOLS` frozen per entry (`tools: [...TOOLS]` is fine; `Object.freeze` on the outer object only matches current behavior).

- [ ] **Step 4: Use `CATALOG_PROVIDERS` in `provider-catalog.js`**

- Import `CATALOG_PROVIDERS, PROVIDERS, catalogProviderDefinition, validModelId`.
- Constructor lines 35-36 and 51: `Object.keys(CATALOG_PROVIDERS)`.
- `providers()`:

```js
providers() {
  return Object.values(PROVIDERS).map(({ id, name, kind, tools }) => ({
    id,
    name,
    kind,
    tools: [...tools],
  }));
}
```

- `list()` line 80: `const ids = providerId ? [catalogProviderDefinition(providerId).id] : Object.keys(CATALOG_PROVIDERS);`
- `get()` line 88 and `refresh()` line 102: `catalogProviderDefinition(...)`.

- [ ] **Step 5: Route tool list from registry**

`server/http/routes/providers.js`:

```js
import { TOOL_PROTOCOL } from "../../features/providers/provider-definitions.js";
// ...
if (tool !== undefined && !Object.hasOwn(TOOL_PROTOCOL, tool))
  throw problem(serverMessages.common.unknownCliTool);
```

- [ ] **Step 6: Run tests**

Run: `node --test tests/unit/provider-registry.test.js tests/matrix/providers-launch.test.js tests/blackbox/provider-routes.test.js tests/property/providers-catalog.test.js tests/integration/providers-accounts.test.js`
Expected: PASS. If `providers-routes` asserts the exact `/providers` payload, extend that assertion with `kind` and the `endpoint` entry (the payload legitimately changed); do not touch `providers-launch.test.js`.

- [ ] **Step 7: Commit**

```bash
npx prettier --write server/features/providers/provider-definitions.js server/features/providers/provider-catalog.js server/http/routes/providers.js tests/unit/provider-registry.test.js
git add -A server tests
git commit -m "feat: register endpoint provider kind beside catalog providers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Endpoint block validation (`endpoint-config.js`)

**Files:**

- Create: `server/features/providers/endpoint-config.js`
- Modify: `server/lib/i18n/de/providers.js`, `server/lib/i18n/en/providers.js`
- Test: `tests/unit/endpoint-config.test.js`

**Interfaces:**

- Consumes: `TOOL_PROTOCOL`, `validModelId` (Task 2).
- Produces:
  - `ENDPOINT_PRESETS: { ollama, llamacpp, custom }` each `{ openaiBaseUrl, anthropicBaseUrl, protocols }`.
  - `normalizeEndpointUrl(value, { optional = false }) → string | null` (syntax only).
  - `validateEndpoint(input) → EndpointBlock` (full normalized block; unknown keys rejected).
  - `endpointOrigins(endpoint) → string[]` (sorted unique origins).
  - `endpointTools(endpoint) → string[]` (tools whose protocol is enabled and whose base URL exists, order `codex, claude, opencode`).
  - `endpointBaseUrl(endpoint, tool) → string | null` (`anthropicBaseUrl` for claude, `openaiBaseUrl` otherwise).
  - `endpointModel(endpoint, modelId, tool) → { providerId: "endpoint", modelId, label, contextTokens, routingContextTokens: null, outputTokens, tools, source: "endpoint", fetchedAt: null }`; throws `endpointProtocolDisabled`, `endpointModelUnknown`, `endpointContextRequired`.
  - `fallbackOutputTokens(contextTokens, outputTokens) → number`.

- [ ] **Step 1: Add server messages (both locales, same keys)**

Append to `server/lib/i18n/en/providers.js` inside the frozen object:

```js
  invalidEndpoint: "Invalid custom endpoint settings.",
  invalidEndpointUrl:
    "Enter an http or https base URL without credentials, query or fragment.",
  invalidEndpointHeader: "The auth header name is not allowed.",
  invalidEndpointModels:
    "Invalid model list: check IDs, duplicates and token limits (1024 to 10,000,000).",
  endpointUrlNotAllowed:
    "This endpoint address is not allowed. Unencrypted http is only allowed for local, private or Tailscale addresses.",
  endpointProtocolDisabled: "This endpoint does not offer the protocol this CLI needs.",
  endpointModelUnknown: "The model is not configured on this endpoint connection.",
  endpointContextRequired:
    "Enter the context size for this model in the endpoint connection before launching it.",
  endpointKeyReentryRequired:
    "The endpoint address changed. Enter the API key again or remove it.",
  endpointTestBusy: "Another endpoint test is running. Try again shortly.",
  endpointTestConnectionInvalid: "Only custom endpoint connections can be tested.",
  endpointClaudeCustomHeaderVersion:
    "Custom auth headers require Claude Code 2.1.227 or later. Update the CLI or use the default header.",
```

German counterparts in `server/lib/i18n/de/providers.js`:

```js
  invalidEndpoint: "Ungültige Einstellungen für den eigenen Endpunkt.",
  invalidEndpointUrl:
    "Gib eine http- oder https-Basis-URL ohne Zugangsdaten, Query oder Fragment an.",
  invalidEndpointHeader: "Dieser Name für den Auth-Header ist nicht erlaubt.",
  invalidEndpointModels:
    "Ungültige Modellliste: Prüfe IDs, Duplikate und Token-Grenzen (1024 bis 10.000.000).",
  endpointUrlNotAllowed:
    "Diese Endpunkt-Adresse ist nicht erlaubt. Unverschlüsseltes http ist nur für lokale, private oder Tailscale-Adressen erlaubt.",
  endpointProtocolDisabled:
    "Dieser Endpunkt bietet das Protokoll nicht an, das diese CLI braucht.",
  endpointModelUnknown: "Das Modell ist in dieser Endpunkt-Verbindung nicht eingetragen.",
  endpointContextRequired:
    "Trage für dieses Modell in der Endpunkt-Verbindung die Kontextgröße ein, bevor du es startest.",
  endpointKeyReentryRequired:
    "Die Endpunkt-Adresse hat sich geändert. Gib den API-Key erneut ein oder entferne ihn.",
  endpointTestBusy: "Ein anderer Endpunkt-Test läuft gerade. Versuche es gleich noch einmal.",
  endpointTestConnectionInvalid: "Nur eigene Endpunkt-Verbindungen können getestet werden.",
  endpointClaudeCustomHeaderVersion:
    "Eigene Auth-Header erfordern Claude Code 2.1.227 oder neuer. Aktualisiere die CLI oder nutze den Standard-Header.",
```

- [ ] **Step 2: Write the failing test**

```js
// tests/unit/endpoint-config.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  ENDPOINT_PRESETS,
  normalizeEndpointUrl,
  validateEndpoint,
  endpointOrigins,
  endpointTools,
  endpointModel,
  fallbackOutputTokens,
} from "../../server/features/providers/endpoint-config.js";

const base = {
  preset: "ollama",
  openaiBaseUrl: "http://127.0.0.1:11434/v1/",
  anthropicBaseUrl: "http://127.0.0.1:11434",
  protocols: { messages: true, responses: false, chatCompletions: true },
  authHeader: null,
  models: [
    {
      modelId: "qwen3-coder:30b",
      label: "Qwen",
      contextTokens: 32768,
      outputTokens: null,
      source: "detected",
      contextEdited: false,
    },
  ],
  lastTest: null,
};

test("normalizes a valid endpoint block", () => {
  const value = validateEndpoint(base);
  assert.equal(value.openaiBaseUrl, "http://127.0.0.1:11434/v1");
  assert.deepEqual(endpointTools(value), ["claude", "opencode"]);
  assert.deepEqual(endpointOrigins(value), ["http://127.0.0.1:11434"]);
});

test("rejects unsafe or malformed URLs syntactically", () => {
  for (const url of [
    "ftp://host/v1",
    "http://user:pw@host/v1",
    "http://host/v1?x=1",
    "http://host/v1#f",
    "not a url",
    `http://host/${"a".repeat(2050)}`,
  ])
    assert.throws(() => normalizeEndpointUrl(url), { status: 400 }, url);
  assert.equal(normalizeEndpointUrl("", { optional: true }), null);
});

test("rejects forbidden auth headers and bad models", () => {
  for (const authHeader of ["Host", "cookie", "bad header", "x".repeat(65), "a\nb"])
    assert.throws(() => validateEndpoint({ ...base, authHeader }), { status: 400 });
  assert.equal(
    validateEndpoint({ ...base, authHeader: "api-key" }).authHeader,
    "api-key",
  );
  const model = base.models[0];
  for (const models of [
    [model, model],
    [{ ...model, contextTokens: 100 }],
    [{ ...model, contextTokens: 4096, outputTokens: 8192 }],
    [{ ...model, modelId: "/abs/path.gguf" }],
    Array.from({ length: 201 }, (_, i) => ({ ...model, modelId: `m${i}` })),
  ])
    assert.throws(() => validateEndpoint({ ...base, models }), { status: 400 });
  assert.throws(() => validateEndpoint({ ...base, extra: 1 }), { status: 400 });
});

test("disabling messages or clearing the anthropic URL removes claude", () => {
  assert.deepEqual(endpointTools(validateEndpoint({ ...base, anthropicBaseUrl: null })), [
    "opencode",
  ]);
});

test("model lookup enforces protocol and context", () => {
  const value = validateEndpoint({
    ...base,
    models: [
      ...base.models,
      { ...base.models[0], modelId: "nocontext", contextTokens: null },
    ],
  });
  assert.equal(endpointModel(value, "qwen3-coder:30b", "claude").contextTokens, 32768);
  assert.throws(() => endpointModel(value, "qwen3-coder:30b", "codex"), /Protokoll/);
  assert.throws(() => endpointModel(value, "missing", "claude"), /nicht eingetragen/);
  assert.throws(() => endpointModel(value, "nocontext", "claude"), /Kontextgröße/);
});

test("presets and output fallback", () => {
  assert.equal(ENDPOINT_PRESETS.llamacpp.protocols.chatCompletions, true);
  assert.equal(ENDPOINT_PRESETS.llamacpp.protocols.messages, false);
  assert.equal(fallbackOutputTokens(32768, null), 8192);
  assert.equal(fallbackOutputTokens(1000000, null), 32000);
  assert.equal(fallbackOutputTokens(32768, 4096), 4096);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/unit/endpoint-config.test.js`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `endpoint-config.js`**

```js
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { TOOL_PROTOCOL, validModelId } from "./provider-definitions.js";

const messages = serverMessages.providers;
const PROTOCOLS = ["messages", "responses", "chatCompletions"];
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "cookie",
]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const BLOCK_KEYS = [
  "preset",
  "openaiBaseUrl",
  "anthropicBaseUrl",
  "protocols",
  "authHeader",
  "models",
  "lastTest",
];
const MODEL_KEYS = [
  "modelId",
  "label",
  "contextTokens",
  "outputTokens",
  "source",
  "contextEdited",
  "contextHint",
];
const STATUSES = ["ok", "unsupported", "failed", "skipped"];

export const ENDPOINT_PRESETS = Object.freeze({
  ollama: {
    openaiBaseUrl: "http://127.0.0.1:11434/v1",
    anthropicBaseUrl: "http://127.0.0.1:11434",
    protocols: { messages: true, responses: true, chatCompletions: true },
  },
  llamacpp: {
    openaiBaseUrl: "http://127.0.0.1:8080/v1",
    anthropicBaseUrl: "http://127.0.0.1:8080",
    protocols: { messages: false, responses: false, chatCompletions: true },
  },
  custom: {
    openaiBaseUrl: "",
    anthropicBaseUrl: null,
    protocols: { messages: false, responses: false, chatCompletions: true },
  },
});

const plainObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const tokens = (value) =>
  value === null || (Number.isInteger(value) && value >= 1024 && value <= 10_000_000);

export function normalizeEndpointUrl(value, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "string" || value.length > 2048 || /[\x00-\x20]/.test(value))
    throw problem(messages.invalidEndpointUrl);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw problem(messages.invalidEndpointUrl);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.includes("?") ||
    value.includes("#")
  )
    throw problem(messages.invalidEndpointUrl);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function model(value) {
  if (!plainObject(value) || Object.keys(value).some((key) => !MODEL_KEYS.includes(key)))
    throw problem(messages.invalidEndpointModels);
  const label = value.label ?? value.modelId;
  if (
    !validModelId(value.modelId) ||
    typeof label !== "string" ||
    !label.trim() ||
    label.length > 200 ||
    !tokens(value.contextTokens ?? null) ||
    !tokens(value.outputTokens ?? null) ||
    (value.contextHint !== undefined && !tokens(value.contextHint)) ||
    (value.outputTokens &&
      value.contextTokens &&
      value.outputTokens > value.contextTokens) ||
    !["detected", "manual"].includes(value.source) ||
    (value.contextEdited !== undefined && typeof value.contextEdited !== "boolean")
  )
    throw problem(messages.invalidEndpointModels);
  return {
    modelId: value.modelId,
    label: label.trim(),
    contextTokens: value.contextTokens ?? null,
    outputTokens: value.outputTokens ?? null,
    source: value.source,
    contextEdited: value.contextEdited === true,
    ...(value.contextHint ? { contextHint: value.contextHint } : {}),
  };
}

function lastTest(value) {
  if (value === null || value === undefined) return null;
  if (
    !plainObject(value) ||
    typeof value.at !== "string" ||
    Number.isNaN(Date.parse(value.at)) ||
    !plainObject(value.protocols) ||
    PROTOCOLS.some((key) => !STATUSES.includes(value.protocols[key])) ||
    (value.reasons !== undefined &&
      (!plainObject(value.reasons) ||
        Object.entries(value.reasons).some(
          ([key, reason]) => !PROTOCOLS.includes(key) || !/^[a-zA-Z]{1,40}$/.test(reason),
        )))
  )
    throw problem(messages.invalidEndpoint);
  return {
    at: value.at,
    protocols: Object.fromEntries(PROTOCOLS.map((key) => [key, value.protocols[key]])),
    reasons: { ...(value.reasons || {}) },
  };
}

export function validateEndpoint(input) {
  if (!plainObject(input) || Object.keys(input).some((key) => !BLOCK_KEYS.includes(key)))
    throw problem(messages.invalidEndpoint);
  if (!Object.hasOwn(ENDPOINT_PRESETS, input.preset))
    throw problem(messages.invalidEndpoint);
  if (
    !plainObject(input.protocols) ||
    Object.keys(input.protocols).some((key) => !PROTOCOLS.includes(key)) ||
    PROTOCOLS.some((key) => typeof input.protocols[key] !== "boolean")
  )
    throw problem(messages.invalidEndpoint);
  const authHeader = input.authHeader ?? null;
  if (
    authHeader !== null &&
    (typeof authHeader !== "string" ||
      !TOKEN.test(authHeader) ||
      FORBIDDEN_HEADERS.has(authHeader.toLowerCase()))
  )
    throw problem(messages.invalidEndpointHeader);
  if (!Array.isArray(input.models) || input.models.length > 200)
    throw problem(messages.invalidEndpointModels);
  const models = input.models.map(model);
  if (new Set(models.map((item) => item.modelId)).size !== models.length)
    throw problem(messages.invalidEndpointModels);
  const anthropicBaseUrl = normalizeEndpointUrl(input.anthropicBaseUrl, {
    optional: true,
  });
  return {
    preset: input.preset,
    openaiBaseUrl: normalizeEndpointUrl(input.openaiBaseUrl),
    anthropicBaseUrl,
    protocols: {
      ...input.protocols,
      messages: input.protocols.messages && !!anthropicBaseUrl,
    },
    authHeader,
    models,
    lastTest: lastTest(input.lastTest),
  };
}

export function endpointOrigins(endpoint) {
  return [
    ...new Set(
      [endpoint.openaiBaseUrl, endpoint.anthropicBaseUrl]
        .filter(Boolean)
        .map((url) => new URL(url).origin),
    ),
  ].sort();
}

export function endpointBaseUrl(endpoint, tool) {
  return tool === "claude" ? endpoint.anthropicBaseUrl : endpoint.openaiBaseUrl;
}

export function endpointTools(endpoint) {
  return ["codex", "claude", "opencode"].filter(
    (tool) => endpoint.protocols[TOOL_PROTOCOL[tool]] && endpointBaseUrl(endpoint, tool),
  );
}

export function fallbackOutputTokens(contextTokens, outputTokens) {
  return outputTokens ?? Math.min(Math.floor(contextTokens / 4), 32000);
}

export function endpointModel(endpoint, modelId, tool) {
  if (!endpointTools(endpoint).includes(tool))
    throw problem(messages.endpointProtocolDisabled, 409);
  const found = endpoint.models.find((item) => item.modelId === modelId);
  if (!found) throw problem(messages.endpointModelUnknown, 409);
  if (!found.contextTokens) throw problem(messages.endpointContextRequired, 409);
  return {
    providerId: "endpoint",
    modelId: found.modelId,
    label: found.label,
    contextTokens: found.contextTokens,
    routingContextTokens: null,
    outputTokens: fallbackOutputTokens(found.contextTokens, found.outputTokens),
    tools: endpointTools(endpoint),
    source: "endpoint",
    fetchedAt: null,
  };
}
```

Note: `validateEndpoint` silently turns `messages` off when no Anthropic URL exists (UI shows it disabled anyway).

- [ ] **Step 5: Run tests**

Run: `node --test tests/unit/endpoint-config.test.js tests/unit/server-i18n-catalogs.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write server/features/providers/endpoint-config.js server/lib/i18n/*/providers.js tests/unit/endpoint-config.test.js
git add server/features/providers/endpoint-config.js server/lib/i18n tests/unit/endpoint-config.test.js
git commit -m "feat: validate custom endpoint connection settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Address policy (`endpoint-address.js`)

**Files:**

- Create: `server/features/providers/endpoint-address.js`
- Test: `tests/property/endpoint-address.test.js`

**Interfaces:**

- Produces:
  - `classifyAddress(ip: string) → "loopback"|"private"|"linkLocal"|"cgnat"|"public"|"forbidden"`.
  - `async resolveEndpointTarget(url: string, { lookup }) → { hostname, address, family }` — throws `problem(endpointUrlNotAllowed, 400)` when any resolved address is forbidden, or when `http:` and any address is `public`. Returns the first allowed address for pinning. `lookup` defaults to `dns.promises.lookup` and is called as `lookup(hostname, { all: true, verbatim: true })`.

- [ ] **Step 1: Write the failing property test**

```js
// tests/property/endpoint-address.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  classifyAddress,
  resolveEndpointTarget,
} from "../../server/features/providers/endpoint-address.js";

const octet = fc.integer({ min: 0, max: 255 });
const ipv4 = fc.tuple(octet, octet, octet, octet).map((parts) => parts.join("."));
const local = (ip) =>
  ["loopback", "private", "linkLocal", "cgnat"].includes(classifyAddress(ip));

test("known ranges classify correctly", () => {
  for (const [ip, kind] of [
    ["127.0.0.1", "loopback"],
    ["::1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.1", "private"],
    ["169.254.1.1", "linkLocal"],
    ["fe80::1", "linkLocal"],
    ["fd12::1", "private"],
    ["100.64.0.1", "cgnat"],
    ["100.127.255.255", "cgnat"],
    ["100.128.0.1", "public"],
    ["8.8.8.8", "public"],
    ["0.0.0.0", "forbidden"],
    ["::", "forbidden"],
    ["224.0.0.1", "forbidden"],
    ["255.255.255.255", "forbidden"],
    ["ff02::1", "forbidden"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:8.8.8.8", "public"],
    ["2001:4860::8888", "public"],
  ])
    assert.equal(classifyAddress(ip), kind, ip);
});

test("mapped IPv6 always classifies like its IPv4 address", () => {
  fc.assert(
    fc.property(ipv4, (ip) => classifyAddress(`::ffff:${ip}`) === classifyAddress(ip)),
  );
});

test("http never reaches a public address; https may", async () => {
  await fc.assert(
    fc.asyncProperty(ipv4, async (ip) => {
      const lookup = async () => [{ address: ip, family: 4 }];
      const kind = classifyAddress(ip);
      const http = resolveEndpointTarget("http://model.example:8080/v1", { lookup });
      if (local(ip)) assert.equal((await http).address, ip);
      else await assert.rejects(http, { status: 400 });
      const https = resolveEndpointTarget("https://model.example/v1", { lookup });
      if (kind === "forbidden") await assert.rejects(https, { status: 400 });
      else assert.equal((await https).address, ip);
    }),
  );
});

test("one public address among private ones blocks http", async () => {
  const lookup = async () => [
    { address: "10.0.0.2", family: 4 },
    { address: "8.8.8.8", family: 4 },
  ];
  await assert.rejects(resolveEndpointTarget("http://mixed.example/v1", { lookup }), {
    status: 400,
  });
});

test("IP literals do not call DNS", async () => {
  const lookup = async () => assert.fail("lookup called");
  assert.equal(
    (await resolveEndpointTarget("http://[::1]:11434/v1", { lookup })).address,
    "::1",
  );
  assert.equal(
    (await resolveEndpointTarget("http://192.168.0.5/v1", { lookup })).address,
    "192.168.0.5",
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/property/endpoint-address.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
import dns from "node:dns";
import net from "node:net";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

function ipv4Number(ip) {
  return ip.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}
function inV4(ip, base, bits) {
  const mask = bits === 0 ? 0 : 2 ** 32 - 2 ** (32 - bits);
  return (ipv4Number(ip) & mask) >>> 0 === (ipv4Number(base) & mask) >>> 0;
}
function expandV6(ip) {
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = ip.includes("::") ? 8 - left.length - right.length : 0;
  return [...left, ...Array(fill).fill("0"), ...right].map((part) =>
    parseInt(part || "0", 16),
  );
}
function classifyV4(ip) {
  if (inV4(ip, "0.0.0.0", 8) || inV4(ip, "224.0.0.0", 4) || ip === "255.255.255.255")
    return "forbidden";
  if (inV4(ip, "127.0.0.0", 8)) return "loopback";
  if (
    inV4(ip, "10.0.0.0", 8) ||
    inV4(ip, "172.16.0.0", 12) ||
    inV4(ip, "192.168.0.0", 16)
  )
    return "private";
  if (inV4(ip, "169.254.0.0", 16)) return "linkLocal";
  if (inV4(ip, "100.64.0.0", 10)) return "cgnat";
  return "public";
}
export function classifyAddress(input) {
  const ip = input.replace(/^\[|\]$/g, "").split("%")[0];
  if (net.isIPv4(ip)) return classifyV4(ip);
  if (!net.isIPv6(ip)) return "forbidden";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return classifyV4(mapped[1]);
  const words = expandV6(ip);
  if (words.every((word) => word === 0)) return "forbidden";
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return "loopback";
  if ((words[0] & 0xff00) === 0xff00) return "forbidden";
  if ((words[0] & 0xfe00) === 0xfc00) return "private";
  if ((words[0] & 0xffc0) === 0xfe80) return "linkLocal";
  return "public";
}
const LOCAL = new Set(["loopback", "private", "linkLocal", "cgnat"]);
export async function resolveEndpointTarget(
  value,
  { lookup = dns.promises.lookup } = {},
) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => {
        throw problem(serverMessages.providers.endpointUrlNotAllowed);
      });
  const kinds = addresses.map(({ address }) => classifyAddress(address));
  if (
    !addresses.length ||
    kinds.includes("forbidden") ||
    (url.protocol === "http:" && kinds.some((kind) => !LOCAL.has(kind)))
  )
    throw problem(serverMessages.providers.endpointUrlNotAllowed);
  return { hostname, address: addresses[0].address, family: addresses[0].family };
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/property/endpoint-address.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/features/providers/endpoint-address.js tests/property/endpoint-address.test.js
git add server/features/providers/endpoint-address.js tests/property/endpoint-address.test.js
git commit -m "feat: classify endpoint target addresses

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Connection storage for endpoints, key binding and public view

**Files:**

- Modify: `server/features/providers/provider-connections.js`
- Test: `tests/integration/endpoint-connections.test.js` (create)

**Interfaces:**

- Consumes: `validateEndpoint`, `endpointOrigins`, `endpointTools` (Task 3); `PROVIDERS[id].keyRequired`, `responsesGate` (Task 2).
- Produces:
  - `ProviderConnections.create({ name, providerId: "endpoint", endpoint, apiKey? })`.
  - `ProviderConnections.update(id, { name?, endpoint?, apiKey?, removeApiKey? })` → 409 `endpointKeyReentryRequired` when origins change while a key is stored and neither `apiKey` nor `removeApiKey` is given.
  - `public(record)` adds `launchable: boolean`, and for endpoint `endpoint` (the validated block). `tools` for endpoint = `endpointTools(record.endpoint)`.
  - `ProviderConnections.record(id)` (already exists) returns the raw record including `endpoint` — used by launch.
  - `ProviderConnections.invalid: string[]` ids of records skipped at load because their endpoint block failed validation.

- [ ] **Step 1: Write the failing test**

```js
// tests/integration/endpoint-connections.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";

export const ollama = {
  preset: "ollama",
  openaiBaseUrl: "http://127.0.0.1:11434/v1",
  anthropicBaseUrl: "http://127.0.0.1:11434",
  protocols: { messages: true, responses: true, chatCompletions: true },
  authHeader: null,
  models: [
    {
      modelId: "qwen3",
      label: "qwen3",
      contextTokens: 32768,
      outputTokens: null,
      source: "detected",
      contextEdited: false,
    },
  ],
  lastTest: null,
};
function store(t) {
  const dataDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-endpoint-")),
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, connections: new ProviderConnections({ dataDir }) };
}

test("keyless endpoint connection is launchable and exposes its tools", (t) => {
  const { connections } = store(t);
  const created = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: ollama,
  });
  assert.equal(created.hasSecret, false);
  assert.equal(created.launchable, true);
  assert.deepEqual(created.tools, ["codex", "claude", "opencode"]);
  assert.equal(created.endpoint.models[0].modelId, "qwen3");
  assert.equal(created.responsesAccess, undefined);
});

test("catalog connections without key are not launchable", (t) => {
  const { connections } = store(t);
  assert.equal(
    connections.create({ name: "R", providerId: "openrouter" }).launchable,
    false,
  );
  assert.throws(
    () => connections.create({ name: "R", providerId: "openrouter", endpoint: ollama }),
    { status: 400 },
  );
});

test("changing the origin requires key re-entry or removal", (t) => {
  const { connections } = store(t);
  const { id } = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: ollama,
    apiKey: "secret-1",
  });
  const moved = {
    ...ollama,
    openaiBaseUrl: "http://10.0.0.9:11434/v1",
    anthropicBaseUrl: "http://10.0.0.9:11434",
  };
  assert.throws(() => connections.update(id, { endpoint: moved }), { status: 409 });
  assert.equal(connections.secret(id).apiKey, "secret-1");
  // Path-only change keeps the key.
  connections.update(id, {
    endpoint: { ...ollama, openaiBaseUrl: "http://127.0.0.1:11434/api/v1" },
  });
  assert.equal(connections.secret(id).apiKey, "secret-1");
  connections.update(id, { endpoint: moved, apiKey: "secret-2" });
  assert.equal(connections.secret(id).apiKey, "secret-2");
  connections.update(id, { endpoint: ollama, removeApiKey: true });
  assert.equal(connections.secret(id), null);
});

test("invalid stored endpoint records are skipped, not fatal", (t) => {
  const { dataDir, connections } = store(t);
  const good = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: ollama,
  });
  const file = path.join(dataDir, "provider-connections.json");
  const records = JSON.parse(fs.readFileSync(file, "utf8"));
  records.push({
    ...records[0],
    id: "00000000-0000-4000-8000-000000000000",
    endpoint: { preset: "bad" },
  });
  fs.writeFileSync(file, JSON.stringify(records));
  const reloaded = new ProviderConnections({ dataDir });
  assert.deepEqual(
    reloaded.list().map((item) => item.id),
    [good.id],
  );
  assert.deepEqual(reloaded.invalid, ["00000000-0000-4000-8000-000000000000"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/integration/endpoint-connections.test.js`
Expected: FAIL (`endpoint` rejected as unknown field).

- [ ] **Step 3: Implement in `provider-connections.js`**

1. Imports: `import { PROVIDERS, providerDefinition } from "./provider-definitions.js";` and `import { endpointOrigins, endpointTools, validateEndpoint } from "./endpoint-config.js";`.
2. `inputValue(input, creation)`: add `"endpoint"` to `allowed`.
3. Constructor, after reading records:

```js
this.invalid = [];
this.records = this.records.filter((record) => {
  if (record.providerId !== "endpoint") return true;
  try {
    record.endpoint = validateEndpoint(record.endpoint);
    return true;
  } catch {
    this.invalid.push(record.id);
    return false;
  }
});
```

Invalid records stay on disk untouched until the next `save()` — to avoid silently deleting them, `save()` writes `[...this.records, ...this.skipped]` where `this.skipped` holds the raw invalid records:

```js
    this.skipped = [];
    // inside the catch: this.skipped.push(record);
  save() {
    writePrivate(this.file, [...this.records, ...this.skipped]);
  }
```

4. `public(record)`:

```js
  public(record) {
    const definition = providerDefinition(record.providerId);
    const hasSecret = !!this.secret(record.id)?.apiKey;
    const endpoint = definition.kind === "endpoint";
    return {
      id: record.id,
      name: record.name,
      providerId: record.providerId,
      hasSecret,
      launchable: hasSecret || !definition.keyRequired,
      tools: endpoint
        ? endpointTools(record.endpoint)
        : definition.tools.filter(
            (tool) => tool !== "codex" || !definition.responsesGate || record.responsesAccess === true,
          ),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(definition.responsesGate ? { responsesAccess: record.responsesAccess === true } : {}),
      ...(endpoint ? { endpoint: structuredClone(record.endpoint) } : {}),
    };
  }
```

5. `create(input)`:

```js
    const definition = providerDefinition(input.providerId);
    if (!definition.responsesGate && input.responsesAccess !== undefined)
      throw problem(serverMessages.providers.responsesEntitlementZaiOnly);
    if ((definition.kind === "endpoint") !== (input.endpoint !== undefined))
      throw problem(serverMessages.providers.invalidConnectionFields);
    // record:
      ...(definition.responsesGate ? { responsesAccess: input.responsesAccess === true } : {}),
      ...(definition.kind === "endpoint" ? { endpoint: validateEndpoint(input.endpoint) } : {}),
```

6. `update(id, input)`:

```js
const definition = providerDefinition(current.providerId);
if (!definition.responsesGate && input.responsesAccess !== undefined)
  throw problem(serverMessages.providers.responsesEntitlementZaiOnly);
if (input.endpoint !== undefined && definition.kind !== "endpoint")
  throw problem(serverMessages.providers.invalidConnectionFields);
const endpoint =
  input.endpoint !== undefined ? validateEndpoint(input.endpoint) : current.endpoint;
if (
  endpoint &&
  this.secret(id)?.apiKey &&
  !key &&
  !input.removeApiKey &&
  JSON.stringify(endpointOrigins(endpoint)) !==
    JSON.stringify(endpointOrigins(current.endpoint))
)
  throw problem(serverMessages.providers.endpointKeyReentryRequired, 409);
const record = {
  ...current,
  ...(input.name !== undefined ? { name: nameValue(input.name) } : {}),
  ...(input.responsesAccess !== undefined
    ? { responsesAccess: input.responsesAccess }
    : {}),
  ...(endpoint ? { endpoint } : {}),
  updatedAt: new Date().toISOString(),
};
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/integration/endpoint-connections.test.js tests/integration/provider-connections.test.js tests/property/provider-connections.test.js tests/blackbox/provider-connections.test.js`
Expected: PASS. If an existing test deep-equals the public view, add `launchable` to its expected object (legitimate new field).

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/features/providers/provider-connections.js tests/integration/endpoint-connections.test.js
git add server/features/providers/provider-connections.js tests
git commit -m "feat: store custom endpoint connections with host-bound keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Provider selection dispatch, access resolution and pipeline snapshots

**Files:**

- Modify: `server/features/providers/provider-definitions.js:42-64` (`validateProviderSelection`)
- Modify: `server/features/providers/provider-access.js:30-44`
- Modify: `server/features/pipelines/profile-validation.js:37-63`
- Modify: `server/features/pipelines/native-profile.js:36-58`
- Test: `tests/integration/endpoint-connections.test.js` (extend), `tests/matrix/pipeline-central-profiles.test.js` (run only)

**Interfaces:**

- Consumes: `endpointModel` (Task 3), connection `record()` (Task 5).
- Produces:
  - `validateProviderSelection(value, tool, catalog, { endpoint } = {})` — for `kind === "endpoint"` validates via `endpointModel(endpoint, modelId, tool)` (throws if `endpoint` missing), returns `{ id: "endpoint", modelId }`.
  - `endpointSnapshot(endpoint, modelIds) → { origins, protocols, models: { [id]: { contextTokens, outputTokens } } }` exported from `profile-validation.js`.
  - `profileConnection()` returns for endpoint `{ id, providerId: "endpoint", endpoint: endpointSnapshot(...) }`.

- [ ] **Step 1: Extend the failing test**

Append to `tests/integration/endpoint-connections.test.js`:

```js
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { ProviderAccess } from "../../server/features/providers/provider-access.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { profileConnection } from "../../server/features/pipelines/profile-validation.js";

function full(t) {
  const { dataDir, connections } = store(t);
  const providerCatalog = new ProviderCatalog({ dataDir });
  const accounts = new AccountStore({
    dataDir,
    home: dataDir,
    providerCatalog,
    providerConnections: connections,
  });
  return {
    connections,
    accounts,
    access: new ProviderAccess({ accounts, connections, providerCatalog }),
  };
}

test("keyless endpoint resolves to an internal account with only id and model", (t) => {
  const { connections, access } = full(t);
  const { id } = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: ollama,
  });
  const resolved = access.resolve({
    tool: "claude",
    providerConnectionId: id,
    providerModelId: "qwen3",
  });
  assert.deepEqual(resolved.account.provider, { id: "endpoint", modelId: "qwen3" });
  assert.equal(resolved.selection.providerId, "endpoint");
  assert.throws(
    () =>
      access.resolve({
        tool: "claude",
        providerConnectionId: id,
        providerModelId: "nope",
      }),
    { status: 409 },
  );
});

test("endpoint pipeline snapshot covers origins, protocols and selected model limits only", (t) => {
  const { connections, accounts } = full(t);
  const { id } = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: ollama,
  });
  const snapshot = profileConnection(
    { providerConnectionId: id, cliTool: "opencode", models: { available: ["qwen3"] } },
    accounts,
  );
  assert.deepEqual(snapshot, {
    id,
    providerId: "endpoint",
    endpoint: {
      origins: ["http://127.0.0.1:11434"],
      protocols: ollama.protocols,
      models: { qwen3: { contextTokens: 32768, outputTokens: null } },
    },
  });
  connections.update(id, {
    endpoint: {
      ...ollama,
      lastTest: {
        at: new Date().toISOString(),
        protocols: { messages: "ok", responses: "ok", chatCompletions: "ok" },
        reasons: {},
      },
    },
  });
  assert.deepEqual(
    profileConnection(
      { providerConnectionId: id, cliTool: "opencode", models: { available: ["qwen3"] } },
      accounts,
    ),
    snapshot,
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/integration/endpoint-connections.test.js`
Expected: FAIL (`apiKeyRequiredForSession` or `unknownProvider`).

- [ ] **Step 3: Implement `validateProviderSelection`**

```js
export function validateProviderSelection(value, tool, catalog, { endpoint } = {}) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["id", "modelId", "responsesAccess"].includes(key))
  )
    throw problem(serverMessages.providers.invalidProviderSelection);
  const definition = providerDefinition(value.id);
  if (!definition.tools.includes(tool))
    throw problem(serverMessages.providers.providerToolUnsupported);
  if (definition.kind === "endpoint") {
    if (!endpoint || value.responsesAccess !== undefined)
      throw problem(serverMessages.providers.invalidProviderSelection);
    if (!validModelId(value.modelId))
      throw problem(serverMessages.providers.invalidModelId);
    endpointModel(endpoint, value.modelId, tool);
    return { id: value.id, modelId: value.modelId };
  }
  catalog.get(value.id, value.modelId, { tool });
  const requiresResponses = tool === "codex" && definition.responsesGate;
  // ...unchanged remainder...
}
```

Import `endpointModel` from `./endpoint-config.js`. `endpoint-config.js` imports `TOOL_PROTOCOL, validModelId` from `provider-definitions.js` — this is a circular import; it is safe because both modules only use each other's exports inside functions. Confirm by running the test.

- [ ] **Step 4: `provider-access.js`**

```js
const connection = this.connections.get(body.providerConnectionId);
if (!connection.launchable)
  throw problem(serverMessages.providers.apiKeyRequiredForSession, 409);
if (!connection.tools.includes(source.tool))
  throw problem(serverMessages.providers.connectionToolUnsupported);
const definition = providerDefinition(connection.providerId);
const provider = validateProviderSelection(
  {
    id: connection.providerId,
    modelId: body.providerModelId,
    ...(source.tool === "codex" && definition.responsesGate
      ? { responsesAccess: connection.responsesAccess }
      : {}),
  },
  source.tool,
  this.catalog,
  { endpoint: connection.endpoint },
);
```

Import `providerDefinition`.

- [ ] **Step 5: `profile-validation.js`**

```js
import { endpointOrigins } from "../providers/endpoint-config.js";
import { providerDefinition } from "../providers/provider-definitions.js";

export function endpointSnapshot(endpoint, modelIds) {
  return {
    origins: endpointOrigins(endpoint),
    protocols: { ...endpoint.protocols },
    models: Object.fromEntries(
      modelIds.map((id) => {
        const model = endpoint.models.find((item) => item.modelId === id);
        return [
          id,
          { contextTokens: model.contextTokens, outputTokens: model.outputTokens },
        ];
      }),
    ),
  };
}

export function profileConnection(config, accounts) {
  if (config.providerConnectionId === undefined) return null;
  if (!accounts.providerConnections)
    throw problem(serverMessages.pipelineProfiles.connectionsUnavailable, 409);
  const connection = accounts.providerConnections.get(config.providerConnectionId);
  if (!connection.tools.includes(config.cliTool))
    throw problem(serverMessages.pipelineProfiles.connectionUnsupported);
  const gate =
    config.cliTool === "codex" && providerDefinition(connection.providerId).responsesGate;
  for (const modelId of config.models.available)
    validateProviderSelection(
      {
        id: connection.providerId,
        modelId,
        ...(gate ? { responsesAccess: connection.responsesAccess } : {}),
      },
      config.cliTool,
      accounts.providerCatalog,
      { endpoint: connection.endpoint },
    );
  return {
    id: connection.id,
    providerId: connection.providerId,
    ...(gate ? { responsesAccess: connection.responsesAccess } : {}),
    ...(connection.endpoint
      ? { endpoint: endpointSnapshot(connection.endpoint, config.models.available) }
      : {}),
  };
}
```

- [ ] **Step 6: `native-profile.js` — narrow the frozen snapshot to the launched model**

`validateProfileLaunch` computes `connection` for `[modelId]` only, while the stored snapshot covers all available models. Compare against the snapshot narrowed to the same model:

```js
function narrowed(snapshot, modelId) {
  if (!snapshot?.endpoint) return snapshot;
  return {
    ...snapshot,
    endpoint: {
      ...snapshot.endpoint,
      models: Object.hasOwn(snapshot.endpoint.models, modelId)
        ? { [modelId]: snapshot.endpoint.models[modelId] }
        : {},
    },
  };
}
// in validateProfileLaunch:
    (profile.providerConnectionSnapshot &&
      !isDeepStrictEqual(connection, narrowed(profile.providerConnectionSnapshot, modelId))) ||
```

- [ ] **Step 7: Run tests**

Run: `node --test tests/integration/endpoint-connections.test.js tests/matrix/pipeline-central-profiles.test.js tests/matrix/pipeline-provider-model.test.js tests/blackbox/provider-session-access.test.js tests/matrix/providers-launch.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npx prettier --write server/features/providers/provider-definitions.js server/features/providers/provider-access.js server/features/pipelines/profile-validation.js server/features/pipelines/native-profile.js tests/integration/endpoint-connections.test.js
git add server tests
git commit -m "feat: resolve endpoint connections for sessions and pipelines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Launch description and endpoint launch for all three CLIs

**Files:**

- Create: `server/features/providers/launch-description.js`
- Create: `server/features/providers/endpoint-launch.js`
- Modify: `server/features/providers/provider-environment.js`
- Modify: `server/features/providers/provider-launch.js`
- Modify: `server/features/providers/claude-provider.js`
- Modify: `server/features/providers/native-config.js` (rename `glmCodexCatalog` → `codexModelCatalog`)
- Modify: `server/features/accounts/account-store.js:309-383`
- Test: `tests/matrix/endpoint-launch.test.js` (create)

**Interfaces:**

- Consumes: Tasks 2, 3, 5, 6.
- Produces:
  - `launchDescription(account, { catalog, endpoint }) → { providerKey, displayName, kind, endpoints: { messages, responses, chatCompletions }, auth: { keyEnv, header, required }, model }` where for catalog providers `keyEnv` is `PROVIDERS[id].keyEnv[tool]` (claude: `null`, it uses `ANTHROPIC_AUTH_TOKEN`), `header: null`; for endpoint `providerKey: "agentpier-endpoint"`, `keyEnv: "AGENTPIER_ENDPOINT_API_KEY"`, `header: endpoint.authHeader`, `model = endpointModel(...)`.
  - `prepareProviderLaunch(account, secret, launch, { root, catalog, cliVersion, endpoint })` — `endpoint` is the current connection's validated block (required for `endpoint` accounts).
  - `configureClaudeProvider(launch, metadata, cliVersion, { forceCustom = false, customHeader = null } = {})`.
  - `codexModelCatalog(model, { description, reasoning })`.

- [ ] **Step 1: Write the failing matrix test**

```js
// tests/matrix/endpoint-launch.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { prepareProviderLaunch } from "../../server/features/providers/provider-launch.js";
import { validateEndpoint } from "../../server/features/providers/endpoint-config.js";

const catalog = new ProviderCatalog();
const endpointBlock = (overrides = {}) =>
  validateEndpoint({
    preset: "custom",
    openaiBaseUrl: "https://llm.example/v1",
    anthropicBaseUrl: "https://llm.example",
    protocols: { messages: true, responses: true, chatCompletions: true },
    authHeader: null,
    models: [
      {
        modelId: "qwen3-coder:30b",
        label: "Qwen",
        contextTokens: 65536,
        outputTokens: null,
        source: "manual",
        contextEdited: true,
      },
      {
        modelId: "claude-proxy",
        label: "Proxy",
        contextTokens: 200000,
        outputTokens: 16000,
        source: "manual",
        contextEdited: true,
      },
    ],
    lastTest: null,
    ...overrides,
  });
function launch(
  t,
  tool,
  {
    key = "endpoint-secret",
    endpoint = endpointBlock(),
    modelId = "qwen3-coder:30b",
    cliVersion = "2.1.263",
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-endpoint-launch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = prepareProviderLaunch(
    { kind: "managed", tool, provider: { id: "endpoint", modelId } },
    key ? { apiKey: key } : null,
    {
      command: `/opt/${tool}`,
      args: [],
      env: {
        PATH: "/bin",
        HOME: root,
        AGENTPIER_ENDPOINT_API_KEY: "inherited",
        OPENAI_API_KEY: "x",
      },
    },
    { root, catalog, cliVersion, endpoint },
  );
  const files = [];
  const walk = (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .forEach((entry) =>
        entry.isDirectory()
          ? walk(path.join(dir, entry.name))
          : files.push(fs.readFileSync(path.join(dir, entry.name), "utf8")),
      );
  walk(root);
  if (key) {
    assert.equal(JSON.stringify(result.args).includes(key), false, "key in argv");
    assert.equal(
      files.some((content) => content.includes(key)),
      false,
      "key in config files",
    );
  }
  assert.equal(result.env.OPENAI_API_KEY, undefined);
  assert.equal(result.provider.modelChangeRequiresRestart, true);
  return result;
}

for (const key of ["endpoint-secret", null])
  for (const header of [null, "api-key"]) {
    const label = `${key ? "key" : "no key"} / ${header || "default header"}`;
    test(`claude endpoint launch ${label}`, (t) => {
      const result = launch(t, "claude", {
        key,
        endpoint: endpointBlock({ authHeader: header }),
      });
      assert.equal(result.env.ANTHROPIC_BASE_URL, "https://llm.example");
      assert.equal(result.env.ANTHROPIC_API_KEY, "");
      assert.equal(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "65536");
      assert.equal(result.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "16384");
      assert.equal(result.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, "1");
      assert.equal(result.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, undefined);
      if (key && !header) assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, key);
      else assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, "agentpier-endpoint");
      assert.equal(
        result.env.ANTHROPIC_CUSTOM_HEADERS,
        key && header ? `api-key: ${key}` : undefined,
      );
    });
    test(`codex endpoint launch ${label}`, (t) => {
      const result = launch(t, "codex", {
        key,
        endpoint: endpointBlock({ authHeader: header }),
      });
      const config = parseToml(
        fs.readFileSync(path.join(result.env.CODEX_HOME, "config.toml"), "utf8"),
      );
      const provider = config.model_providers["agentpier-endpoint"];
      assert.equal(config.model_provider, "agentpier-endpoint");
      assert.equal(provider.base_url, "https://llm.example/v1");
      assert.equal(provider.wire_api, "responses");
      assert.equal(provider.requires_openai_auth, false);
      assert.equal(config.model_context_window, 65536);
      assert.equal(
        provider.env_key,
        key && !header ? "AGENTPIER_ENDPOINT_API_KEY" : undefined,
      );
      assert.deepEqual(
        provider.env_http_headers,
        key && header ? { "api-key": "AGENTPIER_ENDPOINT_API_KEY" } : undefined,
      );
      assert.equal(result.env.AGENTPIER_ENDPOINT_API_KEY, key || undefined);
      const catalogJson = JSON.parse(fs.readFileSync(config.model_catalog_json, "utf8"));
      assert.equal(catalogJson.models[0].context_window, 65536);
      assert.deepEqual(result.args.slice(-2), ["--model", "qwen3-coder:30b"]);
    });
    test(`opencode endpoint launch ${label}`, (t) => {
      const result = launch(t, "opencode", {
        key,
        endpoint: endpointBlock({ authHeader: header }),
      });
      const config = JSON.parse(result.env.OPENCODE_CONFIG_CONTENT);
      const provider = config.provider["agentpier-endpoint"];
      assert.equal(config.model, "agentpier-endpoint/qwen3-coder:30b");
      assert.equal(provider.npm, "@ai-sdk/openai-compatible");
      assert.equal(provider.options.baseURL, "https://llm.example/v1");
      assert.equal(
        provider.options.apiKey,
        key ? "{env:AGENTPIER_ENDPOINT_API_KEY}" : undefined,
      );
      assert.deepEqual(
        provider.options.headers,
        key && header ? { "api-key": "{env:AGENTPIER_ENDPOINT_API_KEY}" } : undefined,
      );
      assert.deepEqual(provider.models["qwen3-coder:30b"].limit, {
        context: 65536,
        output: 16384,
      });
    });
  }

test("claude-named endpoint model takes the non-Claude path", (t) => {
  const result = launch(t, "claude", { modelId: "claude-proxy" });
  assert.equal(result.provider.cliModelId, "claude-proxy");
  assert.equal(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "200000");
  assert.equal(result.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "16000");
});

test("custom header on old Claude Code is refused; old version without header works", (t) => {
  assert.throws(
    () =>
      launch(t, "claude", {
        endpoint: endpointBlock({ authHeader: "api-key" }),
        cliVersion: "2.1.226",
      }),
    /2\.1\.227/,
  );
  assert.equal(
    launch(t, "claude", { cliVersion: "2.1.200" }).env.ANTHROPIC_AUTH_TOKEN,
    "endpoint-secret",
  );
});

test("disabled protocol refuses the launch", (t) => {
  const endpoint = endpointBlock({
    protocols: { messages: true, responses: false, chatCompletions: true },
  });
  assert.throws(() => launch(t, "codex", { endpoint }), { status: 409 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/matrix/endpoint-launch.test.js`
Expected: FAIL (`apiKeyRequiredForAccount` / unknown endpoint handling).

- [ ] **Step 3: `launch-description.js`**

```js
import { PROVIDERS, validateProviderSelection } from "./provider-definitions.js";
import { endpointModel } from "./endpoint-config.js";

export function launchDescription(account, { catalog, endpoint }) {
  const selection = validateProviderSelection(account.provider, account.tool, catalog, {
    endpoint,
  });
  const definition = PROVIDERS[selection.id];
  if (definition.kind === "endpoint")
    return {
      kind: "endpoint",
      selection,
      providerKey: "agentpier-endpoint",
      displayName: "Custom endpoint",
      endpoints: {
        messages: endpoint.anthropicBaseUrl,
        responses: endpoint.openaiBaseUrl,
        chatCompletions: endpoint.openaiBaseUrl,
      },
      auth: {
        keyEnv: "AGENTPIER_ENDPOINT_API_KEY",
        header: endpoint.authHeader,
        required: false,
      },
      model: endpointModel(endpoint, selection.modelId, account.tool),
    };
  return {
    kind: "catalog",
    selection,
    providerKey: selection.id,
    displayName: definition.codexName,
    endpoints: { ...definition.endpoints, chatCompletions: null },
    auth: {
      keyEnv: definition.keyEnv[account.tool] || null,
      header: null,
      required: true,
    },
    model: catalog.get(selection.id, selection.modelId, { tool: account.tool }),
  };
}
```

- [ ] **Step 4: `provider-environment.js` reads the description**

```js
export function providerEnvironment(account, secret, environment, root, description) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (
      /^(ANTHROPIC_|OPENAI_|OPENROUTER_|ZAI_|ZHIPU_|AGENTPIER_ENDPOINT_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_MAX_CONTEXT|CLAUDE_CODE_DISABLE_1M|CLAUDE_CODE_SUBAGENT_MODEL|CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)/.test(
        key,
      ) ||
      key === "DISABLE_COMPACT"
    )
      delete env[key];
  }
  const directory = path.join(root, "providers", account.provider.id);
  const key = secret?.apiKey?.trim() || null;
  if (account.tool === "codex") {
    env.CODEX_HOME = privateDirectory(path.join(directory, "codex"));
    if (key) env[description.auth.keyEnv] = key;
  } else if (account.tool === "claude") {
    env.CLAUDE_CONFIG_DIR = privateDirectory(path.join(directory, "claude"));
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
    env.ANTHROPIC_BASE_URL = description.endpoints.messages;
    env.ANTHROPIC_API_KEY = "";
    if (description.kind === "catalog") {
      if (key) env.ANTHROPIC_AUTH_TOKEN = key;
    } else if (key && !description.auth.header) env.ANTHROPIC_AUTH_TOKEN = key;
    else {
      env.ANTHROPIC_AUTH_TOKEN = "agentpier-endpoint";
      if (key) env.ANTHROPIC_CUSTOM_HEADERS = `${description.auth.header}: ${key}`;
    }
  } else if (account.tool === "opencode") {
    for (const [name, folder] of Object.entries({
      XDG_CONFIG_HOME: "config",
      XDG_DATA_HOME: "data",
      XDG_STATE_HOME: "state",
      XDG_CACHE_HOME: "cache",
    }))
      env[name] = privateDirectory(path.join(directory, folder));
    if (key) env[description.auth.keyEnv] = key;
  }
  return env;
}
```

Catalog values are identical to the previous ternaries (`openrouter` → `https://openrouter.ai/api`, Z.ai → `https://api.z.ai/api/anthropic`; key envs from registry). Search all other callers first: `grep -rn "providerEnvironment(" server tests` — `account-store.js` `environment()` calls it too; pass a description there (see Step 7).

- [ ] **Step 5: `claude-provider.js`**

```js
function atLeast(version, [major, minor, patch]) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version || "");
  if (!match) return false;
  const [a, b, c] = match.slice(1).map(Number);
  return a !== major ? a > major : b !== minor ? b > minor : c >= patch;
}
export function configureClaudeProvider(launch, metadata, cliVersion, { forceCustom = false, customHeader = false } = {}) {
  const env = launch.env;
  const window = /* unchanged */;
  const recognizedClaude = !forceCustom && /claude-/i.test(metadata.modelId);
  // ...
  } else {
    if (!/^\d+\.\d+\.\d+/.test(cliVersion || ""))
      throw problem(serverMessages.providers.claudeVersionUnverified, 409);
    if (!atLeast(cliVersion, [2, 1, 193]))
      throw problem(serverMessages.providers.claudeVersionTooOld, 409);
    if (customHeader && !atLeast(cliVersion, [2, 1, 227]))
      throw problem(serverMessages.providers.endpointClaudeCustomHeaderVersion, 409);
    // unchanged context handling
  }
  // ...
  if (metadata.outputTokens)
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.min(metadata.outputTokens, 32000));
  if (metadata.providerId === "openrouter") env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  if (forceCustom) env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
```

Remove `supportedVersion`; replace its single use with `atLeast(cliVersion, [2, 1, 193])`.

- [ ] **Step 6: `native-config.js` and `endpoint-launch.js`**

Rename in `native-config.js`:

```js
export function codexModelCatalog(model, { contextTokens, description, reasoning }) {
  return {
    models: [
      {
        slug: model.modelId,
        display_name: model.label,
        description,
        default_reasoning_level: reasoning ? "high" : "medium",
        supported_reasoning_levels: reasoning
          ? [
              { effort: "low", description: "Low" },
              { effort: "high", description: "High" },
            ]
          : [{ effort: "medium", description: "Medium" }],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 0,
        base_instructions: "",
        supports_reasoning_summaries: reasoning,
        default_reasoning_summary: "none",
        support_verbosity: false,
        apply_patch_tool_type: "freeform",
        truncation_policy: { mode: "bytes", limit: 10000 },
        context_window: contextTokens,
        max_context_window: contextTokens,
        effective_context_window_percent: 95,
        supports_parallel_tool_calls: true,
        experimental_supported_tools: [],
        input_modalities: ["text"],
      },
    ],
  };
}
export const glmCodexCatalog = (model) =>
  codexModelCatalog(model, {
    contextTokens: model.codexContextTokens,
    description: "GLM via Z.ai Responses API",
    reasoning: true,
  });
```

GLM output stays byte-identical (the matrix test checks `context_window`; verify with `git stash`-free diff by running the old matrix test).

Create `endpoint-launch.js`:

```js
import path from "node:path";
import { problem, readJSON, writePrivate } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { tomlValue } from "../../lib/launch-serialization.js";
import { codexModelCatalog, writeTomlConfig } from "./native-config.js";

export function endpointCodexLaunch(result, description, secret) {
  const { model } = description;
  const key = secret?.apiKey?.trim();
  const env = result.env;
  const config = {
    model: model.modelId,
    model_provider: description.providerKey,
    cli_auth_credentials_store: "file",
    model_context_window: model.contextTokens,
    model_catalog_json: path.join(env.CODEX_HOME, "models.json"),
    model_providers: {
      [description.providerKey]: {
        name: description.displayName,
        base_url: description.endpoints.responses,
        wire_api: "responses",
        requires_openai_auth: false,
        ...(key && !description.auth.header ? { env_key: description.auth.keyEnv } : {}),
        ...(key && description.auth.header
          ? { env_http_headers: { [description.auth.header]: description.auth.keyEnv } }
          : {}),
      },
    },
  };
  writePrivate(
    config.model_catalog_json,
    codexModelCatalog(model, {
      contextTokens: model.contextTokens,
      description: "Custom endpoint model",
      reasoning: false,
    }),
  );
  writeTomlConfig(path.join(env.CODEX_HOME, "config.toml"), config);
  for (const [name, value] of Object.entries(config))
    result.args.push("-c", `${name}=${tomlValue(value)}`);
  result.args.push("--model", model.modelId);
  return config;
}

export function endpointOpenCodeLaunch(result, description, secret, connectionName) {
  const { model } = description;
  const key = secret?.apiKey?.trim();
  const cliModelId = `${description.providerKey}/${model.modelId}`;
  const reference = `{env:${description.auth.keyEnv}}`;
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: cliModelId,
    provider: {
      [description.providerKey]: {
        npm: "@ai-sdk/openai-compatible",
        name: connectionName || description.displayName,
        options: {
          baseURL: description.endpoints.chatCompletions,
          ...(key ? { apiKey: reference } : {}),
          ...(key && description.auth.header
            ? { headers: { [description.auth.header]: reference } }
            : {}),
        },
        models: {
          [model.modelId]: {
            name: model.label,
            limit: { context: model.contextTokens, output: model.outputTokens },
          },
        },
      },
    },
  };
  const file = path.join(result.env.XDG_CONFIG_HOME, "opencode/opencode.json");
  let current;
  try {
    current = readJSON(file, {});
  } catch {
    throw problem(serverMessages.providers.managedOpenCodeConfigInvalid, 409);
  }
  writePrivate(file, {
    ...current,
    ...config,
    provider: { ...current.provider, ...config.provider },
  });
  result.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  result.args.push("--model", cliModelId);
  return cliModelId;
}
```

Note: `model.outputTokens` from `endpointModel()` is already the fallback-applied value.

- [ ] **Step 7: `provider-launch.js` and `account-store.js` wiring**

`prepareProviderLaunch`:

```js
export function prepareProviderLaunch(
  account,
  secret,
  launch,
  { root, catalog, cliVersion, endpoint, connectionName } = {},
) {
  if (!account.provider || account.kind !== "managed") return launch;
  const description = launchDescription(account, { catalog, endpoint });
  const { selection, model } = description;
  if (
    description.auth.required &&
    (typeof secret?.apiKey !== "string" || !secret.apiKey.trim())
  )
    throw problem(serverMessages.providers.apiKeyRequiredForAccount, 409);
  const env = providerEnvironment(account, secret, launch.env, root, description);
  const metadata = {/* unchanged fields */};
  const result = { ...launch, args: [...launch.args], env, provider: metadata };
  const endpointKind = description.kind === "endpoint";
  if (account.tool === "claude")
    return configureClaudeProvider(
      result,
      metadata,
      cliVersion ?? readCliVersion(launch.command),
      {
        forceCustom: endpointKind,
        customHeader:
          endpointKind && !!description.auth.header && !!secret?.apiKey?.trim(),
      },
    );
  if (endpointKind) {
    if (account.tool === "codex") endpointCodexLaunch(result, description, secret);
    else if (account.tool === "opencode")
      metadata.cliModelId = endpointOpenCodeLaunch(
        result,
        description,
        secret,
        connectionName,
      );
    Object.assign(metadata, {
      assumedContextTokens: model.contextTokens,
      contextStatus: "configured",
      contextSource: "endpoint",
      modelChangeRequiresRestart: true,
    });
    return result;
  }
  // existing codex/opencode catalog branches, with these replacements:
  //   name: router ? "OpenRouter" : "Z.ai"            -> name: description.displayName
  //   base_url: router ? ... : ...                     -> base_url: description.endpoints.responses
  //   { env_key: "ZAI_API_KEY" }                       -> { env_key: description.auth.keyEnv }
  //   apiKey: selection.id === "openrouter" ? ... : ...-> apiKey: `{env:${description.auth.keyEnv}}`
  // `router` stays `selection.id === "openrouter"` for the auth-command and routing-context branches.
}
```

Configure Claude: `forceCustom` makes `modelChangeRequiresRestart: true` (since `!recognizedClaude`).

`account-store.js`:

- `environment(id)` (lines ~275-308) calls `providerEnvironment(account, secret, env, root)` for provider accounts. Read the method first. For accounts with `provider.id === "endpoint"`, build the description with `launchDescription(account, { catalog: this.providerCatalog, endpoint: this.endpointFor(account) })` and pass it; for catalog accounts build it the same way (endpoint undefined). If `environment()` is also called from `connectionProfile()` before a model is validated, wrap in the same call — the model is already validated there.
- Add:

```js
  endpointFor(account) {
    if (account.provider?.id !== "endpoint") return undefined;
    if (account.internal?.kind !== "provider-connection" || !this.providerConnections)
      throw problem(serverMessages.providers.invalidProviderSelection);
    return this.providerConnections.record(account.internal.connectionId).endpoint;
  }
```

- `command()` live model switch branch (line ~321) and the final `prepareProviderLaunch` call pass `{ endpoint: this.endpointFor(account), connectionName: this.providerConnections?.record(account.internal?.connectionId)?.name }` (guard the name lookup with `account.internal`):

```js
    const endpoint = this.endpointFor(account);
    // in the modelId branch:
          provider: validateProviderSelection({ ...account.provider, modelId }, account.tool, this.providerCatalog, { endpoint }),
    // final:
    return prepareProviderLaunch(account, this.secret(account), launch, {
      root,
      catalog: this.providerCatalog,
      endpoint,
      connectionName: endpoint ? this.providerConnections.record(account.internal.connectionId).name : undefined,
    });
```

- [ ] **Step 8: Run tests**

Run: `node --test tests/matrix/endpoint-launch.test.js tests/matrix/providers-launch.test.js tests/matrix/provider-connections-launch.test.js tests/matrix/codex-router-context.test.js tests/unit/provider-session.test.js tests/integration/providers-accounts.test.js tests/integration/endpoint-connections.test.js`
Expected: PASS. `providers-launch.test.js` must be untouched (`git diff --stat tests/matrix/providers-launch.test.js` prints nothing).

- [ ] **Step 9: Commit**

```bash
npx prettier --write server/features/providers/*.js server/features/accounts/account-store.js tests/matrix/endpoint-launch.test.js
git add server tests
git commit -m "feat: launch Claude Code, Codex and OpenCode against custom endpoints

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Pre-launch address check for sessions, pipelines and reloads

**Files:**

- Modify: `server/features/accounts/account-store.js` (add `verifyEndpointTarget`)
- Modify: `server/application/session-lifecycle.js:126-144`
- Modify: `server/application/session-reload-lifecycle.js:42-49`
- Test: `tests/integration/endpoint-connections.test.js` (extend)

**Interfaces:**

- Consumes: `resolveEndpointTarget` (Task 4), `endpointBaseUrl` (Task 3), `endpointFor` (Task 7).
- Produces: `async AccountStore.verifyEndpointTarget(accountId, { lookup } = {})` — no-op for non-endpoint accounts; throws `endpointUrlNotAllowed` (400) otherwise.

- [ ] **Step 1: Extend the failing test**

```js
test("pre-launch target check refuses http to public resolution", async (t) => {
  const { connections, access, accounts } = full(t);
  const { id } = connections.create({
    name: "Remote",
    providerId: "endpoint",
    endpoint: {
      ...ollama,
      openaiBaseUrl: "http://llm.example/v1",
      anthropicBaseUrl: "http://llm.example",
    },
  });
  const { account } = access.resolve({
    tool: "opencode",
    providerConnectionId: id,
    providerModelId: "qwen3",
  });
  await assert.rejects(
    accounts.verifyEndpointTarget(account.id, {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    }),
    { status: 400 },
  );
  await accounts.verifyEndpointTarget(account.id, {
    lookup: async () => [{ address: "192.168.1.20", family: 4 }],
  });
  await accounts.verifyEndpointTarget("local-codex");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/integration/endpoint-connections.test.js`
Expected: FAIL (`verifyEndpointTarget` is not a function).

- [ ] **Step 3: Implement**

`account-store.js`:

```js
import { resolveEndpointTarget } from "../providers/endpoint-address.js";
import { endpointBaseUrl } from "../providers/endpoint-config.js";
// method:
  async verifyEndpointTarget(id, { lookup } = {}) {
    const account = this.get(id);
    const endpoint = this.endpointFor(account);
    if (!endpoint) return;
    // Best effort: the CLI resolves the host again when it connects.
    await resolveEndpointTarget(endpointBaseUrl(endpoint, account.tool), lookup ? { lookup } : {});
  }
```

`session-lifecycle.js` inside `launchResolved`, directly before `let launch = accounts.command(...)`:

```js
await accounts.verifyEndpointTarget(account.id);
```

`session-reload-lifecycle.js` directly before `let launch = accounts.command(account.id, binaries, false, ...)`:

```js
await accounts.verifyEndpointTarget(account.id);
```

Pipeline stages launch through `session-lifecycle.js` (`trusted.pipeline`), so they are covered.

- [ ] **Step 4: Run tests**

Run: `node --test tests/integration/endpoint-connections.test.js tests/blackbox/provider-session-access.test.js tests/blackbox/provider-connection-launch-race.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/features/accounts/account-store.js server/application/session-lifecycle.js server/application/session-reload-lifecycle.js tests/integration/endpoint-connections.test.js
git add server tests
git commit -m "feat: check endpoint target addresses before launch and reload

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Pinned HTTP client, model listing and merge

**Files:**

- Create: `server/features/providers/endpoint-http.js`
- Create: `server/features/providers/endpoint-models.js`
- Create: `tests/helpers/endpoint-servers.js`
- Test: `tests/unit/endpoint-models.test.js`, `tests/integration/endpoint-probe.test.js` (create; listing part)

**Interfaces:**

- Consumes: `resolveEndpointTarget` (Task 4).
- Produces:
  - `async endpointRequest({ url, method = "GET", headers = {}, body, timeoutMs, signal, lookup }) → { status, json }` — resolves + pins via `resolveEndpointTarget`, uses `node:http`/`node:https` `request` with `lookup: (_host, _opts, cb) => cb(null, address, family)` (and `servername` = hostname for https), 1 MB cap, no redirects (3xx returned as status), `json` is parsed body or `null`. Rejects with `{ reason: "timeout"|"network"|"tooLarge"|"notAllowed" }`-tagged errors (`error.reason`).
  - `authHeaders(apiKey, authHeader) → object` — `{}` without key; `{ Authorization: "Bearer <key>" }` default; `{ [authHeader]: key }` custom.
  - `parseOllamaNumCtx(parameters: string) → number | null`.
  - `async listEndpointModels({ endpoint, apiKey, signal, lookup }) → { listed: boolean, models: DetectedModel[], warnings: string[] }` where `DetectedModel = { modelId, label, contextTokens, contextHint?, source: "detected" }`.
  - `mergeModels(previous, detection) → Model[]`.

- [ ] **Step 1: Fake servers helper**

```js
// tests/helpers/endpoint-servers.js
import http from "node:http";

export async function fakeEndpoint(t, routes) {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", async () => {
      const entry = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: body ? JSON.parse(body) : null,
      };
      seen.push(entry);
      const handler = routes[`${request.method} ${request.url.split("?")[0]}`];
      if (!handler) {
        response.writeHead(404, { "content-type": "application/json" });
        return response.end(JSON.stringify({ error: "not found" }));
      }
      const result = await handler(entry);
      if (result === "hang") return;
      response.writeHead(result.status || 200, {
        "content-type": "application/json",
        ...(result.headers || {}),
      });
      response.end(
        typeof result.raw === "string" ? result.raw : JSON.stringify(result.json ?? {}),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

const chat = {
  json: {
    id: "c",
    object: "chat.completion",
    choices: [
      { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
    ],
  },
};
const messages = {
  json: {
    id: "m",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
  },
};
const responses = { json: { id: "r", object: "response", output: [] } };
const known =
  (models, ok) =>
  ({ body }) =>
    models.includes(body.model)
      ? ok
      : { status: 404, json: { error: "model not found" } };

export const ollamaRoutes = (models = ["qwen3:8b", "llama3:8b"]) => ({
  "GET /v1/models": () => ({
    json: { object: "list", data: models.map((id) => ({ id, object: "model" })) },
  }),
  "GET /api/tags": () => ({
    json: { models: models.map((name) => ({ name, model: name })) },
  }),
  "POST /api/show": ({ body }) =>
    body.model === "qwen3:8b"
      ? {
          json: {
            parameters: 'temperature 0.6\nnum_ctx 40960\nstop "<|im_end|>"',
            model_info: {
              "general.architecture": "qwen3",
              "qwen3.context_length": 262144,
            },
          },
        }
      : {
          json: {
            parameters: "",
            model_info: {
              "general.architecture": "llama",
              "llama.context_length": 131072,
            },
          },
        },
  "POST /v1/messages": known(models, messages),
  "POST /v1/responses": known(models, responses),
  "POST /v1/chat/completions": known(models, chat),
});

export const llamaRoutes = ({ router = false } = {}) => ({
  "GET /v1/models": () => ({
    json: {
      data: router
        ? [{ id: "coder" }, { id: "small" }]
        : [{ id: "/models/coder-q4.gguf" }, { id: "coder" }],
    },
  }),
  "GET /props": ({ url }) => {
    const model = new URL(url, "http://x").searchParams.get("model");
    if (router && !model) return { status: 400, json: {} };
    return {
      json: { default_generation_settings: { n_ctx: model === "small" ? 8192 : 32768 } },
    };
  },
  "POST /v1/chat/completions": () => chat,
});

export const azureRoutes = (key) => ({
  "GET /openai/v1/models": ({ headers }) =>
    headers["api-key"] === key
      ? { json: { data: [{ id: "gpt-4.1" }] } }
      : { status: 401, json: {} },
  "POST /openai/v1/responses": ({ headers, body }) =>
    headers["api-key"] !== key
      ? { status: 401, json: {} }
      : body.model === "my-deploy"
        ? responses
        : { status: 404, json: { error: { code: "DeploymentNotFound" } } },
  "POST /openai/v1/chat/completions": ({ headers, body }) =>
    headers["api-key"] !== key
      ? { status: 401, json: {} }
      : body.model === "my-deploy"
        ? { status: 400, json: { error: "use max_completion_tokens" } }
        : { status: 404, json: {} },
});
```

- [ ] **Step 2: Unit tests for parsing and merge**

```js
// tests/unit/endpoint-models.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseOllamaNumCtx,
  mergeModels,
  authHeaders,
} from "../../server/features/providers/endpoint-models.js";

test("parses num_ctx from Modelfile parameters", () => {
  assert.equal(parseOllamaNumCtx("temperature 0.7\nnum_ctx   16384\n"), 16384);
  assert.equal(parseOllamaNumCtx("temperature 0.7"), null);
  assert.equal(parseOllamaNumCtx(undefined), null);
  assert.equal(parseOllamaNumCtx("num_ctx 12"), null); // below 1024 is ignored
});

test("merge keeps manual models and edits, replaces detected ones only after listing", () => {
  const previous = [
    {
      modelId: "a",
      label: "a",
      contextTokens: 8192,
      outputTokens: null,
      source: "detected",
      contextEdited: false,
    },
    {
      modelId: "b",
      label: "b",
      contextTokens: 50000,
      outputTokens: 4096,
      source: "detected",
      contextEdited: true,
    },
    {
      modelId: "deploy",
      label: "deploy",
      contextTokens: 128000,
      outputTokens: null,
      source: "manual",
      contextEdited: true,
    },
  ];
  const detection = {
    listed: true,
    models: [
      { modelId: "b", label: "b", contextTokens: 32768, source: "detected" },
      { modelId: "deploy", label: "deploy", contextTokens: 200000, source: "detected" },
      {
        modelId: "c",
        label: "c",
        contextTokens: null,
        contextHint: 131072,
        source: "detected",
      },
    ],
  };
  assert.deepEqual(mergeModels(previous, detection), [
    {
      modelId: "b",
      label: "b",
      contextTokens: 50000,
      outputTokens: 4096,
      source: "detected",
      contextEdited: true,
    },
    {
      modelId: "deploy",
      label: "deploy",
      contextTokens: 128000,
      outputTokens: null,
      source: "detected",
      contextEdited: true,
    },
    {
      modelId: "c",
      label: "c",
      contextTokens: null,
      outputTokens: null,
      source: "detected",
      contextEdited: false,
      contextHint: 131072,
    },
  ]);
  assert.deepEqual(mergeModels(previous, { listed: false, models: [] }), previous);
});

test("auth headers", () => {
  assert.deepEqual(authHeaders("", null), {});
  assert.deepEqual(authHeaders("k", null), { Authorization: "Bearer k" });
  assert.deepEqual(authHeaders("k", "api-key"), { "api-key": "k" });
});
```

Note: `authHeaders` lives in `endpoint-http.js` and is re-exported from `endpoint-models.js` for convenience — or import it from `endpoint-http.js` in the test; pick one and keep it consistent (recommended: export from `endpoint-http.js`, test imports from there).

- [ ] **Step 3: Integration test for listing**

```js
// tests/integration/endpoint-probe.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  fakeEndpoint,
  ollamaRoutes,
  llamaRoutes,
  azureRoutes,
} from "../helpers/endpoint-servers.js";
import { listEndpointModels } from "../../server/features/providers/endpoint-models.js";
import { endpointRequest } from "../../server/features/providers/endpoint-http.js";

const draft = (base, preset, extra = {}) => ({
  preset,
  openaiBaseUrl: `${base}/v1`,
  anthropicBaseUrl: base,
  authHeader: null,
  ...extra,
});

test("ollama listing reads num_ctx and keeps model maximum only as hint", async (t) => {
  const server = await fakeEndpoint(t, ollamaRoutes());
  const result = await listEndpointModels({
    endpoint: draft(server.base, "ollama"),
    apiKey: "",
  });
  assert.equal(result.listed, true);
  assert.deepEqual(
    result.models.map(({ modelId, contextTokens, contextHint }) => ({
      modelId,
      contextTokens,
      contextHint,
    })),
    [
      { modelId: "qwen3:8b", contextTokens: 40960, contextHint: 262144 },
      { modelId: "llama3:8b", contextTokens: null, contextHint: 131072 },
    ],
  );
  assert.ok(result.warnings.includes("ollamaContextUnknown"));
});

test("llama.cpp single and router mode", async (t) => {
  const single = await fakeEndpoint(t, llamaRoutes());
  const one = await listEndpointModels({
    endpoint: draft(single.base, "llamacpp"),
    apiKey: "",
  });
  assert.deepEqual(
    one.models.map((m) => [m.modelId, m.contextTokens]),
    [["coder", 32768]],
  );
  assert.ok(one.warnings.includes("modelIdSkipped"));
  const router = await fakeEndpoint(t, llamaRoutes({ router: true }));
  const many = await listEndpointModels({
    endpoint: draft(router.base, "llamacpp"),
    apiKey: "",
  });
  assert.deepEqual(
    many.models.map((m) => [m.modelId, m.contextTokens]),
    [
      ["coder", 32768],
      ["small", 8192],
    ],
  );
});

test("azure-like listing uses the custom header and never echoes bodies", async (t) => {
  const server = await fakeEndpoint(t, azureRoutes("az-key"));
  const endpoint = {
    preset: "custom",
    openaiBaseUrl: `${server.base}/openai/v1`,
    anthropicBaseUrl: null,
    authHeader: "api-key",
  };
  const result = await listEndpointModels({ endpoint, apiKey: "az-key" });
  assert.deepEqual(
    result.models.map((m) => m.modelId),
    ["gpt-4.1"],
  );
  assert.equal(server.seen[0].headers["api-key"], "az-key");
  assert.equal(server.seen[0].headers.authorization, undefined);
});

test("client enforces redirect, size and timeout limits", async (t) => {
  const server = await fakeEndpoint(t, {
    "GET /redirect": () => ({
      status: 302,
      headers: { location: "http://127.0.0.1:1/" },
      json: {},
    }),
    "GET /big": () => ({ raw: "x".repeat(1024 * 1024 + 10) }),
    "GET /hang": () => "hang",
  });
  assert.equal(
    (await endpointRequest({ url: `${server.base}/redirect`, timeoutMs: 2000 })).status,
    302,
  );
  await assert.rejects(endpointRequest({ url: `${server.base}/big`, timeoutMs: 2000 }), {
    reason: "tooLarge",
  });
  await assert.rejects(endpointRequest({ url: `${server.base}/hang`, timeoutMs: 200 }), {
    reason: "timeout",
  });
  await assert.rejects(
    endpointRequest({ url: "http://8.8.8.8/v1/models", timeoutMs: 200 }),
    { reason: "notAllowed" },
  );
});

test("pinned lookup is used for hostnames", async (t) => {
  const server = await fakeEndpoint(t, {
    "GET /v1/models": () => ({ json: { data: [] } }),
  });
  const port = new URL(server.base).port;
  const calls = [];
  const lookup = async (host) => (
    calls.push(host),
    [{ address: "127.0.0.1", family: 4 }]
  );
  const result = await endpointRequest({
    url: `http://model.test:${port}/v1/models`,
    timeoutMs: 2000,
    lookup,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, ["model.test"]);
  assert.equal(server.seen[0].headers.host, `model.test:${port}`);
});
```

- [ ] **Step 4: Run to verify failure**

Run: `node --test tests/unit/endpoint-models.test.js tests/integration/endpoint-probe.test.js`
Expected: FAIL (modules missing).

- [ ] **Step 5: Implement `endpoint-http.js`**

```js
import http from "node:http";
import https from "node:https";
import { resolveEndpointTarget } from "./endpoint-address.js";

const LIMIT = 1024 * 1024;
const tagged = (reason) => Object.assign(new Error(reason), { reason });

export function authHeaders(apiKey, authHeader) {
  if (!apiKey) return {};
  return authHeader ? { [authHeader]: apiKey } : { Authorization: `Bearer ${apiKey}` };
}

export async function endpointRequest({
  url,
  method = "GET",
  headers = {},
  body,
  timeoutMs,
  signal,
  lookup,
}) {
  let target;
  try {
    target = await resolveEndpointTarget(url, lookup ? { lookup } : {});
  } catch {
    throw tagged("notAllowed");
  }
  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? https : http;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = client.request(
      parsed,
      {
        method,
        headers: {
          Accept: "application/json",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          ...headers,
        },
        lookup: (_hostname, options, callback) =>
          options?.all
            ? callback(null, [{ address: target.address, family: target.family }])
            : callback(null, target.address, target.family),
        ...(parsed.protocol === "https:" ? { servername: target.hostname } : {}),
        signal,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > LIMIT) {
            request.destroy(tagged("tooLarge"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            json = null;
          }
          resolve({ status: response.statusCode, json });
        });
        response.on("error", (error) => reject(error.reason ? error : tagged("network")));
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(tagged("timeout")));
    request.on("error", (error) =>
      reject(error.reason ? error : tagged(signal?.aborted ? "aborted" : "network")),
    );
    if (payload) request.write(payload);
    request.end();
  });
}
```

Node calls a custom `lookup` with `options.all` in some versions; the implementation handles both shapes.

- [ ] **Step 6: Implement `endpoint-models.js`**

```js
import { validModelId } from "./provider-definitions.js";
import { endpointRequest, authHeaders } from "./endpoint-http.js";

const LIST_TIMEOUT = 10_000;
const valid = (value) => Number.isInteger(value) && value >= 1024 && value <= 10_000_000;
const rootUrl = (endpoint) =>
  endpoint.anthropicBaseUrl || endpoint.openaiBaseUrl.replace(/\/v1$/, "");

export function parseOllamaNumCtx(parameters) {
  if (typeof parameters !== "string") return null;
  const match = /^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters);
  const value = match ? Number(match[1]) : null;
  return valid(value) ? value : null;
}

async function pool(items, size, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]);
      }
    }),
  );
  return results;
}

export async function listEndpointModels({ endpoint, apiKey, signal, lookup }) {
  const headers = authHeaders(apiKey, endpoint.authHeader);
  const call = (url, options = {}) =>
    endpointRequest({
      url,
      headers,
      timeoutMs: LIST_TIMEOUT,
      signal,
      lookup,
      ...options,
    });
  const warnings = new Set();
  let ids = [];
  let listed = false;
  try {
    const result = await call(`${endpoint.openaiBaseUrl}/models`);
    if (result.status === 200 && Array.isArray(result.json?.data)) {
      ids = result.json.data
        .map((item) => item?.id)
        .filter((id) => typeof id === "string");
      listed = true;
    }
  } catch {
    /* Listing failures are reported through `listed`. */
  }
  const root = rootUrl(endpoint);
  if (endpoint.preset === "ollama") {
    try {
      const tags = await call(`${root}/api/tags`);
      if (tags.status === 200 && Array.isArray(tags.json?.models)) {
        ids = [
          ...new Set([
            ...ids,
            ...tags.json.models.map((item) => item?.name).filter(Boolean),
          ]),
        ];
        listed = true;
      }
    } catch {
      /* Fall back to the OpenAI listing. */
    }
  }
  const usable = ids
    .filter((id) => {
      if (validModelId(id)) return true;
      warnings.add("modelIdSkipped");
      return false;
    })
    .slice(0, 200);
  let models = usable.map((modelId) => ({
    modelId,
    label: modelId,
    contextTokens: null,
    source: "detected",
  }));
  if (endpoint.preset === "ollama")
    models = await pool(models.slice(0, 50), 4, async (model) => {
      try {
        const show = await call(`${root}/api/show`, {
          method: "POST",
          body: { model: model.modelId },
        });
        const numCtx = parseOllamaNumCtx(show.json?.parameters);
        const info = show.json?.model_info || {};
        const hint = info[`${info["general.architecture"]}.context_length`];
        if (!numCtx) warnings.add("ollamaContextUnknown");
        return {
          ...model,
          contextTokens: numCtx,
          ...(valid(hint) ? { contextHint: hint } : {}),
        };
      } catch {
        warnings.add("ollamaContextUnknown");
        return model;
      }
    }).then((head) => [...head, ...models.slice(50)]);
  if (endpoint.preset === "llamacpp") {
    const router = models.length > 1;
    models = await pool(models, 4, async (model) => {
      try {
        const props = await call(
          `${root}/props${router ? `?model=${encodeURIComponent(model.modelId)}` : ""}`,
        );
        const nCtx = props.json?.default_generation_settings?.n_ctx;
        return valid(nCtx) ? { ...model, contextTokens: nCtx } : model;
      } catch {
        return model;
      }
    });
  }
  return { listed, models, warnings: [...warnings] };
}

export function mergeModels(previous, detection) {
  if (!detection.listed) return previous;
  const byId = new Map(previous.map((model) => [model.modelId, model]));
  const detected = detection.models.map((model) => {
    const old = byId.get(model.modelId);
    return {
      modelId: model.modelId,
      label: old?.label ?? model.label,
      contextTokens: old?.contextEdited ? old.contextTokens : model.contextTokens,
      outputTokens: old?.contextEdited ? old.outputTokens : (old?.outputTokens ?? null),
      source: "detected",
      contextEdited: old?.contextEdited === true,
      ...(model.contextHint ? { contextHint: model.contextHint } : {}),
    };
  });
  const ids = new Set(detected.map((model) => model.modelId));
  return [
    ...detected,
    ...previous.filter((model) => model.source === "manual" && !ids.has(model.modelId)),
  ];
}
```

For llama.cpp the single-model case with two IDs (`/models/coder-q4.gguf` skipped, `coder` kept) yields one model, so `router = false` is evaluated after skipping — matches the test. Adjust the test expectation of the merged order if `mergeModels` output order differs: detected first (listing order), then remaining manual models.

- [ ] **Step 7: Run tests**

Run: `node --test tests/unit/endpoint-models.test.js tests/integration/endpoint-probe.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npx prettier --write server/features/providers/endpoint-http.js server/features/providers/endpoint-models.js tests/helpers/endpoint-servers.js tests/unit/endpoint-models.test.js tests/integration/endpoint-probe.test.js
git add server tests
git commit -m "feat: detect endpoint models through a pinned HTTP client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Protocol probes, test orchestration, route, audit

**Files:**

- Create: `server/features/providers/endpoint-probe.js`
- Create: `server/features/providers/endpoint-tester.js`
- Modify: `server/http/routes/provider-connections.js`
- Modify: `server/application/services.js:49-59`
- Modify: `server/features/audit/audit-http.js` (provider-connections branch)
- Test: `tests/integration/endpoint-probe.test.js` (extend), `tests/blackbox/endpoint-routes.test.js` (create)

**Interfaces:**

- Consumes: Tasks 3, 5, 9.
- Produces:
  - `classifyProbe({ status, json } | { reason }, { listedModel }) → { status: "ok"|"unsupported"|"failed", reason?: string, warning?: "rejectedRequest" }`.
  - `async runEndpointTest({ endpoint, apiKey, probeModelId, previousModels, signal, lookup }) → { models, listed, protocols, reasons, probeModelId, warnings }`.
  - `class EndpointTester { constructor({ connections, lookup }); async test(body, signal) }` — validates body, resolves key, enforces global lock (429 `endpointTestBusy`).
  - Route `POST /provider-connections/test`.

- [ ] **Step 1: Extend failing tests**

Append to `tests/integration/endpoint-probe.test.js`:

```js
import {
  classifyProbe,
  runEndpointTest,
} from "../../server/features/providers/endpoint-probe.js";

test("probe classification distinguishes missing protocol from missing model", () => {
  assert.deepEqual(classifyProbe({ status: 200, json: {} }, { listedModel: true }), {
    status: "ok",
  });
  assert.deepEqual(classifyProbe({ status: 404, json: {} }, { listedModel: true }), {
    status: "unsupported",
    reason: "notFound",
  });
  assert.deepEqual(classifyProbe({ status: 404, json: {} }, { listedModel: false }), {
    status: "failed",
    reason: "modelNotFound",
  });
  assert.deepEqual(classifyProbe({ status: 400, json: {} }, { listedModel: true }), {
    status: "ok",
    warning: "rejectedRequest",
  });
  assert.deepEqual(classifyProbe({ status: 401, json: {} }, { listedModel: true }), {
    status: "failed",
    reason: "auth",
  });
  assert.deepEqual(classifyProbe({ status: 302, json: null }, { listedModel: true }), {
    status: "failed",
    reason: "http",
  });
  assert.deepEqual(classifyProbe({ status: 200, json: null }, { listedModel: true }), {
    status: "failed",
    reason: "invalidResponse",
  });
  assert.deepEqual(classifyProbe({ reason: "timeout" }, { listedModel: true }), {
    status: "failed",
    reason: "timeout",
  });
});

test("ollama test proposes all protocols", async (t) => {
  const server = await fakeEndpoint(t, ollamaRoutes());
  const result = await runEndpointTest({
    endpoint: draft(server.base, "ollama"),
    apiKey: "",
    previousModels: [],
  });
  assert.equal(result.probeModelId, "qwen3:8b");
  assert.deepEqual(result.protocols, {
    messages: "ok",
    responses: "ok",
    chatCompletions: "ok",
  });
});

test("llama.cpp without messages route reports unsupported", async (t) => {
  const server = await fakeEndpoint(t, llamaRoutes());
  const result = await runEndpointTest({
    endpoint: draft(server.base, "llamacpp"),
    apiKey: "",
    previousModels: [],
  });
  assert.deepEqual(result.protocols, {
    messages: "unsupported",
    responses: "unsupported",
    chatCompletions: "ok",
  });
});

test("azure manual deployment: 404 on unlisted model is modelNotFound, 400 is rejectedRequest", async (t) => {
  const server = await fakeEndpoint(t, azureRoutes("az-key"));
  const endpoint = {
    preset: "custom",
    openaiBaseUrl: `${server.base}/openai/v1`,
    anthropicBaseUrl: null,
    authHeader: "api-key",
  };
  const manual = [
    {
      modelId: "my-deploy",
      label: "my-deploy",
      contextTokens: 128000,
      outputTokens: null,
      source: "manual",
      contextEdited: true,
    },
  ];
  const result = await runEndpointTest({
    endpoint,
    apiKey: "az-key",
    previousModels: manual,
    probeModelId: "my-deploy",
  });
  assert.deepEqual(result.protocols, {
    messages: "skipped",
    responses: "ok",
    chatCompletions: "ok",
  });
  assert.ok(result.warnings.includes("rejectedRequest"));
  assert.ok(
    result.models.some(
      (model) => model.modelId === "my-deploy" && model.source === "manual",
    ),
  );
  const wrong = await runEndpointTest({
    endpoint,
    apiKey: "az-key",
    previousModels: manual,
    probeModelId: "gpt-4.1",
  });
  assert.equal(wrong.protocols.responses, "unsupported"); // gpt-4.1 was listed, so 404 means unsupported
});

test("upstream error bodies containing the key are never returned", async (t) => {
  const server = await fakeEndpoint(t, {
    "GET /v1/models": () => ({ json: { data: [{ id: "m" }] } }),
    "POST /v1/chat/completions": () => ({
      status: 500,
      json: { error: "bad key secret-xyz" },
    }),
  });
  const result = await runEndpointTest({
    endpoint: { ...draft(server.base, "custom"), anthropicBaseUrl: null },
    apiKey: "secret-xyz",
    previousModels: [],
  });
  assert.equal(JSON.stringify(result).includes("secret-xyz"), false);
  assert.equal(result.reasons.chatCompletions, "http");
});
```

Create `tests/blackbox/endpoint-routes.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { EndpointTester } from "../../server/features/providers/endpoint-tester.js";
import { providerConnectionRoutes } from "../../server/http/routes/provider-connections.js";
import { requestAudit } from "../../server/features/audit/audit-http.js";
import { fakeEndpoint, ollamaRoutes } from "../helpers/endpoint-servers.js";

async function app(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-endpoint-http-"));
  const providerConnections = new ProviderConnections({ dataDir });
  const endpointTester = new EndpointTester({ connections: providerConnections });
  const application = express();
  application.use(
    express.json(),
    providerConnectionRoutes({ providerConnections, endpointTester }),
  );
  application.use((error, _request, response, _next) =>
    response.status(error.status || 500).json({ error: error.message }),
  );
  const server = application.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const request = (route, method = "GET", body) =>
    fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { request, base, providerConnections, endpointTester };
}

test("test route returns a proposal and never persists", async (t) => {
  const upstream = await fakeEndpoint(t, ollamaRoutes());
  const { request, providerConnections } = await app(t);
  const endpoint = {
    preset: "ollama",
    openaiBaseUrl: `${upstream.base}/v1`,
    anthropicBaseUrl: upstream.base,
    authHeader: null,
  };
  const response = await request("/provider-connections/test", "POST", { endpoint });
  assert.equal(response.status, 200);
  const proposal = await response.json();
  assert.equal(proposal.protocols.chatCompletions, "ok");
  assert.equal(providerConnections.list().length, 0);
});

test("stored key is only reused for the same origins and only for endpoint connections", async (t) => {
  const upstream = await fakeEndpoint(t, ollamaRoutes());
  const { request, providerConnections } = await app(t);
  const endpoint = {
    preset: "ollama",
    openaiBaseUrl: `${upstream.base}/v1`,
    anthropicBaseUrl: upstream.base,
    authHeader: null,
  };
  const saved = providerConnections.create({
    name: "GPU",
    providerId: "endpoint",
    apiKey: "stored-key",
    endpoint: {
      ...endpoint,
      protocols: { messages: true, responses: true, chatCompletions: true },
      models: [],
      lastTest: null,
    },
  });
  await request("/provider-connections/test", "POST", {
    connectionId: saved.id,
    endpoint,
  });
  assert.equal(upstream.seen[0].headers.authorization, "Bearer stored-key");
  upstream.seen.length = 0;
  const other = await fakeEndpoint(t, ollamaRoutes());
  const moved = {
    ...endpoint,
    openaiBaseUrl: `${other.base}/v1`,
    anthropicBaseUrl: other.base,
  };
  const result = await (
    await request("/provider-connections/test", "POST", {
      connectionId: saved.id,
      endpoint: moved,
    })
  ).json();
  assert.ok(result.warnings.includes("storedKeyNotUsed"));
  assert.equal(
    other.seen.every((entry) => entry.headers.authorization === undefined),
    true,
  );
  const router = providerConnections.create({
    name: "R",
    providerId: "openrouter",
    apiKey: "router-key",
  });
  assert.equal(
    (
      await request("/provider-connections/test", "POST", {
        connectionId: router.id,
        endpoint,
      })
    ).status,
    400,
  );
});

test("only one test runs at a time", async (t) => {
  const upstream = await fakeEndpoint(t, { "GET /v1/models": () => "hang" });
  const { request, base, endpointTester } = await app(t);
  const endpoint = {
    preset: "custom",
    openaiBaseUrl: `${upstream.base}/v1`,
    anthropicBaseUrl: null,
    authHeader: null,
  };
  const controller = new AbortController();
  const first = fetch(`${base}/provider-connections/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
    signal: controller.signal,
  }).catch(() => {});
  while (!endpointTester.running) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    (await request("/provider-connections/test", "POST", { endpoint })).status,
    429,
  );
  controller.abort();
  await first;
  // Client disconnect aborts the upstream request and releases the lock.
  for (let i = 0; i < 100 && endpointTester.running; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(endpointTester.running, false);
});

test("audit records the test as provider.tested", () => {
  const audit = requestAudit({
    method: "POST",
    path: "/api/provider-connections/test",
    params: {},
  });
  assert.equal(audit.resourceType, "provider");
  assert.equal(audit.action, "tested");
  assert.equal(audit.resourceId, undefined);
});
```

Before writing the last test, read the full `requestAudit` return shape (`server/features/audit/audit-http.js`) and adapt property names to what it returns.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/integration/endpoint-probe.test.js tests/blackbox/endpoint-routes.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `endpoint-probe.js`**

```js
import { endpointRequest, authHeaders } from "./endpoint-http.js";
import { listEndpointModels, mergeModels } from "./endpoint-models.js";

const PROBE_TIMEOUT = 90_000;
const TOTAL_TIMEOUT = 180_000;

export function classifyProbe(result, { listedModel }) {
  if (result.reason)
    return {
      status: "failed",
      reason: result.reason === "notAllowed" ? "network" : result.reason,
    };
  const { status, json } = result;
  if (status >= 200 && status < 300)
    return json ? { status: "ok" } : { status: "failed", reason: "invalidResponse" };
  if (status === 400 || status === 422)
    return { status: "ok", warning: "rejectedRequest" };
  if ([404, 405, 501].includes(status))
    return listedModel
      ? { status: "unsupported", reason: "notFound" }
      : { status: "failed", reason: "modelNotFound" };
  if (status === 401 || status === 403) return { status: "failed", reason: "auth" };
  return { status: "failed", reason: "http" };
}

function probes(endpoint, model) {
  const ask = [{ role: "user", content: "ok" }];
  return {
    messages: endpoint.anthropicBaseUrl && {
      url: `${endpoint.anthropicBaseUrl}/v1/messages`,
      body: { model, max_tokens: 1, messages: ask },
      headers: { "anthropic-version": "2023-06-01" },
    },
    responses: {
      url: `${endpoint.openaiBaseUrl}/responses`,
      body: { model, input: "ok", max_output_tokens: 16 },
    },
    chatCompletions: {
      url: `${endpoint.openaiBaseUrl}/chat/completions`,
      body: { model, max_tokens: 1, messages: ask },
    },
  };
}

export async function runEndpointTest({
  endpoint,
  apiKey,
  probeModelId,
  previousModels = [],
  signal,
  lookup,
}) {
  const deadline = AbortSignal.timeout(TOTAL_TIMEOUT);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const detection = await listEndpointModels({
    endpoint,
    apiKey,
    signal: combined,
    lookup,
  });
  const models = mergeModels(previousModels, detection);
  const listedIds = new Set(detection.models.map((model) => model.modelId));
  const model =
    probeModelId || detection.models[0]?.modelId || models[0]?.modelId || null;
  const warnings = new Set(detection.warnings);
  const protocols = {};
  const reasons = {};
  const headers = authHeaders(apiKey, endpoint.authHeader);
  for (const [name, probe] of Object.entries(probes(endpoint, model))) {
    if (!model || !probe) {
      protocols[name] = "skipped";
      continue;
    }
    let outcome;
    try {
      outcome = classifyProbe(
        await endpointRequest({
          url: probe.url,
          method: "POST",
          body: probe.body,
          headers: { ...headers, ...(probe.headers || {}) },
          timeoutMs: PROBE_TIMEOUT,
          signal: combined,
          lookup,
        }),
        { listedModel: listedIds.has(model) },
      );
    } catch (error) {
      outcome = classifyProbe(
        { reason: error.reason || "network" },
        { listedModel: listedIds.has(model) },
      );
    }
    protocols[name] = outcome.status;
    if (outcome.reason) reasons[name] = outcome.reason;
    if (outcome.warning) warnings.add(outcome.warning);
  }
  return {
    models,
    listed: detection.listed,
    protocols,
    reasons,
    probeModelId: model,
    warnings: [...warnings],
  };
}
```

`reason` values are fixed identifiers only (`notFound`, `modelNotFound`, `auth`, `http`, `invalidResponse`, `timeout`, `network`, `tooLarge`, `aborted`), so no upstream text can leak.

- [ ] **Step 4: Implement `endpoint-tester.js`**

```js
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { validModelId } from "./provider-definitions.js";
import { endpointOrigins, validateEndpoint } from "./endpoint-config.js";
import { runEndpointTest } from "./endpoint-probe.js";

const DRAFT_KEYS = ["connectionId", "endpoint", "apiKey", "probeModelId"];
const ENDPOINT_KEYS = ["preset", "openaiBaseUrl", "anthropicBaseUrl", "authHeader"];
const NO_PROTOCOLS = { messages: false, responses: false, chatCompletions: false };

export class EndpointTester {
  constructor({ connections, lookup }) {
    this.connections = connections;
    this.lookup = lookup;
    this.running = false;
  }
  draft(body) {
    const messages = serverMessages.providers;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !DRAFT_KEYS.includes(key))
    )
      throw problem(messages.invalidEndpoint);
    const input = body.endpoint;
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !ENDPOINT_KEYS.includes(key))
    )
      throw problem(messages.invalidEndpoint);
    if (
      body.apiKey !== undefined &&
      (typeof body.apiKey !== "string" ||
        body.apiKey.length > 16384 ||
        /[\x00-\x1f]/.test(body.apiKey))
    )
      throw problem(messages.invalidApiKey);
    if (body.probeModelId !== undefined && !validModelId(body.probeModelId))
      throw problem(messages.invalidModelId);
    // One validator owns URL and header rules: validate a block without protocols or models.
    const { preset, openaiBaseUrl, anthropicBaseUrl, authHeader } = validateEndpoint({
      ...input,
      protocols: NO_PROTOCOLS,
      models: [],
      lastTest: null,
    });
    return { preset, openaiBaseUrl, anthropicBaseUrl, authHeader };
  }
  async test(body, signal) {
    const endpoint = this.draft(body);
    const warnings = [];
    let apiKey = body.apiKey?.trim() || "";
    let previousModels = [];
    if (body.connectionId !== undefined) {
      const record = this.connections.record(body.connectionId);
      if (record.providerId !== "endpoint")
        throw problem(serverMessages.providers.endpointTestConnectionInvalid);
      previousModels = record.endpoint.models;
      if (body.apiKey === undefined) {
        const same =
          JSON.stringify(endpointOrigins(endpoint)) ===
          JSON.stringify(endpointOrigins(record.endpoint));
        const stored = this.connections.secret(record.id)?.apiKey || "";
        if (same) apiKey = stored;
        else if (stored) warnings.push("storedKeyNotUsed");
      }
    }
    if (this.running) throw problem(serverMessages.providers.endpointTestBusy, 429);
    this.running = true;
    try {
      const result = await runEndpointTest({
        endpoint,
        apiKey,
        probeModelId: body.probeModelId,
        previousModels,
        signal,
        lookup: this.lookup,
      });
      return { ...result, warnings: [...new Set([...warnings, ...result.warnings])] };
    } finally {
      this.running = false;
    }
  }
}
```

- [ ] **Step 5: Route, services, audit**

`server/http/routes/provider-connections.js`:

```js
export function providerConnectionRoutes({ providerConnections, endpointTester }) {
  const router = Router();
  // ... existing routes ...
  router.post("/provider-connections/test", async (request, response) => {
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    response.json(await endpointTester.test(request.body, controller.signal));
  });
  return router;
}
```

Express 5 forwards rejected promises to the error handler; confirm the Express major version in `package.json` (`"express"`). If it is 4, wrap with `.catch(next)`.

`server/application/services.js` after `providerConnections`:

```js
const endpointTester = new EndpointTester({ connections: providerConnections });
```

and add `endpointTester` to the returned services object (find the `return {` of `createServices` and add it next to `providerConnections`).

`server/features/audit/audit-http.js`, in the `if/else if` chain add:

```js
  } else if (area === "provider-connections" && id === "test") {
    action = "tested";
    resourceId = undefined;
```

- [ ] **Step 6: Run tests**

Run: `node --test tests/integration/endpoint-probe.test.js tests/blackbox/endpoint-routes.test.js tests/blackbox/provider-connections.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx prettier --write server/features/providers/endpoint-probe.js server/features/providers/endpoint-tester.js server/http/routes/provider-connections.js server/application/services.js server/features/audit/audit-http.js tests/integration/endpoint-probe.test.js tests/blackbox/endpoint-routes.test.js
git add server tests
git commit -m "feat: test custom endpoints for protocols and models

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: MCP models, doctor and restore

**Files:**

- Modify: `server/features/mcp/tool-service.js:178-198`
- Modify: `server/features/operations/doctor.js:183-194`
- Modify: `server/features/operations/restore.js:137-147`
- Test: `tests/integration/endpoint-connections.test.js` (extend), plus the existing MCP/doctor/restore tests

**Interfaces:**

- Consumes: `endpointModel`/`endpointTools` (Task 3), `ProviderConnections.record` (Task 5).

- [ ] **Step 1: Failing tests**

Find the existing tests: `grep -rln "models_list" tests` and `grep -rln "credentialsNeedingLogin" tests` and `grep -rln "provider-connection\\." tests`. Add, in the respective files using their fixtures:

- MCP: an endpoint connection with models `qwen3` (context 32768) and `nocontext` (null) → `models_list` for `opencode` returns exactly `[{ modelId: "qwen3", name: "qwen3", contextTokens: 32768, ... }]`.
- Doctor: an endpoint connection without key → check `provider-connection.<id>` status `ok` and its detail mentions the last test (`"never tested"` when `lastTest` is null) and the count of models without context.
- Restore: backup containing a keyless endpoint connection → `credentialsNeedingLogin` does not include `provider:<id>`; a keyed one does.

- [ ] **Step 2: Run to verify failure**

Run the three test files found in Step 1. Expected: FAIL.

- [ ] **Step 3: Implement**

`tool-service.js` `models_list`:

```js
const models =
  connection.providerId === "endpoint"
    ? connection.endpoint.models
        .filter((model) => model.contextTokens)
        .map((model) => endpointModel(connection.endpoint, model.modelId, args.tool))
    : providerCatalog.list({ providerId: connection.providerId, tool: args.tool });
```

(`connection.tools.includes(args.tool)` is already checked above, so `endpointModel` cannot throw for protocol reasons.) Import `endpointModel`.

`doctor.js` loop over connections:

```js
for (const connection of readJson(
  path.join(this.dataDir, "provider-connections.json"),
  [],
)) {
  const keyed = fs.existsSync(
    path.join(this.dataDir, "provider-connection-secrets", `${connection.id}.json`),
  );
  if (connection.providerId === "endpoint") {
    const missing = (connection.endpoint?.models || []).filter(
      (model) => !model.contextTokens,
    ).length;
    const tested = connection.endpoint?.lastTest;
    add(
      `provider-connection.${connection.id}`,
      missing ? "warn" : "ok",
      `Custom endpoint; key ${keyed ? "configured" : "not configured"}; ${
        tested
          ? `last test ${tested.at}: ${Object.entries(tested.protocols)
              .map(([name, status]) => `${name}=${status}`)
              .join(", ")}`
          : "never tested"
      }; ${missing} model(s) without context. No network check was performed.`,
    );
    continue;
  }
  add(/* existing call */);
}
```

Doctor details are diagnostic evidence (English, untranslated) like the existing messages.

`restore.js`:

```js
for (const connection of readJson(path.join(stage, "provider-connections.json"), []))
  if (
    !secrets.some(
      (member) => member.path === `provider-connection-secrets/${connection.id}.json`,
    ) &&
    connection.providerId !== "endpoint"
  )
    credentialsNeedingLogin.push(`provider:${connection.id}`);
```

A keyed endpoint connection's secret is in the backup like any other; if it is missing from the archive, the user re-enters it — but restore cannot know whether the endpoint needed one. Record this: keyless endpoints are never flagged; the UI shows `launchable` status after restore. The spec's "keyed endpoint connections are flagged" requires knowing a key existed; check whether the backup manifest lists excluded secrets (`grep -n "secrets" server/features/operations/backup.js`). If the manifest records secret paths, flag endpoint connections whose secret path appears in the manifest but not in the restored members; otherwise flag none and adjust the restore test accordingly. Note the outcome in the commit message.

Restored endpoint blocks are validated by the `ProviderConnections` constructor (Task 5) when the server restarts on the restored data; invalid ones are skipped and kept on disk, so restore itself needs no second validator.

- [ ] **Step 4: Run tests**

Run the test files from Step 1 plus `tests/integration/provider-connections-backup.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/features/mcp/tool-service.js server/features/operations/doctor.js server/features/operations/restore.js
git add server tests
git commit -m "feat: list endpoint models over MCP and report endpoints in doctor and restore

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Web — launchable gates, connection models hook, provider names

**Files:**

- Create: `web/features/providers/useConnectionModels.js`
- Modify: `web/features/sessions/useLaunchAccess.js:12-26,61,77-80`
- Modify: `web/features/sessions/LaunchAccessFields.jsx:59-60`
- Modify: `web/features/pipelines/ProfileProviderFields.jsx:60`
- Modify: `web/features/pipelines/ProfileEditor.jsx:100-105`
- Modify: `web/features/provider-connections/ProviderConnections.jsx:28-34`
- Modify: `web/features/providers/ProviderFields.jsx:24-28`
- Modify: `web/features/providers/useAccountProvider.js:42`
- Modify: `web/lib/i18n/{de,en}/connections.js`
- Test: `tests/browser/provider-connections.spec.js` (run), new spec in Task 14

**Interfaces:**

- Produces: `useConnectionModels(connection, tool) → { models, status, loading, error, refresh, reloading, endpoint: boolean }` — same shape as `useProviderCatalog`; for endpoint connections `models` are `connection.endpoint.models` with `contextTokens` set, mapped to `{ providerId: "endpoint", modelId, label, contextTokens, routingContextTokens: null, outputTokens, tools: connection.tools }`, `status: null`, `loading: false`, `refresh: async () => {}`.

- [ ] **Step 1: i18n keys (both locales)**

`web/lib/i18n/en/connections.js` — extend `providerNames` and add keys:

```js
  providerNames: {
    openrouter: "OpenRouter",
    zai: "Z.ai API",
    "zai-coding-plan": "Z.ai Coding Plan",
    endpoint: "Custom endpoint",
  },
  keyNotRequired: "No API key required",
```

German:

```js
    endpoint: "Eigener Endpunkt",
  // ...
  keyNotRequired: "Kein API-Key nötig",
```

Copy the exact German style of neighboring entries (read `web/lib/i18n/de/connections.js` first).

- [ ] **Step 2: `useConnectionModels.js`**

```js
import { useMemo } from "react";
import useProviderCatalog from "./useProviderCatalog.js";

export default function useConnectionModels(connection, tool) {
  const endpoint = connection?.providerId === "endpoint";
  const catalog = useProviderCatalog(endpoint ? "" : connection?.providerId || "", tool);
  const models = useMemo(
    () =>
      endpoint
        ? connection.endpoint.models
            .filter((model) => model.contextTokens)
            .map((model) => ({
              providerId: "endpoint",
              modelId: model.modelId,
              label: model.label,
              contextTokens: model.contextTokens,
              routingContextTokens: null,
              outputTokens: model.outputTokens,
              tools: connection.tools,
            }))
            .filter((model) => model.tools.includes(tool))
        : null,
    [endpoint, connection, tool],
  );
  if (!endpoint) return { ...catalog, endpoint: false };
  return {
    models,
    status: null,
    loading: false,
    error: "",
    refresh: async () => {},
    reloading: false,
    endpoint: true,
  };
}
```

- [ ] **Step 3: Use it and switch gates**

- `useLaunchAccess.js`: `defaultAccess` uses `connection.launchable` instead of `connection.hasSecret` (both occurrences); `const catalog = useConnectionModels(connection, tool)`; `ready` uses `connection?.launchable`.
- `LaunchAccessFields.jsx` lines 59-60:

```js
              label: `${connection.name} · ${copy.providerNames[connection.providerId] || connection.providerId}${connection.launchable ? "" : ` · ${copy.keyMissing}`}`,
              disabled: !connection.launchable,
```

- `ProfileProviderFields.jsx:60`: `{!connection.launchable && (`.
- `ProfileEditor.jsx`: replace the `useProviderCatalog(...)` call with

```js
const connectionModels = useConnectionModels(connection, config.cliTool);
const accountCatalog = useProviderCatalog(
  !config.providerConnectionId && account?.provider?.id ? account.provider.id : "",
  config.cliTool,
);
const catalog = config.providerConnectionId ? connectionModels : accountCatalog;
```

(`useConnectionModels(undefined, …)` calls `useProviderCatalog("")`, a no-op.)

- `ProviderConnections.jsx:32`: `{connection.hasSecret ? copy.keySaved : connection.launchable ? copy.keyNotRequired : copy.keyMissing}`, and for endpoint connections show the host: after the provider name add `{connection.endpoint ? ` · ${new URL(connection.endpoint.openaiBaseUrl).host}` : ""}`.
- `ProviderFields.jsx`: `...controller.providers.filter((provider) => provider.kind !== "endpoint").map(...)`.
- `useAccountProvider.js:42`: `const requiresResponses = tool === "codex" && providerId && providerId !== "openrouter";` → keep behavior for catalog providers (endpoint is filtered out of this form), but express it via the providers list: `const definition = providers.find((item) => item.id === providerId); const requiresResponses = tool === "codex" && !!providerId && definition?.id !== "openrouter";`. Read the hook first; if `providers` is not available there, leave this line unchanged (endpoint never reaches it) and note it in the commit.

- [ ] **Step 4: Run checks**

Run: `npm run lint && node --test tests/unit/i18n-catalogs.test.js && npm run build`
Expected: PASS.

Run: `npx playwright test tests/browser/provider-connections.spec.js tests/browser/providers.spec.js tests/browser/provider-model-picker.spec.js --project=chromium`
Expected: PASS. Fixtures in `tests/browser/providers-fixture.js` may need `launchable: true` on connections with keys — add it where connections are built, mirroring `hasSecret`.

- [ ] **Step 5: Commit**

```bash
npx prettier --write web tests/browser
git add web tests/browser
git commit -m "feat: treat keyless endpoint connections as launchable in the web UI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Web — endpoint connection dialog

**Files:**

- Create: `web/features/provider-connections/endpoint-draft.js`
- Create: `web/features/provider-connections/useEndpointTest.js`
- Create: `web/features/provider-connections/EndpointFields.jsx`
- Create: `web/features/provider-connections/EndpointTestResult.jsx`
- Create: `web/features/provider-connections/EndpointModelTable.jsx`
- Modify: `web/features/provider-connections/ConnectionDialog.jsx`
- Modify: `web/lib/i18n/{de,en}/connections.js` (`endpointCopy` section)
- Test: `tests/unit/endpoint-draft.test.js` (pure helpers), browser test in Task 14

**Interfaces:**

- Produces:
  - `endpoint-draft.js`: `PRESETS` (mirror of server presets), `initialEndpoint(connection) → EndpointDraft`, `suggestAnthropicUrl(openaiUrl) → string`, `originsChanged(saved, draft) → boolean`, `applyProposal(draft, proposal) → EndpointDraft` (sets `models`, protocol flags from `ok` results, `lastTest`), `endpointPayload(draft) → object` (body for POST/PATCH `endpoint`).
  - `useEndpointTest({ connection, draft, apiKey }) → { run(probeModelId?), busy, result, error }` posting to `/provider-connections/test` with `AbortController` cleanup.

- [ ] **Step 1: i18n — add `endpoint` object to `connectionCopy` in both locales**

English:

```js
  endpoint: {
    preset: "Server type",
    presets: { ollama: "Ollama", llamacpp: "llama.cpp", custom: "Custom (OpenAI/Anthropic compatible)" },
    openaiBaseUrl: "OpenAI-compatible base URL",
    openaiHelp: "Usually ends with /v1. Used by Codex (Responses) and OpenCode (Chat Completions).",
    advanced: "Advanced",
    anthropicBaseUrl: "Anthropic-compatible base URL",
    anthropicHelp: "Used by Claude Code. Leave empty if the server has no Anthropic Messages API.",
    authHeader: "Auth header name",
    authHeaderHelp: "Leave empty to send the key as Authorization: Bearer. Example: api-key.",
    keyOptional: "Optional for local servers",
    keyReentry: "The address changed. Enter the API key again or remove it.",
    test: "Test connection",
    testing: "Testing …",
    testCost: "The test sends a few tokens per protocol. Paid endpoints may charge for them.",
    probeModel: "Test model",
    probeAuto: "Automatic",
    protocols: "Protocols",
    protocolNames: { messages: "Anthropic Messages", responses: "OpenAI Responses", chatCompletions: "OpenAI Chat Completions" },
    enables: { messages: "Claude Code", responses: "Codex", chatCompletions: "OpenCode" },
    statuses: { ok: "Available", unsupported: "Not supported", failed: "Failed", skipped: "Not tested" },
    reasons: {
      notFound: "Endpoint not found",
      modelNotFound: "Model not found on the server",
      auth: "Authentication failed",
      http: "Unexpected server response",
      invalidResponse: "Unreadable response",
      timeout: "Timed out",
      network: "Server not reachable or address not allowed",
      tooLarge: "Response too large",
      aborted: "Cancelled",
    },
    warnings: {
      ollamaContextUnknown: "Ollama does not report the loaded context for some models. Confirm the context size; the model maximum is only a hint.",
      modelIdSkipped: "Some model IDs could not be used (for example file paths). Start llama.cpp with --alias or add the model manually.",
      storedKeyNotUsed: "The saved key was not sent because the address changed.",
      rejectedRequest: "The server rejected the minimal test request but the endpoint exists.",
    },
    notListed: "The model list could not be read. Previously detected and manual models are kept.",
    models: "Models",
    modelId: "Model ID",
    context: "Context",
    output: "Max output",
    source: "Source",
    sources: { detected: "Detected", manual: "Manual" },
    contextHint: (tokens) => `Model maximum: ${tokens}`,
    contextMissing: "Context required",
    addModel: "Add model",
    removeModel: (id) => `Remove ${id}`,
    azureHint: "Azure OpenAI: enter your deployment names as model IDs.",
    noModels: "No models yet. Test the connection or add a model.",
  },
```

German with identical keys and arities:

```js
  endpoint: {
    preset: "Server-Typ",
    presets: { ollama: "Ollama", llamacpp: "llama.cpp", custom: "Benutzerdefiniert (OpenAI/Anthropic-kompatibel)" },
    openaiBaseUrl: "OpenAI-kompatible Basis-URL",
    openaiHelp: "Endet meist auf /v1. Wird von Codex (Responses) und OpenCode (Chat Completions) genutzt.",
    advanced: "Erweitert",
    anthropicBaseUrl: "Anthropic-kompatible Basis-URL",
    anthropicHelp: "Wird von Claude Code genutzt. Leer lassen, wenn der Server keine Anthropic Messages API hat.",
    authHeader: "Name des Auth-Headers",
    authHeaderHelp: "Leer lassen, um den Key als Authorization: Bearer zu senden. Beispiel: api-key.",
    keyOptional: "Für lokale Server optional",
    keyReentry: "Die Adresse hat sich geändert. Gib den API-Key erneut ein oder entferne ihn.",
    test: "Verbindung testen",
    testing: "Teste …",
    testCost: "Der Test sendet pro Protokoll ein paar Tokens. Bezahlte Endpunkte können dafür abrechnen.",
    probeModel: "Testmodell",
    probeAuto: "Automatisch",
    protocols: "Protokolle",
    protocolNames: { messages: "Anthropic Messages", responses: "OpenAI Responses", chatCompletions: "OpenAI Chat Completions" },
    enables: { messages: "Claude Code", responses: "Codex", chatCompletions: "OpenCode" },
    statuses: { ok: "Verfügbar", unsupported: "Nicht unterstützt", failed: "Fehlgeschlagen", skipped: "Nicht getestet" },
    reasons: {
      notFound: "Endpunkt nicht gefunden",
      modelNotFound: "Modell auf dem Server nicht gefunden",
      auth: "Anmeldung fehlgeschlagen",
      http: "Unerwartete Serverantwort",
      invalidResponse: "Antwort nicht lesbar",
      timeout: "Zeitüberschreitung",
      network: "Server nicht erreichbar oder Adresse nicht erlaubt",
      tooLarge: "Antwort zu groß",
      aborted: "Abgebrochen",
    },
    warnings: {
      ollamaContextUnknown: "Ollama meldet für manche Modelle nicht den geladenen Kontext. Bestätige die Kontextgröße; das Modell-Maximum ist nur ein Hinweis.",
      modelIdSkipped: "Einige Modell-IDs waren nicht nutzbar (z. B. Dateipfade). Starte llama.cpp mit --alias oder trage das Modell manuell ein.",
      storedKeyNotUsed: "Der gespeicherte Key wurde nicht gesendet, weil sich die Adresse geändert hat.",
      rejectedRequest: "Der Server hat die minimale Testanfrage abgelehnt, der Endpunkt existiert aber.",
    },
    notListed: "Die Modellliste konnte nicht gelesen werden. Bisher erkannte und manuelle Modelle bleiben erhalten.",
    models: "Modelle",
    modelId: "Modell-ID",
    context: "Kontext",
    output: "Max. Output",
    source: "Herkunft",
    sources: { detected: "Erkannt", manual: "Manuell" },
    contextHint: (tokens) => `Modell-Maximum: ${tokens}`,
    contextMissing: "Kontext erforderlich",
    addModel: "Modell hinzufügen",
    removeModel: (id) => `${id} entfernen`,
    azureHint: "Azure OpenAI: Trage deine Deployment-Namen als Modell-IDs ein.",
    noModels: "Noch keine Modelle. Teste die Verbindung oder füge ein Modell hinzu.",
  },
```

If `web/lib/i18n/messages/connections.js` wraps catalogs with a reactive proxy, nested objects are supported only if existing catalogs use them (`providerNames` is nested, so yes).

- [ ] **Step 2: Pure helpers + unit test**

```js
// web/features/provider-connections/endpoint-draft.js
export const PRESETS = {
  ollama: {
    openaiBaseUrl: "http://127.0.0.1:11434/v1",
    anthropicBaseUrl: "http://127.0.0.1:11434",
    protocols: { messages: true, responses: true, chatCompletions: true },
  },
  llamacpp: {
    openaiBaseUrl: "http://127.0.0.1:8080/v1",
    anthropicBaseUrl: "http://127.0.0.1:8080",
    protocols: { messages: false, responses: false, chatCompletions: true },
  },
  custom: {
    openaiBaseUrl: "",
    anthropicBaseUrl: "",
    protocols: { messages: false, responses: false, chatCompletions: true },
  },
};
export function initialEndpoint(connection, preset = "ollama") {
  if (connection?.endpoint)
    return {
      ...connection.endpoint,
      anthropicBaseUrl: connection.endpoint.anthropicBaseUrl || "",
      authHeader: connection.endpoint.authHeader || "",
    };
  return {
    preset,
    ...structuredClone(PRESETS[preset]),
    authHeader: "",
    models: [],
    lastTest: null,
  };
}
export const suggestAnthropicUrl = (url) =>
  url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
const origin = (url) => {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return url;
  }
};
export const originsChanged = (saved, draft) =>
  !!saved &&
  [origin(saved.openaiBaseUrl), origin(saved.anthropicBaseUrl)].sort().join() !==
    [origin(draft.openaiBaseUrl), origin(draft.anthropicBaseUrl)].sort().join();
export function applyProposal(draft, proposal, now = new Date().toISOString()) {
  const protocols = Object.fromEntries(
    Object.entries(draft.protocols).map(([name, enabled]) => [
      name,
      proposal.protocols[name] === "ok"
        ? true
        : proposal.protocols[name] === "skipped"
          ? enabled
          : false,
    ]),
  );
  return {
    ...draft,
    protocols,
    models: proposal.models,
    lastTest: { at: now, protocols: proposal.protocols, reasons: proposal.reasons },
  };
}
export function endpointPayload(draft) {
  return {
    preset: draft.preset,
    openaiBaseUrl: draft.openaiBaseUrl.trim(),
    anthropicBaseUrl: draft.anthropicBaseUrl.trim() || null,
    protocols: draft.protocols,
    authHeader: draft.authHeader.trim() || null,
    models: draft.models,
    lastTest: draft.lastTest,
  };
}
```

`origin()` for `""` and `null` both yield `""`; saved `anthropicBaseUrl` may be `null`.

```js
// tests/unit/endpoint-draft.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyProposal,
  originsChanged,
  suggestAnthropicUrl,
  endpointPayload,
  initialEndpoint,
} from "../../web/features/provider-connections/endpoint-draft.js";

test("draft helpers", () => {
  assert.equal(suggestAnthropicUrl("https://x.example/v1/"), "https://x.example");
  const saved = { openaiBaseUrl: "http://a:1/v1", anthropicBaseUrl: null };
  assert.equal(
    originsChanged(saved, { openaiBaseUrl: "http://a:1/other", anthropicBaseUrl: "" }),
    false,
  );
  assert.equal(
    originsChanged(saved, { openaiBaseUrl: "http://b:1/v1", anthropicBaseUrl: "" }),
    true,
  );
  const draft = initialEndpoint(null, "ollama");
  const next = applyProposal(
    draft,
    {
      protocols: { messages: "failed", responses: "ok", chatCompletions: "skipped" },
      reasons: { messages: "auth" },
      models: [],
    },
    "2026-10-06T00:00:00.000Z",
  );
  assert.deepEqual(next.protocols, {
    messages: false,
    responses: true,
    chatCompletions: true,
  });
  assert.equal(
    endpointPayload({ ...next, anthropicBaseUrl: " ", authHeader: "" }).anthropicBaseUrl,
    null,
  );
});
```

Run: `node --test tests/unit/endpoint-draft.test.js` → FAIL first, then PASS after creating the file.

- [ ] **Step 3: `useEndpointTest.js`**

```js
import { useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";

export default function useEndpointTest({ connection, draft, apiKey, removeApiKey }) {
  const [state, setState] = useState({ busy: false, result: null, error: "" });
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function run(probeModelId) {
    controller.current?.abort();
    controller.current = new AbortController();
    setState({ busy: true, result: null, error: "" });
    try {
      const result = await api(
        "/provider-connections/test",
        "POST",
        {
          ...(connection ? { connectionId: connection.id } : {}),
          endpoint: {
            preset: draft.preset,
            openaiBaseUrl: draft.openaiBaseUrl.trim(),
            anthropicBaseUrl: draft.anthropicBaseUrl.trim() || null,
            authHeader: draft.authHeader.trim() || null,
          },
          ...(apiKey ? { apiKey } : removeApiKey ? { apiKey: "" } : {}),
          ...(probeModelId ? { probeModelId } : {}),
        },
        controller.current.signal,
      );
      setState({ busy: false, result, error: "" });
      return result;
    } catch (error) {
      if (!controller.current.signal.aborted)
        setState({ busy: false, result: null, error: error.message });
      return null;
    }
  }
  return { ...state, run };
}
```

Verify `api(path, method, body, signal)` signature in `web/lib/api.js` (used that way in `useProviderCatalog.js:24-29`).

- [ ] **Step 4: Components**

`EndpointFields.jsx` (URL fields, preset, advanced):

```jsx
import React from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { PRESETS, suggestAnthropicUrl } from "./endpoint-draft.js";

export default function EndpointFields({ draft, setDraft, locked }) {
  const copy = connectionCopy.endpoint;
  const patch = (values) => setDraft((current) => ({ ...current, ...values }));
  return (
    <>
      <label>
        {copy.preset}
        <AnchoredSelect
          label={copy.preset}
          value={draft.preset}
          disabled={locked}
          onChange={(preset) =>
            setDraft((current) => ({
              ...current,
              preset,
              ...structuredClone(PRESETS[preset]),
            }))
          }
          options={Object.keys(PRESETS).map((value) => ({
            value,
            label: copy.presets[value],
          }))}
        />
      </label>
      <label>
        {copy.openaiBaseUrl}
        <input
          required
          type="url"
          inputMode="url"
          value={draft.openaiBaseUrl}
          onChange={(event) => {
            const value = event.target.value;
            setDraft((current) => ({
              ...current,
              openaiBaseUrl: value,
              ...(current.preset === "custom" && current.anthropicAuto !== false
                ? { anthropicBaseUrl: suggestAnthropicUrl(value) }
                : {}),
            }));
          }}
        />
        <small>{copy.openaiHelp}</small>
      </label>
      <details>
        <summary>{copy.advanced}</summary>
        <label>
          {copy.anthropicBaseUrl}
          <input
            type="url"
            value={draft.anthropicBaseUrl}
            onChange={(event) =>
              patch({ anthropicBaseUrl: event.target.value, anthropicAuto: false })
            }
          />
          <small>{copy.anthropicHelp}</small>
        </label>
        <label>
          {copy.authHeader}
          <input
            value={draft.authHeader}
            maxLength={64}
            placeholder="Authorization"
            onChange={(event) => patch({ authHeader: event.target.value })}
          />
          <small>{copy.authHeaderHelp}</small>
        </label>
      </details>
    </>
  );
}
```

`anthropicAuto` is a UI-only flag; `endpointPayload` does not include it.

`EndpointTestResult.jsx`:

```jsx
import React from "react";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";

export default function EndpointTestResult({ draft, setDraft, result }) {
  const copy = connectionCopy.endpoint;
  return (
    <fieldset className="endpoint-protocols">
      <legend>{copy.protocols}</legend>
      {Object.keys(copy.protocolNames).map((name) => {
        const status = result?.protocols[name];
        const reason = result?.reasons?.[name];
        const unavailable = name === "messages" && !draft.anthropicBaseUrl.trim();
        return (
          <label key={name} className="provider-check">
            <input
              type="checkbox"
              checked={draft.protocols[name] && !unavailable}
              disabled={unavailable}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  protocols: { ...current.protocols, [name]: event.target.checked },
                }))
              }
            />
            <span>
              {copy.protocolNames[name]} · {copy.enables[name]}
              {status && (
                <small data-status={status}>
                  {copy.statuses[status]}
                  {reason ? ` · ${copy.reasons[reason] || reason}` : ""}
                </small>
              )}
            </span>
          </label>
        );
      })}
      {result && !result.listed && <p className="field-description">{copy.notListed}</p>}
      {result?.warnings.map((warning) => (
        <p key={warning} className="field-description" role="status">
          {copy.warnings[warning] || warning}
        </p>
      ))}
    </fieldset>
  );
}
```

`EndpointModelTable.jsx`:

```jsx
import React, { useState } from "react";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";

const tokens = (value) => (value === "" ? null : Number(value));

export default function EndpointModelTable({ draft, setDraft }) {
  const copy = connectionCopy.endpoint;
  const [newId, setNewId] = useState("");
  const update = (modelId, values) =>
    setDraft((current) => ({
      ...current,
      models: current.models.map((model) =>
        model.modelId === modelId ? { ...model, ...values, contextEdited: true } : model,
      ),
    }));
  return (
    <fieldset className="endpoint-models">
      <legend>{copy.models}</legend>
      {draft.preset === "custom" && <p className="field-description">{copy.azureHint}</p>}
      {!draft.models.length && <p className="field-description">{copy.noModels}</p>}
      {draft.models.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{copy.modelId}</th>
              <th>{copy.context}</th>
              <th>{copy.output}</th>
              <th>{copy.source}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.models.map((model) => (
              <tr
                key={model.modelId}
                data-missing-context={!model.contextTokens || undefined}
              >
                <td>{model.modelId}</td>
                <td>
                  <input
                    type="number"
                    min={1024}
                    max={10000000}
                    aria-label={`${copy.context} ${model.modelId}`}
                    value={model.contextTokens ?? ""}
                    placeholder={
                      model.contextHint
                        ? copy.contextHint(model.contextHint)
                        : copy.contextMissing
                    }
                    onChange={(event) =>
                      update(model.modelId, { contextTokens: tokens(event.target.value) })
                    }
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={1024}
                    max={10000000}
                    aria-label={`${copy.output} ${model.modelId}`}
                    value={model.outputTokens ?? ""}
                    onChange={(event) =>
                      update(model.modelId, { outputTokens: tokens(event.target.value) })
                    }
                  />
                </td>
                <td>{copy.sources[model.source]}</td>
                <td>
                  <button
                    type="button"
                    className="button secondary"
                    aria-label={copy.removeModel(model.modelId)}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        models: current.models.filter(
                          (item) => item.modelId !== model.modelId,
                        ),
                      }))
                    }
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="endpoint-add-model">
        <input
          aria-label={copy.modelId}
          value={newId}
          maxLength={200}
          onChange={(event) => setNewId(event.target.value)}
        />
        <button
          type="button"
          className="button secondary"
          disabled={
            !newId.trim() || draft.models.some((model) => model.modelId === newId.trim())
          }
          onClick={() => {
            const modelId = newId.trim();
            setDraft((current) => ({
              ...current,
              models: [
                ...current.models,
                {
                  modelId,
                  label: modelId,
                  contextTokens: null,
                  outputTokens: null,
                  source: "manual",
                  contextEdited: true,
                },
              ],
            }));
            setNewId("");
          }}
        >
          {copy.addModel}
        </button>
      </div>
    </fieldset>
  );
}
```

Add minimal CSS where the connection dialog styles live (`grep -rn "connection-fields" web --include=*.css`): `.endpoint-models table { width: 100%; } .endpoint-models input[type=number] { width: 9ch; } [data-missing-context] input:first-child { outline: 1px solid var(--danger, #c33); }`. Use existing color tokens from that stylesheet instead of the fallback if available. Verify at phone width (the dialog must not scroll horizontally — wrap the table in a `div` with `overflow-x: auto`).

- [ ] **Step 5: Wire into `ConnectionDialog.jsx`**

Changes:

```jsx
import EndpointFields from "./EndpointFields.jsx";
import EndpointTestResult from "./EndpointTestResult.jsx";
import EndpointModelTable from "./EndpointModelTable.jsx";
import useEndpointTest from "./useEndpointTest.js";
import { applyProposal, endpointPayload, initialEndpoint, originsChanged } from "./endpoint-draft.js";
// state
  const [draft, setDraft] = useState(() => initialEndpoint(connection));
  const endpoint = providerId === "endpoint";
  const tester = useEndpointTest({ connection, draft, apiKey, removeApiKey });
  const [probeModelId, setProbeModel] = useState("");
  const keyReentry = endpoint && connection?.hasSecret && !apiKey && !removeApiKey && originsChanged(connection.endpoint, draft);
// body in onSubmit
              ...(providerId !== "openrouter" && !endpoint && (...existing condition...) ? { responsesAccess } : {}),
              ...(endpoint ? { endpoint: endpointPayload(draft) } : {}),
// JSX: after the provider select
            {endpoint && <EndpointFields draft={draft} setDraft={setDraft} locked={false} />}
// key input placeholder:
                placeholder={connection?.hasSecret ? copy.keyPlaceholder : endpoint ? copy.endpoint.keyOptional : copy.keyOptional}
            {keyReentry && <p role="alert">{copy.endpoint.keyReentry}</p>}
// the responses checkbox condition becomes: {providerId !== "openrouter" && !endpoint && (
// after the key section:
            {endpoint && (
              <>
                <div className="endpoint-test">
                  <label>
                    {copy.endpoint.probeModel}
                    <AnchoredSelect
                      label={copy.endpoint.probeModel}
                      value={probeModelId}
                      onChange={setProbeModel}
                      options={[{ value: "", label: copy.endpoint.probeAuto }, ...draft.models.map((model) => ({ value: model.modelId, label: model.modelId }))]}
                    />
                  </label>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={tester.busy || !draft.openaiBaseUrl.trim()}
                    onClick={async () => {
                      const proposal = await tester.run(probeModelId);
                      if (proposal) setDraft((current) => applyProposal(current, proposal));
                    }}
                  >
                    {tester.busy ? copy.endpoint.testing : copy.endpoint.test}
                  </button>
                  <small>{copy.endpoint.testCost}</small>
                  <ErrorMessage error={tester.error} />
                </div>
                <EndpointTestResult draft={draft} setDraft={setDraft} result={tester.result} />
                <EndpointModelTable draft={draft} setDraft={setDraft} />
              </>
            )}
// save button
            disabled={action.busy || keyReentry || (!connection && !providers.data)}
// provider select onChange also resets the draft:
                  setDraft(initialEndpoint(null));
```

The default provider stays `"openrouter"`. Keep `ConnectionDialog.jsx` under 600 lines (it is ~160 now).

- [ ] **Step 6: Run checks**

Run: `npm run lint && npm run format:check && node --test tests/unit/endpoint-draft.test.js tests/unit/i18n-catalogs.test.js && npm run build && npm run check:structure`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx prettier --write web tests/unit/endpoint-draft.test.js
git add web tests/unit/endpoint-draft.test.js
git commit -m "feat: add custom endpoint fields, test and model table to the connection dialog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Browser test for the endpoint flow

The existing browser suite mocks the API with `page.route` (`tests/browser/providers-fixture.js`). This test follows that pattern; the real probe logic is covered by Task 9/10 integration tests against fake servers.

**Files:**

- Create: `tests/browser/endpoint-connections.spec.js`
- Modify: `tests/browser/providers-fixture.js` (add `endpoint` to `providers`, add `/provider-connections/test` mock and a POST/PATCH capture)

- [ ] **Step 1: Read the fixture and an existing spec**

Read `tests/browser/providers-fixture.js` fully (it routes `**/api/**`, records every call in `controls.calls`, and handles `/api/provider-connections*` generically) and `tests/browser/provider-connections.spec.js` (navigation via `page.goto(baseURL + "/accounts")`, the mobile "new session" flow, native `selectOption` on `AnchoredSelect`).

- [ ] **Step 2: Extend the fixture**

- `providers` list: add `{ id: "endpoint", name: "Custom endpoint", kind: "endpoint", tools: ["codex", "claude", "opencode"] }` and `kind: "catalog"` on the others.
- In the `/api/provider-connections` handler, handle `path === "/api/provider-connections/test"` **before** the generic POST branch, and compute endpoint connection fields in the generic branch:

```js
      if (path === "/api/provider-connections/test")
        return route.fulfill({ json: controls.endpointProposal });
      // generic branch, inside `const connection = {...}`:
        launchable: Boolean(body.apiKey || existing.hasSecret) || (body.providerId || existing.providerId) === "endpoint",
        tools: (body.endpoint || existing.endpoint)
          ? [
              ["codex", "responses"],
              ["claude", "messages"],
              ["opencode", "chatCompletions"],
            ]
              .filter(([, protocol]) => (body.endpoint || existing.endpoint).protocols[protocol])
              .map(([tool]) => tool)
          : /* existing tools expression */,
```

and add `launchable: true` to the connections built in existing specs only where they assert on the launch access select (search for `hasSecret: true` in `tests/browser/*.spec.js`; add `launchable: true` beside each).

- `controls.endpointProposal` default:

```js
{
  models: [
    { modelId: "qwen3:8b", label: "qwen3:8b", contextTokens: 40960, outputTokens: null, source: "detected", contextEdited: false },
    { modelId: "llama3:8b", label: "llama3:8b", contextTokens: null, outputTokens: null, source: "detected", contextEdited: false, contextHint: 131072 },
  ],
  listed: true,
  protocols: { messages: "ok", responses: "unsupported", chatCompletions: "ok" },
  reasons: { responses: "notFound" },
  probeModelId: "qwen3:8b",
  warnings: ["ollamaContextUnknown"],
}
```

- [ ] **Step 3: Write the spec (English UI)**

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

test("create a keyless Ollama connection, confirm context and launch with it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const controls = await fixture(page);
  controls.state.accounts = ["codex", "claude", "opencode"].map((tool) => ({
    id: `local-${tool}`,
    name: `Native ${tool}`,
    tool,
    kind: "local",
  }));
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("button", { name: "Add provider connection", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Connection name", { exact: true }).fill("GPU box");
  await dialog.getByLabel("API provider", { exact: true }).selectOption("endpoint");
  await expect(
    dialog.getByLabel("OpenAI-compatible base URL", { exact: true }),
  ).toHaveValue("http://127.0.0.1:11434/v1");
  await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(dialog.getByText("Not supported · Endpoint not found")).toBeVisible();
  await expect(dialog.getByText(/does not report the loaded context/)).toBeVisible();
  const context = dialog.getByLabel("Context llama3:8b", { exact: true });
  await expect(context).toHaveAttribute("placeholder", "Model maximum: 131072");
  await context.fill("8192");
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const created = controls.calls
    .filter((call) => call.path === "/api/provider-connections" && call.method === "POST")
    .at(-1).body;
  expect(created.apiKey).toBeUndefined();
  expect(created.endpoint.protocols).toEqual({
    messages: true,
    responses: false,
    chatCompletions: true,
  });
  expect(created.endpoint.models[1]).toMatchObject({
    modelId: "llama3:8b",
    contextTokens: 8192,
    contextEdited: true,
  });
  await expect(page.getByText("No API key required")).toBeVisible();

  await page.goto(baseURL + "/");
  await page
    .locator(".mobile-header")
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await page.getByLabel("CLI", { exact: true }).selectOption("codex");
  const access = page.getByLabel("Connection", { exact: true });
  await expect(access.locator('option[value="provider:connection-one"]')).toHaveCount(0);
  await page.getByLabel("CLI", { exact: true }).selectOption("claude");
  await access.selectOption("provider:connection-one");
  await expect(
    access.locator('option[value="provider:connection-one"]'),
  ).not.toContainText("API key missing");
  const model = page.getByLabel("Provider model", { exact: true });
  await expect(model.locator("option")).toContainText(["qwen3:8b", "llama3:8b"]);
  await model.selectOption("llama3:8b");
  await page.getByLabel("Working directory", { exact: true }).fill("/fixture");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  const body = controls.calls.find(
    (call) => call.path === "/api/sessions" && call.method === "POST",
  ).body;
  expect(body).toMatchObject({
    tool: "claude",
    providerConnectionId: "connection-one",
    providerModelId: "llama3:8b",
  });
});
```

If a selector does not match (e.g. the model picker renders a search field first, as in `provider-connections.spec.js` where `Provider model` is clicked before `selectOption`), mirror that spec's sequence exactly; do not weaken assertions.

- [ ] **Step 4: Run**

Run: `npm run build && npx playwright test tests/browser/endpoint-connections.spec.js --project=chromium && npx playwright test tests/browser/endpoint-connections.spec.js --project=webkit`
Expected: PASS in both.

Also run the German UI smoke: `npx playwright test tests/browser/i18n-plugins-providers.spec.js`. If it enumerates provider names, add "Eigener Endpunkt".

- [ ] **Step 5: Screenshot for the PR**

Capture the dialog after the test step: add `await page.screenshot({ path: "test-results/endpoint-dialog.png", fullPage: true });` temporarily, run once, keep the PNG outside git (attach to the PR), remove the line.

- [ ] **Step 6: Commit**

```bash
npx prettier --write tests/browser
git add tests/browser
git commit -m "test: cover the custom endpoint connection flow in the browser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Documentation

**Files:**

- Modify: `docs/providers.md`
- Modify: `docs/research/provider-compatibility.md`

- [ ] **Step 1: `docs/providers.md`**

1. Find the sentence stating that account selection cannot specify endpoint URLs (`grep -n "endpoint URL" docs/providers.md`) and narrow it to catalog providers ("…for OpenRouter and Z.ai connections").
2. Add `endpoint` to the CLI × provider table with the cell text "if the endpoint offers the protocol".
3. Add a section:

```markdown
## Custom endpoints

A custom endpoint connection points the CLIs at your own model server. Presets fill
sensible defaults for **Ollama** and **llama.cpp**; **Custom** covers any
OpenAI- or Anthropic-compatible server such as LM Studio, vLLM, LiteLLM or Azure OpenAI.

| CLI         | Protocol needed         | URL used                             |
| ----------- | ----------------------- | ------------------------------------ |
| Claude Code | Anthropic Messages      | `<Anthropic base URL>/v1/messages`   |
| Codex       | OpenAI Responses        | `<OpenAI base URL>/responses`        |
| OpenCode    | OpenAI Chat Completions | `<OpenAI base URL>/chat/completions` |

A CLI is offered only when its protocol is enabled on the connection. There is no
protocol translation.

**Addresses.** Plain `http` is accepted only for loopback, private (RFC 1918, `fc00::/7`),
link-local and CGNAT/Tailscale (`100.64.0.0/10`) addresses; everything else needs
`https`. AgentPier checks the resolved address when testing and before launch; the CLI
resolves the host again when it connects.

**API key.** Optional. It is sent as `Authorization: Bearer <key>` unless an auth header
name is set under _Advanced_ (for example `api-key`; requires Claude Code 2.1.227 or
later for Claude). The key is bound to the connection's host: changing the host requires
entering the key again or removing it.

**Test connection.** Reads the model list and sends one minimal request per protocol.
The result is a proposal; nothing is saved until you save the connection. Paid endpoints
may charge for the few tokens used.

**Models and context.** Every model needs a context size before it can be launched.

- Ollama: the context comes from `num_ctx` when the model sets it. Otherwise Ollama sizes
  the context by available VRAM or `OLLAMA_CONTEXT_LENGTH`, which its API does not report;
  confirm a value yourself (the model maximum is shown only as a hint).
- llama.cpp: the loaded `n_ctx` is read from `/props`. Model IDs that are file paths are
  skipped; start `llama-server` with `--alias` or add the model manually.
- Azure OpenAI: use `https://<resource>.openai.azure.com/openai/v1` and add your
  deployment names as models; the model list shows base models, not deployments.

Model changes inside a running endpoint session require a reload.
```

- [ ] **Step 2: `docs/research/provider-compatibility.md`**

Add a table (below the Task 1 section):

```markdown
## Self-hosted and third-party servers (2026-10-06)

| Server       | Chat Completions | Responses           | Anthropic Messages  | Notes                                                       |
| ------------ | ---------------- | ------------------- | ------------------- | ----------------------------------------------------------- |
| Ollama       | yes              | yes                 | yes                 | context via `num_ctx` / `OLLAMA_CONTEXT_LENGTH`             |
| llama.cpp    | yes              | yes (recent builds) | yes (recent builds) | AgentPier preset enables only Chat Completions until tested |
| LM Studio    | yes              | check version       | check version       | use Custom preset and test                                  |
| vLLM         | yes              | check version       | no                  |                                                             |
| Azure OpenAI | yes              | yes                 | no                  | v1 API, deployments as model IDs                            |
```

Before writing "yes" for any cell other than Ollama/llama.cpp/Azure (verified in the spec review), check the server's current official documentation with WebSearch and link the source next to the table; write "check version" when unverified.

- [ ] **Step 3: Commit**

```bash
npx prettier --write docs/providers.md docs/research/provider-compatibility.md
git add docs
git commit -m "docs: document custom endpoint connections

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Full verification and cleanup

- [ ] **Step 1: Full check**

Run: `npm run check`
Expected: lint, format, structure, build and all Node test suites pass. Known environment-dependent failure: `shell.test.js` may fail locally (see project memory); confirm it also fails on `origin/main` before ignoring it.

- [ ] **Step 2: Browser suites**

Run: `npx playwright test --project=chromium` and `npx playwright test --project=webkit` for `tests/browser/provider*.spec.js tests/browser/endpoint-connections.spec.js tests/browser/i18n-plugins-providers.spec.js`.
Expected: PASS.

- [ ] **Step 3: Manual smoke against a real server (if Ollama is installed)**

`ollama serve` locally, run `npm run build && npm start` with a disposable data dir (`AGENTPIER_DATA_DIR=$(mktemp -d)` — confirm the env var name in `server/lib/config.js`), create an Ollama connection in English UI, test, launch OpenCode and Claude Code sessions, send one prompt each. Record the outcome in the PR description. Skip with a note if Ollama is not available.

- [ ] **Step 4: Remove temporary planning docs**

```bash
git rm docs/superpowers/specs/2026-10-06-custom-endpoint-providers-design.md docs/superpowers/plans/2026-10-06-custom-endpoint-providers.md
git commit -m "chore: remove completed endpoint provider plan and spec

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand off to superpowers:finishing-a-development-branch** for push and PR (PR description in English: problem, behavior, validation, screenshots from Task 14). The PR description and release notes must state: downgrading below this release is not supported while custom endpoint connections exist (older builds reject the `endpoint` provider when listing connections).
