# Protocol Adapter Library (PR 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure, offline-tested library that translates Anthropic Messages (Claude Code) and OpenAI Responses (Codex) client traffic to and from Messages, Responses and Chat Completions upstreams, in the four directions the spec requires.

**Architecture:** Client modules parse client requests into an intermediate representation (IR) and emit IR events in the client's wire format; upstream modules build upstream requests from the IR and parse upstream responses and streams into IR events. A small orchestrator (`translate.js`) composes them. No network, no filesystem, no process code — those come in PR 2.

**Tech Stack:** Node.js 22 ES modules, `node:test`, fast-check, JSON fixtures.

**Spec:** `docs/superpowers/specs/2026-10-07-protocol-adapter-design.md` (sections "Architecture → Layers 1", "Intermediate representation", "Translation rules", "Testing"). PR 2 (adapter process, launcher, routing, OpenCode SDK routes) and PR 3 (UI, doctor, docs) get their own plans after this PR merges.

## Global Constraints

- Worktree `.worktrees/protocol-adapter`, branch `feat/protocol-adapter`; never touch the main checkout.
- English commit messages with `feat:`/`fix:`/`test:`/`docs:`/`chore:` prefixes; every commit ends with a `Co-Authored-By:` trailer naming the authoring model.
- Source and test files ≤ 600 lines (`npm run check:structure`); Prettier (2 spaces, double quotes, semicolons, trailing commas, 90 columns); ESLint clean.
- No new npm dependencies.
- Library code under `server/features/protocol-adapter/` is pure: no `node:fs`, `node:net`, `node:http`, `process.env`, timers or `Date.now()` (time is passed in when needed).
- Fixtures under `tests/fixtures/protocol-adapter/`; recorded fixtures contain no real keys, account ids, file paths of the developer, or prompt content beyond synthetic test prompts.
- Effort → budget table: `minimal=1024`, `low=2048`, `medium=8192`, `high=16384`, `xhigh=24576`, `max=32768`; budget ≥ 1024 and < `max_tokens`; thinking disabled when `max_tokens <= 1024`.
- Chat tool names `^[a-zA-Z0-9_-]{1,64}$`; Messages tool names `^[a-zA-Z0-9_-]{1,128}$` (verify in Task 1); Messages call ids `^[a-zA-Z0-9_-]+$`.
- Usage: OpenAI → Messages `input = prompt - cached`, `cache_read = cached`, `cache_creation = 0`; Messages → OpenAI `input = input + cache_read + cache_creation`, `cached = cache_read`.
- Carrier format `ap1.<origin>.<base64url(payload)>`, origin ∈ `messages|responses|chat`.
- Context overflow: Messages client 400 `invalid_request_error` message `prompt is too long: <n> tokens > <max> maximum` (numbers when known, else `prompt is too long`); Responses client error `code: "context_length_exceeded"`.
- Length stop toward Codex is `response.completed`, never `response.incomplete`.

## Review Focus

1. A Codex request with namespaced MCP tools and freeform `apply_patch` sent to a Chat upstream → valid Chat request (names ≤ 64 chars), and the streamed tool calls come back to Codex as the right item types with complete `response.output_item.done` items.
2. A Claude Code request with `thinking: {type:"adaptive"}` + `output_config.effort` and mid-conversation system messages sent to a Chat or Responses upstream → reasoning effort mapped, system messages placed at the same position, no `thinking` field leaked.
3. A Messages upstream gets a Codex request without `max_output_tokens` → `max_tokens` derived from the model; thinking constraints (budget, temperature, forced tool choice) applied.
4. A Chat upstream streams tool calls with the id only on the first chunk, arguments split across chunks and reasoning in `reasoning_content` → correct, ordered client events.
5. A vLLM/llama.cpp/LiteLLM context-overflow error → exact context-length error shape for each client.

---

## File Structure

`server/features/protocol-adapter/`

- `ir.js` — IR constructors and validators (`assertIrRequest`, `assertIrEvent`), effort normalization.
- `mapping.js` — stop-reason tables, effort ↔ budget, usage conversion, `maxTokensFor(model, sampling)`.
- `sse.js` — incremental SSE parser (`createSseParser()` → `push(chunk) → events[]`, `end() → events[]`) and writer (`sseEvent(name, data)`, `sseData(data)`, `sseComment(text)`).
- `names.js` — `createNameMap({ maxLength, pattern })` bijective tool-name map; `createIdMap(pattern)`; namespace flattening helpers.
- `carrier.js` — `encodeCarrier(origin, payload)`, `decodeCarrier(string)`.
- `errors.js` — `classifyUpstreamError(protocol, status, body, headers) → IrError`.
- `client-messages.js` — Claude Code side.
- `client-responses.js` — Codex side.
- `upstream-messages.js`, `upstream-responses.js`, `upstream-chat.js`.
- `translate.js` — `createTranslator({ client, upstream, model, capabilities, thinkTagExtraction, sessionKey })` returning `{ buildUpstream(body, headers), translateStream(upstreamChunks), translateResponse(json), translateError(status, body, headers), errorFor(irError, streaming) }`.

`tests/fixtures/protocol-adapter/`

- `clients/claude-code/*.json`, `clients/codex/*.json` — recorded client requests (Task 2).
- `upstreams/{messages,responses,chat}/*.sse|*.json` — upstream responses (Task 2 synthesizes from docs; notes the source in `README.md`).
- `README.md` — provenance and anonymization notes.

`tests/unit/protocol-adapter/*.test.js`, `tests/property/protocol-adapter-*.test.js`, `tests/integration/protocol-adapter-directions.test.js`.
`tests/helpers/protocol-adapter.js` — fixture loader, SSE chunk splitter, event collectors.

---

### Task 1: Verify protocol facts the library depends on

**Files:**

- Create: `docs/research/protocol-adapter-facts.md`

This task records the facts the later tasks encode, with sources, so implementers do not guess. It produces no code.

- [ ] **Step 1: Research and record** (WebFetch/WebSearch official docs and source; cite URLs and file paths with commit or version):
  1. Anthropic Messages: tool name pattern and max length; `tool_use.id` pattern; streaming event sequence and `ping`; `thinking` types (`enabled`, `adaptive`, `disabled`) and `output_config.effort` values; thinking constraints (min budget, budget < max_tokens, temperature/top_p, forced tool_choice); `cache_control` max breakpoints; error types and statuses (incl. 529 `overloaded_error`, "prompt is too long" wording); usage fields.
  2. Claude Code 2.1.291 gateway behavior (code.claude.com/docs/en/llm-gateway-protocol and related pages): paths incl. `?beta=true`, `/api/hello`, `count_tokens` fallback, headers, idle watchdog, how it treats thinking signatures, mid-conversation system messages, `CLAUDE_CODE_ATTRIBUTION_HEADER`.
  3. OpenAI Responses (as used by Codex 0.159.2, read `openai/codex` at the matching tag): request struct fields (`codex-api/src/common.rs`), tool spec kinds (`tools/src/tool_spec.rs`: function, custom/freeform, namespace, hosted kinds), `function_call` item `namespace` field, SSE events Codex parses and which it ignores (`codex-api/src/sse/responses.rs`), `response.incomplete` handling, `context_length_exceeded` handling, reasoning item shape and `encrypted_content`, `ReasoningEffort` values, `web_search` config key and values.
  4. Chat Completions: streaming tool call chunks (id/name only on first chunk, `index`), `stream_options.include_usage`, `reasoning_effort`, `prompt_tokens_details.cached_tokens`, tool name pattern; vendor reasoning fields (`reasoning_content`, `reasoning`) for vLLM, llama.cpp, LM Studio, LiteLLM, DeepSeek; context-overflow error wording per vLLM, llama.cpp, LM Studio, LiteLLM, OpenAI, Azure.
  5. OpenCode 1.18.33: confirm `@ai-sdk/anthropic` and `@ai-sdk/openai` are bundled (string search in the binary like PR #176 did for openai-compatible) and how their `baseURL` is formed (does `@ai-sdk/anthropic` expect `.../v1`?). This is consumed by PR 2 but verified now.

  Use this structure per fact: **Fact**, **Value**, **Source** (URL or `repo@tag:path:line`), **Consequence for the library** (one line).

- [ ] **Step 2: Flag conflicts with the spec.** If any fact contradicts the spec or Global Constraints (e.g., a tool-name limit, an event Codex requires), list it under "Spec deltas" at the top of the file with the proposed correction.

- [ ] **Step 3: Commit**

```bash
npx prettier --write docs/research/protocol-adapter-facts.md
git add docs/research/protocol-adapter-facts.md
git commit -m "docs: record protocol facts for the adapter library"
```

---

### Task 2: Fixtures — record client requests, synthesize upstream responses

**Files:**

- Create: `tests/fixtures/protocol-adapter/README.md`
- Create: `tests/fixtures/protocol-adapter/clients/claude-code/*.json`
- Create: `tests/fixtures/protocol-adapter/clients/codex/*.json`
- Create: `tests/fixtures/protocol-adapter/upstreams/{messages,responses,chat}/*`
- Create: `tests/helpers/protocol-adapter.js`
- Create: `scripts/dev/capture-cli-requests.mjs` (developer tool; not run in CI)

**Interfaces:**

- Produces: `loadFixture(relPath) → object | string`, `splitChunks(text, sizes) → string[]`, `collect(asyncIterable) → Promise<array>` in `tests/helpers/protocol-adapter.js`.

- [ ] **Step 1: Capture tool.** `scripts/dev/capture-cli-requests.mjs` starts an HTTP server on `127.0.0.1:<port>` that:
  - records every request (method, path, headers minus auth, JSON body) to an output directory;
  - answers `POST /v1/messages` with a canned Messages SSE stream (one `tool_use` the first time, text afterwards), `POST /responses` and `/v1/responses` with a canned Responses SSE stream (one `function_call` the first time, text afterwards), `HEAD|GET /api/hello` 200, anything else 404;
  - stops after N requests or a timeout.

- [ ] **Step 2: Record Claude Code 2.1.291** in an isolated temp profile (`CLAUDE_CONFIG_DIR=$(mktemp -d)`, `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, `ANTHROPIC_AUTH_TOKEN=fixture`, `ANTHROPIC_MODEL=qwen3-coder:30b` — a non-Claude id so it sends adaptive thinking) with `claude -p` prompts that cause: (a) plain text answer; (b) a tool call (e.g. "list files" so it uses Bash/LS) — the canned `tool_use` triggers a second request containing `tool_result`; (c) an MCP tool present (configure a trivial stdio MCP server from `tests/fixtures` or a long-named dummy); (d) an image input if `claude -p` supports passing one, else skip and note it. Save requests as `clients/claude-code/<case>.json` with `{ path, headers, body }`, auth removed.

- [ ] **Step 3: Record Codex 0.159.2** with an isolated `CODEX_HOME=$(mktemp -d)` and `-c model_providers.capture={name="capture",base_url="http://127.0.0.1:<port>/v1",wire_api="responses",env_key="CAPTURE_KEY"} -c model_provider=capture -c model=qwen3-coder:30b`, `codex exec` prompts that cause: (a) text; (b) function call round trip; (c) `apply_patch` freeform (use a model catalog with `apply_patch_tool_type: "freeform"`) and `function` variant; (d) an MCP server configured so `namespace` tools appear; (e) `web_search` at its default and with `web_search="disabled"`; (f) reasoning with `include: ["reasoning.encrypted_content"]` and `store:false`. Save as `clients/codex/<case>.json`.

- [ ] **Step 4: Synthesize upstream fixtures** from the official docs recorded in Task 1 (cite the doc section in `README.md`), as raw SSE text files and JSON bodies:
  - `upstreams/messages/`: text stream; thinking + signature + text; parallel `tool_use` with `input_json_delta` split; `max_tokens` stop; `refusal`; mid-stream `event: error` overloaded; non-stream JSON; 400 prompt too long; 429 with `retry-after`.
  - `upstreams/responses/`: text; reasoning summary + `encrypted_content`; two `function_call`s with argument deltas; `custom_tool_call` input deltas; `response.incomplete` max_output_tokens; `response.failed` `context_length_exceeded`; usage with `cached_tokens`.
  - `upstreams/chat/`: text; `reasoning_content` deltas (DeepSeek/vLLM style); `reasoning` deltas (LM Studio/llama.cpp style); `<think>` inline; two parallel tool calls with id only on first chunk and split arguments; tool call with whole arguments in one chunk; `length` finish; usage chunk with `prompt_tokens_details.cached_tokens`; no usage at all; context errors: vLLM (`This model's maximum context length is …`), llama.cpp (`the request exceeds the available context size`), LM Studio, LiteLLM (`ContextWindowExceededError`), OpenAI/Azure (`context_length_exceeded`) — exact wording per Task 1.

- [ ] **Step 5: Helpers** in `tests/helpers/protocol-adapter.js`:

```js
import fs from "node:fs";
import path from "node:path";

const root = new URL("../fixtures/protocol-adapter/", import.meta.url);

export function loadFixture(relPath) {
  const text = fs.readFileSync(new URL(relPath, root), "utf8");
  return relPath.endsWith(".json") ? JSON.parse(text) : text;
}

export function splitChunks(text, sizes) {
  const chunks = [];
  let offset = 0;
  for (const size of sizes) {
    if (offset >= text.length) break;
    chunks.push(text.slice(offset, offset + size));
    offset += size;
  }
  if (offset < text.length) chunks.push(text.slice(offset));
  return chunks;
}

export async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

export async function* fromChunks(chunks) {
  for (const chunk of chunks) yield chunk;
}

export const fixtureList = (dir) =>
  fs.readdirSync(new URL(dir, root)).map((name) => path.posix.join(dir, name));
```

- [ ] **Step 6: Anonymize and commit.** Grep the fixtures for the developer's home path, user name, email, hostnames, tokens; replace with `/workspace`, `user`, `example.test`, `fixture`. Document in `README.md` how to re-record (command lines from Steps 2–3).

```bash
npx prettier --write tests/helpers/protocol-adapter.js scripts/dev/capture-cli-requests.mjs tests/fixtures/protocol-adapter/README.md
git add tests/fixtures/protocol-adapter tests/helpers/protocol-adapter.js scripts/dev/capture-cli-requests.mjs
git commit -m "test: record protocol adapter client fixtures and synthesize upstream streams"
```

---

### Task 3: IR, mapping tables and usage conversion

**Files:**

- Create: `server/features/protocol-adapter/ir.js`, `server/features/protocol-adapter/mapping.js`
- Test: `tests/unit/protocol-adapter/mapping.test.js`, `tests/unit/protocol-adapter/ir.test.js`

**Interfaces:**

- Produces:
  - `normalizeEffort(value) → "none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"` (`ultra`/`persistent` → `max`; unknown → `medium` and `{ unknown: true }` flag via `normalizeEffortWithInfo`).
  - `budgetForEffort(effort) → number`, `effortForBudget(budget) → effort` (nearest).
  - `resolveThinkingForMessages({ thinking, maxTokens, temperature, topP, toolChoice }) → { thinking: object|null, temperature, topP, toolChoice, adjustments: string[] }` applying all Anthropic constraints from Global Constraints.
  - `maxTokensFor({ sampling, model }) → number` (`sampling.maxOutputTokens ?? model.outputTokens ?? min(floor(model.contextTokens/4), 32000)`).
  - `usageFromOpenAI({ prompt, completion, cached, reasoning })` and `usageFromMessages({ input, output, cacheRead, cacheWrite })` → IR usage; `usageToMessages(ir)`, `usageToOpenAI(ir)`.
  - `STOP` tables: `stopFromMessages`, `stopFromResponses(status, incompleteReason, hasToolCalls)`, `stopFromChat(finishReason)`, `stopToMessages`, `stopToResponses` (returns `{ status: "completed" | "incomplete", incompleteReason? }` — never `incomplete` for `length`).
  - `assertIrRequest(ir)`, `assertIrEvent(event)` throwing `TypeError` with a path.

- [ ] **Step 1: Write failing tests** covering every table row from the spec ("Stop reasons", "Usage and caching") and every Global Constraint number: e.g.

```js
test("thinking is disabled when max_tokens is too small", () => {
  const r = resolveThinkingForMessages({
    thinking: { mode: "enabled", budgetTokens: 4096 },
    maxTokens: 1024,
    temperature: 0.2,
    topP: 0.9,
    toolChoice: "auto",
  });
  assert.equal(r.thinking, null);
  assert.deepEqual(r.adjustments, ["thinkingDisabledMaxTokens"]);
});
test("thinking removes temperature/top_p and relaxes forced tool choice", () => {
  const r = resolveThinkingForMessages({
    thinking: { mode: "adaptive", effort: "high" },
    maxTokens: 32000,
    temperature: 0.2,
    topP: 0.9,
    toolChoice: { name: "x" },
  });
  assert.deepEqual(r.thinking, { type: "adaptive" });
  assert.equal(r.temperature, undefined);
  assert.equal(r.topP, undefined);
  assert.equal(r.toolChoice, "auto");
});
test("budget is clamped below max_tokens and never below 1024", () => {
  assert.equal(
    resolveThinkingForMessages({
      thinking: { mode: "enabled", budgetTokens: 9000 },
      maxTokens: 4000,
      toolChoice: "auto",
    }).thinking.budget_tokens,
    3999,
  );
  assert.equal(
    resolveThinkingForMessages({
      thinking: { mode: "enabled", budgetTokens: 10 },
      maxTokens: 4000,
      toolChoice: "auto",
    }).thinking.budget_tokens,
    1024,
  );
});
test("usage conversion both ways", () => {
  const ir = usageFromOpenAI({ prompt: 1000, completion: 50, cached: 600 });
  assert.deepEqual(usageToMessages(ir), {
    input_tokens: 400,
    output_tokens: 50,
    cache_read_input_tokens: 600,
    cache_creation_input_tokens: 0,
  });
  const back = usageFromMessages({
    input: 400,
    output: 50,
    cacheRead: 600,
    cacheWrite: 10,
  });
  assert.deepEqual(usageToOpenAI(back), {
    input_tokens: 1010,
    output_tokens: 50,
    input_tokens_details: { cached_tokens: 600 },
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 1060,
  });
});
test("length toward Responses clients is completed", () => {
  assert.deepEqual(stopToResponses("length"), { status: "completed" });
});
```

- [ ] **Step 2: Run** `node --test tests/unit/protocol-adapter/` → FAIL (modules missing).
- [ ] **Step 3: Implement** `ir.js` and `mapping.js` to make the tests pass. Thinking for Messages uses `{ type: "adaptive" }` when the IR mode is `adaptive` (effort goes to `output_config.effort`, returned as `effort` in the result), `{ type: "enabled", budget_tokens }` for `enabled`.
- [ ] **Step 4: Run** → PASS. Also `npx eslint server/features/protocol-adapter tests/unit/protocol-adapter`.
- [ ] **Step 5: Commit** `feat: add protocol adapter IR and mapping tables`.

---

### Task 4: SSE parser and writer

**Files:**

- Create: `server/features/protocol-adapter/sse.js`
- Test: `tests/unit/protocol-adapter/sse.test.js`, `tests/property/protocol-adapter-sse.test.js`

**Interfaces:**

- Produces: `createSseParser({ maxEventBytes = 16 * 1024 * 1024 } = {})` with `push(text) → { event, data, id }[]` and `end() → [...]`; throws `RangeError("sseEventTooLarge")` beyond the cap. `sseEvent(name, dataObject) → string`, `sseData(dataObject | "[DONE]") → string`, `sseComment(text) → string`. Data lines joined with `\n`; CRLF and LF accepted; comments ignored; `data: [DONE]` yields `{ data: "[DONE]" }`.

- [ ] **Step 1: Failing tests**: fixed examples (multi-line data, CRLF, comments, event without data, trailing event without blank line flushed by `end()`), and a property test: for every upstream fixture file and random chunk splits (`fc.array(fc.integer({min:1,max:64}))`), the parsed events equal the events from a single `push`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: add incremental SSE parser and writer for the protocol adapter`.

---

### Task 5: Names, ids and reasoning carrier

**Files:**

- Create: `server/features/protocol-adapter/names.js`, `server/features/protocol-adapter/carrier.js`
- Test: `tests/unit/protocol-adapter/names.test.js`, `tests/property/protocol-adapter-names.test.js`

**Interfaces:**

- Produces:
  - `createNameMap({ pattern, maxLength })` → `{ toUpstream(name, namespace?) → string, fromUpstream(name) → { name, namespace? } }`. Valid short names pass through unchanged (namespaced become `<namespace>__<name>` when that fits); others become `<prefix>_<hash8>` where prefix is the longest valid leading slice and hash is a stable FNV-1a hex of the full name; collisions are resolved deterministically by appending a counter; the map is per translator instance (per session).
  - `createIdMap(pattern)` → `{ toUpstream(id), fromUpstream(id) }`, verbatim when valid, otherwise `id_<hash>`.
  - `encodeCarrier(origin, payloadString | null) → "ap1.<origin>.<base64url>"`, `decodeCarrier(string) → { origin, payload } | null` (null for any non-carrier string, including real Anthropic signatures).

- [ ] **Step 1: Failing tests** incl. property tests: bijectivity for random name sets (including names of length 1–300 with `.`, `:`, `/`, unicode), output always matches the pattern, idempotence of repeated calls, carrier round trip for random payloads, `decodeCarrier` returns null for random base64 strings without the prefix.
- [ ] **Step 2–4:** Run (FAIL) → implement (no `crypto` dependency needed; FNV-1a in a few lines) → run (PASS).
- [ ] **Step 5: Commit** `feat: add bijective tool name, id and reasoning carrier helpers`.

---

### Task 6: Upstream error classification and client error emitters

**Files:**

- Create: `server/features/protocol-adapter/errors.js`
- Test: `tests/unit/protocol-adapter/errors.test.js`

**Interfaces:**

- Produces:
  - `classifyUpstreamError({ protocol, status, body, headers }) → IrError` using status first, then per-family recognizers for context overflow (all wordings recorded in Task 1/Task 2 fixtures), rate limit, overloaded, auth. `retryAfter` from the `retry-after` header (seconds or HTTP date relative to a passed `now`).
  - `sanitizeMessage(text, secrets[]) → string` (500 chars, control chars removed, every secret replaced by `[redacted]`).
  - `messagesErrorBody(irError) → { status, body }`, `responsesErrorBody(irError) → { status, body }` (used by client modules; context wording per Global Constraints; `overloaded` → Messages 529 `overloaded_error`, Responses 503 `server_error`).
- [ ] **Step 1: Failing tests** — one test per context fixture per client, plus 401/403/404/429/500/503/529 mapping and secret redaction.
- [ ] **Step 2–4:** Run → implement → run.
- [ ] **Step 5: Commit** `feat: classify upstream errors and render client error bodies`.

---

### Task 7: Claude Code client — parse requests

**Files:**

- Create: `server/features/protocol-adapter/client-messages.js` (parse part)
- Test: `tests/unit/protocol-adapter/client-messages-parse.test.js`

**Interfaces:**

- Produces: `parseMessagesRequest(body, headers) → { ir: IrRequest, dropped: string[] }`. Rules from spec "Requests from Claude Code": system blocks with `cache_control` → `system` parts with `cache: "ephemeral"`; messages with `role:"system"` mid-conversation → IR system messages; content blocks text/image/tool_use/tool_result/thinking/redacted_thinking; thinking `adaptive` + `output_config.effort` → `{ mode: "adaptive", effort }`; `enabled` + `budget_tokens`; `tools` with `input_schema`; `tool_choice` (`auto`, `any` → `required`, `tool` → `{name}`, `none`); `disable_parallel_tool_use` → `parallelToolCalls:false`; `metadata`, unknown top-level fields → `dropped`; thinking blocks keep `signature` as `carrier` (decoded by translator later).
- [ ] **Step 1: Failing tests** against every recorded `clients/claude-code/*.json` fixture (snapshot the IR as `tests/fixtures/protocol-adapter/ir/claude-code/<case>.json`, reviewed by hand once) plus targeted unit cases (mid-conversation system message position; tool_result with image; empty assistant message dropped).
- [ ] **Step 2–4:** Run → implement → run.
- [ ] **Step 5: Commit** `feat: parse Claude Code requests into the adapter IR`.

---

### Task 8: Claude Code client — emit streams, responses and errors

**Files:**

- Modify: `server/features/protocol-adapter/client-messages.js` (emit part; split into `client-messages-emit.js` if the file would exceed 600 lines)
- Test: `tests/unit/protocol-adapter/client-messages-emit.test.js`

**Interfaces:**

- Produces: `emitMessagesStream(events: AsyncIterable<IrEvent>, { model, messageId }) → AsyncIterable<string>`; `emitMessagesResponse(events) → Promise<object>`; `messagesPing() → string` (`event: ping\ndata: {"type":"ping"}\n\n`); `emitMessagesStreamError(irError) → string`.
- Rules: exact event order `message_start` (usage input placeholder) → per block `content_block_start` / deltas (`text_delta`, `thinking_delta`, `signature_delta` carrying the carrier, `input_json_delta`) / `content_block_stop` → `message_delta` (stop_reason, usage) → `message_stop`. Tool call blocks are `tool_use` with names and ids restored through the translator's maps. Claude Code never declares custom (freeform) tools, so an IR tool call of kind `custom` cannot occur on this path; the emitter throws `TypeError("unexpectedCustomToolCall")` if it does (covered by a test). Usage output uses `usageToMessages`.
- [ ] **Step 1: Failing tests**: feed IR event sequences (from Task 11–13 parsers later; here hand-written) and assert the exact SSE text for: text only; thinking with carrier; two parallel tool calls with split JSON; length stop; usage with cache read; mid-stream error after partial text (error event, no `message_stop`); non-stream response equals the collected stream content.
- [ ] **Step 2–4:** Run → implement → run.
- [ ] **Step 5: Commit** `feat: emit Claude Code wire format from adapter events`.

---

### Task 9: Codex client — parse requests

**Files:**

- Create: `server/features/protocol-adapter/client-responses.js` (parse part)
- Test: `tests/unit/protocol-adapter/client-responses-parse.test.js`

**Interfaces:**

- Produces: `parseResponsesRequest(body, headers) → { ir, dropped, rejected?: IrError }`.
- Rules from spec "Requests from Codex": `instructions` + `input` items (`message` with roles `system|developer|user|assistant`, `input_text`, `input_image`, `output_text`, `function_call` (with `namespace`), `function_call_output`, `custom_tool_call`, `custom_tool_call_output`, `reasoning` (summary, `encrypted_content` → carrier)); `tools` kinds (`function`, `custom` with `format.grammar`, `namespace` with member tools, hosted kinds → `kind:"hosted"`); `tool_choice`; `parallel_tool_calls`; `reasoning.effort`/`summary` → thinking `{ mode: "enabled"|... }` with normalized effort (`none` → `disabled`); `text.format` json_schema → output; `max_output_tokens`; `store`, `include`; `previous_response_id` → `rejected` invalidRequest; `prompt_cache_key` → `cache.key`.
- [ ] **Step 1: Failing tests** against every `clients/codex/*.json` fixture (IR snapshots) plus targeted cases.
- [ ] **Step 2–4.** **Step 5: Commit** `feat: parse Codex requests into the adapter IR`.

---

### Task 10: Codex client — emit streams, responses and errors

**Files:**

- Modify/Create: `client-responses.js` or `client-responses-emit.js`
- Test: `tests/unit/protocol-adapter/client-responses-emit.test.js`

**Interfaces:**

- Produces: `emitResponsesStream(events, { model, responseId, includeEncrypted }) → AsyncIterable<string>`; `emitResponsesResponse(events)`; `responsesKeepalive() → string` (SSE comment); `emitResponsesStreamError(irError)`.
- Rules (spec "Streaming obligations"): `response.created` → per item `response.output_item.added` → deltas (`response.output_text.delta`, `response.reasoning_summary_text.delta`, `response.function_call_arguments.delta`, `response.custom_tool_call_input.delta` with `item_id` and `call_id`) → complete `response.output_item.done` items (function_call with full `arguments`, `namespace` restored; custom_tool_call with raw `input`; reasoning with summary and, when `includeEncrypted`, `encrypted_content` = carrier) → `response.completed` with usage (`usageToOpenAI`) or `response.failed` (context errors with `code: "context_length_exceeded"`). `length` → `response.completed`.
- [ ] **Step 1: Failing tests** mirroring Task 8 plus: custom tool round trip (IR function call created from a Chat upstream for a custom tool is emitted as `custom_tool_call` with unwrapped `input`); namespaced function call restored; every added item has a matching done item.
- [ ] **Step 2–4.** **Step 5: Commit** `feat: emit Codex wire format from adapter events`.

---

### Task 11: Chat Completions upstream

**Files:**

- Create: `server/features/protocol-adapter/upstream-chat.js`
- Test: `tests/unit/protocol-adapter/upstream-chat.test.js`

**Interfaces:**

- Produces: `buildChatRequest(ir, { names, ids, capabilities, model, sessionKey }) → { path: "/chat/completions", body }`; `parseChatStream(sseEvents, { names, ids, thinkTagExtraction }) → AsyncIterable<IrEvent>`; `parseChatResponse(json, ctx)`.
- Rules (spec "Upstream: Chat Completions" and "Capabilities"): system/developer placement; tool results one message each with `[error] ` prefix; images in tool results moved to a following user message; custom tools → function with `{input: string}` schema; namespaced names via `names`; `tool_choice`, `parallel_tool_calls` (only if capability), `reasoning_effort` (only if capability), `stream_options.include_usage` (only if capability `streamUsage`), `prompt_cache_key` (only if capability); `reasoningReplay` adds `reasoning_content` to assistant messages from IR reasoning text; deterministic JSON key order in the body (sort tool schema keys); stream parsing: id/name on first chunk per index, argument accumulation, whole-argument chunks, `reasoning_content` and `reasoning` fields, optional `<think>` extraction across chunk boundaries, `finish_reason` → stop, usage chunk → usage, missing usage → `usage` with `estimated: true` computed from serialized request and emitted text (chars/4, rounded up).
- [ ] **Step 1: Failing tests** using every `upstreams/chat/*` fixture, with random chunk splits for stream fixtures.
- [ ] **Step 2–4.** **Step 5: Commit** `feat: translate adapter IR to and from Chat Completions`.

---

### Task 12: Responses upstream

**Files:**

- Create: `server/features/protocol-adapter/upstream-responses.js`
- Test: `tests/unit/protocol-adapter/upstream-responses.test.js`

**Interfaces:**

- Produces: `buildResponsesRequest(ir, ctx) → { path: "/responses", body }`; `parseResponsesStream(sseEvents, ctx)`; `parseResponsesResponse(json, ctx)`.
- Rules: `instructions` from leading system parts, mid-conversation system as `developer` messages; thinking → `reasoning.effort` (budget → nearest) and `summary: "auto"`; `max_output_tokens`; `store: false`; `include: ["reasoning.encrypted_content"]` only when replaying encrypted reasoning (carrier origin `responses`); strip item ids when `store` is false; `prompt_cache_key` when capability; stream parsing uses `output_item.done` as the source of truth for tool calls (deltas used for incremental IR events); reasoning `encrypted_content` → `reasoningCarrier` event with origin `responses`; `response.incomplete` → length/contentFilter; `response.failed` → error via `classifyUpstreamError`.
- [ ] **Step 1–4.** **Step 5: Commit** `feat: translate adapter IR to and from the Responses API`.

---

### Task 13: Messages upstream

**Files:**

- Create: `server/features/protocol-adapter/upstream-messages.js`
- Test: `tests/unit/protocol-adapter/upstream-messages.test.js`

**Interfaces:**

- Produces: `buildMessagesRequest(ir, ctx) → { path: "/v1/messages", body, headers: { "anthropic-version": "2023-06-01" } }`; `parseMessagesStream(sseEvents, ctx)`; `parseMessagesResponse(json, ctx)`.
- Rules: `max_tokens` via `maxTokensFor`; thinking via `resolveThinkingForMessages` (adaptive with `output_config.effort`; effort → budget table for `enabled`); mid-conversation system messages: Messages has no system role inside `messages` for all models — follow Task 1's finding (either keep `role:"system"` if the API accepts it, or merge into a user text block prefixed `<system>…</system>` and record the choice in the facts doc); alternation enforced by merging same-role neighbors; namespaced/custom tools → function tools with mapped names; `cache_control` kept (max 4, extra dropped oldest-first, counted); reasoning replay: only carriers with origin `messages` (decoded signature) are sent back as signed thinking; others dropped; stream parsing: `thinking_delta`, `signature_delta` (→ carrier origin `messages`), `input_json_delta`, `message_delta` stop/usage, `event: error` → error.
- [ ] **Step 1–4.** **Step 5: Commit** `feat: translate adapter IR to and from Anthropic Messages`.

---

### Task 14: Translator orchestration and the four directions

**Files:**

- Create: `server/features/protocol-adapter/translate.js`
- Test: `tests/integration/protocol-adapter-directions.test.js`

**Interfaces:**

- Produces:

```js
export function createTranslator({ client, upstream, model, capabilities, thinkTagExtraction, sessionKey, secrets }) {
  // client: "messages" | "responses"; upstream: "messages" | "responses" | "chat"
  return {
    buildUpstream(body, headers) → { ok: true, request: { path, body, headers }, dropped } | { ok: false, error: { status, body } },
    translateStream(upstreamTextChunks: AsyncIterable<string>) → AsyncIterable<string>,  // client SSE text
    translateResponse(upstreamJson) → Promise<object>,
    translateError({ status, body, headers }, { streaming }) → { status, headers, body } | string,
    keepalive() → string,                                  // ping or comment for the client protocol
    diagnostics() → { dropped: Record<string, number>, adjustments: Record<string, number>, estimatedUsage: number },
  };
}
```

The translator owns one `names`/`ids` map pair per instance (per session) and decodes carriers on the way to the upstream. `client === upstream` is rejected (native routes never use the adapter).

- [ ] **Step 1: Failing direction tests**, one `describe` per direction (Messages←Responses, Messages←Chat, Responses←Messages, Responses←Chat):
  - request: each recorded client fixture builds a valid upstream request (shape checked against small hand-written validators per upstream protocol — required fields, name patterns, no IR leftovers like `thinking` on Chat);
  - stream: each relevant upstream fixture, split at random chunk boundaries, yields client SSE that a client-side parser (reuse the client modules' own parse helpers for responses or a small checker) accepts: correct order, matching added/done pairs (Responses), `message_stop` present (Messages), tool names and ids restored, carriers round-trip on the next request;
  - errors: every context-overflow fixture → exact client wording; 429 keeps `retry-after`.
  - multi-turn: a tool loop of two requests in each direction where the second request contains the first response's tool call, tool result and reasoning (carrier) → upstream request contains correctly mapped ids/names and reasoning only where allowed.
- [ ] **Step 2–4.** Run → implement `translate.js` → run.
- [ ] **Step 5: Commit** `feat: compose the protocol adapter translator for all four directions`.

---

### Task 15: Verification

- [ ] **Step 1:** `npm run check` (lint, format, structure, build, all Node suites). Known baseline failure on macOS: `tests/integration/shell.test.js` Unicode login shell.
- [ ] **Step 2:** `grep -rn "node:fs\|node:net\|node:http\|process.env\|Date.now\|setTimeout" server/features/protocol-adapter` → no matches (purity).
- [ ] **Step 3:** Ensure fixtures contain no secrets or personal paths: `grep -rniE "sk-|/Users/|d\.kaulig|ranger" tests/fixtures/protocol-adapter` → no matches.
- [ ] **Step 4:** Final cleanup commit removes this plan file (AGENTS.md: completed plans are removed before the PR). The spec stays in `docs/superpowers/specs/` because PR 2 and PR 3 are still active work. Then open PR 1 via superpowers:finishing-a-development-branch.
