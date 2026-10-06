# Custom endpoint providers

Date: 2026-10-06

## Problem

Central provider connections support exactly three hardcoded providers: `openrouter`,
`zai` and `zai-coding-plan`. Endpoint URLs, key variables and per-provider quirks are
spread across ternaries in:

- `provider-environment.js`, `provider-launch.js` and `claude-provider.js`
- `provider-connections.js` and `provider-access.js`
- `pipelines/profile-validation.js`
- several web components

A connection stores only a name, a provider id, an API key and the Z.ai Responses flag.
Models come from a global public catalog.

Users cannot launch Claude Code, Codex or OpenCode against a self-hosted or third-party
model server such as Ollama, llama.cpp, LM Studio, vLLM, LiteLLM or Azure OpenAI.

## Goal

1. Add a provider type `endpoint`. A connection of this type carries its own base URLs,
   supported wire protocols, auth header, optional API key and model list.
2. Ship presets for Ollama and llama.cpp. They pre-fill sensible values and add
   server-specific model and context detection. Everything else uses the `custom`
   preset.
3. Offer an explicit, user-triggered connection test. It probes protocols, reads the
   model list and returns a proposal the user confirms before saving.
4. Launch each CLI only when the endpoint supports the protocol that CLI needs.
5. Replace the provider ternaries with a per-provider launch description. OpenRouter and
   Z.ai keep their exact current behavior, and a later protocol adapter has one seam to
   attach to.

## Non-goals

- No protocol adapter or translating proxy. A CLI is offered only when the endpoint
  natively speaks that CLI's protocol. This is a planned follow-up.
- No migration of OpenRouter or Z.ai onto the generic endpoint
  (`docs/research/provider-compatibility.md`: native OpenRouter stays native).
- No Azure Entra ID or OAuth token acquisition. Static keys only.
- No model management on the server (`ollama pull`, loading or unloading models).
- No automatic or periodic background probing. `doctor` makes no network calls.
- No endpoint connection create, update or test through MCP tools. Connections stay
  owner-managed through the HTTP API and UI, as today. MCP `models_list` does list
  endpoint models (see Launch → MCP).
- No support for downgrading to a build without `endpoint` while endpoint connections
  exist. The release notes state this.

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

An endpoint connection offers a tool exactly when that tool's protocol is enabled on the
connection. This table is the only place a future adapter changes.

### Launch description

Every provider produces a launch description, which the per-CLI launch code consumes:

```js
{
  providerKey,        // stable config key: "openrouter", "zai", "agentpier-endpoint"
  displayName,        // "OpenRouter", "Z.ai", or the connection name
  endpoints: { messages, responses, chatCompletions }, // URL or null
  auth: {
    keyEnv,           // env var carrying the key, e.g. "OPENROUTER_API_KEY"
    header,           // null = native/default scheme, else a custom header name
    required,         // whether a key must exist
  },
  model,              // normalized model record incl. contextTokens/outputTokens
  quirks,             // provider-specific flags (gateway discovery, GLM catalog, ...)
}
```

`openrouter`, `zai` and `zai-coding-plan` build the description from the registry and
catalog with their current constant values. `endpoint` builds it from the connection
record. The existing matrix tests must pass unchanged, which proves the current
providers behave exactly as before.

### Registry

`PROVIDERS` gains `endpoint`. Every entry gains these fields:

- `kind: "catalog" | "endpoint"`
- `auth: { required, keyEnv }`
- `responsesGate`, which is true for `zai` and `zai-coding-plan`
- `endpoints`, for catalog providers only

A derived `CATALOG_PROVIDERS` subset holds only `kind === "catalog"` entries.
**Everything that iterates catalogs uses `CATALOG_PROVIDERS`:**

- `ProviderCatalog`: constructor states, the cache load loop, `list()` without a
  provider, and `providers()` for status
- `catalogSnapshot()`

Without this, `this.models.endpoint` is undefined and the server crashes on start
(`provider-catalog.js:35-42`).

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
      contextEdited: false,     // true once the user changed contextTokens or outputTokens
      contextHint: 262144,      // optional: model maximum reported by the server, display only
    },
  ],
  lastTest: {
    at: "2026-10-06T10:00:00.000Z",
    protocols: { messages: "ok", responses: "unsupported", chatCompletions: "ok" },
    reasons: { responses: "notFound" },        // stable reason ids only
  } | null,
}
```

- `responsesAccess` is not used for `endpoint`. Protocol flags replace it.
- The API key stays in `<dataDir>/provider-connection-secrets/<id>.json` and is
  **optional** for `endpoint`.
- Changing `providerId` of an existing connection stays forbidden. The `endpoint` block
  is fully replaceable on update, subject to key binding (below).
- The public view adds three things:
  - `endpoint` (without secrets)
  - the derived `tools`
  - a derived `launchable` flag: `hasSecret || !auth.required`

  The web gates that currently check `hasSecret` use `launchable` instead (see UI).

- Backup and snapshot carry the record unchanged, because it lives in the same file.

### Key binding

The stored key is bound to the **origins** (scheme, host, port) of `openaiBaseUrl` and
`anthropicBaseUrl`. This preserves host-scoped credentials:

- An update that changes either origin must either supply a new `apiKey` or set
  `removeApiKey: true`. Otherwise it is rejected with 409 `endpointKeyReentryRequired`.
  Path-only changes keep the key.
- The test route uses a stored key only if the draft origins equal the stored origins
  (see Connection test).

### Presets

| Preset   | openaiBaseUrl               | anthropicBaseUrl         | Protocols enabled by default         |
| -------- | --------------------------- | ------------------------ | ------------------------------------ |
| ollama   | `http://127.0.0.1:11434/v1` | `http://127.0.0.1:11434` | messages, responses, chatCompletions |
| llamacpp | `http://127.0.0.1:8080/v1`  | `http://127.0.0.1:8080`  | chatCompletions                      |
| custom   | (user input)                | derived suggestion       | chatCompletions                      |

- The llama.cpp default is intentionally conservative. Current llama-server versions
  document `/v1/messages` and `/v1/responses`, and the test enables them when they
  answer.
- For `custom`, the UI suggests `anthropicBaseUrl` by stripping a trailing `/v1` from
  `openaiBaseUrl`. The user can clear it.
- Presets only seed values. The test is the intended way to get them right.

### Validation

URL rules are enforced on save syntactically, and with DNS on test and before launch:

- Scheme `http:` or `https:` only. No userinfo, query or fragment. Trailing slashes are
  normalized away. The maximum length is 2048.
- Always rejected:
  - unspecified addresses (`0.0.0.0/8`, `::`)
  - multicast and broadcast addresses
- IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is normalized to IPv4 before classification.
- `http:` is allowed only when every resolved address of the host is in one of these
  ranges:
  - loopback: `127.0.0.0/8`, `::1`
  - private: `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`
  - link-local: `169.254/16`, `fe80::/10`
  - CGNAT/Tailscale: `100.64/10`
- IP literals are checked directly. Hostnames are resolved with
  `dns.lookup(all: true)`. Saving checks syntax only, so an offline host can still be
  saved.
- Every other target requires `https:`.

Other fields:

- `authHeader`: `null`, or an RFC 7230 token of at most 64 characters. It must not be
  (case-insensitively) `host`, `content-length`, `transfer-encoding`, `connection` or
  `cookie`.
- The key keeps the existing control-character check (`/[\x00-\x1f]/`). Together with
  the token rule, this prevents header injection through `ANTHROPIC_CUSTOM_HEADERS` and
  request headers.
- `models`:
  - at most 200 entries, each with a unique `modelId`
  - `modelId` uses the existing `validModelId()`
  - `label` has at most 200 characters
  - `contextTokens` and `outputTokens` are `null` or integers from 1024 to 10 000 000,
    with `outputTokens <= contextTokens`
- Unknown keys are rejected, as today.

The same validator runs:

- on the API
- in the `ProviderConnections` constructor (invalid records are reported and skipped,
  never crash startup)
- in restore

## Connection test and model detection

### API

`POST /api/provider-connections/test`

The body is a draft:

```js
{ connectionId?, endpoint: { preset, openaiBaseUrl, anthropicBaseUrl, authHeader },
  apiKey?, probeModelId? }
```

- With `connectionId`, the connection must have `providerId === "endpoint"`. Otherwise
  the request is rejected with 400.
- The stored key is used only when `apiKey` is absent **and** the draft origins equal
  the stored origins. An empty `apiKey` means "test without key". If the origins differ
  and no `apiKey` is given, the test runs without a key and returns the warning
  `storedKeyNotUsed`.
- The route requires the authenticated owner, like all connection routes.
- At most one test runs at a time, globally. A concurrent request gets 429.
- If the client disconnects, all upstream requests are aborted.
- Audit records the request as `provider.tested`, not `provider.created`. The
  `ssh-accesses` route is the precedent in `audit-http.js`.

The response is a proposal and is **not persisted**:

```js
{
  models: [ /* merged list as it would be saved */ ],
  listed: true,                    // whether any model listing succeeded
  protocols: { messages: "ok"|"unsupported"|"failed"|"skipped", ... },
  reasons: { responses: "modelNotFound", ... },
  probeModelId: "qwen3-coder:30b",
  warnings: [ "ollamaContextUnknown", "modelIdSkipped", ... ],  // stable message ids
}
```

The UI pre-fills protocol checkboxes and the model table from the proposal. Saving the
connection persists the result together with `lastTest`.

### Steps

1. **List models.** Call `GET {openaiBaseUrl}/models` (OpenAI list format).
   - **ollama:** also call `GET {root}/api/tags` and `POST {root}/api/show` for each
     model, at most 50 models with 4 in parallel.
     - `parameters` is a Modelfile-style string. Parse its `num_ctx` line.
     - If `num_ctx` is set, it becomes `contextTokens`.
     - Otherwise `contextTokens` stays **null**, and `model_info["<arch>.context_length"]`
       is stored as `contextHint`, with the warning `ollamaContextUnknown`. Ollama sizes
       the loaded context by VRAM or by `OLLAMA_CONTEXT_LENGTH`, which the API does not
       expose. The UI asks the user to confirm a value and shows the hint plus a link to
       the Ollama context documentation.
   - **llamacpp:**
     - If the server lists one model, call `GET {root}/props` and use
       `default_generation_settings.n_ctx` (the context actually loaded).
     - If it lists several models (router mode), call `GET {root}/props?model=<id>` for
       each model. A failure leaves `contextTokens` null.
   - `{root}` is `anthropicBaseUrl` if set, otherwise `openaiBaseUrl` without a trailing
     `/v1`.
   - Detected IDs that fail `validModelId()`, such as llama.cpp's `/path/model.gguf`,
     are skipped with the warning `modelIdSkipped`. The warning suggests `--alias` or a
     manual model.
   - A failed listing is not fatal, and `listed` becomes false. Manual models still work.
   - **Azure note (UI and docs):** model IDs are deployment names. `/models` lists base
     models, not deployments, so deployments must be added manually.
2. **Probe protocols.** The user can choose `probeModelId` before testing. By default it
   is the first detected model, otherwise the first manual model. For each protocol
   whose base URL exists, the test sends one minimal request. If there is no model, the
   protocol is `skipped`.
   - messages: `POST {anthropicBaseUrl}/v1/messages` with
     `{model, max_tokens: 1, messages:[{role:"user", content:"ok"}]}`
   - responses: `POST {openaiBaseUrl}/responses` with
     `{model, input:"ok", max_output_tokens: 16}`
   - chatCompletions: `POST {openaiBaseUrl}/chat/completions` with
     `{model, max_tokens: 1, messages:[{role:"user", content:"ok"}]}`

   Classification:

   | Response                                                        | Status        | Reason                                                                                                                                              |
   | --------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
   | 2xx with a parseable body                                       | `ok`          |                                                                                                                                                     |
   | 400 or 422                                                      | `ok`          | `rejectedRequest` (warning). The route exists and only the minimal body was rejected, e.g. reasoning deployments requiring `max_completion_tokens`. |
   | 404, 405 or 501, probe model came from this server's listing    | `unsupported` |                                                                                                                                                     |
   | 404, 405 or 501, probe model was manual or no listing succeeded | `failed`      | `modelNotFound`. Ollama, Azure and llama.cpp router mode answer 404 for unknown models, so 404 alone does not prove a missing protocol.             |
   | 401 or 403                                                      | `failed`      | `auth`                                                                                                                                              |
   | anything else                                                   | `failed`      | `timeout`, `http`, `invalidResponse` or `network`                                                                                                   |

3. **Merge models.**
   - Newly detected models replace previously detected ones, **only if the listing
     succeeded**. If it failed, previously detected models are kept unchanged.
   - Manual models are always kept.
   - For the same `modelId`, user-edited values (`contextEdited`) are kept.
   - A manual model that is now detected becomes `detected` and keeps its edits.

### Request safety

- Requests use `node:http` / `node:https` directly, not global `fetch`, so the checked
  address can be pinned. A custom `lookup` returns the address that passed the URL rule.
  TLS SNI and certificate checks still use the hostname. This closes DNS rebinding
  between check and request for the test. No new dependency is added.
- Redirects are not followed; any 3xx is `failed/http`.
- Each response is limited to 1 MB. Timeouts:
  - 10 s for listings
  - 90 s for protocol probes, because local servers may load the model on first use
  - 180 s for the whole test
- The key travels only in the header the CLI will later use:
  - by default, `Authorization: Bearer <key>`, also for messages, matching
    `ANTHROPIC_AUTH_TOKEN`
  - with a custom header, `<authHeader>: <key>`
- The key never appears in logs, audit entries, error messages or responses. Upstream
  response bodies are never echoed. Only status codes and reason ids are returned.
- A note next to the test button says that paid endpoints are billed for a few tokens.

### Doctor

`doctor` reports for each endpoint connection:

- whether a key is configured
- the time and per-protocol result of `lastTest`
- models without `contextTokens`

It makes no network calls.

## Launch

### Resolution

`ProviderAccess.resolve` (sessions) and `pipelines/profile-validation.js` (pipelines)
keep their flow, with these changes:

- The `hasSecret` requirement applies only when `auth.required` is true, which is never
  the case for `endpoint`. The same applies to the key check in `prepareProviderLaunch`
  (`provider-launch.js:28-29`).
- The Codex `responsesAccess` branch applies only to providers with `responsesGate`.

**Model lookup.** `validateProviderSelection` dispatches by registry `kind`:

- `catalog` uses `ProviderCatalog.get`.
- `endpoint` looks the model up in the connection.

**Plumbing.**

- `AccountStore` receives `providerConnections`. For internal accounts with
  `provider.id === "endpoint"`, `command()` reads the **current** connection via
  `internal.connectionId` and passes it to `prepareProviderLaunch`.
- Internal accounts keep storing only `{id: "endpoint", modelId}`. Reuse is keyed by
  `JSON.stringify(provider)`, so URL edits take effect on the next start or reload
  without new internal accounts.

**Model switches.** Endpoint launches set `modelChangeRequiresRestart: true` for every
CLI, so `model-controller.js` rejects live model switches for endpoint sessions, as it
already does for non-Claude models. A model change means a reload or a new session.

### Pre-launch checks

The checks are:

- The connection exists, is of type `endpoint`, and the tool's protocol is enabled.
- The model exists in the connection and has `contextTokens`.
- The URL rule, including DNS resolution.

Where the checks run:

- `accounts.command()` is synchronous, so the synchronous checks (first two) run inside
  it.
- The asynchronous DNS check runs in `session-lifecycle.js` before `command()`, in
  `session-reload-lifecycle.js` before `command()`, and in the pipeline stage launch
  path.
- The launch-time DNS check is **best effort**: the CLI resolves the host itself later.

Failures return translated errors with stable ids: `endpointProtocolDisabled`,
`endpointModelUnknown`, `endpointContextRequired` and `endpointUrlNotAllowed`.

### Environment

- The inherited-variable strip in `provider-environment.js` also removes
  `AGENTPIER_ENDPOINT_*`.
- Profile directories live under `<profileRoot>/providers/endpoint/`.
- The key, if present, goes into `AGENTPIER_ENDPOINT_API_KEY`. It never appears in argv
  or in written config files. Launches already pass env through the private payload
  file, not tmux argv.

### Claude Code

- `ANTHROPIC_BASE_URL = anthropicBaseUrl` and `ANTHROPIC_API_KEY = ""`.
- Auth:
  - Default header: `ANTHROPIC_AUTH_TOKEN = <key>`.
  - Custom header: `ANTHROPIC_CUSTOM_HEADERS = "<authHeader>: <key>"` and
    `ANTHROPIC_AUTH_TOKEN = "agentpier-endpoint"`. The placeholder keeps Claude Code
    from starting an OAuth login. This path requires **Claude Code >= 2.1.227**
    (`ANTHROPIC_CUSTOM_HEADERS`). Older versions get `endpointClaudeCustomHeaderVersion`.
  - No key: `ANTHROPIC_AUTH_TOKEN = "agentpier-endpoint"`.
- Endpoint models **always** take the non-Claude-model path in `claude-provider.js`,
  even when the model ID contains `claude-` (e.g. a LiteLLM alias). That path sets:
  - the model variables
  - `CLAUDE_CODE_MAX_CONTEXT_TOKENS = contextTokens`
  - the CLI version requirement >= 2.1.193
  - `--model`
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS = outputTokens ?? min(floor(contextTokens / 4), 32000)`.
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = 1`, because gateways and local servers reject
  unknown beta headers.
- Gateway model discovery stays OpenRouter-only.

### Codex

```toml
model = "<modelId>"
model_provider = "agentpier-endpoint"
model_context_window = <contextTokens>
model_catalog_json = "<CODEX_HOME>/models.json"

[model_providers.agentpier-endpoint]
name = "<connection name>"
base_url = "<openaiBaseUrl>"          # Codex appends /responses
wire_api = "responses"
requires_openai_auth = false
env_key = "AGENTPIER_ENDPOINT_API_KEY"                               # default header, key present
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
      "models": {
        "<modelId>": { "name": "<label>", "limit": { "context": 0, "output": 0 } }
      }
    }
  }
}
```

- `apiKey` is omitted without a key. `headers` is present only with a custom header.
- `limit.output = outputTokens ?? min(floor(contextTokens / 4), 32000)`, because the
  schema requires both limits.
- Config is passed via the existing merge into `opencode.json`, plus
  `OPENCODE_CONFIG_CONTENT` and `--model`.
- **Verification item (first plan task):**
  - Confirm that the installed OpenCode bundles `@ai-sdk/openai-compatible`. Upstream
    source does (`provider.ts`). Confirm with a launch test that blocks npm registry
    access.
  - Confirm that `{env:...}` substitution works inside `options.headers`.
  - Only if bundling fails: provision the package through the installation scripts and
    the update path (AGENTS.md).

### Pipelines

Pipeline run snapshots currently freeze `{id, providerId, responsesAccess}` and compare
them with `isDeepStrictEqual` (`native-profile.js`, `pipeline-definitions.js`).

For endpoint connections, the snapshot adds a **stable subset**:

- `openaiBaseUrl` and `anthropicBaseUrl` origins
- `protocols`
- the selected model's `contextTokens` and `outputTokens`

`lastTest` and other models are excluded, so re-testing does not break running
pipelines. Editing these fields mid-run triggers the existing snapshot-mismatch
behavior, instead of silently re-targeting later stages. A profile that references a
model removed from the connection fails validation with `endpointModelUnknown` at run
start.

### MCP

`models_list` (`server/features/mcp/tool-service.js`) returns the connection's own models
for endpoint connections, in the existing response shape. Agents need these IDs for
`profile_save`.

## Refactor scope

The refactor is limited to what the launch description replaces:

- Registry fields and `CATALOG_PROVIDERS`, as described in Concepts.
- The `"openrouter"` comparisons become registry lookups (`responsesGate`,
  `auth.required`) in:
  - `provider-connections.js`
  - `provider-access.js`
  - `profile-validation.js`
  - `native-profile.js`
- `provider-environment.js` and `provider-launch.js` read the launch description instead
  of comparing provider ids.
- `GET /api/providers` lists `endpoint` with `kind: "endpoint"` and no catalog status.
  The hardcoded tool list in `routes/providers.js` comes from the registry.
- `GET /providers/endpoint/models` and `POST /providers/endpoint/refresh` keep returning
  400 like any non-catalog provider today. The web fetches endpoint models from the
  connection.
- Restore:
  - Connections with `providerId: "endpoint"` and no secret file are **not** added to
    `credentialsNeedingLogin` when no key is required.
  - Connections with a key are added, as today.

## UI

### Connection dialog (`web/features/provider-connections/`)

- The provider select gains "Custom endpoint", with a preset select (Ollama, llama.cpp,
  Custom).
- Fields:
  - name
  - OpenAI base URL
  - API key (optional), with "remove key" as today
  - under "Advanced": Anthropic base URL and auth header name
- Changing an origin while a key is stored shows that the key must be re-entered or
  removed. This mirrors the 409 `endpointKeyReentryRequired`.
- **Test connection**:
  - shows the cost note
  - offers an optional probe-model select
  - lists each protocol in the result (✓ / not supported / failed with reason) and the
    CLIs it enables
  - shows warnings (`ollamaContextUnknown`, `modelIdSkipped`, `storedKeyNotUsed`,
    `rejectedRequest`)
  - leaves the protocol checkboxes editable
- **Model table**:
  - columns: ID, context, max output, source; `contextHint` is shown as a placeholder
  - lets the user add a manual model, remove a model, and edit context and output
  - flags rows without context; they cannot be launched
  - Azure hint: enter deployment names
- New files keep everything under 600 lines:
  - `EndpointFields.jsx`
  - `EndpointTestResult.jsx`
  - `EndpointModelTable.jsx`
  - `useEndpointTest.js`

  `ConnectionDialog.jsx` delegates to them when the provider is `endpoint`.

### Other places

- **Launchable instead of has-key.** These web gates switch from `hasSecret` to
  `launchable`:
  - `LaunchAccessFields.jsx` (disabled state and "key missing" label)
  - `useLaunchAccess.js` (default access and `ready`)
  - `ProfileProviderFields.jsx`
  - `ProviderConnections.jsx`
- **Models.** A new hook, `useConnectionModels(connection, tool)`, returns catalog models
  via `useProviderCatalog` for catalog providers and `connection.endpoint.models` for
  endpoint connections. `useLaunchAccess.js` and `ProfileEditor.jsx` use it instead of
  calling `useProviderCatalog(connection.providerId)` directly. Catalog status and
  refresh are hidden for endpoints.
- The connection list shows the endpoint host and the available CLIs.
- `useLaunchAccess.js` keeps sending `{tool, providerConnectionId, providerModelId}`.
  The tool list is derived from `connection.tools`.
- The legacy per-account provider form (`ProviderFields.jsx`) filters out
  `kind === "endpoint"`, so endpoints exist only as central connections.
- The hardcoded provider name maps (`ProviderAccountSummary.jsx`, `providerNames`) gain
  `endpoint`. `useAccountProvider.js` uses the registry instead of `!== "openrouter"`.
- All new text goes in `web/lib/i18n/{de,en}/connections.js` and `providers.js`, with
  matching keys and arguments. Server errors go in
  `server/lib/i18n/{de,en}/providers.js`, with stable ids.

## Testing

**Unit / property** (`tests/unit`, `tests/property`, fast-check):

- URL rule:
  - No generated public address is ever accepted with `http:`.
  - Every private and loopback address is accepted.
  - Mapped IPv6 is classified as its IPv4 address.
  - Unspecified and multicast addresses are always rejected.
  - Userinfo, query and fragment are always rejected.
- `TOOL_PROTOCOL` derivation of `tools` and `launchable`.
- Model merge:
  - Manual models and edits are kept.
  - Detected models are replaced only after a successful listing.
- Probe classification, including 404 with listed vs. manual model and 400 as
  `rejectedRequest`.
- Ollama `parameters` string parsing.
- Header-name validation.
- Key binding: an origin change without a new key or removal is rejected.

**Integration** (`tests/integration`, local Node HTTP fake servers on ephemeral ports):

- Fake servers:
  - Ollama-like: `/v1/models`, `/api/tags`, `/api/show` with and without `num_ctx`,
    all three protocols, 404 for unknown models.
  - llama.cpp-like: single-model and router mode, `/props` and `/props?model=`, a path
    model ID, chat completions only.
  - Azure-like: requires an `api-key` header, `/models` without the deployment.
- Probe timeout, redirect rejection, client-disconnect abort.
- The address pinning lookup is used.
- A key planted in an upstream error body never appears in the response or logs.
- The 429 concurrency limit.
- A stored key is not sent to a changed origin.
- The `ProviderCatalog` constructor and `models_list` work with `endpoint` registered.

**Matrix** (`tests/matrix`):

- `endpoint` × {claude, codex, opencode}, each with and without a key, and with the
  default and a custom header.
- Asserts:
  - env vars
  - parsed TOML/JSON
  - the key is absent from argv and config files
  - context and output values
  - the Claude path for a `claude-*` endpoint model ID
  - the Claude version gate for custom headers
- A disabled protocol refuses the launch.
- The existing provider matrix runs **unchanged**.

**Blackbox** (`tests/blackbox`):

- Connection CRUD with the endpoint block, key re-entry, and the test route including
  audit action `provider.tested`.
- Session launch through `providerConnectionId` without a key.
- Pipeline profile validation and the snapshot subset.
- Backup/restore round trip with keyless and keyed endpoint connections.

**Browser** (`tests/browser`, Playwright, against the fake server):

- Create an Ollama connection, run the test, confirm the context for a model without
  `num_ctx`, add a manual model, and check that the launch dialog shows only enabled
  CLIs and treats the keyless connection as launchable.
- Runs in English. The i18n spec covers the German strings.

## Documentation

- `docs/providers.md`:
  - New section "Custom endpoints" covering presets, the protocol table, the URL rule,
    key binding, the test, models and context (Ollama context, llama.cpp aliases, Azure
    deployment names) and limits.
  - The sentence that account selection cannot specify endpoint URLs is narrowed to
    catalog providers.
- `docs/research/provider-compatibility.md` gains a table of the protocols supported by
  Ollama, llama.cpp, LM Studio, vLLM and Azure OpenAI, the matching CLIs and sources. It
  also notes the conservative llama.cpp preset.
- `docs/sandbox.md` is unchanged: network access is already allowed under nono.
- Release notes state that downgrading below this release is not supported while
  endpoint connections exist.

## Risks

- **Ollama context.** Ollama may load a smaller context than the model maximum.
  Mitigation: `num_ctx` is used when present, and otherwise a user-confirmed value is
  required, with the maximum shown only as a hint.
- **Protocol drift across server versions.** The test result is a snapshot. A later
  server change surfaces as a CLI error, not as a pre-launch check. This is acceptable
  without background probing.
- **SSRF surface.** The test route lets the authenticated owner reach private
  addresses. Mitigations:
  - owner-only access and no MCP exposure
  - no redirects and no body echo
  - address pinning
  - response limits and a global concurrency limit of 1

  AgentPier's own API is not a useful target, because it refuses Bearer requests outside
  MCP and requires `Origin` on POST.

- **Launch-time DNS.** The DNS check before launch is best effort. The CLI resolves the
  host itself.
