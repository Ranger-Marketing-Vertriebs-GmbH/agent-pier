# Protocol adapter for custom endpoints

Date: 2026-10-07

## Problem

Custom endpoint connections (PR #176) offer a CLI only when the endpoint natively
speaks that CLI's wire protocol:

| CLI         | Protocol                |
| ----------- | ----------------------- |
| Claude Code | Anthropic Messages      |
| Codex       | OpenAI Responses        |
| OpenCode    | OpenAI Chat Completions |

Many servers speak only Chat Completions (vLLM, older llama.cpp builds, many LiteLLM and
company gateways), and some speak only Messages or only Responses. Users cannot run the
CLI of their choice against the model of their choice.

## Goal

1. Translate between all three protocols in every direction (6 directions), so every CLI
   can use every custom endpoint that offers at least one supported protocol.
2. Keep fidelity for agentic coding: text, streaming, tool calls (including parallel and
   custom/freeform tools), system prompts, reasoning, images, structured output, prompt
   caching hints and cache usage, stop reasons, token usage and errors.
3. Prefer native protocols. Use the adapter automatically only when needed, show the
   user when it is used, and allow per-CLI override per connection.
4. Keep running sessions independent of AgentPier server restarts and release
   activation.
5. Do not expose the upstream API key to the CLI process when the adapter is used.

## Non-goals

- Translation for catalog providers (OpenRouter, Z.ai). They stay native.
- Realtime, audio, batch, files and assistants APIs.
- Hosted tools without a counterpart on the target (web search, code interpreter, file
  search, computer use). They are rejected with a clear error, not emulated.
- Model capability discovery beyond what PR #176 already detects.
- A general-purpose public proxy. The adapter serves exactly one session.

## Architecture

### Layers

1. **Protocol library** — `server/features/protocol-adapter/`. Pure functions, no
   network, no filesystem. Per protocol module (`messages.js`, `responses.js`,
   `chat-completions.js`):
   - `parseRequest(body) → IrRequest` (client request to IR)
   - `buildRequest(ir, target) → { path, body }` (IR to upstream request)
   - `parseStream(chunks) → AsyncIterable<IrEvent>` (upstream SSE to IR events)
   - `emitStream(events) → AsyncIterable<string>` (IR events to client SSE)
   - `parseResponse(json)` and `emitResponse(events)` for non-streaming calls; the
     non-streaming emitter collects the event stream, so there is one code path.
   - `parseError(status, body) → IrError` and `emitError(irError) → { status, body }`.

   Shared modules: `ir.js` (types and validators), `sse.js` (incremental SSE parser and
   writer), `mapping.js` (stop reasons, reasoning effort/budget table, usage mapping),
   `tool-ids.js` (per-session id mapping), `state.js` (per-session conversation store for
   `previous_response_id`).

2. **Adapter server** — `server/features/protocol-adapter/adapter-server.js`. A small
   HTTP server bound to `127.0.0.1` on an ephemeral port. It:
   - authenticates every request with the per-session token;
   - routes the client protocol's paths (below) through parse → build → upstream →
     parse → emit;
   - sends upstream requests with a streaming variant of `endpointRequest` from PR #176
     (same address policy, address pinning, no redirects, TLS SNI) without the 1 MB
     total cap but with an idle timeout and a request-body cap;
   - answers side endpoints the CLIs call (see "Side endpoints").

3. **Integration** — the terminal launcher (`server/terminal-launcher.js`) starts the
   adapter server in its own process before it spawns the CLI when the launch payload
   contains an `adapter` block, substitutes the bound URL into the CLI launch, and stops
   the adapter when the CLI exits.

### Why in the launcher

Each session already runs its CLI through a per-session launcher process that outlives
AgentPier server restarts. Running the adapter there:

- keeps in-flight streams alive across server restarts and release activation;
- isolates failures to one session;
- keeps the upstream key in the launcher process only.

Release migration (existing session reload engine) restarts the launcher of migrated
sessions, which restarts their adapter on the new release.

## Intermediate representation (IR)

```js
IrRequest {
  model: string,
  system: Part[],                       // text parts; cache breakpoints allowed
  messages: { role: "user" | "assistant", parts: Part[] }[],
  tools: { name, description, kind: "function" | "custom", schema?, grammar? }[],
  toolChoice: "auto" | "none" | "required" | { name },
  parallelToolCalls: boolean | null,
  sampling: { maxOutputTokens, temperature, topP, stop: string[] },
  reasoning: { effort?: "minimal"|"low"|"medium"|"high", budgetTokens?, summary?: "auto"|"none" } | null,
  output: { format: "text" } | { format: "json_schema", name, schema, strict },
  cache: { key: string | null, breakpoints: PartRef[] },
  stream: boolean,
  metadata: object | null,
}
Part =
  | { type: "text", text, cache?: true }
  | { type: "image", mediaType, data? (base64), url? }
  | { type: "toolCall", id, name, kind: "function"|"custom", input }   // input: JSON string or raw text for custom
  | { type: "toolResult", callId, parts: Part[], isError }
  | { type: "reasoning", text?, summary?, signature?, encrypted?, redacted?, origin: "messages"|"responses"|"chat" }

IrEvent =
  | { type: "start", id, model }
  | { type: "blockStart", index, kind: "text"|"reasoning"|"toolCall", toolCall?: { id, name, kind } }
  | { type: "textDelta", index, text }
  | { type: "reasoningDelta", index, text?, summary?, signature?, encrypted? }
  | { type: "toolInputDelta", index, fragment }
  | { type: "blockStop", index }
  | { type: "usage", input, output, cacheRead, cacheWrite, reasoning }
  | { type: "stop", reason: "end"|"length"|"toolUse"|"stopSequence"|"contentFilter"|"refusal", stopSequence? }
  | { type: "error", status, kind: "auth"|"permission"|"notFound"|"rateLimit"|"overloaded"|"invalidRequest"|"server"|"timeout"|"network", message }
```

Every IR value is validated (`ir.js`); unknown fields from clients are either mapped
explicitly or recorded in diagnostics as dropped hints (see "Unsupported features").

## Translation rules

### Messages and roles

- System: Messages `system` (string or blocks) ↔ Responses `instructions` and
  `system`/`developer` input items ↔ Chat `system`/`developer` messages. Multiple
  system parts are concatenated in order with `\n\n` only when the target accepts a
  single string.
- Consecutive same-role messages are merged when the target requires alternation
  (Messages); empty assistant turns are dropped.

### Tool calls

- Calls: Messages `tool_use` ↔ Responses `function_call`/`custom_tool_call` ↔ Chat
  `tool_calls[]`.
- Results: Messages `tool_result` blocks inside a user message ↔ Responses
  `function_call_output`/`custom_tool_call_output` items ↔ one Chat `tool` message per
  result. `is_error` becomes a `[error] ` text prefix where the target has no flag.
  Image parts inside tool results are kept where the target allows them, otherwise
  converted into a following user message with the images.
- IDs: kept verbatim when valid for the target; otherwise a per-session bijective map
  (`tool-ids.js`) translates them both ways (Messages requires `toolu_`-style ids only
  by convention; Chat and Responses accept arbitrary strings — keep verbatim where
  possible).
- Streaming arguments: buffered per call index and re-emitted as the client protocol's
  delta events (`input_json_delta`, `function_call_arguments.delta`,
  `tool_calls[].function.arguments`). Parallel calls stay separated by index.
- Custom/freeform tools (Codex `apply_patch` with grammar): to non-Responses targets they
  become a function tool with one string parameter `input`; the call's argument string
  is unwrapped on the way back so Codex receives a `custom_tool_call` with raw input.
- `tool_choice` and `parallel_tool_calls` mapped per protocol; `disable_parallel_tool_use`
  (Messages) ↔ `parallel_tool_calls: false`.
- Hosted tools without counterpart: request rejected with `invalidRequest` naming the
  tool.

### Reasoning

- Upstream reasoning sources: Messages `thinking`/`redacted_thinking` blocks, Responses
  `reasoning` items (summary text, `encrypted_content`), Chat `reasoning_content` or
  `reasoning` fields. Inline `<think>…</think>` text is extracted only when the
  connection enables `thinkTagExtraction` (default off).
- To Claude Code: `thinking` blocks with streamed `thinking_delta`. Signatures from a
  non-Messages origin are not available; the adapter emits a stable placeholder
  signature and marks the block `origin` so that on the next request these blocks are
  converted back into the upstream's own format (never sent to a Messages upstream as
  signed thinking).
- To Codex: `reasoning` items with summary deltas; `encrypted_content` only when the
  origin is Responses and the upstream is the same endpoint.
- Request control: Responses `reasoning.effort` ↔ Messages
  `thinking.budget_tokens` ↔ Chat `reasoning_effort`, via a fixed table:
  `minimal=1024`, `low=2048`, `medium=8192`, `high=24576` (budget clamped below
  `max_tokens`). Budget → effort uses the nearest table entry.
- Reasoning parts are only replayed to the upstream when its protocol can carry them;
  otherwise they are dropped and counted in diagnostics.

### Images

- Base64 ↔ data URLs ↔ URLs per protocol (`image` source, `input_image`,
  `image_url`). URLs are passed through, not fetched by the adapter.
- When the selected model is marked `images: false` on the connection, image input is
  rejected with `invalidRequest` and a clear message. Default `null` (unknown) means
  pass through.

### Caching

- Messages target: `cache_control` breakpoints are preserved on system, tools and
  message parts (max 4, as Anthropic allows).
- OpenAI-style targets (Responses, Chat — e.g. Azure OpenAI): the adapter sets
  `prompt_cache_key` to a stable per-session value and serializes system, tools and
  history deterministically (stable key order, no per-request timestamps or ids in the
  prefix) so automatic prefix caching hits. Breakpoints are dropped (recorded as a hint).
- Usage back: OpenAI `prompt_tokens_details.cached_tokens` /
  `input_tokens_details.cached_tokens` ↔ Messages `cache_read_input_tokens`;
  `cache_creation_input_tokens` is 0 when the upstream does not report it. Messages
  `input_tokens` excludes cached tokens; OpenAI `prompt_tokens` includes them — the
  mapping converts accordingly so CLIs show correct context and cost.

### Stop reasons and usage

| IR            | Messages        | Responses                            | Chat             |
| ------------- | --------------- | ------------------------------------ | ---------------- |
| end           | `end_turn`      | `completed`                          | `stop`           |
| length        | `max_tokens`    | `incomplete` (`max_output_tokens`)   | `length`         |
| toolUse       | `tool_use`      | `completed` with function call items | `tool_calls`     |
| stopSequence  | `stop_sequence` | `completed`                          | `stop`           |
| contentFilter | `refusal`       | `incomplete` (`content_filter`)      | `content_filter` |

- Chat targets get `stream_options.include_usage: true`. Missing usage stays 0, never
  estimated.

### Structured output

- Chat `response_format: json_schema` ↔ Responses `text.format: json_schema`.
- Messages target has no native equivalent: mapped to a forced single tool
  (`tool_choice: {name}`) whose input is returned as the text content. Messages client
  requests never ask for this, so the reverse is not needed.

### Stateful Responses features

- `previous_response_id` from a Codex client to a non-Responses upstream: the adapter
  keeps an in-memory store per session (`state.js`) of response id → full IR history,
  bounded (default 64 responses, 32 MB, LRU). An unknown id returns `notFound` in the
  Responses error format so Codex resends full input.
- `store: false` and `include: ["reasoning.encrypted_content"]` are honored only for a
  Responses upstream.

### Errors

- Upstream errors are classified into `IrError.kind` by status and protocol error type,
  then emitted in the client protocol's format and status (Messages `overloaded_error`
  529 ↔ 503/`server_error`, `rate_limit_error` 429, etc.), so the CLIs' built-in retry
  logic works. `retry-after` headers are passed through.
- Error messages from upstream are sanitized: length-capped (500 chars), control
  characters removed, the API key and auth header values redacted. No upstream headers
  are forwarded except `retry-after` and request ids.
- Mid-stream upstream failures are emitted as the client protocol's in-stream error
  event (Messages `event: error`, Responses `response.failed`, Chat error chunk) and the
  stream is closed.

### Unsupported features

Rule: **reject** what changes behavior (hosted tools, unsupported structured output
modes, image input to a non-image model); **drop and count** what is only a hint
(metadata, cache breakpoints without target support, `service_tier`, `user`). Counts go
to diagnostics.

## Side endpoints

| Client protocol | Path                                             | Behavior                                                                                 |
| --------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Messages        | `POST /v1/messages`                              | translated                                                                               |
| Messages        | `POST /v1/messages/count_tokens`                 | forwarded natively when upstream is Messages; else estimated (chars/4, marked estimated) |
| Messages        | `GET /v1/models`                                 | returns the connection's models for this CLI                                             |
| Responses       | `POST /v1/responses`, `/responses`               | translated                                                                               |
| Responses       | `GET /v1/models`, `/models`                      | returns the connection's models                                                          |
| Chat            | `POST /v1/chat/completions`, `/chat/completions` | translated                                                                               |
| Chat            | `GET /v1/models`, `/models`                      | returns the connection's models                                                          |

Any other path returns 404 in the client protocol's error format.

## Routing and configuration

The `endpoint` block gains:

```js
routing: {
  claude:   "auto" | "native" | "adapter:responses" | "adapter:chatCompletions" | "off",
  codex:    "auto" | "native" | "adapter:messages"  | "adapter:chatCompletions" | "off",
  opencode: "auto" | "native" | "adapter:messages"  | "adapter:responses"       | "off",
},
thinkTagExtraction: false,
```

and each model gains `images: boolean | null` (default `null`).

- `auto` (default): native when the CLI's protocol is enabled; otherwise the adapter
  with the first enabled source protocol in the order Responses > Messages > Chat
  Completions; otherwise unavailable.
- `native`: only the native protocol; unavailable if disabled.
- `adapter:<protocol>`: always the adapter from that source protocol; unavailable if
  that protocol is disabled.
- `off`: never offered.
- Existing connections without `routing` behave as `auto`. Validation rejects unknown
  values and an adapter source equal to the CLI's native protocol.
- `endpointTools()` derives the offered tools from routing; the public view adds
  `toolRoutes: { claude: { mode: "native"|"adapter", source } | null, … }`.
- Pipeline snapshots include the resolved route for the profile's CLI, so a routing
  change mid-run is detected like other relevant changes.

## Launch

- `launchDescription` gains `adapter: { clientProtocol, upstreamProtocol }` when the
  resolved route is `adapter`.
- The CLI configuration uses the literal placeholder `__AGENTPIER_ADAPTER_URL__` as its
  base URL (the launcher replaces it with `http://127.0.0.1:<port>`) and a random 32-byte
  session token as its API key (in the variable the CLI already reads:
  `ANTHROPIC_AUTH_TOKEN`, Codex `env_key`, OpenCode `apiKey`). The custom auth header
  setting does not apply to the adapter hop.
- The launch payload gains:
  ```js
  adapter: {
    token, clientProtocol, upstreamProtocol,
    upstream: { baseUrl, authHeader, apiKey, addresses },   // addresses: pinned, checked at launch
    models: [{ modelId, contextTokens, outputTokens, images }],
    routing: { thinkTagExtraction },
    configFiles: [absolute paths whose content contains the placeholder],
    diagnosticsPath,
  }
  ```
  The real key and upstream URL are in this private one-use payload only, never in the
  CLI environment, argv, tmux metadata or written CLI config files.
- The launcher binds the adapter server, then replaces `__AGENTPIER_ADAPTER_URL__` in
  `env` values, `args` and the listed `configFiles` (atomic rewrite, mode preserved),
  then spawns the CLI. If binding fails, the launcher prints a sanitized error and exits
  127 without starting the CLI.
- The adapter stops when the CLI exits or the launcher receives SIGHUP/SIGTERM.
- Pre-launch address checks (PR #176) still run on the server; the launcher re-resolves
  and re-checks the upstream address with the same policy when it starts (best effort,
  like the CLI's own resolution before).
- Model change, reload and release migration restart the launcher and therefore the
  adapter; `modelChangeRequiresRestart` stays true for endpoint sessions.

## Security

- Loopback only (`127.0.0.1`); every request must carry the session token in the header
  the client protocol uses (`x-api-key` or `Authorization: Bearer`); others get 401
  without body echo. Constant-time comparison.
- Upstream requests go only to the single upstream origin checked at launch, with the
  address policy, pinning, no redirects and TLS verification from PR #176.
- Request body cap 32 MB (images); upstream response streams uncapped in total but with
  a 5 min idle timeout and a per-event cap of 16 MB.
- Tool-id and response stores are per session and in memory only.
- No prompt, completion or key content is logged. Diagnostics contain only counters and
  error kinds.
- The adapter process runs with the launcher's privileges; the CLI's sandbox (nono) is
  unchanged; loopback access from the CLI is already allowed.

## Observability

- The launcher writes `diagnosticsPath` (private, mode 0600, rewritten at most once per
  5 s): request counts per path, error kinds, upstream status classes, dropped hints by
  name, rejected features by name, cache read tokens, last error time.
- `doctor` shows, for running sessions using the adapter, the last diagnostics summary.
- The session view shows "via adapter (<source protocol>)" in the provider details.

## UI

- Connection dialog: per-CLI routing select with the options above, showing the resolved
  result ("native", "via adapter from Chat Completions", "unavailable"); a
  `thinkTagExtraction` checkbox under Advanced; per-model "supports images" tri-state in
  the model table.
- Connection list and launch dialog: compatible CLIs labeled "native" or "via adapter".
- All new text in German and English with identical keys.

## Testing

- **Golden fixtures** per protocol (anonymized recordings): requests and SSE streams for
  plain text, parallel tool calls with streamed arguments, custom/freeform tools,
  reasoning (each origin), images, structured output, errors (4xx, 429, 529, mid-stream),
  cache usage, every stop reason. Each of the 6 directions is tested request-wise and
  stream-wise against expected outputs.
- **Property tests** (fast-check): IR → protocol → IR round trips preserve everything the
  protocol can express; SSE parser handles arbitrary chunk splits; tool-id map is
  bijective; stop reason and usage mapping are total.
- **Adapter server integration**: fake upstreams for all three protocols with real SSE,
  token auth, idle timeout, abort mid-stream, upstream error mapping, side endpoints,
  `previous_response_id` store.
- **Launcher integration**: placeholder substitution in env, args and config files;
  adapter stops with the CLI; key absent from CLI env/argv/config files.
- **CLI smoke** (matrix): real Claude Code, Codex and OpenCode against the adapter with a
  scripted fake upstream for each of the two non-native source protocols, one tool-call
  round trip each (6 combinations). Skipped with a clear message when a CLI is not
  installed.
- **Browser**: routing select, labels in launch dialog, English UI.

## Delivery

One spec and one plan, delivered as three PRs, each mergeable on its own:

1. Protocol library and IR with all 6 directions, offline tests only.
2. Adapter server, launcher integration, launch description, routing on the server,
   launcher and CLI smoke tests.
3. UI (routing, labels, images flag, think-tag option), doctor diagnostics, docs
   (`docs/providers.md`, `docs/research/provider-compatibility.md`).

## Risks

- **Protocol drift**: CLIs and servers evolve their protocols. Mitigation: golden
  fixtures recorded from current CLI versions, CLI smoke tests, and diagnostics that
  count unknown fields.
- **Reasoning signatures**: Claude Code may require valid signatures for thinking blocks
  in some modes. Mitigation: placeholder signatures are never forwarded to a Messages
  upstream; if a Claude Code version rejects unsigned thinking from the server, the
  adapter falls back to emitting reasoning as hidden (dropped) and counts it.
- **Token counting**: `count_tokens` estimates may differ from the real tokenizer;
  marked as estimates, used only for Claude Code's context display.
- **Memory**: the per-session response store is bounded (LRU).
