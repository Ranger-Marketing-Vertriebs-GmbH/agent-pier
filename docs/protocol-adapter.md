# Protocol adapter

For users: routes, options and limits are described under _Custom endpoints_ in
[providers.md](providers.md). This page covers how the adapter works.

## Purpose

Claude Code speaks Anthropic Messages, Codex speaks OpenAI Responses. A custom endpoint
may offer only Chat Completions, Responses or Messages. When a CLI's native protocol is
not available (or the connection routes it elsewhere), a local adapter translates between
the CLI's protocol and the server's. OpenCode bundles AI SDK providers for all three
protocols and never uses the adapter. The adapter therefore implements four directions:
Messages or Responses toward the client, and Messages, Responses or Chat Completions
toward the upstream (the native pairs are not translated).

It keeps text, streaming, tool calls (parallel, custom and namespaced), system prompts,
reasoning, images, structured output, prompt caching, stop reasons, usage and
context-overflow signalling. It does not translate realtime, audio, batch or file APIs,
Codex's websocket transport, or stateful Responses features (`previous_response_id` is
rejected), and it does not emulate hosted tools on targets without them.

Code: `server/features/protocol-adapter/` (pure translation library, no network or
filesystem) and `server/features/adapter-runtime/` (process, supervisor, HTTP server,
diagnostics). Launch preparation lives in `server/features/providers/`.

## Process model

- A session on an adapter route starts through `server/terminal-launcher.js`. The payload
  carries an `adapter` block (session token, protocols, upstream URL, auth header and
  key, model limits, options, diagnostics path, launch generation, cache-key seed). The
  launcher loads the adapter modules only then.
- The launcher's supervisor (`adapter-supervisor.js`, `adapter-listener.js`) binds
  `127.0.0.1:0` itself and keeps the socket for the whole session. The adapter child
  (`server/adapter-process.js`) never binds: the supervisor hands each accepted connection
  over IPC. The port is never released while the session runs, so no other local process
  can take it during a restart.
- The launcher waits up to 10 s for the adapter's `ready`, substitutes the URL placeholder
  into the CLI's environment values and arguments only (never into persistent config
  files), starts the CLI, and stops the adapter (SIGTERM, SIGKILL after 2 s) when the CLI
  exits. The adapter outlives server restarts like the launcher does, and release
  reference tracking covers its entry point.
- Restart budget: an adapter exit the supervisor did not cause restarts it after 250 ms
  with the same configuration and token, at most 3 times within a sliding 60 s (a failed
  start counts as one). A restart continues the counters and learned options of its own
  launch generation. While no child takes connections, up to 64 connections wait for at
  most 15 s each; the rest are closed.
- Give-up: when the budget is spent, the supervisor drops key and token and answers every
  waiting and later connection with a static HTTP 503 in the client's own error format
  until the session is reloaded or restarted. The CLI keeps running. The doctor reports
  this as failed.
- A start that fails (`config`, `timeout`, `spawn`, `listen`, `exited`) is recorded in the
  diagnostics file, the launcher prints a sanitized one-line message and exits 127 without
  starting the CLI. The session then stops; the doctor still reports the failure for
  24 hours.
- Reloads, model changes and release migration restart launcher and adapter. A pipeline
  (headless) session uses the same path.

## Security

- Loopback only. Every request needs the session token (`x-api-key` or
  `Authorization: Bearer`, constant-time comparison); the token is a random 32-byte value
  in the variable the CLI already reads. The `Host` header must name the loopback listener
  and its port, and any `Origin` header is refused (403), as protection against DNS
  rebinding and browsers. Refusals close the connection without reading the body.
- The upstream key exists only in the private one-use launch payload and in the adapter
  process (passed over IPC, never in its argv or environment). The CLI never sees it. A
  custom auth header applies only to the adapter's upstream hop.
- Upstream requests go only to the configured origin under the same address policy as the
  connection test, re-checked for every new connection; each connection is pinned to its
  checked addresses; TLS verifies the host name; redirects are not followed.
- The adapter ignores `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` and does not receive
  them. Its environment holds `PATH` plus `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and
  `SSL_CERT_DIR` (taken from the CLI environment, else AgentPier's); the process also runs
  with `--use-system-ca` where Node supports it, so private company CAs work.
- Limits: request body 64 MiB (larger bodies get HTTP 400 in the client's format and the
  connection closes), one SSE event up to 16 MiB, no total cap on response streams. A
  client that stops reading for 240 s is cut off.
- Name and id maps live in memory per session. No prompt, completion, key or token
  content is logged; diagnostics hold counters and fixed error kinds only.
- Under nono confinement, adapter launches add `--open-port <port>` before `--`; see
  [sandbox.md](sandbox.md).

## Translation overview

Both client protocols are parsed into one intermediate representation (IR): a request
(system parts, messages with typed parts, tools, tool choice, sampling, thinking, output
format, cache hints) and a stream of events (block start, deltas, usage, stop, error). The
upstream builders write the target protocol from the IR, upstream parsers read responses
back into IR events, and client emitters write the client protocol. Features without a
target equivalent are dropped and counted, or rejected when dropping would change
behavior (image input to a model marked without images, structured output the target
cannot express, `previous_response_id`).

- **Tools.** Codex namespaces and freeform tools (`apply_patch`) are mapped to function
  tools for Messages and Chat targets and back. Tool names that the target forbids are
  mapped per session (bijective, hashed when too long). Parallel calls and streamed
  argument fragments are handled; a call without arguments reaches Codex as `{}`.
- **System messages.** Mid-conversation system messages become `developer` messages on
  Responses targets, stay in place on Messages targets, and are merged into the next
  user turn as `<system>…</system>` on Chat targets (chat templates of many local servers
  reject a system message that is not first) unless the option keeps them inline.
- **Reasoning.** Replay data travels in an opaque carrier `ap1.<origin>.<payload>`
  (base64url of the upstream's own replay data). Claude Code receives it as the thinking
  block's `signature`, Codex as the reasoning item's `encrypted_content` (only when Codex
  asked for it). On the next request a carrier goes back only to an upstream of the same
  origin; otherwise it is dropped, except that Chat targets with the reasoning-text option
  get the text as `reasoning_content`. Anthropic replay uses the exact original thinking
  text and signature, since modified thinking blocks are rejected.
- **Thinking and effort.** Toward Messages upstreams, adaptive thinking and effort pass
  through; the thinking-budget option sends `enabled` with `budget_tokens`
  (minimal 1024, low 2048, medium 8192, high 16384, xhigh 24576, max 32768, clamped).
  Temperature, top_p and top_k are removed, and a forced tool choice is relaxed to `auto`
  while thinking is on. Claude's effort values are low, medium, high, xhigh and max.
- **Usage.** Messages `input_tokens` excludes cache reads and writes, OpenAI's includes
  cached tokens; the adapter converts both ways. Missing upstream usage is estimated
  (characters / 4) and counted, so automatic compaction keeps working. Usage events carry
  cumulative totals; emitters keep the per-field maximum.
- **Stop reasons.** end, length, tool use and stop sequence map to the client's
  equivalents. A content filter becomes `refusal` for Claude Code and a failed response
  (`invalid_prompt`) for Codex. A refusal becomes an output text part for Codex. Codex
  treats `response.incomplete` as an error, so a length stop is sent as
  `response.completed`.
- **Errors and context overflow.** Upstream errors are classified per server family
  (Anthropic, OpenAI and Azure, vLLM, llama.cpp, LM Studio, LiteLLM) and re-emitted in
  the client's format, with sanitized messages (500 characters, no control characters, key
  and header values redacted). Context overflow is worded as each client recognizes it so
  automatic compaction works: Claude Code gets `prompt is too long: <n> tokens > <max>
maximum` (or the `max_tokens` variant when shrinking the output budget helps), Codex
  gets `context_length_exceeded`. Codex errors that should drive its behavior (overflow,
  rate limit, overload, invalid prompt) are sent as an in-stream `response.failed`
  after HTTP 200; plain HTTP error bodies are used for authentication failures and
  non-streaming requests.
- **Keep-alives and timing.** The upstream idle timeout is 240 s, below the 300 s of both
  CLIs. Toward Claude Code the adapter writes nothing until the upstream answered 2xx, so
  an upstream rejection (notably overflow) still arrives as an HTTP 400 body; `ping` events
  follow only after the first frame, every 15 s while silent. Toward Codex the stream
  starts at once and `response.in_progress` events every 15 s keep it alive (Codex
  ignores SSE comments). A first frame that does not arrive within 240 s after the
  upstream's 2xx ends in an in-stream error.
- **Claude Code specifics.** `count_tokens` answers 404 without an upstream call (Claude
  Code then estimates itself) and is counted separately. AgentPier sets
  `CLAUDE_CODE_ATTRIBUTION_HEADER=0` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` from the model
  record for adapter routes. For Codex, `web_search` is disabled, the model catalog marks
  freeform `apply_patch`, and its image and reasoning flags come from the model and
  connection.
- **Determinism.** Toward OpenAI-style upstreams, system, tools and history are serialized
  with fixed key order so automatic prefix caching hits.

## Capabilities

The option table lives in [providers.md](providers.md#custom-endpoints) (defaults are
`CAPABILITY_DEFAULTS` in `server/features/protocol-adapter/capabilities.js`, which
documents every key). Stored values override defaults, unknown names are ignored and
invalid values are rejected.

- **Probe.** _Test connection_ runs `server/features/providers/endpoint-capability-probe.js`:
  one extra 16-token request per option, only fixed values leave the module. The result
  is a proposal; the user can edit it and nothing is saved before the connection is.
- **Runtime retry.** If the upstream answers 400 or 422 and the error names one of the
  options (read from OpenAI's `error.param` or quoted in the message), the adapter
  retries once with the changed option. It keeps the change for the rest of the session
  only if the retry succeeds; a failed retry restores the previous value, because the
  mapping is heuristic. Both outcomes are counted as `kept` or `reverted` under
  `capabilityFallbacks`. Mappings: Responses `reasoning`, `reasoning.effort`,
  `reasoning.summary`, `include` turn reasoning effort off; Chat `max_tokens` and
  `max_completion_tokens` switch the field, `stream_options` turns usage off; both: a
  rejected `prompt_cache_key` or `parallel_tool_calls` is turned off; Messages: rejected
  adaptive thinking turns the thinking budget on.

## Diagnostics file

- Path: `<dataDir>/sessions/<id>.adapter.json`, mode 0600, written atomically, at most once
  per 5 s and once on shutdown. An adapter that never served a request writes no final
  snapshot.
- Fields (counters and fixed values only): `version` (1), `generation`, `startedAt`,
  `updatedAt`, `route` (`client`, `upstream`), `restarts`, `requests` (per path),
  `unauthorized`, `upstreamStatus` (per class, `2xx` and so on), `errors` (per kind),
  `forbidden`, `clientDisconnects`, `shutdownAborts`, `dropped` (hints and hosted tools
  by name), `adjustments`, `compactionDropped`, `capabilityFallbacks`, `capabilities`
  (current values), `estimatedUsage`, `cacheReadTokens`, and `supervisor`
  (`restarts`, `lastReason`, `gaveUpAt` or `startFailed`, `at`).
- Ownership: every launch (create and reload) puts a random `generation` into the adapter
  block; the session record stores it as `adapterGeneration`. The adapter and supervisor
  write the file only while the session record exists and names their generation.
  Removal deletes the session record before the file, and a reload records the new
  generation before deleting the old snapshot, so a late write of an old process cannot
  recreate the file of a deleted session or overwrite a newer snapshot; a write that
  loses this race is taken back. The doctor ignores a snapshot of another generation.
- The doctor (`server/features/operations/adapter-doctor.js`) reads only whitelisted
  counter maps, ISO timestamps and fixed enums, and never writes. It reports running
  sessions and stopped sessions whose current snapshot records `startFailed` or
  `gaveUpAt` within the last 24 hours.

## Testing

- Golden fixtures: `tests/fixtures/protocol-adapter/` (requests recorded from the CLIs and
  synthesized upstream responses; its README lists every case), loaded with
  `tests/helpers/protocol-adapter.js`.
- Unit tests for the library: `tests/unit/protocol-adapter/`; property tests (SSE splits, translation directions and
  name maps): `tests/property/protocol-adapter-*.test.js`.
- Adapter process, launcher and restart behavior against scripted upstreams:
  `tests/integration/adapter-*.test.js` and `tests/helpers/scripted-upstream.js`.
- CLI smoke matrix (real installed CLIs, scripted loopback upstreams, temporary home and
  a dead proxy so nothing leaves the machine): `tests/matrix/adapter-cli-smoke.test.js`.
  Rows skip with the CLI's name when it is not installed; `AGENTPIER_SKIP_CLI_SMOKE=1`
  skips the matrix.
- nono: `tests/matrix/nono-adapter-loopback.test.js` (skips without nono).
- Browser: `tests/browser/endpoint-routing.spec.js`, `endpoint-route-labels.spec.js` and
  `operations-adapter-diagnostics.spec.js`. Run
  `CAPTURE_ADAPTER_SCREENSHOTS=1 AGENTPIER_TEST_BROWSER=chromium npx playwright test` on
  them to regenerate the documentation screenshots.

```sh
node scripts/test.mjs unit
node scripts/test.mjs integration
node scripts/test.mjs property
node scripts/test.mjs matrix
```
