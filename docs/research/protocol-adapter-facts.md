# Protocol adapter facts

Date: 2026-10-07. Verified for the protocol adapter library
(`docs/superpowers/specs/2026-10-07-protocol-adapter-design.md`). Later tasks treat this
file as the source of truth. Each fact lists **Value**, **Source** and **Consequence**
(for the library unless noted).

Versions and sources used:

| Subject                          | Version / revision                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Claude Code                      | 2.1.291 (installed binary, string search + live capture against a local fake server)                   |
| Claude Code docs                 | `code.claude.com/docs/en/{llm-gateway-protocol,network-config,env-vars,errors}.md`, fetched 2026-10-07 |
| Anthropic API docs               | `platform.claude.com/docs/en/...` `.md` pages, fetched 2026-10-07                                      |
| Codex                            | 0.159.2; source `openai/codex@rust-v0.159.2` (commit `ff6aec9`); live capture with the installed CLI   |
| OpenAI SDK types (Chat)          | `openai/openai-python@4e152cd` (v3.26.0)                                                               |
| vLLM                             | `vllm-project/vllm@7436a7f` (main, 2026-10-07)                                                         |
| llama.cpp                        | `ggml-org/llama.cpp@fa3c2fa` (master, 2026-10-07)                                                      |
| LiteLLM                          | `BerriAI/litellm@d364d5e` (main, 2026-10-07)                                                           |
| OpenCode                         | 1.18.33 (installed binary, string search)                                                              |
| `eventsource-stream` (Codex dep) | 0.2.3 (crates.io)                                                                                      |

Abbreviations: `codex@` = `openai/codex@rust-v0.159.2:codex-rs/`. "Live" = observed in a
capture run on this machine with a synthetic prompt and a local fake upstream (no real
keys, no network).

## Spec deltas

Facts below contradict or sharpen the spec / Global Constraints. Proposed corrections:

1. **Codex treats `response.incomplete` as an error for every reason except
   `interrupted`, including `content_filter`.** (§3.7) The spec's stop table maps
   `contentFilter` → `response.incomplete` reason `content_filter` and says Codex accepts
   `interrupted`/`content_filter`. Correction: toward Codex emit `contentFilter` as
   `response.failed` with `error.code: "invalid_prompt"` (Codex maps it to a
   non-retryable `InvalidPrompt` and shows the message), never `response.incomplete`.
   `length` stays `response.completed` (Global Constraint confirmed: `max_output_tokens`
   as incomplete reason makes Codex reconnect and finally fail — verified live).
2. **Codex has no `refusal` content part.** (§3.4) `ContentItem` only knows
   `input_text`, `input_image`, `input_audio`, `output_text`; an assistant message with a
   `refusal` part fails to deserialize and is silently dropped. Correction: `refusal`
   toward Codex = `output_text` part carrying the refusal text, then
   `response.completed`.
3. **Codex recognizes context overflow only inside the SSE stream.** (§3.8) A
   `response.failed` event whose `response.error.code` is `context_length_exceeded`
   maps to `ContextWindowExceeded` (verified live: "Codex ran out of room in the model's
   context window"). An HTTP 400 JSON body with the same code becomes a plain
   `InvalidRequest` that shows the raw body (verified live). Codex always sends
   `stream: true`. Correction: for the Responses client, `contextLength` (and every
   other error that should drive Codex behavior) is sent as HTTP 200
   `text/event-stream` with `response.created` → `response.failed`, then the stream
   closes. The "non-streaming body" variant only applies to `stream: false` requests,
   which Codex does not send.
4. **SSE comments do not reset Codex's stream idle timer.** (§3.9) Codex parses SSE with
   `eventsource-stream` 0.2.3, which never yields comment lines or data-less events; the
   idle timeout (default 300 s) wraps `stream.next()`. Correction: keep-alives toward
   Codex must be data events Codex ignores, e.g.
   `event: response.in_progress` / `data: {"type":"response.in_progress","response":{"id":"…"}}`
   (`response.in_progress` is in Codex's ignore list). With the 240 s upstream idle
   timeout the comment is harmless but useless.
5. **`apply_patch_tool_type` only accepts `"freeform"` in Codex 0.159.2.** (§3.12) A model
   catalog with `"function"` makes Codex exit at startup: `failed to parse
model_catalog_json … unknown variant 'function', expected 'freeform'` (verified live).
   `null`/absent disables the `apply_patch` tool. Correction: the spec's catalog rule
   (`function` for non-Responses routes) is invalid; write `"freeform"` for every route
   (the adapter maps the custom tool to a function tool for Messages/Chat upstreams and
   back) or omit the field. **Existing bug outside this PR:**
   `server/features/providers/endpoint-launch.js:37` passes
   `applyPatchToolType: "function"` today, which breaks Codex 0.159.2 endpoint launches.
6. **Codex does not retry HTTP 429 and does not retry `server_is_overloaded`.** (§3.8)
   Transport retries cover 5xx only (`retry_429: false`); a 429 maps to `RetryLimit`
   (fatal). `response.failed` with code `rate_limit_exceeded`/`slow_down` maps to a
   retryable `RateLimitExceeded` (delay parsed from "try again in N s/ms" in the
   message). 503 + `error.code: "server_is_overloaded"` (HTTP or SSE) maps to
   `ServerOverloaded`, which is **not** retried. Correction: toward Codex, `rateLimit`
   → SSE `response.failed` with `code: "rate_limit_exceeded"` and message
   `"Rate limit reached. Please try again in <retryAfter>s."`; `overloaded` → SSE
   `response.failed` with a generic code (e.g. `server_error`, retryable) or HTTP 503
   without `server_is_overloaded`. `retry-after` headers are not honored by Codex for
   these paths.
7. **Anthropic `thinking` has more shapes than the IR models.** (§1.4) Types:
   `enabled` (`budget_tokens`), `adaptive`, `disabled`, and `between_tools` (Sonnet
   5.5 only); `adaptive` carries `display: "summarized" | "omitted" | "updates"`. Claude Code
   2.1.291 sends `{"type":"adaptive","display":"omitted"}` + `output_config.effort`
   (verified live). Correction: `parseRequest` accepts `display` and `between_tools`
   (treat `between_tools` as `disabled` for non-Messages upstreams, pass through to
   Messages upstreams); IR `thinking` gains `display?`.
8. **Anthropic effort values are `low`, `medium`, `high`, `xhigh`, `max` only.** (§1.5)
   No `minimal`/`none`. Correction for Responses/Chat → Messages: `minimal` → `low`;
   `none` → omit thinking (or `disabled` where the model allows it). Budget table in
   Global Constraints unchanged.
9. **Sampling restrictions on current Claude models are stricter than "only with
   thinking".** (§1.6) Opus 4.7+/Sonnet 5+/Fable/Mythos reject non-default
   `temperature`, `top_p`, `top_k` on every request; forced `tool_choice` is rejected
   with manual (`enabled`) thinking on all models, works with adaptive thinking, and is
   rejected on every request by Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1.
   Correction: keep the spec rule (strip `temperature`/`top_p` and relax forced
   `tool_choice` when thinking is on) and additionally rely on the 400 → capability
   retry path, or strip `temperature`/`top_p`/`top_k` toward Messages upstreams by
   default (neither Codex nor Claude Code sends them in normal use).
10. **Error envelope shapes differ per Chat server.** (§4.6) vLLM: `error.code` is an
    integer and `error.type` is e.g. `"BadRequestError"`; LiteLLM proxy: `error.code` is
    a string (`"400"`); LM Studio: `error` is a **string**, not an object. `errors.js`
    must accept all three.
11. **vLLM streams reasoning as `delta.reasoning`, not `reasoning_content`.** (§4.4)
    `reasoning_content` is still accepted on input (renamed to `reasoning`). Spec already
    reads both fields — confirmed necessary; `reasoningReplay` toward vLLM may use either.

Confirmed without change: Messages tool names `^[a-zA-Z0-9_-]{1,128}$`; Chat tool names
max 64 `[a-zA-Z0-9_-]`; Messages `tool_use.id` `^[a-zA-Z0-9_-]+$`; Claude Code accepts
an arbitrary (non-Anthropic) thinking `signature` and replays it unchanged (§2.6);
`/v1/messages?beta=true`; `count_tokens` is optional; Codex never sends
`previous_response_id` over HTTP; Codex always sends `store:false`, `stream:true`,
`include:["reasoning.encrypted_content"]`; `web_search = "disabled"` removes the hosted
tool; OpenCode bundles `@ai-sdk/anthropic` and `@ai-sdk/openai` and both need a base URL
ending in `/v1`.

## 1. Anthropic Messages API

### 1.1 Tool name

- **Value:** `name`: minLength 1, maxLength 128, pattern `^[a-zA-Z0-9_-]{1,128}$`.
  (`tool_reference.tool_name` allows 256; not relevant.)
- **Source:** `platform.claude.com/docs/en/api/messages` (Tool `name`, "minLength: 1,
  maxLength: 128, pattern: ^[a-zA-Z0-9_-]{1,128}$");
  `platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools` ("Must match the
  regex `^[a-zA-Z0-9_-]{1,128}$`").
- **Consequence:** Messages upstreams accept names ≤ 128; longer/invalid names
  (namespaced Codex MCP tools) go through `names.js`.

### 1.2 `tool_use.id`

- **Value:** `ToolUseBlockParam.id` pattern `^[a-zA-Z0-9_-]+$` (no length limit stated).
- **Source:** `platform.claude.com/docs/en/api/messages` (ToolUseBlockParam `id`).
- **Consequence:** OpenAI call ids (`call_…`, `fc_…`) pass; ids with other characters
  are mapped by `names.js`. Claude Code itself accepted `call_abc-1` (live).

### 1.3 Streaming event sequence and `ping`

- **Value:** `message_start` (Message with empty `content`, `stop_reason: null`) →
  per block `content_block_start`, one or more `content_block_delta`,
  `content_block_stop` (each with `index`) → one or more `message_delta` (usage counts
  are **cumulative**) → `message_stop`. "Event streams may also include any number of
  `ping` events." Errors in-stream: `event: error`,
  `data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`.
  Unknown event types must be tolerated. Delta types seen in Claude Code 2.1.291:
  `text_delta`, `input_json_delta`, `thinking_delta`, `signature_delta`,
  `compaction_delta`.
- **Source:** `platform.claude.com/docs/en/build-with-claude/streaming` ("Event types",
  "Ping events", "Error events"); Claude Code 2.1.291 binary (string search:
  `case"signature_delta"`, `case"thinking_delta"`).
- **Consequence:** `emitStream` must emit the full ordered sequence; `message_delta`
  usage is cumulative (send totals, not increments); `parseStream` ignores unknown
  events.

### 1.4 `thinking` types

- **Value:** `{type:"enabled", budget_tokens}` (manual, deprecated on 4.6, rejected on
  4.7+), `{type:"adaptive", display?: "summarized"|"omitted"|"updates"}`, `{type:"disabled"}`,
  `{type:"between_tools"}` (Sonnet 5.5 only). `display` defaults to `"omitted"` on
  current models (thinking blocks come back without text, signature only). Per-model
  rejects: e.g. Opus 5.5 rejects `enabled` and `disabled`.
- **Source:** `platform.claude.com/docs/en/build-with-claude/thinking` (display
  defaults), `…/thinking-troubleshooting` (per-model table), `…/extended-thinking`
  (deprecation); `display: "updates"`: same page, "Controlling thinking display", beta
  `thinking-display-updates-2026-08-18`. Live: Claude Code 2.1.291 sends
  `"thinking":{"type":"adaptive","display":"omitted"}` for the unknown model id
  `custom-model-x`, and `display: "updates"` (with that beta) in the recorded
  `clients/claude-code/image.json` fixture.
- **Consequence:** see Spec delta 7. When the client asked `display:"omitted"`, the
  adapter may still send thinking text (Claude Code accepts it); if it strips the text
  for fidelity, the carrier must keep whatever a Chat `reasoningReplay` needs.
  Toward a Messages upstream (Codex client, spec Amendment 15): effort-only requests use
  `adaptive` + `output_config.effort` (manual `enabled` is rejected on 4.7+); capability
  `thinkingBudget` opts into `enabled` for older models. Thinking blocks must be passed
  back complete and unmodified, so the messages carrier stores signature and exact text
  as JSON `{"s","t"}` (`{"r"}` for redacted data).

### 1.5 `output_config.effort`

- **Value:** `low`, `medium`, `high`, `xhigh`, `max` (API schema: `"low" or "medium" or
"high" or 2 more`). Availability per model (`xhigh` not on every model that has `max`).
  Most models default to `high`; Opus 5.5 defaults to `medium`. Claude Code sends
  `output_config: {effort: "high"}` (live) and also `context_management` with
  `clear_thinking_20251015`.
- **Source:** `platform.claude.com/docs/en/build-with-claude/effort` ("Effort levels");
  `platform.claude.com/docs/en/api/messages` (`effort`); live capture.
- **Consequence:** Spec delta 8. `context_management` is a Messages-only field: drop and
  count toward OpenAI targets.

### 1.6 Thinking constraints

- **Value:** `budget_tokens` minimum 1,024 and less than `max_tokens` (exception:
  interleaved thinking, where it may exceed `max_tokens`). Forced tool use
  (`any`/`tool`) incompatible with manual thinking; works with adaptive except Opus 5.5,
  Sonnet 5.5, Fable 5.1, Mythos 5.1 (rejected on every request). Current models
  (Fable/Mythos, Opus 4.7+, Sonnet 5+) reject non-default `temperature`/`top_p`/`top_k`
  on every request; older models only while thinking. No assistant prefill with
  thinking.
- **Source:** `platform.claude.com/docs/en/build-with-claude/extended-thinking`
  ("`budget_tokens` must satisfy these constraints"),
  `…/thinking` ("Limits and feature compatibility", "Tool choice limitation").
- **Consequence:** Global Constraint (≥ 1024, < `max_tokens`, disable when
  `max_tokens <= 1024`) confirmed; see Spec delta 9.

### 1.7 `cache_control` breakpoints

- **Value:** up to 4 cache breakpoints per request; `cache_control:
{type:"ephemeral", ttl?: "5m"|"1h"}`. Exact error wording for a fifth breakpoint:
  **unverified** (commonly reported as `A maximum of 4 blocks with cache_control may be
provided. Found 5.`; no doc quote found).
- **Source:** `platform.claude.com/docs/en/build-with-claude/prompt-caching` ("You can
  define up to 4 cache breakpoints").
- **Consequence:** keep at most 4 toward Messages upstreams, drop extra ones from the
  oldest (spec). Claude Code puts `cache_control` on system blocks and on
  mid-conversation `role:"system"` messages (live).

### 1.8 Errors

- **Value:** body `{"type":"error","error":{"type":"…","message":"…"},"request_id":"…"}`.
  Status → type: 400 `invalid_request_error`, 401 `authentication_error`, 402
  `billing_error`, 403 `permission_error`, 404 `not_found_error`, 409 `conflict_error`,
  413 `request_too_large`, 429 `rate_limit_error`, 500 `api_error`, 504
  `timeout_error`, 529 `overloaded_error`. Request size limit 32 MB.
- **Source:** `platform.claude.com/docs/en/api/errors` ("HTTP errors", "Error shapes",
  "Request size limits").
- **Consequence:** `client-messages.emitError` uses these pairs; the 32 MB body cap in
  the spec matches.

### 1.9 "Prompt is too long" wording (as Claude Code matches it)

- **Value:** Claude Code 2.1.291 classifies a 400 as prompt-too-long when the message,
  lowercased, contains `prompt is too long` or `input is too long for requested model`,
  or the token `capability_rejected: prompt_too_long`; a 413 also counts when it
  contains `context window`. Numbers are extracted with
  `/prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i`. A 400 containing
  ``input length and `max_tokens` exceed context limit`` is a separate class: Claude
  Code retries with a reduced `max_tokens` instead of compacting. The Anthropic wording
  `prompt is too long: <n> tokens > <max> maximum` matches the regex (LiteLLM emits the
  same format for Bedrock Mantle overflows,
  `litellm@d364d5e:litellm_core_utils/exception_mapping_utils.py:870`).
- **Source:** Claude Code 2.1.291 binary (functions `$Jn`, `UJn`, `_zr`, `vmt`, `WJn`);
  `code.claude.com/docs/en/errors.md` ("Prompt is too long", "Automatic retries").
- **Consequence:** Global Constraint confirmed. Optional improvement: when an OpenAI-family
  error says the _output_ budget does not fit (vLLM "you requested N output tokens"),
  emitting ``input length and `max_tokens` exceed context limit: <in> + <out> > <max>``
  lets Claude Code shrink `max_tokens` before compacting.

### 1.10 Usage fields

- **Value:** `input_tokens` (excludes cache reads/writes), `output_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation`
  (per-TTL breakdown), `output_tokens_details`, `server_tool_use`, `service_tier`,
  `inference_geo`. "Total input tokens in a request is the summation of `input_tokens`,
  `cache_creation_input_tokens`, and `cache_read_input_tokens`."
- **Source:** `platform.claude.com/docs/en/api/messages` (Usage).
- **Consequence:** Global Constraint usage mapping confirmed.

### 1.11 Stop reasons

- **Value:** `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`,
  `refusal`, `model_context_window_exceeded`.
- **Source:** `platform.claude.com/docs/en/api/messages` (`stop_reason`).
- **Consequence:** `parseStream` maps `pause_turn` (server tools only) and
  `model_context_window_exceeded` (→ `length`) in addition to the spec table.

## 2. Claude Code 2.1.291 as a gateway client

### 2.1 Paths and startup traffic

- **Value:** inference `POST /v1/messages?beta=true` (match the path, not the URL);
  optional `POST /v1/messages/count_tokens` (absent → character estimate);
  best-effort `HEAD /api/hello` connection warm-up (skipped with an HTTP proxy or client
  certificate; not observed in a live `-p` run with
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`); `GET /v1/models?limit=1000` only when
  `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`.
- **Source:** `code.claude.com/docs/en/llm-gateway-protocol.md` ("Optional endpoints and
  startup traffic", "Model discovery"); live capture (`POST /v1/messages?beta=true`).
- **Consequence:** spec routing confirmed; `GET /api/hello` is not documented (harmless).

### 2.2 Request headers

- **Value (live):** `authorization: Bearer <ANTHROPIC_AUTH_TOKEN>` (no `x-api-key` when
  only the token is set), `anthropic-version: 2023-06-01`, `anthropic-beta` (live:
  `claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01,effort-2025-11-24,…`),
  `x-claude-code-session-id`, `x-app: cli`, `user-agent: claude-cli/2.1.291 …`,
  `x-stainless-*`. Gateway hint headers (`x-claude-code-request-class`, …) only with
  `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`.
- **Source:** live capture; `llm-gateway-protocol.md` ("Request headers").
- **Consequence:** token auth via `Authorization: Bearer` works; the adapter must not
  forward `anthropic-beta` to OpenAI targets (forward verbatim to Messages upstreams).

### 2.3 Response headers Claude Code reads

- **Value:** `content-type: text/event-stream` on streams; `retry-after` as integer
  seconds (a value > 60 stops retries outside watchdog mode); `x-should-retry`;
  `anthropic-ratelimit-unified-*`.
- **Source:** `llm-gateway-protocol.md` ("Response headers").
- **Consequence:** pass `retry-after` through as integer seconds.

### 2.4 Idle watchdogs

- **Value:** byte-level watchdog (no bytes, including pings) 300 s on gateway
  connections; event-level watchdog 300 s on every provider (arriving bytes reset it on
  byte-watchdog connections); first-byte deadline not applied behind
  `ANTHROPIC_BASE_URL`. Retry/stall UI after 20 s without data. Clamp: values below
  5 min are raised to 5 min.
- **Source:** `code.claude.com/docs/en/network-config.md` ("Streaming idle watchdogs");
  `errors.md` ("What you see while Claude Code retries or waits").
- **Consequence:** `event: ping` every 15 s keeps both watchdogs satisfied; the 240 s
  upstream idle timeout is below 300 s.

### 2.5 Streaming completeness and retries

- **Value:** a body that ends after a content block started but before `message_delta`
  is treated as a dropped connection. Retried: 5xx/overloaded/timeouts before output,
  temporary 429, dropped connections before any completed block; not retried after a
  completed text/tool block (keeps partial output). Default 10 retries.
- **Source:** `llm-gateway-protocol.md` ("Streaming"); `errors.md` ("Automatic
  retries").
- **Consequence:** mid-stream upstream failures → `event: error` then close (spec);
  never end a stream "cleanly" without `message_delta`/`message_stop`.

### 2.6 Thinking signatures (PR 2 question)

- **Value:** Claude Code does **not** validate signatures client-side. Live: a fake
  server returned a thinking block with `signature: "ap1.chat.eyJ4IjoxfQ"` plus a
  `tool_use`; Claude Code replayed the block byte-for-byte on the next request
  (`{"type":"thinking","thinking":"Let me look for files.","signature":"ap1.chat.eyJ4IjoxfQ"}`),
  both when `message_start.model` equalled the request model and when it differed. A
  string search of the binary found no client-side signature verification, only
  `typeof signature === "string"` checks. Server-side rejections are
  recognized by wording (`signature in thinking block`, `invalid data in
redacted_thinking block`, `thinking.signature … field required`, `thinking block …
cannot be modified|invalid signature`, `bound to a different conversation`); Claude
  Code then strips earlier thinking blocks, retries, and keeps them out for the rest of
  the conversation. Separately it strips thinking from assistant messages recorded with a
  different model id under some conditions (`foreignThinking`, default `upgrade`).
- **Source:** live capture (two runs of `claude -p` against a local fake Messages
  server; captures kept in the task scratchpad, not committed); Claude Code 2.1.291 binary (functions `Szr`, `yZt`, `iwe`, `nKe`);
  `llm-gateway-protocol.md` ("Automatic retry and error forwarding").
- **Consequence:** the carrier-in-signature design works. Echo the request's `model` in
  `message_start` to avoid foreign-thinking stripping. PR 2 fallback: if a carrier
  cannot be honored, answer 400 `invalid_request_error` with a message containing
  `invalid signature in thinking block`; Claude Code then drops thinking replay itself.

### 2.7 Mid-conversation system messages

- **Value:** Claude Code sends `role:"system"` entries inside `messages` (beta
  `mid-conversation-system-2026-04-07`), with `content` either a string or a block array
  that may carry `cache_control` (live). If the upstream rejects them, Claude Code
  retries without and disables them for the conversation.
- **Source:** live capture; `llm-gateway-protocol.md` ("Feature pass-through",
  "Automatic retry and error forwarding").
- **Consequence:** `client-messages.parseRequest` accepts string and array content for
  system entries. Toward a Messages upstream through the adapter (only Codex gets
  there) the beta is not sent, so `upstream-messages.js` puts system messages that
  precede every other message into top-level `system` and merges later ones into the
  next user turn as a `<system>…</system>` text block after its `tool_result` blocks
  (as for Chat, Amendment 13), keeping strict user/assistant alternation.

### 2.8 Attribution block / `CLAUDE_CODE_ATTRIBUTION_HEADER`

- **Value:** first system block `x-anthropic-billing-header: cc_version=2.1.291.650;
cc_entrypoint=sdk-cli;` (live). Stable per conversation through a custom base URL
  since 2.1.181. `CLAUDE_CODE_ATTRIBUTION_HEADER=0` omits it.
- **Source:** live capture; `llm-gateway-protocol.md` ("System prompt attribution
  block"); `env-vars.md` (`CLAUDE_CODE_ATTRIBUTION_HEADER`).
- **Consequence:** spec rule (set `=0` on adapter routes) confirmed.

### 2.9 Request body for an unrecognized model id

- **Value (live, `ANTHROPIC_MODEL=custom-model-x`):** `max_tokens: 32000`,
  `thinking: {type:"adaptive", display:"omitted"}`, `output_config: {effort:"high"}`,
  `context_management: {edits:[{type:"clear_thinking_20251015", keep:"all"}]}`,
  `metadata.user_id` (JSON string), `stream: true`, 22 tools without `type`
  (custom tools). Default max output for unknown ids: 32000, cap 128000.
- **Source:** live capture; `env-vars.md` (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`).
- **Consequence:** golden fixtures for the Messages client should use this shape.

## 3. OpenAI Responses as used by Codex 0.159.2

### 3.1 Request struct

- **Value:** `ResponsesApiRequest { model, instructions (omitted if empty), input,
tools?, tool_choice: String, parallel_tool_calls, reasoning: Option<Reasoning>, store,
stream, stream_options?, include, service_tier?, prompt_cache_key?, text?,
client_metadata?, access_programs? }`. `Reasoning { effort?, summary?, context? }`
  (`context`: `auto|current_turn|all_turns`). `stream_options.reasoning_summary_delivery:
"sequential_cutoff"` (OpenAI provider only). `text { verbosity?, format? }` with
  `format {type:"json_schema", strict, schema, name:"codex_output_schema"}`. Built with
  `tool_choice:"auto"`, `store:false`, `stream:true`,
  `include:["reasoning.encrypted_content"]` (always), `prompt_cache_key` always set,
  `parallel_tool_calls` from the catalog. No `previous_response_id`, no
  `max_output_tokens`, no `temperature`.
- **Source:** `codex@codex-api/src/common.rs:157-168,191-194,278-304`;
  `codex@core/src/client.rs:863-1000` (`include` 959, `prompt_cache_key` 976,
  `tool_choice` 994, `store` 997). Live capture confirmed the shape (input items carry
  ids like `msg_<uuid>` even with `store:false`; `instructions` absent when the
  catalog's `base_instructions` is empty).
- **Consequence:** `client-responses.parseRequest` tolerates `client_metadata`,
  `access_programs`, `reasoning.context`, `stream_options`; carriers go into
  `encrypted_content` (Codex always requests it).

### 3.2 Responses-lite mode

- **Value:** when the catalog sets `use_responses_lite: true`, Codex sends
  `instructions: ""`, no `tools`, prepends an `additional_tools` input item
  (`role:"developer"`, `tools:[…]`), sets `reasoning.context:"all_turns"` and
  `parallel_tool_calls:false`. Default `false`.
- **Source:** `codex@core/src/client.rs:902-937`; `codex@protocol/src/openai_models.rs`
  (`use_responses_lite`, `#[serde(default)]`).
- **Consequence:** AgentPier's catalog does not set it; the parser should reject or
  count `additional_tools` items rather than silently drop tools.

### 3.3 Tool spec kinds

- **Value:** `ToolSpec` (tag `type`): `function {name, description, strict,
defer_loading?, parameters}`, `namespace {name, description, tools:[function|custom]}`,
  `tool_search {execution, description, parameters}`, `web_search
{external_web_access?, indexed_web_access?, filters?, user_location?,
search_context_size?, search_content_types?}`, `custom {name, description,
defer_loading?, format:{type:"grammar", syntax:"lark", definition}}`. No `local_shell`,
  `image_generation` or other hosted specs are emitted by this version's `ToolSpec`.
  Live default tool list: `exec_command`, `write_stdin`, `request_user_input`,
  `apply_patch` (custom), `view_image`, namespace `multi_agent_v1` (5 functions),
  `get_goal`, `create_goal`, `update_goal`.
- **Source:** `codex@tools/src/tool_spec.rs:20-56`; `codex@tools/src/responses_api.rs:16-80`;
  `codex@core/src/tools/handlers/apply_patch_spec.rs:9-28`; live capture.
- **Consequence:** hosted kinds to handle are `web_search` and `tool_search`; namespace
  members are `function` or `custom`.

### 3.4 Output/input item shapes

- **Value:** `function_call {id?, name, namespace?, arguments: String, call_id}`;
  `custom_tool_call {id?, status?, call_id, name, namespace?, input}`;
  `function_call_output`/`custom_tool_call_output {call_id, output: string | content
items}`; `reasoning {id?, summary:[{type:"summary_text",text}], content?: null |
[{type:"reasoning_text"|"text",text}], encrypted_content: string|null}` — Codex
  serializes `content` only when it contains `reasoning_text`, otherwise `null`, and
  always serializes `encrypted_content` (possibly `null`); `message {role, content:
[input_text|input_image|input_audio|output_text], phase?}`. Unknown `type` → `Other`.
  MCP tools: `namespace` like `mcp__<server>__` / `mcp__codex_apps__gmail`, member name
  separate.
- **Source:** `codex@protocol/src/models.rs:879-896,1012-1256,1624-1631,1984-1993,2098-2190`;
  `codex@protocol/src/mcp.rs:53-60`.
- **Consequence:** Spec delta 2 (no `refusal` part). Required fields when emitting
  `output_item.done`: `summary` array on reasoning; `name`/`arguments`/`call_id` on
  function calls; `call_id`/`name`/`input` on custom calls.

### 3.5 SSE events Codex parses

- **Value:** handled: `response.created` (needs `response`), `response.output_item.added`,
  `response.output_item.done` (tool calls and messages are built from `done`),
  `response.output_text.delta`, `response.custom_tool_call_input.delta` (needs `delta`
  and `item_id` or `call_id`), `response.reasoning_summary_text.delta` (needs
  `summary_index`), `response.reasoning_summary_text.done`,
  `response.reasoning_text.delta` (needs `content_index`),
  `response.reasoning_summary_part.added`, `response.completed`, `response.incomplete`,
  `response.failed`, `error` (only the flex-unavailable case; otherwise ignored).
  Explicitly ignored: `codex.response.metadata`, `response.content_part.added/.done`,
  `response.custom_tool_call_input.done`, `response.function_call_arguments.delta/.done`,
  `response.in_progress`, `response.metadata`, `response.output_text.done`,
  `response.reasoning_summary_part.done`, `responsesapi.websocket_timing`, any other
  `*.delta`. Unparseable `data` is skipped.
- **Source:** `codex@codex-api/src/sse/responses.rs:344-502,572-583`.
- **Consequence:** spec streaming obligations confirmed; function-call argument deltas
  are optional (Codex ignores them).

### 3.6 `response.completed`

- **Value:** `response.id` required (String); `usage` optional; when present
  `input_tokens`, `output_tokens`, `total_tokens` required; `input_tokens_details`
  optional but, when present, `cached_tokens` required (`cache_write_tokens` optional);
  `output_tokens_details.reasoning_tokens` required when the object is present;
  `end_turn` optional. A parse failure is a stream error. The stream ends at
  `completed`. A stream that closes without `completed` → "stream closed before
  response.completed" (retryable).
- **Source:** `codex@codex-api/src/sse/responses.rs:106-156,433-460,555-561`.
- **Consequence:** `emitStream` always includes `response.id` and complete usage
  objects; Messages → Responses may also fill `cache_write_tokens` from
  `cache_creation_input_tokens` (Codex reads it).

### 3.7 `response.incomplete`

- **Value:** reason `interrupted` → treated as completed with `end_turn:false`; any
  other reason (including `max_output_tokens`, `content_filter`, missing → `unknown`) →
  `ApiError::Stream("Incomplete response returned, reason: …")`, retried, then fatal.
  Live: reason `max_output_tokens` → "Reconnecting... 1/1" then "stream disconnected
  before completion".
- **Source:** `codex@codex-api/src/sse/responses.rs:418-432`; live capture.
- **Consequence:** Spec delta 1; Global Constraint "length → `response.completed`"
  confirmed.

### 3.8 Error handling

- **Value:** `response.failed` → `response.error.code`: `context_length_exceeded` →
  ContextWindowExceeded (no retry, triggers compaction paths);
  `insufficient_quota|credit_balance_exhausted|…` → QuotaExceeded;
  `usage_not_included`; `cyber_policy`; `bio_policy`; `misalignment_policy_violation`;
  `invalid_prompt` → InvalidPrompt (no retry); `server_is_overloaded` → ServerOverloaded
  (no retry); `rate_limit_exceeded|slow_down` → RateLimitExceeded (retry; delay from
  `/try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)/i`); anything else → Retryable.
  After `response.failed` Codex keeps reading until the stream closes, then reports the
  error. HTTP errors: transport retries 5xx and transport failures
  (`request_max_retries` default 4), not 429; 503 + `server_is_overloaded` →
  ServerOverloaded; 400 → InvalidRequest (raw body shown; `context_length_exceeded` not
  recognized — verified live); 500 → InternalServerError (retried at turn level); 429 →
  RetryLimit unless `usage_limit_reached`/quota codes; others → UnexpectedStatus
  (retried). Turn-level retries (`stream_max_retries` default 5) apply to Stream,
  RateLimitExceeded, Timeout, UnexpectedStatus, InternalServerError, ConnectionFailed.
- **Source:** `codex@codex-api/src/sse/responses_error.rs:25-94`;
  `codex@codex-api/src/api_bridge.rs:49-271`; `codex@protocol/src/error.rs:384-424`;
  `codex@model-provider-info/src/lib.rs:63-65,445-452`; live capture.
- **Consequence:** Spec deltas 3 and 6.

### 3.9 Stream idle timeout and keep-alives

- **Value:** `stream_idle_timeout_ms` default 300 000; the timer wraps each
  `eventsource-stream` `next()`; that parser drops comment lines and events without
  `data`.
- **Source:** `codex@model-provider-info/src/lib.rs:63`;
  `codex@codex-api/src/sse/responses.rs:532-567`; `eventsource-stream-0.2.3/src/event_stream.rs:95-102,210-232`.
- **Consequence:** Spec delta 4.

### 3.10 `ReasoningEffort` and summary values

- **Value:** effort `none`, `minimal`, `low`, `medium` (default), `high`, `xhigh`,
  `max`, `ultra`, `persistent`, or `Custom(String)`; a custom value that parses as an
  integer is serialized as a JSON **number**. Summary: `auto` (default), `concise`,
  `detailed`, `none` (→ field omitted). Codex resolves the effort against the catalog's
  `supported_reasoning_levels` (live: `"reasoning":{"effort":"medium"}`).
- **Source:** `codex@protocol/src/openai_models.rs:59-90`;
  `codex@codex-api/src/common.rs:170-183`; `codex@protocol/src/config_types.rs:65-72`;
  `codex@core/src/client.rs:863-883`.
- **Consequence:** IR `effort` is an open string; numeric efforts map to `medium` and
  are counted.

### 3.11 `web_search` config

- **Value:** top-level `web_search = "disabled" | "cached" (default) | "indexed" |
"live"`; a `[tools] web_search` table (`WebSearchToolConfig`) also exists. The hosted
  tool is only emitted when the mode is not `disabled` and the provider capability
  allows it. Live with `-c web_search="disabled"`: no `web_search` tool sent.
- **Source:** `codex@protocol/src/config_types.rs:376-382`;
  `codex@config/src/config_toml.rs:468-469,664-670`;
  `codex@core/src/tools/spec_plan.rs:632-650`; live capture.
- **Consequence:** spec launch rule confirmed.

### 3.12 Catalog fields relevant to the adapter

- **Value:** `apply_patch_tool_type: Option<ApplyPatchToolType>` with the single variant
  `freeform`; `apply_patch` is registered only when it is `Some`. Custom providers get
  `namespace_tools: true`, `remote_compaction: Unsupported` (local compaction through
  normal `/responses` turns), so Codex never calls a remote compact endpoint on adapter
  routes. Chat wire API is removed (`wire_api = "chat"` is a config error).
- **Source:** `codex@protocol/src/openai_models.rs:320-324,445`;
  `codex@core/src/tools/spec_plan.rs:1269-1272`;
  `codex@model-provider/src/provider.rs:45-68,420-431`;
  `codex@model-provider-info/src/lib.rs:100-130`; live capture (catalog with
  `"function"` rejected).
- **Consequence:** Spec delta 5.

## 4. Chat Completions

### 4.1 Streaming tool calls

- **Value:** `choices[].delta.tool_calls[]` entries carry `index: int` (required), and
  optional `id`, `type`, `function.name`, `function.arguments`. OpenAI sends `id`/`name`
  only on the first chunk of each index and argument fragments afterwards; the SDK
  accumulates by `index`. Some servers send complete arguments in one chunk.
- **Source:** `openai/openai-python@4e152cd:src/openai/types/chat/chat_completion_chunk.py:30-95`
  (all optional except `index`). "First chunk only" is OpenAI's observed behavior, not a
  documented guarantee (**unverified as a contract**).
- **Consequence:** `upstream-chat.parseStream` keys tool calls by `index`, takes the
  first non-empty `id`/`name`, concatenates arguments (spec confirmed).

### 4.2 `stream_options.include_usage`

- **Value:** adds a final chunk before `data: [DONE]` with `usage` and `choices: []`;
  other chunks carry `usage: null`; may be missing if the stream is interrupted.
- **Source:** `openai-python@4e152cd:src/openai/types/chat/chat_completion_stream_options_param.py:24-32`.
- **Consequence:** usage may arrive in a choice-less chunk after `finish_reason`; missing
  usage → estimate (spec).

### 4.3 `reasoning_effort`, `max_completion_tokens`, `prompt_cache_key`

- **Value:** `reasoning_effort`: `none | minimal | low | medium | high | xhigh | max`.
  `max_tokens` is deprecated in favor of `max_completion_tokens` (OpenAI reasoning models
  reject `max_tokens`). `prompt_cache_key` exists on Chat too. `finish_reason`: `stop`,
  `length`, `tool_calls`, `content_filter`, `function_call`.
- **Source:** `openai-python@4e152cd:src/openai/types/shared/reasoning_effort.py:8`;
  `…/chat/completion_create_params.py:117-130,192,233`;
  `…/chat/chat_completion_chunk.py:155`.
- **Consequence:** send `max_completion_tokens` to OpenAI/Azure; local servers accept
  `max_tokens` (keep a capability or send both only where tested). Map
  `function_call` like `tool_calls`.

### 4.4 Cached tokens and usage

- **Value:** `usage {prompt_tokens, completion_tokens, total_tokens,
prompt_tokens_details {cached_tokens, cache_write_tokens, audio_tokens, …},
completion_tokens_details {reasoning_tokens, …}}`; `prompt_tokens` includes cached.
- **Source:** `openai-python@4e152cd:src/openai/types/completion_usage.py:10-65`.
- **Consequence:** Global Constraint usage mapping confirmed; `cache_write_tokens` can
  feed `cache_creation_input_tokens` when present.

### 4.5 Tool name pattern

- **Value:** "Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum
  length of 64."
- **Source:** `openai-python@4e152cd:src/openai/types/shared/function_definition.py:10-16`.
- **Consequence:** `^[a-zA-Z0-9_-]{1,64}$` confirmed.
- **Responses upstream:** the function-name limit of the Responses API (`FunctionTool.name`) is
  unverified; the adapter conservatively applies the same Chat rule (≤ 64 characters,
  `[a-zA-Z0-9_-]`) through the per-session name map.

### 4.6 Vendor reasoning fields

| Server    | Streamed field                                                                                                      | Replay on input                                                                                              | Source                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| vLLM      | `delta.reasoning` (`DeltaMessage.reasoning`)                                                                        | `reasoning`; `reasoning_content` accepted and renamed                                                        | `vllm@7436a7f:vllm/entrypoints/generate/base/protocol.py:343-347`; `vllm/entrypoints/openai/chat_completion/protocol.py:528-551` |
| llama.cpp | `delta.reasoning_content` (with a reasoning format enabled)                                                         | `reasoning_content` on assistant messages                                                                    | `llama.cpp@fa3c2fa:tools/server/server-chat.cpp:535,624`                                                                         |
| LM Studio | `delta.reasoning_content` (0.3.9+, setting "separate reasoning_content"); `delta.reasoning` for `gpt-oss` (0.3.23+) | unverified                                                                                                   | `lmstudio.ai/docs/developer/api-changelog`                                                                                       |
| LiteLLM   | `delta.reasoning_content` (normalized across providers)                                                             | `reasoning_content` passed to providers that need it                                                         | LiteLLM docs (reasoning content); **unverified in source**                                                                       |
| DeepSeek  | `reasoning_content` (same level as `content`)                                                                       | without tool calls ignored; **with tool calls all previous `reasoning_content` must be sent back, else 400** | `api-docs.deepseek.com/guides/thinking_mode`                                                                                     |

- **Consequence:** `parseStream` reads both `reasoning_content` and `reasoning`;
  `reasoningReplay` writes `reasoning_content` (accepted by vLLM, llama.cpp, DeepSeek).
  DeepSeek thinking mode ignores `temperature`, `presence_penalty`, `frequency_penalty`.

### 4.7 Context-overflow wording per server

| Server    | Status / envelope                                                                                    | Message                                                                                                                                                                                                                                                                              | Source                                                                                                                                                                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vLLM      | 400, `{"error":{"message","type":"BadRequestError","param","code":400}}` (code is an int)            | `This model's maximum context length is <max> tokens. However, you requested <out> output tokens and your prompt contains [at least ]<in> input tokens, for a total of [at least ]<total> tokens. Please reduce …`                                                                   | `vllm@7436a7f:vllm/renderers/params.py:485-506`; `vllm/entrypoints/serve/engine/protocol.py:79-90`                                                                                                                                                                                                                   |
| llama.cpp | 400, `{"error":{"code":400,"message","type":"exceed_context_size_error","n_prompt_tokens","n_ctx"}}` | `request (<n> tokens) exceeds the available context size (<ctx> tokens), try increasing it` or `input (<n> tokens) is larger than the max context size (<ctx> tokens). skipping`                                                                                                     | `llama.cpp@fa3c2fa:tools/server/server-common.cpp:68-77`; `server-context.cpp:3405-3423`; `server-task.cpp:1512-1518`                                                                                                                                                                                                |
| LM Studio | 400, `{"error":"<string>"}`                                                                          | `Trying to keep the first <n> tokens when context the overflows. However, the model is loaded with context length of only <ctx> tokens, which is not enough. …` (typo is original); older: `The number of tokens to keep from the initial prompt is greater than the context length` | `github.com/lmstudio-ai/lmstudio-bug-tracker/issues/237` (observed, not a contract)                                                                                                                                                                                                                                  |
| LiteLLM   | 400, `{"error":{"message","type":null,"param":null,"code":"400"}}`                                   | `litellm.ContextWindowExceededError: …<provider message>`; maps upstream wording such as `this model's maximum context length is`, `exceeds the available context size`, `prompt is too long`                                                                                        | `litellm@d364d5e:litellm/exceptions.py:535-565` (prefix at `:557`); `litellm_core_utils/exception_mapping_utils.py:83-115` (substrings), `:318-320` (`ContextWindowExceededError: <Provider>Exception - …`), `:539`, `:896` (`prompt is too long`, Anthropic/Bedrock only); `docs.litellm.ai/docs/exception_mapping` |
| OpenAI    | 400, `error.code: "context_length_exceeded"`                                                         | Chat: `This model's maximum context length is <max> tokens. However, your messages resulted in <n> tokens…`; Responses: `Your input exceeds the context window of this model. Please adjust your input and try again.`                                                               | Responses wording: `codex@codex-api/src/sse/responses.rs:1090` (test fixture); Chat wording: widely reported, **unverified in official docs**                                                                                                                                                                        |
| Azure     | 400, `error.code: "context_length_exceeded"`                                                         | `This model's maximum context length is <max> tokens. However, you requested <n> tokens (<a> in the messages, <b> in the completion). Please reduce the length of the messages or completion.`                                                                                       | `github.com/Azure/azure-sdk-for-python/issues/40986` (observed)                                                                                                                                                                                                                                                      |

- **Consequence:** `errors.js` recognizers: `code === "context_length_exceeded"`,
  `type === "exceed_context_size_error"`, `/maximum context length is/i`,
  `/exceeds the available context size/i`, `/context the overflows|greater than the
context length/i`, `/ContextWindowExceededError/`, `/prompt is too long/i`,
  `/exceeds the context window/i`; extract `<n>`/`<max>` where present (vLLM, llama.cpp
  `n_prompt_tokens`/`n_ctx`, LM Studio).
- **Unverified wordings the code relies on by substring only** (no code or type backs
  them up; a wording change silently degrades the behavior to the generic fallback):
  - LM Studio context overflow:
    `/context the overflows|greater than the context length/i` is the only signal
    (string `error`, no code) → without it a plain `invalidRequest`, so Claude Code and
    Codex do not compact. Its numbers
    (`keep the first <n> tokens … context length of only <ctx> tokens`) likewise.
  - OpenAI Chat / Azure numbers: `messages resulted in <n> tokens` and
    `(<a> in the messages, <b> in the completion)` feed only the token numbers; the
    classification itself rests on `code: "context_length_exceeded"`.
  - Capability retries (`capabilities.js` `capabilityForError`): OpenAI
    `Unsupported parameter: '<name>' …` / `Use 'max_completion_tokens' instead`, pydantic
    or proxy `extra fields not permitted` / `Unrecognized request argument`, DeepSeek
    ``Missing `reasoning_content` `` (the 400 is documented, the wording is not), and
    the Anthropic adaptive-thinking rejection (`adaptive … not supported` or the
    `thinking.type` tag error). Only `param`, where an upstream sets it, is structured.
  - Responses `response.failed` codes not listed in §3.8 are classified by substring of
    the code (`polic`, `invalid_`, `unsupported`, `not_supported`, `content_filter` →
    `invalidRequest`); the listed codes are exact.

### 4.8 Native endpoints on local servers (context)

- **Value:** llama.cpp serves `/v1/messages`, `/v1/messages/count_tokens`,
  `/v1/responses`; LM Studio added `/v1/responses` (0.3.29) and `/v1/messages` (0.4.1).
- **Source:** `llama.cpp@fa3c2fa:tools/server/server.cpp:276-298`; LM Studio API changelog.
- **Consequence:** `auto` routing prefers these native protocols when PR #176 detection
  finds them.

## 5. OpenCode 1.18.33

### 5.1 Bundled AI SDK providers

- **Value:** the binary bundles a provider map with
  `"@ai-sdk/anthropic": () => import("/$bunfs/root/chunk-rpc1xard.js").then($ => $.createAnthropic)`,
  `"@ai-sdk/openai": () => import("/$bunfs/root/chunk-09s61q8x.js").then($ => $.createOpenAI)`,
  `"@ai-sdk/openai-compatible": … createOpenAICompatible`, plus Bedrock, Azure, Google,
  Vertex and others. Versions: `@ai-sdk/anthropic` 3.0.111 (`ai-sdk/anthropic/${UQ}`,
  `UQ="3.0.111"`); `@ai-sdk/openai` 3.0.84 and 3.0.88 (two copies).
- **Source:** `strings -n 8 ~/.opencode/bin/opencode` and search for the provider map
  (`var ty={"@ai-sdk/amazon-bedrock":…`).
- **Consequence:** spec claim confirmed; no download at runtime.

### 5.2 Base URL formation

- **Value:** `@ai-sdk/anthropic`: base URL = `options.baseURL` or `ANTHROPIC_BASE_URL`;
  only the exact value `https://api.anthropic.com` gets `/v1` appended; default
  `https://api.anthropic.com/v1`; request URL `${baseURL}/messages`; auth `x-api-key`
  (or `Authorization: Bearer` with `authToken`), `anthropic-version: 2023-06-01`.
  `@ai-sdk/openai`: base URL = `options.baseURL` or `OPENAI_BASE_URL`, default
  `https://api.openai.com/v1`; URL `${baseURL}${path}` with path `/responses`;
  `provider(modelId)` / `languageModel` = Responses model. An experimental native path
  (`OPENCODE_EXPERIMENTAL_NATIVE_LLM`) uses the same `/v1` + `/messages` convention.
- **Source:** OpenCode 1.18.33 binary (function `sV`/`iV` for Anthropic:
  `jQ="https://api.anthropic.com",FQ=\`${jQ}/v1\``; `buildRequestUrl … \`${this.config.baseURL}/messages\``;
`FX`/`dY`for OpenAI:`url:({path:B})=>\`${$}${B}\``, `K.languageModel=V` →
  `provider:\`${J}.responses\``).
- **Consequence (PR 2):** OpenCode `sdk` routes must set `baseURL` to the endpoint's
  Messages base **including `/v1`** for `@ai-sdk/anthropic`, and the Responses base
  **including `/v1`** for `@ai-sdk/openai` (spec: `anthropicBaseUrl + /v1` is correct
  when `anthropicBaseUrl` has no `/v1`).

## 6. Runtime facts (PR 2)

Date: 2026-10-07. Verified on macOS (Darwin 25.5.0, arm64) with the installed CLIs: Claude Code
2.1.292, Codex 0.160.1, OpenCode 1.18.35, nono 0.79.0, Node.js v22.22.2. "Capture" = a local
loopback server on `127.0.0.1:0` that answers with the recorded `text.sse` fixture and logs one
JSON line per request; every CLI ran with an isolated temporary `HOME` and config directory,
the placeholder token `session-token`, `NO_PROXY=127.0.0.1,localhost`, and (Claude Code, Codex)
`HTTPS_PROXY` pointed at the dead port `127.0.0.1:9`. Nothing left the machine. Linux was not
available here; facts marked macOS-only must be re-checked there.

### R1a. nono default profile and loopback

- **Value:** the `default` profile leaves outbound network allowed (`net outbound allowed`);
  a sandboxed `node` fetch to a loopback server returned `pong`.
- **Source:** `nono wrap -p default --allow-cwd -- node -e "fetch('http://127.0.0.1:<port>/')…"`
  from a directory under the repository's ignored `.cache/` (nono 0.79.0, Node v22.22.2).
- **Consequence:** Tasks 14 and 15: a nono-wrapped CLI reaches the adapter on `127.0.0.1`
  without extra grants when the profile does not block the network.

### R1b. nono `block: true` and `--open-port`

- **Value:** a profile with `network: { block: true }` denies loopback: the fetch failed with
  `EPERM` (`net outbound blocked`). Adding `--open-port <port>` (bidirectional localhost TCP on
  that port, shown as `ipc localhost:<port>`) restored it: `pong`. Verified on macOS only
  (Seatbelt); `--allow-connect-port` is documented as Linux Landlock V4+ only, and the Linux
  behavior of `--open-port` is **not verified on this machine**.
- **Source:** same command with `block.json` (copy of `restrictive` from
  `tests/matrix/nono-confinement.test.js` with `network.block: true`), once plain and once with
  `--open-port <port>`; `nono wrap --help` (nono 0.79.0).
- **Consequence:** this contradicts the plan's assumption that loopback stays reachable under
  block-net. Task 15 Step 3 applies: a launch with a blocking network profile and an adapter
  route must add `--open-port <adapter port>` (the port is known only after the adapter
  binds, so the nono argv is composed after the bind), and the Linux case needs a test that
  skips when it cannot run.

### R2. Claude Code against a loopback `ANTHROPIC_BASE_URL`

- **Value:** `POST /v1/messages?beta=true`, `authorization: Bearer` (no `x-api-key`),
  `max_tokens: 4096` from `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, first system block is
  `You are a Claude agent, …` (no `x-anthropic-billing-header` with
  `CLAUDE_CODE_ATTRIBUTION_HEADER=0`), the CLI printed the fixture text
  (`Hello from the fixture.`), exit 0, no request reached the dead `HTTPS_PROXY` (`NO_PROXY`
  bypass works). For the unknown model id `custom-model-x` Claude Code also prints an
  `unrecognized_model` notice on stderr; it does not affect the request.
- **Source:** `claude -p "say ok"` with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL=custom-model-x`,
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, `HTTPS_PROXY=http://127.0.0.1:9`
  (Claude Code 2.1.292). Request body keys: `model, messages, system, tools, metadata,
max_tokens, thinking, output_config, stream`; 21 tools.
- **Consequence:** Task 4 (Claude Code launch env) and Task 10: the launch environment from the
  Global Constraints is sufficient; scripted tests may parse stdout and ignore the stderr
  notice.

### R3a. Codex with a `-c model_providers=…` override

- **Value:** with `model_providers={agentpier-endpoint={…,base_url="http://127.0.0.1:<port>/v1"}}`
  and `model_provider="agentpier-endpoint"` given as `-c` arguments, Codex sent
  `POST /v1/responses`, `authorization: Bearer` (from the `env_key` variable), no `x-api-key`,
  `stream: true`; the tool list (`exec_command`, `write_stdin`, `request_user_input`,
  `view_image`, `multi_agent_v1`, `get_goal`, `create_goal`, `update_goal`) contained no
  `web_search` with `web_search="disabled"`; the CLI printed the fixture text, exit 0. A
  `Model metadata … not found` warning appears for the unknown model slug (no catalog was
  supplied in this run).
- **Source:** `codex exec --skip-git-repo-check -c … --model fixture-model "say ok"` with
  `CODEX_HOME` set to a temp directory (Codex 0.160.1).
- **Consequence:** Task 5: the `-c` override carries the adapter URL at launch, so no URL is
  written to disk; `web_search = "disabled"` verified again.

### R3b. `config.toml` provider without `base_url`

- **Value:** Codex accepts a `[model_providers.agentpier-endpoint]` table without `base_url`
  (and `model_provider` pointing at it): it started, reported `provider: agentpier-endpoint`,
  and tried to reach the network (stderr `Reconnecting... waiting for network`, with
  `HTTPS_PROXY` dead and no request reaching the loopback capture); it was stopped after 90 s.
  The default origin it targets was not asserted; this is consistent with the OpenAI default.
- **Source:** same run without the `-c model_providers=…` argument, `CODEX_HOME/config.toml`
  holding `model_provider = "agentpier-endpoint"` and the provider table with `name`,
  `wire_api = "responses"`, `requires_openai_auth = false`, `env_key` and no `base_url`
  (Codex 0.160.1).
- **Consequence:** no correction: Task 5 may keep the provider table in `config.toml` without
  `base_url`, and the adapter URL arrives only through the `-c model_providers=…` override at
  launch. A launch that loses the override would try the default origin, so tests assert that
  the override is present in argv.

### R4a. OpenCode `@ai-sdk/anthropic`

- **Value:** request path `POST /v1/messages` (with `baseURL` ending in `/v1`), no `?beta`.
  `options.authToken` is passed through: `authorization: Bearer`, no `x-api-key`.
  `options.apiKey` gives `x-api-key` and no `authorization`. Both exit 0 and printed the
  fixture text. No `/v1/models` or other `GET` request; the only extra startup request is a
  second `POST /v1/messages` for the title generator (a small system prompt `You are a title
generator…`, no tools) before the main request (tools `bash, edit, glob, grep, read,
skill, task, todowrite, webfetch, write`). `max_tokens` is 32000 in both.
- **Source:** `opencode run --model agentpier-endpoint/fixture-model "say ok"` with
  `XDG_*` and `HOME` in a temp directory and `OPENCODE_CONFIG_CONTENT` setting
  `npm: "@ai-sdk/anthropic"`, `options.baseURL: "http://127.0.0.1:<port>/v1"` and
  `authToken`/`apiKey` = `{env:AGENTPIER_ENDPOINT_API_KEY}` (OpenCode 1.18.35).
- **Consequence:** Task 4: SDK routes talk to the endpoint directly, without the adapter, so
  they must send the same `Authorization: Bearer` header as Claude Code's native endpoint
  route: use `authToken` for `@ai-sdk/anthropic`. A server sees two Messages requests per
  OpenCode prompt.

### R4b. OpenCode `@ai-sdk/openai`

- **Value:** request path `POST /v1/responses`, `authorization: Bearer` from `options.apiKey`,
  no `x-api-key`; body keys `model, input, max_output_tokens, store, prompt_cache_key,
tools, tool_choice, stream`. Same extra title-generator request as in R4a; no `GET`
  requests. Exit 0, fixture text printed.
- **Source:** same invocation with `npm: "@ai-sdk/openai"` and the Responses fixture
  (OpenCode 1.18.35).
- **Consequence:** Task 4: `baseURL` including `/v1` is right for both SDK packages.

### R4c. OpenCode SDK providers without a key or with a custom header

- **Value:** `@ai-sdk/anthropic` and `@ai-sdk/openai` do not start without a key option:
  with no `apiKey`/`authToken` (keyless, or only `headers`) OpenCode exits 1 before any
  request (`Anthropic|OpenAI API key is missing`), with an `env -i` environment. Observed
  auth headers (all exit 0, fixture text printed; both requests per prompt identical):

  | Case                                                                               | Headers that arrive                          |
  | ---------------------------------------------------------------------------------- | -------------------------------------------- |
  | anthropic `authToken: "agentpier-endpoint"`                                        | `authorization: Bearer agentpier-endpoint`   |
  | anthropic `apiKey: "agentpier-endpoint"`                                           | `x-api-key: agentpier-endpoint`              |
  | openai `apiKey: "agentpier-endpoint"`                                              | `authorization: Bearer agentpier-endpoint`   |
  | anthropic `authToken` placeholder + `headers: {"api-key": key, authorization: ""}` | `api-key: key`, `authorization` empty string |
  | openai `apiKey` placeholder + `headers: {"api-key": key, authorization: ""}`       | `api-key: key`, `authorization` empty string |

  A header set to `""` in `options.headers` replaces the SDK credential header; it arrives
  as an empty header, with no Bearer token or `x-api-key` value. Not verified: how Azure
  treats an empty `Authorization` header next to `api-key`; an empty value was chosen over a
  dummy Bearer token because it carries no misleading credential.

- **Source:** `opencode run` (OpenCode 1.18.35) under `env -i` with temp `HOME`/`XDG_*`,
  `OPENCODE_CONFIG_CONTENT`, a loopback capture server and the `messages/text.sse` and
  `responses/text.sse` fixtures; the key was the placeholder `PLACEHOLDER-TOKEN`.
- **Consequence:** Task 4: keyless SDK routes pass the fixed placeholder `agentpier-endpoint`
  as the key option; with a custom header the key option is the placeholder too, the SDK
  credential header (`authorization`) is blanked and only the custom header carries the key.

### R5. `--use-system-ca`

- **Value:** `process.allowedNodeEnvironmentFlags.has("--use-system-ca")` is `true` on
  v22.22.2. The flag first appeared in v23.8.0 and was backported to v22.15.0.
- **Source:** `node -p 'process.allowedNodeEnvironmentFlags.has("--use-system-ca")'`
  (Node v22.22.2).
- **Consequence:** Task 10: the adapter launcher passes `--use-system-ca` when the running Node
  accepts it (feature-detect with `allowedNodeEnvironmentFlags`); Node 22.13 and 22.14 fall
  back to passing `NODE_EXTRA_CA_CERTS` through.
