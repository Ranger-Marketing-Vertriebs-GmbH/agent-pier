# Custom endpoint providers

Date: 2026-10-06

## Problem

Central provider connections support exactly three hardcoded providers: `openrouter`,
`zai` and `zai-coding-plan`. Endpoint URLs, key variables and per-provider quirks are
spread across ternaries in `provider-environment.js`, `provider-launch.js`,
`claude-provider.js`, `provider-connections.js`, `provider-access.js`,
`pipelines/profile-validation.js` and several web components. A connection stores only a
name, a provider id, an API key and the Z.ai Responses flag. Models come from a global
public catalog.

Users cannot launch Claude Code, Codex or OpenCode against a self-hosted or third-party
model server: Ollama, llama.cpp, LM Studio, vLLM, LiteLLM, Azure OpenAI and similar.

## Goal

1. Add a provider type `endpoint`. A connection of this type carries its own base URLs,
   supported wire protocols, auth header, optional API key and model list.
2. Ship presets for Ollama and llama.cpp that pre-fill sensible values and add
   server-specific model and context detection. Everything else uses the `custom`
   preset.
3. Offer an explicit, user-triggered connection test that probes protocols and reads the
   model list, returning a proposal the user confirms before saving.
4. Launch each CLI only when the endpoint supports the protocol that CLI needs.
5. Replace the provider ternaries with a per-provider launch description, so OpenRouter
   and Z.ai keep their exact current behavior and a later protocol adapter has one seam
   to attach to.

## Non-goals

- No protocol adapter or translating proxy. A CLI is offered only when the endpoint
  natively speaks its protocol. This is a planned follow-up.
- No migration of OpenRouter or Z.ai onto the generic endpoint
  (`docs/research/provider-compatibility.md`: native OpenRouter stays native).
- No Azure Entra ID / OAuth token acquisition. Static keys only.
- No model management on the server (`ollama pull`, loading or unloading models).
- No automatic or periodic background probing. `doctor` makes no network calls.
- No endpoint connection management through MCP tools. Connections stay owner-managed
  through the HTTP API and UI, as today.

## Concepts

### Protocols and tools

One central table maps each CLI to the wire protocol it needs:

```js
export const TOOL_PROTOCOL = Object.freeze({
  claude: "messages", // Anthropic Messages API, <anthropicBaseUrl>/v1/messages
  codex: "responses", // OpenAI Responses API, <openaiBaseUrl>/responses
  opencode: "chatCompletions", // OpenAI Chat Completions, <openaiBaseUrl>/chat/completions
});
```

An endpoint connection offers a tool exactly when the tool's protocol is enabled on the
connection. This table is the only place a future adapter changes.

### Launch description

Every provider produces a launch description consumed by the per-CLI launch code:

```js
{
  providerKey,        // stable config key, e.g. "openrouter", "zai", "agentpier-endpoint"
  displayName,        // e.g. "OpenRouter", "Z.ai", connection name
  endpoints: { messages, responses, chatCompletions }, // URL or null
  auth: {
    keyEnv,           // env var carrying the key, e.g. "OPENROUTER_API_KEY"
    header,           // null = native/default scheme, else custom header name
    required,         // whether a key must exist
  },
  model,              // normalized model record incl. contextTokens/outputTokens
  quirks,             // provider-specific flags (gateway discovery, GLM catalog, ...)
}
```

`openrouter`, `zai` and `zai-coding-plan` build it from the registry and catalog with
their current constant values. `endpoint` builds it from the connection record. The
existing matrix tests stay unchanged and must pass unchanged, which proves that the
current providers behave exactly as before.

## Data model

### Connection record

`<dataDir>/provider-connections.json` keeps the existing fields. A connection with
`providerId: "endpoint"` additionally stores:

```js
endpoint: {
  preset: "ollama" | "llamacpp" | "custom",
  openaiBaseUrl: "http://gpu-box:11434/v1",     // required
  anthropicBaseUrl: "http://gpu-box:11434",     // optional; null disables "messages"
  protocols: { messages: false, responses: true, chatCompletions: true },
  authHeader: null,                             // null = default scheme, else header name
  models: [
    {
      modelId: "qwen3-coder:30b",
      label: "qwen3-coder:30b",
      contextTokens: 32768,     // null until detected or entered; launch requires it
      outputTokens: null,       // optional
      source: "detected" | "manual",
      contextEdited: false,     // true once the user changed contextTokens
    },
  ],
  lastTest: {
    at: "2026-10-06T10:00:00.000Z",
    protocols: { messages: "ok", responses: "unsupported", chatCompletions: "ok" },
    error: null,                // sanitized message id, never raw upstream text with secrets
  } | null,
}
```

- `responsesAccess` is not used for `endpoint`. Protocol flags replace it.
- The API key stays in `<dataDir>/provider-connection-secrets/<id>.json`. It is
  **optional** for `endpoint`.
- Changing `providerId` of an existing connection stays forbidden. The `endpoint` block
  is fully replaceable on update.
- The public view adds `endpoint` (without secrets), `hasSecret` and the derived
  `tools`.
- Backup, snapshot and restore carry the record unchanged, because the record lives in
  the same file. Restore validates the `endpoint` block with the same validator as the
  API.

### Presets

| Preset   | openaiBaseUrl               | anthropicBaseUrl         | Protocols enabled by default         |
| -------- | --------------------------- | ------------------------ | ------------------------------------ |
| ollama   | `http://127.0.0.1:11434/v1` | `http://127.0.0.1:11434` | messages, responses, chatCompletions |
| llamacpp | `http://127.0.0.1:8080/v1`  | `http://127.0.0.1:8080`  | chatCompletions                      |
| custom   | (user input)                | derived suggestion       | chatCompletions                      |

For `custom`, the UI suggests `anthropicBaseUrl` by stripping a trailing `/v1` from
`openaiBaseUrl`. The user can clear it. The connection test is the intended way to get
the flags right, and presets only seed them.

### Validation

URL rules, enforced on save, on test and again before every launch:

- Scheme `http:` or `https:` only. No userinfo, no query, no fragment. Trailing slashes
  are normalized away. Maximum length is 2048.
- `http:` is allowed only when every resolved address of the host is loopback
  (`127.0.0.0/8`, `::1`), private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`),
  link-local (`169.254/16`, `fe80::/10`) or CGNAT/Tailscale (`100.64/10`). IP literals
  are checked directly. Hostnames are resolved with `dns.lookup(all: true)` at test and
  launch time. On save, only syntax is checked, so an offline host can still be saved.
- Every other target requires `https:`.
- Requests from the AgentPier server use `redirect: "error"`, so a redirect cannot move
  a request to a different target.

Other fields:

- `authHeader`: `null` or an RFC 7230 token of at most 64 characters, case-insensitively
  not one of `host`, `content-length`, `transfer-encoding`, `connection` or `cookie`.
- `models`: at most 200 entries with unique `modelId`. `modelId` uses the existing
  `validModelId()` (it already allows `:`, `/`, `.`, `+`, `~`). `label` has at most 200
  characters. `contextTokens` and `outputTokens` are `null` or integers from 1024 to
  10 000 000, with `outputTokens <= contextTokens`.
- Unknown keys are rejected, as today.

## Connection test and model detection

### API

`POST /api/provider-connections/test`

The body is a draft: `{ connectionId?, endpoint: {preset, openaiBaseUrl,
anthropicBaseUrl, authHeader}, apiKey?, probeModelId? }`.

- With `connectionId` and no `apiKey`, the stored key is used.
- An empty `apiKey` with `connectionId` means "test without key".
- The route requires the authenticated owner, like all connection routes.
- At most one test per connection id (or per draft session) runs at a time, and a
  global limit of 2 concurrent tests applies. Excess requests get 429.

The response is a proposal and is **not persisted**:

```js
{
  models: [ /* merged list as it would be saved */ ],
  protocols: { messages: "ok"|"unsupported"|"failed"|"skipped", ... },
  details: { messages: { status: 200 }, responses: { status: 404 }, ... },
  probeModelId: "qwen3-coder:30b",
  warnings: [ "ollamaContextDefault", ... ],  // stable message ids
}
```

The UI pre-fills protocol checkboxes and the model table from the proposal. Saving the
connection persists the result together with `lastTest`.

### Steps

1. **List models.** `GET {openaiBaseUrl}/models` (OpenAI list format).
   - `ollama`: also `GET {root}/api/tags`, and `POST {root}/api/show` per model, at most
     50 models, 4 in parallel. The context is `parameters.num_ctx` when set. Otherwise
     it is `model_info["<arch>.context_length"]`, with the warning
     `ollamaContextDefault`: the server may load a smaller context unless `num_ctx` or
     `OLLAMA_CONTEXT_LENGTH` is configured.
   - `llamacpp`: also `GET {root}/props`, using `default_generation_settings.n_ctx` (the
     context actually loaded) for every model the server reports.
   - `{root}` is `anthropicBaseUrl` if set, otherwise `openaiBaseUrl` without a
     trailing `/v1`.
   - A failed listing is not fatal. Manual models still work.
2. **Probe protocols.** For each protocol whose base URL exists, send one minimal request
   to `probeModelId` (default: the first detected or manual model). If there is no
   model, the protocol is `skipped`.
   - messages: `POST {anthropicBaseUrl}/v1/messages`,
     `{model, max_tokens: 1, messages:[{role:"user", content:"ok"}]}`
   - responses: `POST {openaiBaseUrl}/responses`,
     `{model, input:"ok", max_output_tokens: 16}` (16 is the documented minimum for
     some servers)
   - chatCompletions: `POST {openaiBaseUrl}/chat/completions`,
     `{model, max_tokens: 1, messages:[{role:"user", content:"ok"}]}`
   - Classification:
     - 2xx with a parseable body: `ok`
     - 404, 405 or 501: `unsupported`
     - anything else, including 401/403, timeouts and parse errors: `failed`, with a
       sanitized reason id (`auth`, `timeout`, `http`, `invalidResponse`, `network`)
3. **Merge models.**
   - Newly detected models replace previously detected ones.
   - Manual models are kept.
   - For the same `modelId`, user-edited `contextTokens` (`contextEdited`) and
     `outputTokens` are kept.
   - A manual model that is now detected becomes `detected`, keeping its edits.

### Request safety

- Same URL rule as on save, including DNS resolution. The connection is pinned to the
  resolved address for the duration of the test, so DNS rebinding between check and
  request does not apply.
- `redirect: "error"`, a 1 MB response limit per request, 10 s timeout for listings and
  90 s for protocol probes (local servers may load the model on first use). The overall
  test deadline is 180 s.
- The key travels only in the header the CLI will later use: `Authorization: Bearer
  <key>` by default (also for messages, matching `ANTHROPIC_AUTH_TOKEN`), or
  `<authHeader>: <key>` when a custom header is configured.
- The key never appears in logs, audit entries, error messages or responses. Upstream
  response bodies are never echoed. Only status codes and reason ids are returned.
- The UI shows a short note next to the test button: paid endpoints are billed for a
  few tokens.

### Doctor

`doctor` reports for each endpoint connection whether a key is configured, the time and
per-protocol result of `lastTest`, and models without `contextTokens`. It makes no
network calls.

## Launch

### Resolution

- `ProviderAccess.resolve` (sessions) and `pipelines/profile-validation.js` (pipelines)
  keep their flow.
  - The `hasSecret` requirement applies only to providers whose
    `auth.required` is true. It is false for `endpoint`.
  - The Codex `responsesAccess` branch applies only to `zai`/`zai-coding-plan`.
- `validateProviderSelection` dispatches model lookup by provider. Catalog providers use
  `ProviderCatalog.get`. `endpoint` looks the model up in the connection. Because
  internal accounts store only `{id: "endpoint", modelId}` plus
  `internal.connectionId`, the launch always reads the **current** connection record.
  Editing a URL therefore takes effect on the next start or reload without creating new
  internal accounts.
- Live model switches (`command(..., { modelId })`, `model-controller.js`) use the same
  dispatch. Endpoint launches set `modelChangeRequiresRestart: true` for every CLI.

### Pre-launch checks (no network calls except DNS)

- The connection exists, is of type `endpoint`, and the tool's protocol is enabled.
- The model exists in the connection and has `contextTokens`.
- The URL rule holds, including DNS resolution.

Failures return translated errors with stable ids (`endpointProtocolDisabled`,
`endpointModelUnknown`, `endpointContextRequired`, `endpointUrlNotAllowed`).

### Environment

- The inherited-variable strip in `provider-environment.js` also removes
  `AGENTPIER_ENDPOINT_*`.
- Profile directories live under `<profileRoot>/providers/endpoint/`, as for the other
  providers.
- The key, if present, is placed in `AGENTPIER_ENDPOINT_API_KEY`. It never appears in
  argv or in written config files.

### Claude Code

- `ANTHROPIC_BASE_URL = anthropicBaseUrl`, and `ANTHROPIC_API_KEY = ""`.
- Default header: `ANTHROPIC_AUTH_TOKEN = <key>`.
- Custom header: `ANTHROPIC_CUSTOM_HEADERS = "<authHeader>: <key>"` and
  `ANTHROPIC_AUTH_TOKEN = "agentpier-endpoint"` (placeholder, so Claude Code does not
  start an OAuth login).
- No key: `ANTHROPIC_AUTH_TOKEN = "agentpier-endpoint"`.
- The existing non-Claude-model path in `claude-provider.js` then applies: model
  variables, `CLAUDE_CODE_MAX_CONTEXT_TOKENS = contextTokens`, CLI version >= 2.1.193,
  `--model`.
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS = outputTokens ?? min(floor(contextTokens / 4), 32000)`.
- Gateway model discovery stays OpenRouter-only.

### Codex

```toml
model = "<modelId>"
model_provider = "agentpier-endpoint"
model_context_window = <contextTokens>
model_catalog_json = "<CODEX_HOME>/models.json"

[model_providers.agentpier-endpoint]
name = "<connection name>"
base_url = "<openaiBaseUrl>"
wire_api = "responses"
requires_openai_auth = false
env_key = "AGENTPIER_ENDPOINT_API_KEY"                            # default header, key present
env_http_headers = { "<authHeader>" = "AGENTPIER_ENDPOINT_API_KEY" } # custom header
```

- Without a key, both `env_key` and `env_http_headers` are omitted.
- Config is written with `writeTomlConfig` and passed as `-c` args, as today.
- `glmCodexCatalog()` is generalized into `codexModelCatalog(model)`. GLM keeps its exact
  output.

### OpenCode

```json
{
  "model": "agentpier-endpoint/<modelId>",
  "provider": {
    "agentpier-endpoint": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "<connection name>",
      "options": {
        "baseURL": "<openaiBaseUrl>",
        "apiKey": "{env:AGENTPIER_ENDPOINT_API_KEY}",
        "headers": { "<authHeader>": "{env:AGENTPIER_ENDPOINT_API_KEY}" }
      },
      "models": { "<modelId>": { "name": "<label>", "limit": { "context": 0, "output": 0 } } }
    }
  }
}
```

- `apiKey` is omitted without a key. `headers` is present only with a custom header.
- Config is passed via the existing merge into `opencode.json`, plus
  `OPENCODE_CONFIG_CONTENT` and `--model`.
- **Verification item (first plan task):** determine whether the installed OpenCode
  bundles `@ai-sdk/openai-compatible` or installs it from npm on first use.
  - If it installs from npm, offline launches would fail. In that case the package is
    provisioned through the installation scripts and the update path (AGENTS.md), and the
    launch points OpenCode at it.
  - Either way, a browser- or integration-level test launches OpenCode with network
    access to the registry blocked.

## Refactor scope

The refactor is limited to what the launch description replaces:

- `provider-definitions.js`
  - Registry entries gain `kind: "catalog" | "endpoint"`, `auth.required`, `keyEnv`,
    `endpoints` (catalog providers) and `codexAuth`.
  - The `"openrouter"` comparisons in `provider-connections.js`, `provider-access.js`
    and `profile-validation.js` become registry lookups (`responsesGate`,
    `auth.required`).
- `provider-environment.js` and `provider-launch.js` read the launch description
  instead of comparing provider ids.
- `GET /api/providers` lists `endpoint` with `kind: "endpoint"` and no catalog. The
  hardcoded tool list in `routes/providers.js` comes from the registry.
- `ProviderCatalog` stays catalog-only. `GET /providers/endpoint/models` returns 404. The
  web asks the connection for its models.

## UI

### Connection dialog (`web/features/provider-connections/`)

- The provider select gains "Custom endpoint", with a preset select (Ollama, llama.cpp,
  Custom).
- Fields:
  - name
  - OpenAI base URL
  - API key (optional, with "remove key" as today)
  - under "Advanced": Anthropic base URL and auth header name
- **Test connection** button, with the cost note.
  - The result lists each protocol (✓ / not supported / failed with reason) and the CLIs
    it enables.
  - Protocol checkboxes stay editable.
- Model table:
  - columns: ID, context, max output, source
  - add a manual model, remove a model, edit context and output
  - rows without context are flagged and their CLIs cannot launch them
- New components keep files under 600 lines: `EndpointFields.jsx`,
  `EndpointTestResult.jsx`, `EndpointModelTable.jsx`, `useEndpointTest.js`.
- `ConnectionDialog.jsx` delegates to them when the provider is `endpoint`.

### Other places

- The connection list shows the endpoint host and the available CLIs.
- Launch dialog and pipeline profile editor: for endpoint connections the model picker
  lists the connection's models. Catalog status and refresh are hidden.
  - `useLaunchAccess.js` keeps sending `{tool, providerConnectionId, providerModelId}`.
  - The tool list is derived from `connection.tools`.
- The hardcoded provider name maps (`ProviderAccountSummary.jsx`, `providerNames`) gain
  `endpoint`, and `useAccountProvider.js` uses the registry instead of
  `!== "openrouter"`.
- All new text lives in `web/lib/i18n/{de,en}/connections.js` / `providers.js` with
  matching keys and arguments. Server errors go into `server/lib/i18n/{de,en}/providers.js`
  with stable ids.

The legacy per-account provider form (`ProviderFields.jsx`) does **not** gain
`endpoint`. Endpoints are central connections only.

## Testing

- **Unit / property** (`tests/unit`, `tests/property`, fast-check)
  - URL rule:
    - no generated public address is ever accepted with `http:`
    - every private and loopback address is
    - userinfo, query and fragment are always rejected
  - `TOOL_PROTOCOL` derivation of `tools`.
  - Model merge: manual models are kept, edits are kept, detected models are replaced.
  - Header-name validation.
- **Integration** (`tests/integration`, local Node HTTP fake servers on ephemeral ports)
  - An Ollama-like server (`/v1/models`, `/api/tags`, `/api/show`, all three protocols).
  - A llama.cpp-like server (`/v1/models`, `/props`, chat completions only).
  - An Azure-like HTTPS-style server requiring an `api-key` header.
  - Probe timeout and redirect rejection.
  - A key planted in an upstream error body never appears in the response or logs.
  - The concurrency limit (429).
- **Matrix** (`tests/matrix`)
  - `endpoint` × {claude, codex, opencode}, with and without a key, default and custom
    header.
  - Asserts env vars, parsed TOML/JSON, that the key is absent from argv and config
    files, and the context values.
  - Disabled protocol → launch refused.
  - The existing provider matrix runs **unchanged**.
- **Blackbox** (`tests/blackbox`)
  - Connection CRUD with the endpoint block and the test route.
  - Session launch through `providerConnectionId`.
  - Pipeline profile validation.
  - Backup/restore round trip with an endpoint connection.
- **Browser** (`tests/browser`, Playwright, against the fake server)
  - Create an Ollama connection, run the test, add a manual model with context, launch
    dialog shows only enabled CLIs.
  - Runs in English. The i18n spec covers the German strings.

## Documentation

- `docs/providers.md`
  - New section "Custom endpoints": presets, protocol table, URL rule, test, models and
    context, limits.
  - The sentence that account selection cannot specify endpoint URLs is narrowed to
    catalog providers.
- `docs/research/provider-compatibility.md` gains a table of the Ollama, llama.cpp,
  LM Studio, vLLM and Azure OpenAI protocols and the matching CLIs, with sources.
- `docs/sandbox.md` is unchanged: network access is already allowed under nono.

## Risks

- **Ollama context.** Ollama may load a smaller context than the model maximum. This is
  mitigated by preferring `num_ctx`, the `ollamaContextDefault` warning and an editable
  context.
- **Protocol drift across server versions.** The test result is a snapshot. A later
  server downgrade surfaces as a CLI error, not as a pre-launch check. This is
  acceptable without background probing.
- **SSRF surface.** The test route lets the authenticated owner reach private
  addresses. This is mitigated by owner-only access, no MCP exposure, no redirects, no
  body echo, response limits and the concurrency limit.
