# Protocol adapter for custom endpoints

Date: 2026-10-07

## Problem

Custom endpoint connections (PR #176) offer a CLI only when the endpoint natively speaks
that CLI's wire protocol:

| CLI         | Protocol today          |
| ----------- | ----------------------- |
| Claude Code | Anthropic Messages      |
| Codex       | OpenAI Responses        |
| OpenCode    | OpenAI Chat Completions |

Many servers speak only Chat Completions (vLLM, older llama.cpp builds, many LiteLLM and
company gateways), some only Messages or only Responses. Users cannot run the CLI of
their choice against the model of their choice.

## Goal

1. Every CLI can use every custom endpoint that offers at least one of the three
   protocols.
2. Keep fidelity for agentic coding: text, streaming, tool calls (parallel, custom and
   namespaced tools), system prompts (including mid-conversation system messages),
   reasoning, images, structured output, prompt caching and cache usage, stop reasons,
   token usage, context-overflow signalling and errors.
3. Prefer native protocols. Use translation automatically only when needed, show it, and
   allow a per-CLI override per connection.
4. Keep running sessions independent of AgentPier server restarts and release
   activation.
5. Do not expose the upstream API key to the CLI process when the adapter is used.

## How each CLI reaches each protocol

| CLI         | Messages upstream              | Responses upstream             | Chat Completions upstream              |
| ----------- | ------------------------------ | ------------------------------ | -------------------------------------- |
| Claude Code | native                         | adapter (Messages ← Responses) | adapter (Messages ← Chat)              |
| Codex       | adapter (Responses ← Messages) | native                         | adapter (Responses ← Chat)             |
| OpenCode    | native SDK `@ai-sdk/anthropic` | native SDK `@ai-sdk/openai`    | native SDK `@ai-sdk/openai-compatible` |

OpenCode needs no adapter: it bundles the AI SDK providers for all three protocols
(verified for `@ai-sdk/openai-compatible` in PR #176; `@ai-sdk/anthropic` and
`@ai-sdk/openai` must be verified the same way — first plan task). AgentPier only
switches the provider package and base URL. The adapter therefore implements **four
directions**, with **two client protocols** (Messages for Claude Code, Responses for
Codex) and **three upstream protocols**.

## Non-goals

- Translation for catalog providers (OpenRouter, Z.ai). They stay native.
- Realtime, audio, batch, files, assistants APIs, and Codex's websocket transport.
- Stateful Responses features over the adapter (`previous_response_id`, server-side
  storage). Codex does not send `previous_response_id` over HTTP; if it appears, the
  adapter returns an `invalid_request_error`.
- Emulating hosted tools (web search, code interpreter, file search, computer use,
  `tool_search`) on targets without them.
- Upstream HTTP(S) proxies (`HTTPS_PROXY`) in this iteration; documented as
  unsupported for adapter routes. Private CAs are supported (see Security).
- Model capability discovery beyond what PR #176 detects.

## Architecture

### Layers

1. **Protocol library** — `server/features/protocol-adapter/`, pure functions, no network,
   no filesystem.
   - Client side (2 modules): `client-messages.js` and `client-responses.js`, each with
     `parseRequest(body, headers) → IrRequest`, `emitStream(events) →
AsyncIterable<string>`, `emitResponse(events) → object` (collects the same event
     stream), `emitError(irError) → { status, headers, body }`, `emitStreamError(irError)`.
   - Upstream side (3 modules): `upstream-messages.js`, `upstream-responses.js`,
     `upstream-chat.js`, each with `buildRequest(ir, capabilities) → { path, body,
headers }`, `parseStream(chunks) → AsyncIterable<IrEvent>`, `parseResponse(json)`,
     `parseError(status, body, headers) → IrError`.
   - Shared: `ir.js` (types, validators), `sse.js` (incremental parser and writer),
     `mapping.js` (stop reasons, effort ↔ budget, usage), `names.js` (per-session
     bijective maps for tool names and call ids), `errors.js` (classifiers per server
     family).

2. **Adapter process** — `server/adapter-process.js` (entry point at the release root next
   to `terminal-launcher.js`, so release reference tracking covers it). A child process of
   the launcher. It binds an HTTP server on `127.0.0.1:0`, reports the port to the launcher
   over an IPC channel, and serves exactly one session. It never writes to stdout/stderr;
   failures go to its diagnostics file and a sanitized one-line message the launcher prints.

3. **Launcher integration** — `server/terminal-launcher.js` starts the adapter process
   when the payload has an `adapter` block, waits for the bound port (timeout 10 s),
   substitutes the adapter URL into the CLI's `env` values and `args`, spawns the CLI,
   and stops the adapter (SIGTERM, then SIGKILL after 2 s) when the CLI exits or the
   launcher is signalled. Signal handlers are registered before the adapter is started.

### Why a child of the launcher

- The launcher outlives AgentPier server restarts; release activation is already guarded
  by launcher references (`release-references.js`). In-flight streams survive server
  restarts.
- A separate process isolates adapter crashes from the TUI (the launcher's stdio is the
  CLI's PTY) and from other sessions.
- The upstream key lives only in the launcher payload and the adapter process.

Pipeline (headless) sessions use the same launcher path (`spawnNativeProcess`); the
adapter is started the same way before the process group.

## Intermediate representation (IR)

```js
IrRequest {
  model: string,
  system: Part[],                                   // leading system/developer content
  messages: { role: "system" | "user" | "assistant", parts: Part[] }[], // system allowed mid-conversation
  tools: {
    name, namespace?: string, description,
    kind: "function" | "custom" | "hosted",
    schema?, grammar?, hostedType?                 // hosted: e.g. "web_search"
  }[],
  toolChoice: "auto" | "none" | "required" | { name, namespace? },
  parallelToolCalls: boolean | null,
  sampling: { maxOutputTokens: number | null, temperature, topP, stop: string[] },
  thinking: { mode: "disabled" | "enabled" | "adaptive", budgetTokens?, effort?: string, summary?: "auto" | "none" } | null,
  output: { format: "text" } | { format: "json_schema", name, schema, strict },
  cache: { key: string | null },                    // breakpoints live on parts
  stream: boolean,
  hints: { metadata?, user?, serviceTier?, ... }    // dropped-and-counted unless a target maps them
}
Part =
  | { type: "text", text, cache?: "ephemeral" }
  | { type: "image", mediaType, data?, url?, cache? }
  | { type: "toolCall", id, name, namespace?, kind: "function" | "custom", input }   // input: JSON text or raw custom text
  | { type: "toolResult", callId, parts: Part[], isError, cache? }
  | { type: "reasoning", text?, summary?, carrier?: string, redacted?: true }

IrEvent =
  | { type: "start", id, model }
  | { type: "blockStart", index, kind: "text" | "reasoning" | "toolCall", toolCall?: { id, name, namespace?, kind } }
  | { type: "textDelta", index, text }
  | { type: "reasoningDelta", index, text?, summary? }
  | { type: "reasoningCarrier", index, carrier }    // opaque replay data, see Reasoning
  | { type: "toolInputDelta", index, fragment }
  | { type: "blockStop", index }
  | { type: "usage", input, output, cacheRead, cacheWrite, reasoning, estimated: boolean }
  | { type: "stop", reason: "end" | "length" | "toolUse" | "stopSequence" | "contentFilter" | "refusal", stopSequence? }
  | { type: "error", error: IrError }

IrError { kind: "auth" | "permission" | "notFound" | "rateLimit" | "overloaded" | "invalidRequest"
               | "contextLength" | "server" | "timeout" | "network", status, message, retryAfter? }
```

`effort` is an open string. Known values: `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max` (Claude and Codex), further Codex values map to the nearest known value
(`ultra`, `persistent` → `max`); unknown values map to `medium` and are counted.

## Translation rules

### Requests from Claude Code (Messages client)

- Paths: `POST /v1/messages` (any query string, e.g. `?beta=true`, ignored for routing),
  `POST /v1/messages/count_tokens`, `HEAD`/`GET /api/hello` (200 empty). Everything else
  404 in Messages error format.
- `system` is kept in block form in the IR. Mid-conversation `role: "system"` entries are
  IR system messages; to OpenAI targets they become `developer` (Responses) or `system`
  (Chat) messages at the same position; Messages upstreams keep them as sent.
- `thinking: {type: "adaptive"}` plus `output_config.effort` (what Claude Code sends for
  non-Claude model ids) becomes `thinking.mode = "adaptive"` with that effort;
  `{type: "enabled", budget_tokens}` becomes `mode = "enabled"`.
- `count_tokens`: forwarded when the upstream is Messages; otherwise 404 so Claude Code
  uses its own estimate.
- AgentPier sets `CLAUDE_CODE_ATTRIBUTION_HEADER=0` for adapter routes so the attribution
  block is not injected into OpenAI-style system prompts.

### Requests from Codex (Responses client)

- Paths: `POST /responses` and `POST /v1/responses`; others 404 in Responses error format.
- Tools: `function`, `custom` (freeform with grammar, e.g. `apply_patch`), `namespace`
  (groups of MCP tools; each member becomes an IR tool with `namespace`), hosted tools
  (`web_search`, `tool_search`, `local_shell`, …) become `kind: "hosted"`.
- AgentPier writes `web_search = "disabled"` for Codex adapter routes (launch config), so
  Codex normally sends no hosted tools. Hosted tools that still arrive are **dropped and
  counted** when the target has no equivalent (Responses upstreams keep them).
- `store` is forced to `false` toward non-Responses targets; toward a Responses upstream
  item ids (`fc_…`, `rs_…`, `msg_…`) are stripped when `store` is false.
- `include: ["reasoning.encrypted_content"]` is honored only for a Responses upstream.
- `previous_response_id` → `invalidRequest`.
- The Codex model catalog written by AgentPier derives `input_modalities` from the
  model's `images` flag, reasoning levels from the connection's reasoning support, and
  `apply_patch_tool_type` from the route: `freeform` for a Responses upstream, `function`
  otherwise (the adapter maps freeform ↔ function anyway, but `function` avoids needless
  translation).

### Upstream: Messages

- `max_tokens` is required: `sampling.maxOutputTokens ?? model.outputTokens ??
min(floor(contextTokens / 4), 32000)`.
- Thinking: `adaptive` is sent as-is with `output_config.effort`; `enabled` sends
  `budget_tokens = max(1024, budget)`, and thinking is disabled when `max_tokens <= 1024`
  or when `budget >= max_tokens` cannot be resolved by lowering the budget to
  `max_tokens - 1` with at least 1024 left. With thinking on, `temperature` and `top_p`
  are removed and a forced `tool_choice` is relaxed to `auto` (Anthropic rejects forced
  tool choice with thinking).
- Effort → budget when the client sends effort but the upstream needs a budget:
  `minimal=1024`, `low=2048`, `medium=8192`, `high=16384`, `xhigh=24576`, `max=32768`,
  clamped as above.
- `cache_control` on system, tools and parts preserved (max 4 breakpoints; extra ones
  dropped from the oldest).
- Tool names: Anthropic accepts `^[a-zA-Z0-9_-]{1,128}$` (to be verified against the
  current docs in the plan); namespaced tools become `<namespace>__<name>`, mapped back
  on the response. Call ids must match `^[a-zA-Z0-9_-]+$`; other ids are mapped.

### Upstream: Responses

- Messages client → Responses: `instructions` from the leading system blocks; messages,
  tool calls and results as input items; `thinking` → `reasoning.effort` (budget → nearest
  effort) and `reasoning.summary: "auto"`; `max_tokens` → `max_output_tokens`.
- `prompt_cache_key` set to a stable per-session value **if the connection's capabilities
  allow it** (see Capabilities).

### Upstream: Chat Completions

- Messages and system as chat messages; tool results as one `tool` message per result
  (`is_error` as `[error] ` prefix); images in tool results moved to a following user
  message.
- Reasoning sent only through capabilities (`reasoning_effort`).
- `stream_options.include_usage: true` when allowed by capabilities.
- Tool names: `^[a-zA-Z0-9_-]{1,64}$`. Longer or invalid names (e.g. long
  `mcp__server__tool` names) are mapped to a hashed short name per session and restored
  on the way back (`names.js`, bijective).
- Streaming tool calls: ids appear only on the first chunk per index; arguments are
  accumulated per index; servers that send whole arguments at once are handled.
- Reasoning arrives as `reasoning_content` or `reasoning` delta fields; `<think>` tags in
  content are extracted only when the connection enables `thinkTagExtraction`.

### Capabilities and strict servers

Each connection stores `adapterCapabilities` for the upstream protocol:

```js
{ promptCacheKey: bool, streamUsage: bool, reasoningEffort: bool, parallelToolCalls: bool,
  reasoningReplay: bool }   // reasoningReplay: echo reasoning_content on assistant messages (Chat)
```

- Defaults are conservative (`false` except `streamUsage`, which most servers accept);
  the PR #176 "Test connection" probe is extended with one extra request per optional
  parameter and proposes the values; users can edit them.
- At runtime, if the upstream rejects a request with 400/422 whose error names one of
  these optional parameters, the adapter retries once without it and disables it for the
  rest of the session (counted in diagnostics).

### Reasoning round trip

- Carrier: the adapter stores replay data for a reasoning block in an opaque carrier
  string `ap1.<origin>.<base64url(payload)>`, where payload is the upstream's own replay
  data (Responses `encrypted_content`, Messages `signature`, or nothing).
  - To Claude Code the carrier is placed in the `thinking` block's `signature`.
  - To Codex the carrier is placed in the reasoning item's `encrypted_content` (only when
    Codex requested `reasoning.encrypted_content`).
  - On the next request the adapter reads the carrier back: Messages-origin signatures go
    back to a Messages upstream; Responses-origin encrypted content goes back to the same
    Responses upstream; everything else is dropped from the upstream request, except Chat
    upstreams with `reasoningReplay` enabled, which get the text as `reasoning_content` on
    the assistant message (required by DeepSeek/Kimi/GLM thinking modes within tool
    loops).
  - A thinking block without a carrier that arrives from Claude Code toward a Messages
    upstream is sent unchanged (it came from that upstream).
- If a Claude Code version rejects carrier signatures, the fallback is to omit thinking
  blocks from the client stream (counted). The CLI smoke test detects this.

### Images

- Base64 ↔ data URL ↔ URL per protocol; URLs are passed through, never fetched.
- When a model is marked `images: false`, image input is rejected with `invalidRequest`.

### Usage and caching

- Messages `input_tokens` excludes cache reads and writes; OpenAI `prompt_tokens` /
  `input_tokens` include `cached_tokens`.
  - OpenAI → Messages: `input_tokens = prompt_tokens - cached_tokens`,
    `cache_read_input_tokens = cached_tokens`, `cache_creation_input_tokens = 0`.
  - Messages → OpenAI: `input_tokens = input + cache_read + cache_creation`,
    `cached_tokens = cache_read`.
- Missing upstream usage: estimated (characters / 4 on the serialized request and
  output), flagged `estimated: true`, counted in diagnostics, so both CLIs keep their
  automatic compaction working.
- Toward OpenAI-style upstreams the adapter serializes system, tools and history
  deterministically (stable key order, no per-request values in the prefix) so automatic
  prefix caching (e.g. Azure OpenAI) hits.

### Stop reasons

| IR            | Messages client | Responses client                                   | from Chat upstream       |
| ------------- | --------------- | -------------------------------------------------- | ------------------------ |
| end           | `end_turn`      | `response.completed`                               | `stop`                   |
| length        | `max_tokens`    | `response.completed` (see note below)              | `length`                 |
| toolUse       | `tool_use`      | `response.completed` with function call items      | `tool_calls`             |
| stopSequence  | `stop_sequence` | `response.completed`                               | `stop`                   |
| contentFilter | `refusal`       | `response.incomplete` reason `content_filter`      | `content_filter`         |
| refusal       | `refusal`       | `response.completed` with a `refusal` content part | (Messages upstream only) |

Codex treats `response.incomplete` with any reason other than `interrupted` /
`content_filter` as an error and retries; therefore `length` is emitted as
`response.completed` (the plan verifies against current Codex source and fixtures).

### Errors and context overflow

- Upstream errors are classified by status and by per-family recognizers (`errors.js`:
  Anthropic, OpenAI/Azure, vLLM, llama.cpp, LM Studio, LiteLLM) into `IrError`.
- `contextLength` is emitted exactly as the client expects so automatic compaction works:
  - Messages client: 400 `invalid_request_error` with message `prompt is too long: <n>
tokens > <max> maximum` (numbers when known).
  - Responses client: error `code: "context_length_exceeded"` (non-streaming body and
    `response.failed` in streams).
- Other kinds map to the client's error types and statuses (429 `rate_limit_error`, 529
  `overloaded_error` ↔ 503 `server_error`, …) so the CLIs' retry logic works;
  `retry-after` is passed through.
- Upstream messages are sanitized (500 chars, control characters removed, key and auth
  header values redacted); no upstream headers besides `retry-after` and request ids.
- Mid-stream failures become the client's in-stream error (`event: error` for Messages,
  `response.failed` for Responses) and the stream closes.

### Streaming obligations toward the clients

- Messages client: full ordered sequence `message_start`, `content_block_start`,
  deltas, `content_block_stop`, `message_delta` (stop reason, usage), `message_stop`.
  While the upstream is silent the adapter sends `event: ping` every 15 s.
- Responses client: every output item gets `response.output_item.added`, deltas
  (`response.output_text.delta`, `response.reasoning_summary_text.delta`,
  `response.custom_tool_call_input.delta` with `item_id`/`call_id`), and a complete
  `response.output_item.done` (Codex builds tool calls from `done`); the stream ends with
  `response.completed` (with usage) or `response.failed`. While the upstream is silent the
  adapter sends an SSE comment every 15 s.
- Upstream idle timeout: 240 s (below Codex's 300 s and with pings keeping Claude Code's
  watchdog satisfied).

### Unsupported features

Rule: **reject** what changes behavior and cannot be dropped safely (structured output
modes the target cannot express, image input to a non-image model,
`previous_response_id`); **drop and count** hints and hosted tools (metadata, user,
service tier, extra cache breakpoints, hosted tools when the target lacks them).

## Routing and configuration

The `endpoint` block gains:

```js
routing: {
  claude:   "auto" | "native" | "adapter:responses" | "adapter:chatCompletions" | "off",
  codex:    "auto" | "native" | "adapter:messages"  | "adapter:chatCompletions" | "off",
  opencode: "auto" | "messages" | "responses" | "chatCompletions" | "off",
},
adapterCapabilities: { … },     // see Capabilities
thinkTagExtraction: false,
```

and each model gains `images: boolean | null` (default `null`).

- `auto`: native protocol if enabled; else, for Claude Code and Codex, the adapter from
  the first enabled source in the order Responses > Messages > Chat; for OpenCode the
  first enabled of Chat > Responses > Messages (its native SDK providers).
- Existing connections without these fields behave as `auto` with default
  capabilities. Validation rejects unknown values and adapter sources equal to the CLI's
  native protocol.
- `endpointTools()` derives the offered tools from routing; the public view adds
  `toolRoutes: { claude: { mode: "native" | "adapter" | "sdk", source } | null, … }`.
- Pipeline snapshots include the resolved route of the profile's CLI.

## Launch

- `launchDescription` gains `route: { mode, source }`.
- **OpenCode** with `sdk` routes: provider `npm` is `@ai-sdk/anthropic` (base URL
  `anthropicBaseUrl` + `/v1`) or `@ai-sdk/openai` (base URL `openaiBaseUrl`), key handling
  as in PR #176. No adapter.
- **Adapter routes** (Claude Code, Codex):
  - The CLI's base URL is the literal placeholder `__AGENTPIER_ADAPTER_URL__` in env
    values and argv only. Persistent config files (Codex `config.toml`, OpenCode JSON) are
    never given the adapter URL: Codex receives the provider through `-c` arguments (which
    override `config.toml`); the shared `config.toml` keeps no endpoint base URL for
    adapter routes.
  - The CLI's API key is a random 32-byte session token in the variable the CLI already
    reads (`ANTHROPIC_AUTH_TOKEN`; Codex `env_key`). The custom auth header setting
    applies only to the adapter → upstream hop.
  - `NO_PROXY` / `no_proxy` include `127.0.0.1,localhost` in the CLI environment.
  - Payload `adapter` block:
    ```js
    adapter: {
      token, clientProtocol, upstreamProtocol,
      upstream: { baseUrl, authHeader, apiKey },
      model: { modelId, contextTokens, outputTokens, images },
      capabilities, thinkTagExtraction,
      diagnosticsPath,
    }
    ```
    The real key and upstream URL exist only in this private one-use payload and the
    adapter process (passed over IPC, never in the adapter's argv or env).
- If the adapter fails to start or bind within 10 s, the launcher prints a sanitized
  one-line error and exits 127 without starting the CLI.
- Model change, reload and release migration restart the launcher and adapter;
  `modelChangeRequiresRestart` stays true for endpoint sessions.

## Security

- Loopback only; every request must carry the session token (`x-api-key` or
  `Authorization: Bearer`); others get 401 without body echo; constant-time comparison.
  `/api/hello` probes also require the token except `HEAD`, which returns 200 empty.
- Upstream requests go only to the configured upstream origin, under the PR #176 address
  policy. DNS is re-resolved per new connection (no launch-time pinning that would break
  multi-day sessions when DNS changes); each connection is pinned to its checked
  addresses; TLS verification on the hostname; no redirects.
- Upstream connections use a keep-alive agent with the policy-checked lookup.
- Trust store: the adapter process is started with Node's system CA support
  (`--use-system-ca` where available; otherwise `NODE_EXTRA_CA_CERTS` from AgentPier's
  environment is passed through) so company gateways with private CAs work.
- Request body cap 32 MB; per-event cap 16 MB; no total cap on response streams.
- Names/ids maps are per session and in memory only. No prompt, completion or key
  content is logged; diagnostics contain counters and error kinds only.
- nono: the plan verifies that sandboxed CLIs can connect to `127.0.0.1` with the
  profiles AgentPier uses (docs/sandbox.md says network is allowed by default under nono;
  loopback must be confirmed explicitly with a test).

## Observability

- The adapter writes `diagnosticsPath` (private, mode 0600, at most once per 5 s): request
  counts per path, error kinds, upstream status classes, dropped hints and hosted tools by
  name, rejected features, capability fallbacks, estimated-usage count, cache-read tokens.
- `doctor` shows the latest summary for running adapter sessions; the session view shows
  "via adapter (<source>)".

## UI

- Connection dialog: per-CLI routing select with resolved result; capabilities checkboxes
  (pre-filled by the extended test); `thinkTagExtraction` under Advanced; per-model
  "supports images" tri-state.
- Connection list and launch dialog: compatible CLIs labeled "native", "via adapter" or
  (OpenCode) the protocol used.
- German and English texts with identical keys.

## Testing

- **Golden fixtures** recorded from current CLI versions (Claude Code with adaptive
  thinking and MCP tools; Codex with namespaced MCP tools, freeform `apply_patch`,
  `store:false`, encrypted reasoning) and from upstream servers (Anthropic, OpenAI
  Responses, Chat from vLLM/llama.cpp/LM Studio/LiteLLM shapes): text, parallel tool
  calls with streamed arguments, custom and namespaced tools, reasoning per origin,
  images, structured output, every stop reason, context overflow per family, 429/529,
  mid-stream errors, cache usage. Each of the four directions is tested request-wise and
  stream-wise.
- **Property tests**: SSE parser under arbitrary chunk splits; name/id maps bijective;
  carrier encode/decode round trip; usage mapping consistent; stop/error mapping total.
- **Adapter process integration**: fake upstreams with real SSE; token auth; pings while
  silent; idle timeout; abort mid-stream; capability fallback retry; context-overflow
  mapping; shutdown with open sockets.
- **Launcher integration**: placeholder substitution in env and argv only; no config file
  contains the adapter URL or the upstream key; adapter stops with the CLI; adapter crash
  does not write to the TUI.
- **CLI smoke** (matrix): real Claude Code against the adapter with Responses and Chat
  fake upstreams; real Codex with Messages and Chat fake upstreams; real OpenCode with
  `@ai-sdk/anthropic` and `@ai-sdk/openai` against fake upstreams; one tool-call round
  trip each. Skipped with a clear message when a CLI is not installed.
- **nono**: a sandboxed launch reaches the adapter on loopback.
- **Browser**: routing select, labels, English UI.

## Delivery

One spec and one plan, three PRs:

1. Protocol library and IR: 2 client modules, 3 upstream modules, shared modules, golden
   and property tests (offline).
2. Adapter process, launcher integration, routing and launch description (incl. OpenCode
   SDK routes), capabilities probe, launcher/CLI smoke and nono tests.
3. UI, doctor diagnostics, docs (`docs/providers.md`,
   `docs/research/provider-compatibility.md`).

## Risks

- **Protocol drift** in CLIs and servers. Mitigation: fixtures recorded from current CLI
  versions, CLI smoke tests, diagnostics that count unknown fields and dropped features.
- **Carrier signatures** rejected by a future Claude Code version. Mitigation: fallback
  to omitting thinking from the client stream; smoke test detects it.
- **Strict servers** rejecting optional parameters. Mitigation: conservative defaults,
  probe, one-shot fallback retry.
- **Usage estimates** may differ from real tokenizers; flagged and counted.
