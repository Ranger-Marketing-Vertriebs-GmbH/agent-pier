# Protocol adapter fixtures

Test data for the protocol adapter library (`server/features/protocol-adapter/`). Protocol
facts and their sources are in `docs/research/protocol-adapter-facts.md` (cited below as
"facts §n"). Load fixtures with `loadFixture()` from `tests/helpers/protocol-adapter.js`;
`tests/unit/protocol-adapter/fixtures.test.js` keeps the set healthy (JSON parses, SSE
files end with a blank line, no credentials, personal paths or addresses).

## Layout and formats

| Directory              | Content                                                      | Format                                        |
| ---------------------- | ------------------------------------------------------------ | --------------------------------------------- |
| `clients/claude-code/` | Requests recorded from Claude Code 2.1.291 (`claude -p`)     | JSON `{ path, headers, body }`                |
| `clients/codex/`       | Requests recorded from Codex 0.159.2 (`codex exec`)          | JSON `{ path, headers, body }`                |
| `upstreams/messages/`  | Synthesized Anthropic Messages responses                     | `.sse` raw stream body; `.json` HTTP response |
| `upstreams/responses/` | Synthesized OpenAI Responses streams                         | `.sse` raw stream body                        |
| `upstreams/chat/`      | Synthesized Chat Completions streams and server error bodies | `.sse` raw stream body; `.json` HTTP response |

- Client fixtures: `path` includes the query string; `headers` are lower-case as received
  with `authorization`, `x-api-key`, `api-key`, `cookie` and `proxy-authorization` removed;
  `body` is the parsed JSON request.
- Upstream `.sse` files are the exact bytes of a `200 text/event-stream` body and end with
  a blank line. Upstream `.json` files are `{ status, headers, body }`.

## Client fixtures

All requests use the model id `qwen3-coder:30b` (not a Claude id, so Claude Code sends
adaptive thinking) and only the synthetic prompts listed here.

| File                               | Case                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code/text.json`            | Plain text prompt                                                                                                                                        |
| `claude-code/tool-call.json`       | Prompt that leads to a `Bash` tool call (first request)                                                                                                  |
| `claude-code/tool-result.json`     | Follow-up request carrying `tool_use` + `tool_result`                                                                                                    |
| `claude-code/mcp.json`             | Stdio MCP server with a long tool name (`mcp__fixture__lookup_project_documentation_…`)                                                                  |
| `claude-code/mcp-tool-result.json` | Follow-up carrying the MCP `tool_result` (content block array)                                                                                           |
| `claude-code/image.json`           | Base64 PNG image block, sent via `--input-format stream-json`                                                                                            |
| `codex/text.json`                  | Plain text; `web_search` at its default (`cached`: `{"type":"web_search","external_web_access":false}`)                                                  |
| `codex/web-search-disabled.json`   | `-c web_search="disabled"`: no `web_search` tool                                                                                                         |
| `codex/function-call.json`         | Prompt answered with an `exec_command` `function_call`                                                                                                   |
| `codex/function-call-output.json`  | Follow-up with `function_call` + `function_call_output`                                                                                                  |
| `codex/apply-patch.json`           | Catalog `apply_patch_tool_type: "freeform"`: `apply_patch` is a `custom` grammar tool                                                                    |
| `codex/apply-patch-output.json`    | Follow-up with `custom_tool_call` + `custom_tool_call_output`                                                                                            |
| `codex/mcp.json`                   | Stdio MCP server: tools appear as `namespace` `mcp__fixture`                                                                                             |
| `codex/mcp-output.json`            | Follow-up with a namespaced `function_call`; the output is a content array (the call was refused because `codex exec` runs with approval policy `never`) |
| `codex/reasoning.json`             | Reasoning catalog, `model_reasoning_effort="high"`, `model_reasoning_summary="auto"`                                                                     |
| `codex/reasoning-replay.json`      | Follow-up replaying the `reasoning` item with `encrypted_content`                                                                                        |
| `codex/image.json`                 | `-i pixel.png`: `input_image` data URL                                                                                                                   |

Every Codex request has `store: false`, `stream: true` and
`include: ["reasoning.encrypted_content"]` (facts §3.1). The `apply_patch` `function`
variant is not recorded: Codex 0.159.2 only accepts `"freeform"` and exits on `"function"`
(facts Spec delta 5).

## Upstream fixtures

Synthesized from the documentation and source revisions listed in the facts file. Ids,
token counts and texts are synthetic unless the wording is noted as exact.

### `upstreams/messages/` (facts §1.3, §1.8, §1.9, §1.11)

| File                    | Content                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `text.sse`              | Text with a `ping`, cache usage in `message_start`, cumulative usage in `message_delta`                                      |
| `thinking-text.sse`     | `thinking_delta` ×2 + `signature_delta`, then a text block                                                                   |
| `parallel-tool-use.sse` | Text then two `tool_use` blocks; `input_json_delta` split inside keys and values                                             |
| `max-tokens.sse`        | `stop_reason: "max_tokens"`                                                                                                  |
| `refusal.sse`           | `stop_reason: "refusal"`                                                                                                     |
| `error-overloaded.sse`  | Text block started, then `event: error` `overloaded_error` `Overloaded` (exact, streaming docs); no `message_stop`           |
| `non-stream.json`       | 200 Message with thinking, text and `tool_use`                                                                               |
| `prompt-too-long.json`  | 400 `invalid_request_error` `prompt is too long: 215000 tokens > 200000 maximum` (format matched by Claude Code, facts §1.9) |
| `rate-limit.json`       | 429 `rate_limit_error` with `retry-after: 30` (message text illustrative)                                                    |
| `overloaded.json`       | 529 `overloaded_error` `Overloaded`                                                                                          |

### `upstreams/responses/` (facts §3.4–§3.8)

Every stream follows what Codex parses: `response.created` → `response.in_progress` →
per item `output_item.added`, deltas, `output_item.done` (complete item) → terminal event
with `response.id` and full usage (`input_tokens_details.cached_tokens`,
`output_tokens_details.reasoning_tokens`). Events carry `sequence_number`.

| File                               | Content                                                                                                                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text.sse`                         | Message with content parts and two `output_text.delta`                                                                                                                                                   |
| `reasoning-summary.sse`            | Reasoning item with summary deltas and `encrypted_content`, then a message                                                                                                                               |
| `function-calls.sse`               | Two `function_call` items with split `function_call_arguments.delta`                                                                                                                                     |
| `custom-tool-call.sse`             | `apply_patch` `custom_tool_call` with split `custom_tool_call_input.delta`                                                                                                                               |
| `incomplete-max-output-tokens.sse` | `response.incomplete`, `incomplete_details.reason: "max_output_tokens"`                                                                                                                                  |
| `failed-context-length.sse`        | `response.failed` `context_length_exceeded`, message `Your input exceeds the context window of this model. Please adjust your input and try again.` (exact, `codex@codex-api/src/sse/responses.rs:1090`) |
| `cached-usage.sse`                 | Text with `cached_tokens: 3072` of 4096 input tokens                                                                                                                                                     |

### `upstreams/chat/` (facts §4.1–§4.7, Spec deltas 10–11)

| File                               | Content                                                                                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text.sse`                         | Text; **no usage chunk at all** (the "no usage" case)                                                                                                                                                                                                 |
| `reasoning-content.sse`            | `delta.reasoning_content` (DeepSeek, llama.cpp, LM Studio, LiteLLM)                                                                                                                                                                                   |
| `reasoning.sse`                    | `delta.reasoning` (vLLM; LM Studio for `gpt-oss`)                                                                                                                                                                                                     |
| `think-inline.sse`                 | `<think>…</think>` inside `content`, tag split across chunks                                                                                                                                                                                          |
| `parallel-tool-calls.sse`          | Two tool calls, `id`/`name` only on the first chunk of each index, interleaved split arguments                                                                                                                                                        |
| `tool-call-whole.sse`              | One tool call with complete arguments in a single chunk                                                                                                                                                                                               |
| `length.sse`                       | `finish_reason: "length"`                                                                                                                                                                                                                             |
| `usage-cached.sse`                 | `usage: null` on content chunks, final `choices: []` chunk with `prompt_tokens_details.cached_tokens`                                                                                                                                                 |
| `context-vllm.json`                | vLLM 400, `error.code` integer `400`, `type: "BadRequestError"`; exact wording from `vllm@7436a7f:vllm/renderers/params.py` plus the `(parameter=…, value=…)` suffix of `VLLMValidationError.__str__` (`vllm/exceptions.py`)                          |
| `context-llamacpp.json`            | llama.cpp 400 `exceed_context_size_error` with `n_prompt_tokens`/`n_ctx`; exact wording                                                                                                                                                               |
| `context-litellm.json`             | LiteLLM proxy 400, `error.code` string `"400"`, `type: null`; message composed as in `litellm@d364d5e` (`exceptions.py` prefixes, `exception_mapping_utils.py:319-320` `ContextWindowExceededError: <Provider>Exception - …`) around the vLLM message |
| `context-lmstudio-unverified.json` | LM Studio 400 with `error` as a **string**                                                                                                                                                                                                            |
| `context-openai-unverified.json`   | OpenAI Chat 400 `context_length_exceeded`                                                                                                                                                                                                             |
| `context-azure-unverified.json`    | Azure OpenAI 400 `context_length_exceeded`                                                                                                                                                                                                            |

### Unverified wordings

Files named `*-unverified.*` use wording that the facts file marks as unverified:

- `chat/context-lmstudio-unverified.json`: text as observed in
  `lmstudio-ai/lmstudio-bug-tracker#237` (including the original typo "context the
  overflows"), not a documented contract.
- `chat/context-openai-unverified.json`: OpenAI Chat wording is widely reported but not in
  the official docs; only `code: "context_length_exceeded"` is reliable.
- `chat/context-azure-unverified.json`: wording from `Azure/azure-sdk-for-python#40986`
  (observed).

Recognizers should key on codes/types first and treat these texts as examples.

## Re-recording client fixtures

Developer tool only (not run in CI). It starts a capture server on `127.0.0.1` that
records each request and answers with canned streams (`/v1/messages`: one `tool_use`
when the case asks for it, text afterwards; `/responses` and `/v1/responses`: one
`function_call`/`custom_tool_call` the first time, text afterwards; `HEAD|GET /api/hello`
200; anything else 404). Each CLI runs with a throw-away `HOME`, `CLAUDE_CONFIG_DIR` or
`CODEX_HOME` and working directory under the system temp dir, the credential `fixture`,
`TZ=UTC`, and `HTTP(S)_PROXY` pointing at a dead local port so nothing can reach a real
API. Temp paths, the home directory, user name, host name and e-mail addresses are
rewritten to `/workspace`, `/home/user`, `user`, `host.example.test` and
`user@example.test`.

```bash
# both CLIs (pass version-pinned binaries to reproduce these fixtures)
node scripts/dev/capture-cli-requests.mjs record \
  --claude-bin ~/.local/share/claude/versions/2.1.291 \
  --codex-bin ~/.codex/packages/standalone/releases/0.159.2-aarch64-apple-darwin/bin/codex
# one CLI
node scripts/dev/capture-cli-requests.mjs record --cli codex --codex-bin codex
# server only, e.g. for manual runs
node scripts/dev/capture-cli-requests.mjs serve --port 4399 --out /tmp/capture --plan bash
```

The recorder runs these command lines (port and temp dirs filled in):

```bash
CLAUDE_CONFIG_DIR=<tmp>/config HOME=<tmp>/home ANTHROPIC_BASE_URL=http://127.0.0.1:<port> \
ANTHROPIC_AUTH_TOKEN=fixture ANTHROPIC_MODEL=qwen3-coder:30b CLAUDE_CODE_ATTRIBUTION_HEADER=0 \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \
  claude -p --model qwen3-coder:30b [--allowedTools 'Bash(ls)' | --mcp-config <file> --strict-mcp-config] <<< '<prompt>'

CODEX_HOME=<tmp>/config HOME=<tmp>/home CAPTURE_KEY=fixture \
  codex exec --skip-git-repo-check -C <tmp>/work \
  -c 'model_providers.capture={name="capture",base_url="http://127.0.0.1:<port>/v1",wire_api="responses",env_key="CAPTURE_KEY"}' \
  -c model_provider=capture -c 'model="qwen3-coder:30b"' -c 'model_catalog_json="<tmp>/config/models.json"' \
  [-c 'web_search="disabled"' | -c mcp_servers.fixture.command=… | -i pixel.png --] '<prompt>'
```

The model catalog comes from `codexModelCatalog()` in
`server/features/providers/native-config.js` (`apply_patch_tool_type: "freeform"`). The
MCP server is `scripts/dev/fixture-mcp-server.mjs`; the canned answers are in
`scripts/dev/capture-cli-streams.mjs`. Upstream fixtures are hand-made and are edited
directly.

Recorded with version-pinned binaries: the machine's `claude`/`codex` had already
auto-updated to 2.1.292 / 0.160.1 at recording time, so the 2.1.291 / 0.159.2 binaries
were called by path. Not recorded: Claude Code `count_tokens` and `HEAD /api/hello`
(not sent with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and a proxy set, facts §2.1).
