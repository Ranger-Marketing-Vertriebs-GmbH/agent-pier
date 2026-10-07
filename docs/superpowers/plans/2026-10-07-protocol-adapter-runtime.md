# Protocol Adapter Runtime (PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the PR 1 protocol library as a per-session adapter process so Claude Code and Codex can use every custom endpoint protocol, switch OpenCode to its bundled SDK providers, and make routing, launch, the capability probe and the CLI smoke tests work end to end.

**Architecture:** The connection record gains `routing`, `adapterCapabilities`, `thinkTagExtraction` and per-model `images`; one pure module (`endpoint-routing.js`) resolves the route per CLI, and everything that offers or launches a CLI asks it. Adapter routes write a private `adapter` block into the one-use launch payload; `terminal-launcher.js` starts `server/adapter-process.js` (a detached child, configured over IPC, bound to `127.0.0.1:0`), substitutes the placeholder URL into the CLI's env and argv, restarts a crashed adapter on the same port (bounded), and stops the adapter with the CLI. `auto` routing offers adapter routes only after PR 3 flips `ADAPTER_AUTO_ROUTES`; PR 2 exercises them through explicit per-CLI choices. The adapter wraps the PR 1 translator per request (one exchange per HTTP request) and reaches the upstream through a streaming, policy-checked keep-alive client.

**Tech Stack:** Node.js 22.13+ ES modules, `node:http`/`node:https`, `node:child_process` IPC, `node:test` + `node:assert/strict`, fast-check (existing property helpers), smol-toml, real Claude Code / Codex / OpenCode / nono binaries in matrix tests (skipped when missing).

**Spec:** `docs/superpowers/specs/2026-10-07-protocol-adapter-design.md` (binding, including Amendments 1–15). Facts: `docs/research/protocol-adapter-facts.md`. PR 1 library: `server/features/protocol-adapter/` (read the JSDoc at the top of `translate.js` and `capabilities.js` before Task 8).

## Global Constraints

- Platforms macOS and Linux, Node.js 22.13+; no new npm dependency; a new runtime tool would need the installer and update path (none is planned).
- Every source and test file ≤ 600 lines (`npm run check:structure`); new server messages in **both** `server/lib/i18n/de/` and `server/lib/i18n/en/` with identical keys.
- Library protocol ids are `"messages" | "responses" | "chat"`; connection and route ids are `"messages" | "responses" | "chatCompletions"`. Convert only with `libraryProtocol()` (Task 2).
- Routing values (verbatim): `claude: "auto" | "native" | "adapter:responses" | "adapter:chatCompletions" | "off"`, `codex: "auto" | "native" | "adapter:messages" | "adapter:chatCompletions" | "off"`, `opencode: "auto" | "messages" | "responses" | "chatCompletions" | "off"`. `auto`: native if enabled; else Claude Code/Codex take the first enabled of Responses > Messages > Chat; OpenCode the first enabled of Chat > Responses > Messages. **PR 2 ships with `ADAPTER_AUTO_ROUTES = false`** (exported from `endpoint-routing.js`): `auto` then resolves only native and OpenCode SDK routes; explicit `adapter:*` choices set through the API still work. PR 3 flips the constant together with the "via adapter" labels (see "PR 3 hand-off" at the end).
- Adapter crash: the supervisor restarts it on the identical `127.0.0.1:<port>` with the same token and configuration, at most 3 restarts within 60 s; a failed rebind counts as a failed restart; after the budget is spent it gives up, records that in the diagnostics file, and the CLI keeps running.
- Model `images: boolean | null` (default `null`); existing records without the new fields behave as `auto` with default capabilities.
- Placeholder literal `__AGENTPIER_ADAPTER_URL__`, in CLI env values and argv only; persistent config files (Codex `config.toml`, OpenCode JSON) never contain the adapter URL, the session token or the upstream key on adapter routes.
- Session token: 32 random bytes (base64url), in `ANTHROPIC_AUTH_TOKEN` (Claude Code) or the Codex `env_key` variable; the custom auth header applies only to adapter → upstream.
- CLI env on adapter routes: `NO_PROXY` and `no_proxy` include `127.0.0.1,localhost`; Claude Code gets `CLAUDE_CODE_ATTRIBUTION_HEADER=0` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` from the model record; Codex gets `web_search = "disabled"` and `apply_patch_tool_type: "freeform"`.
- Adapter: loopback only (`127.0.0.1:0`), token via `x-api-key` or `Authorization: Bearer`, constant-time comparison, 401 without body echo; `HEAD /api/hello` → 200 empty without token; request body cap 32 MB; per-event cap 16 MB; no total cap on response streams; keep-alive every 15 s (Messages `event: ping`, Responses `event: response.in_progress` data event); upstream idle timeout 240 s; never writes to stdout/stderr.
- Launcher: signal handlers before the adapter starts; adapter bind timeout 10 s → sanitized one-line message and exit 127 without starting the CLI; stop = SIGTERM, then SIGKILL after 2 s.
- Upstream: only the configured origin, PR #176 address policy re-checked per new connection (no launch-time pinning), keep-alive agent, TLS verified on the hostname, no redirects, no `HTTPS_PROXY`; system CAs via `--use-system-ca` when the running Node accepts it, else `NODE_EXTRA_CA_CERTS` passed through.
- Per HTTP request: one random, unique `requestId` and one `exchange` from `translator.buildUpstream`. Capability retry: once, only for upstream 400/422 that `capabilityForError` maps to a different value; kept for the session only if the retry succeeds, otherwise the previous value is restored.
- Diagnostics: private file (mode 0600), written at most once per 5 s (plus one final flush on shutdown), counters and error kinds only — never prompt, completion, key or token content; compaction drops (`dropped["input.compaction"]`) are surfaced as `compactionDropped`.
- Transport errors carry `adapterKind` (`"timeout"` for the idle timer, `"network"` for client disconnects and socket failures) so `classifyTransportError` never reports a client disconnect as a timeout.
- Out of scope (PR 3): UI, `doctor`, `docs/providers.md`, `docs/research/provider-compatibility.md`. PR 2 ships only what the server API needs.
- Tests: `node:test` with strict assertions; backend tests `*.test.js`; never the default tmux server or real user sessions; real-CLI and nono tests skip with a clear message when the binary is missing.
- Commits: English, concise imperative prefixes (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on `feat/protocol-adapter-runtime` in `.worktrees/`; never push to `main`.

## Review Focus

1. **Saving a connection from today's UI** (its `endpointPayload` sends no `routing`, `adapterCapabilities`, `thinkTagExtraction` or model `images`) must keep the stored values instead of resetting them to `auto`/defaults. → test in Task 2.
2. **Ctrl+C in the TUI** (SIGINT to the terminal's foreground process group) must not kill the adapter; the CLI keeps reaching it afterwards. → test in Task 11.
3. **Pipeline profiles frozen before PR 2** (snapshot without `route`) must keep launching while their CLI's resolved route is still native, and must fail with `providerConfigurationChanged` once the route changes. → test in Task 3.
4. **Concurrent requests in one session** (Claude Code main agent + subagent; Codex turn + title): a client disconnect or a capability retry on one request must not break the other stream. → test in Task 8 (disconnect) and Task 9 (retry).
5. **Multi-day sessions whose upstream DNS changes**: a new upstream connection re-resolves and re-checks the address policy; a host that now resolves to a forbidden address fails with a client-format network error, not a crash or a silent connection. → test in Task 7.

---

## File Structure

**Create**

| File                                                                                                                                                                                                                                                                                                                                                                                          | Responsibility                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/features/providers/endpoint-routing.js`                                                                                                                                                                                                                                                                                                                                               | Routing values, validation of `routing`/`adapterCapabilities`, `resolveRoute`, `toolRoutes`, `routeBaseUrl`, `libraryProtocol`, `adapterCapabilitiesFor`, `adapterReasoning` (pure) |
| `server/features/providers/adapter-launch.js`                                                                                                                                                                                                                                                                                                                                                 | Placeholder constant, session token, `NO_PROXY` helper, payload `adapter` block builder                                                                                             |
| `server/features/providers/endpoint-stream.js`                                                                                                                                                                                                                                                                                                                                                | Streaming upstream client: keep-alive agent with policy lookup, idle timeout, abort, capped `text()`                                                                                |
| `server/features/providers/endpoint-capability-probe.js`                                                                                                                                                                                                                                                                                                                                      | Extra probe requests per optional parameter; proposes capability values                                                                                                             |
| `server/features/adapter-runtime/adapter-config.js`                                                                                                                                                                                                                                                                                                                                           | `validateAdapterConfig` (shared by session creation and the adapter process)                                                                                                        |
| `server/features/adapter-runtime/adapter-http.js`                                                                                                                                                                                                                                                                                                                                             | Token check, path routing, body reading, rendering helpers                                                                                                                          |
| `server/features/adapter-runtime/adapter-request.js`                                                                                                                                                                                                                                                                                                                                          | One inference request: build, send, error/stream/JSON, keep-alives, disconnect                                                                                                      |
| `server/features/adapter-runtime/adapter-retry.js`                                                                                                                                                                                                                                                                                                                                            | 400/422 → capability retry with keep/restore                                                                                                                                        |
| `server/features/adapter-runtime/adapter-counters.js`                                                                                                                                                                                                                                                                                                                                         | Adapter-side counters                                                                                                                                                               |
| `server/features/adapter-runtime/adapter-diagnostics.js`                                                                                                                                                                                                                                                                                                                                      | Throttled atomic diagnostics writer                                                                                                                                                 |
| `server/features/adapter-runtime/adapter-server.js`                                                                                                                                                                                                                                                                                                                                           | `createAdapterServer`: translator, upstream client, HTTP server, snapshot, close                                                                                                    |
| `server/features/adapter-runtime/adapter-supervisor.js`                                                                                                                                                                                                                                                                                                                                       | Launcher side: `startAdapter`, `substituteAdapterUrl`, exec args, minimal env                                                                                                       |
| `server/adapter-process.js`                                                                                                                                                                                                                                                                                                                                                                   | Entry point (release root): IPC handshake, signals, parent-death exit                                                                                                               |
| `tests/helpers/scripted-upstream.js`                                                                                                                                                                                                                                                                                                                                                          | Scripted HTTP upstream (SSE/JSON, delays, hangs) for adapter tests                                                                                                                  |
| `tests/helpers/adapter-fixture.js`                                                                                                                                                                                                                                                                                                                                                            | Adapter config/fetch helpers shared by integration tests                                                                                                                            |
| `tests/helpers/fake-cli.mjs`                                                                                                                                                                                                                                                                                                                                                                  | Fake CLI for launcher/blackbox tests (dumps env/argv, calls the adapter)                                                                                                            |
| `tests/unit/endpoint-routing.test.js`, `tests/unit/adapter-config.test.js`, `tests/unit/adapter-diagnostics.test.js`, `tests/unit/protocol-adapter/translate-diagnostics.test.js`                                                                                                                                                                                                             | Unit tests                                                                                                                                                                          |
| `tests/integration/endpoint-stream.test.js`, `tests/integration/adapter-server.test.js`, `tests/integration/adapter-server-streams.test.js`, `tests/integration/adapter-retry.test.js`, `tests/integration/adapter-process.test.js`, `tests/integration/adapter-launcher.test.js`, `tests/integration/session-adapter-payload.test.js`, `tests/integration/endpoint-capability-probe.test.js` | Integration tests                                                                                                                                                                   |
| `tests/blackbox/endpoint-adapter-session.test.js`                                                                                                                                                                                                                                                                                                                                             | Real lifecycle → tmux → launcher → adapter → fake upstream                                                                                                                          |
| `tests/matrix/endpoint-adapter-launch.test.js`, `tests/matrix/adapter-cli-smoke.test.js`, `tests/matrix/nono-adapter-loopback.test.js`                                                                                                                                                                                                                                                        | Matrix tests                                                                                                                                                                        |

**Modify**

| File                                                                                                                                                                                                                                                                                               | Change                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/research/protocol-adapter-facts.md`                                                                                                                                                                                                                                                          | New §6 "Runtime facts (PR 2)"                                                                                                                  |
| `server/features/providers/endpoint-config.js`                                                                                                                                                                                                                                                     | New block/model keys, defaults, `inheritAdapterSettings`, `endpointTools` from routes, `endpointModel` adds `images`, remove `endpointBaseUrl` |
| `server/features/providers/endpoint-address.js`                                                                                                                                                                                                                                                    | Extract `assertAllowedAddresses`, add `policyLookup`                                                                                           |
| `server/features/providers/endpoint-models.js`                                                                                                                                                                                                                                                     | `mergeModels` keeps `images`                                                                                                                   |
| `server/features/providers/provider-connections.js`                                                                                                                                                                                                                                                | `toolRoutes` in the public view; `update` inherits omitted adapter settings                                                                    |
| `server/features/providers/launch-description.js`                                                                                                                                                                                                                                                  | `route` in `launchTarget`/`launchDescription`                                                                                                  |
| `server/features/providers/provider-environment.js`                                                                                                                                                                                                                                                | Adapter-route environment (`adapterToken` option)                                                                                              |
| `server/features/providers/provider-launch.js`                                                                                                                                                                                                                                                     | Token, `adapter` block, `provider.route`, Claude/Codex adapter wiring                                                                          |
| `server/features/providers/endpoint-launch.js`                                                                                                                                                                                                                                                     | Codex adapter config (`-c` only base URL), OpenCode SDK routes                                                                                 |
| `server/features/providers/native-config.js`                                                                                                                                                                                                                                                       | `codexModelCatalog` `images` option                                                                                                            |
| `server/features/providers/endpoint-probe.js`                                                                                                                                                                                                                                                      | Calls the capability probe; result gains `capabilities`                                                                                        |
| `server/features/accounts/account-store.js`                                                                                                                                                                                                                                                        | `verifyEndpointTarget` uses the route base URL                                                                                                 |
| `server/features/pipelines/profile-validation.js`, `server/features/pipelines/native-profile.js`                                                                                                                                                                                                   | Snapshot `route`; legacy snapshot compatibility                                                                                                |
| `server/features/sessions/provider-configuration.js`                                                                                                                                                                                                                                               | Persist `route`                                                                                                                                |
| `server/features/sessions/session-creation.js`, `session-replacement.js`, `session-removal.js`                                                                                                                                                                                                     | Payload `adapter` block, diagnostics path, cleanup                                                                                             |
| `server/features/protocol-adapter/translate.js`                                                                                                                                                                                                                                                    | `diagnostics().cacheReadTokens`                                                                                                                |
| `server/terminal-launcher.js`                                                                                                                                                                                                                                                                      | Adapter start, substitution, signals, shutdown                                                                                                 |
| `server/features/nono/nono-launch.js`                                                                                                                                                                                                                                                              | Only if Task 1 fact R1b requires `--open-port` (Task 15)                                                                                       |
| `server/lib/i18n/{de,en}/providers.js`, `server/lib/i18n/{de,en}/sessions.js`                                                                                                                                                                                                                      | New messages                                                                                                                                   |
| `docs/architecture.md`                                                                                                                                                                                                                                                                             | List `server/adapter-process.js` among stable entry points                                                                                     |
| Existing tests: `tests/unit/endpoint-config.test.js`, `tests/integration/provider-connections.test.js`, `tests/integration/endpoint-pipeline-snapshot.test.js`, `tests/matrix/endpoint-launch.test.js`, `tests/integration/release-references.test.js`, `tests/integration/endpoint-probe.test.js` | Extended                                                                                                                                       |

---

### Task 1: Verify the runtime facts PR 2 depends on

**Files:**

- Modify: `docs/research/protocol-adapter-facts.md` (append §6)
- Scratch only (never committed): `$SCRATCH/capture.mjs`, `$SCRATCH/loopback.mjs` where `SCRATCH=$(mktemp -d)`

**Interfaces:**

- Consumes: installed `claude`, `codex`, `opencode`, `nono`; fixtures `tests/fixtures/protocol-adapter/upstreams/{messages,responses}/text.sse`.
- Produces: facts **R1a/R1b** (nono loopback), **R2** (Claude Code env), **R3a/R3b** (Codex `-c` override, `config.toml` without `base_url`), **R4a/R4b** (OpenCode `@ai-sdk/anthropic`/`@ai-sdk/openai` paths and auth), **R5** (`--use-system-ca`). Tasks 4, 5, 10, 14 and 15 cite them by id.

- [ ] **Step 1: Write the capture server (scratch)**

```js
// $SCRATCH/capture.mjs — node capture.mjs <fixture.sse> ; prints PORT=<n>, logs one JSON line per request to stderr
import http from "node:http";
import fs from "node:fs";
const sse = fs.readFileSync(process.argv[2], "utf8");
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {}
    const auth = request.headers.authorization?.split(" ")[0] ?? null;
    console.error(
      JSON.stringify({
        method: request.method,
        url: request.url,
        auth,
        apiKeyHeader: "x-api-key" in request.headers,
        bodyKeys: parsed ? Object.keys(parsed) : null,
        maxTokens: parsed?.max_tokens ?? null,
        systemHead: JSON.stringify(parsed?.system ?? null).slice(0, 120),
        tools: Array.isArray(parsed?.tools)
          ? parsed.tools.map((t) => t.name ?? t.type)
          : null,
      }),
    );
    if (request.method !== "POST") return response.writeHead(200).end();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse);
  });
});
server.listen(0, "127.0.0.1", () => console.log(`PORT=${server.address().port}`));
```

- [ ] **Step 2: R2 — Claude Code against a loopback URL**

Run (fresh temp `HOME`/`CLAUDE_CONFIG_DIR`; `HTTPS_PROXY` points at a dead port to prove `NO_PROXY` bypass):

```bash
node $SCRATCH/capture.mjs tests/fixtures/protocol-adapter/upstreams/messages/text.sse &
# use the printed port as $PORT
env -i PATH="$PATH" HOME="$SCRATCH/home" CLAUDE_CONFIG_DIR="$SCRATCH/claude" \
  ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" ANTHROPIC_AUTH_TOKEN=session-token \
  ANTHROPIC_MODEL=custom-model-x CLAUDE_CODE_ATTRIBUTION_HEADER=0 \
  CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096 CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
  HTTPS_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost \
  claude -p "say ok"
```

Expected and recorded: `POST /v1/messages?beta=true`, `auth: "Bearer"`, no `x-api-key`, `maxTokens: 4096`, `systemHead` without `x-anthropic-billing-header`, CLI prints the fixture text, nothing went to the proxy.

- [ ] **Step 3: R3a/R3b — Codex with a `-c` provider override and a `config.toml` without `base_url`**

Write `$SCRATCH/codex/config.toml` containing `model_provider = "agentpier-endpoint"` and `[model_providers.agentpier-endpoint]` with `name`, `wire_api = "responses"`, `requires_openai_auth = false`, `env_key = "AGENTPIER_ENDPOINT_API_KEY"` and **no** `base_url`. Run with the Responses fixture:

```bash
env -i PATH="$PATH" HOME="$SCRATCH/home" CODEX_HOME="$SCRATCH/codex" \
  AGENTPIER_ENDPOINT_API_KEY=session-token NO_PROXY=127.0.0.1,localhost \
  codex exec --skip-git-repo-check \
  -c 'model_providers={agentpier-endpoint={name="Fixture",wire_api="responses",requires_openai_auth=false,env_key="AGENTPIER_ENDPOINT_API_KEY",base_url="http://127.0.0.1:'"$PORT"'/v1"}}' \
  -c 'model_provider="agentpier-endpoint"' -c 'web_search="disabled"' --model fixture-model "say ok"
```

Expected: `POST /v1/responses`, `auth: "Bearer"`, `tools` without `web_search`. Then run once **without** the `-c model_providers=…` argument: R3b records whether Codex accepts the `config.toml` provider without `base_url` (expected: accepted, requests go to the default OpenAI origin and fail — run with `HTTPS_PROXY` dead so nothing leaves the machine).

- [ ] **Step 4: R4a/R4b — OpenCode SDK providers**

With `XDG_CONFIG_HOME="$SCRATCH/oc/config"` etc. and `OPENCODE_CONFIG_CONTENT` set to a config whose provider `agentpier-endpoint` uses `npm: "@ai-sdk/anthropic"`, `options.baseURL: "http://127.0.0.1:$PORT/v1"`, run `opencode run --model agentpier-endpoint/fixture-model "say ok"` once with `options.authToken: "{env:AGENTPIER_ENDPOINT_API_KEY}"` and once with `options.apiKey: "{env:AGENTPIER_ENDPOINT_API_KEY}"` (Messages fixture). Repeat with `npm: "@ai-sdk/openai"`, `options.apiKey`, Responses fixture. Record path (`/v1/messages`, `/v1/responses`), auth header kind (`Bearer` vs `x-api-key`) per option, and any extra startup requests (e.g. `/v1/models`).

- [ ] **Step 5: R1a/R1b — nono loopback**

```js
// $SCRATCH/loopback.mjs — node loopback.mjs <profile> [extra nono args with PORT placeholder]
import http from "node:http";
import { spawn } from "node:child_process";
const server = http
  .createServer((q, r) => r.end("pong"))
  .listen(0, "127.0.0.1", () => {
    const port = String(server.address().port);
    const extra = process.argv.slice(3).map((a) => a.replaceAll("PORT", port));
    const child = spawn(
      "nono",
      [
        "wrap",
        "-p",
        process.argv[2],
        "--allow-cwd",
        ...extra,
        "--",
        process.execPath,
        "-e",
        `fetch("http://127.0.0.1:${port}/").then(r=>r.text()).then(t=>console.log(t),e=>console.log("DENIED",e.cause?.code))`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      console.log("exit", code, out.trim().slice(0, 300));
      server.close();
    });
  });
```

Run from a directory under the repository's `.cache/` (nono refuses grants overlapping its state root; see `tests/matrix/nono-confinement.test.js`): (a) `node loopback.mjs default`; (b) a profile JSON copied from `nono-confinement.test.js`'s `restrictive` with `network: { block: true }`, once plain and once with `--open-port PORT`. Record R1a (default profile reaches loopback: expected `pong`) and R1b (block-net result, and whether `--open-port` restores loopback on this platform).

- [ ] **Step 6: R5 — system CA flag**

Run: `node -p 'process.allowedNodeEnvironmentFlags.has("--use-system-ca")'` on the installed Node and note the documented first versions (v23.8.0, backported to v22.15.0). Expected here (22.22.2): `true`. Consequence: 22.13–22.14 fall back to `NODE_EXTRA_CA_CERTS`.

- [ ] **Step 7: Record §6 in the facts file**

Append `## 6. Runtime facts (PR 2)` with one subsection per id (R1a…R5), each with **Value**, **Source** (command + CLI version), **Consequence** (task that relies on it). Where a result contradicts this plan, write the correction under "Consequence" and apply it in the named task: R3b rejected → Task 5 writes no `model_providers`/`model_provider` keys to `config.toml` for adapter routes (extend `writeTomlConfig(file, additions, { remove })`); R4a shows `authToken` is not passed through → Task 4 uses `apiKey` for `@ai-sdk/anthropic`; R1b shows block-net denies loopback → Task 15 Step 3 applies.

- [ ] **Step 8: Commit**

```bash
git add docs/research/protocol-adapter-facts.md
git commit -m "docs: record runtime facts for the protocol adapter launch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Routing model in the connection record

**Files:**

- Create: `server/features/providers/endpoint-routing.js`
- Modify: `server/features/providers/endpoint-config.js`, `server/features/providers/endpoint-models.js:167-193`, `server/features/providers/provider-connections.js:96-123,162-196`, `server/lib/i18n/de/providers.js`, `server/lib/i18n/en/providers.js`
- Test: `tests/unit/endpoint-routing.test.js` (new), `tests/unit/endpoint-config.test.js`, `tests/integration/provider-connections.test.js`

**Interfaces:**

- Consumes: `assertCapability` from `server/features/protocol-adapter/capabilities.js`; `TOOL_PROTOCOL` from `provider-definitions.js`.
- Produces (all exported from `endpoint-routing.js`):
  - `ROUTE_CHOICES: { claude: string[], codex: string[], opencode: string[] }`, `DEFAULT_ROUTING = { claude: "auto", codex: "auto", opencode: "auto" }`, `PROTOCOLS = ["messages", "responses", "chatCompletions"]`
  - `validateRouting(value) → { claude, codex, opencode }` (undefined → defaults; throws `problem(messages.invalidEndpointRouting)`)
  - `validateAdapterCapabilities(value) → { messages?, responses?, chatCompletions? }` (unknown capability names dropped; invalid values throw `problem(messages.invalidEndpointCapabilities)`)
  - `ADAPTER_AUTO_ROUTES = false` (PR 3 sets it to `true`)
  - `resolveRoute(endpoint, tool, { adapterAuto = ADAPTER_AUTO_ROUTES } = {}) → { mode: "native" | "adapter" | "sdk", source: "messages" | "responses" | "chatCompletions" } | null` (the option exists so tests can prove the flag flip; production callers never pass it)
  - `toolRoutes(endpoint) → { claude: Route|null, codex: Route|null, opencode: Route|null }`
  - `routeBaseUrl(endpoint, route) → string | null` (messages → `anthropicBaseUrl`, else `openaiBaseUrl`)
  - `libraryProtocol(source) → "messages" | "responses" | "chat"`
  - `adapterCapabilitiesFor(endpoint, source) → object` (stored values for that source, `{}` when none)
  - `adapterReasoning(endpoint, source) → boolean` (messages → true; else the resolved `reasoningEffort` capability)
- Produces in `endpoint-config.js`: `validateEndpoint` returns `routing`, `adapterCapabilities`, `thinkTagExtraction`, models with `images`; `inheritAdapterSettings(input, stored) → input'`; `endpointTools(endpoint)` = tools whose `resolveRoute` is non-null; `endpointModel(...)` adds `images`; `endpointBaseUrl` removed (callers move to `routeBaseUrl` in Task 3).
- Produces in `provider-connections.js`: public endpoint view gains `toolRoutes`.

OpenCode route modes: `chatCompletions` → `mode: "native"` (the PR #176 `@ai-sdk/openai-compatible` path), `messages`/`responses` → `mode: "sdk"`.

- [ ] **Step 1: Write the failing routing unit tests**

```js
// tests/unit/endpoint-routing.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTER_AUTO_ROUTES,
  resolveRoute,
  toolRoutes,
  validateRouting,
  validateAdapterCapabilities,
  libraryProtocol,
  routeBaseUrl,
  adapterReasoning,
} from "../../server/features/providers/endpoint-routing.js";

const endpoint = (protocols, routing, extra = {}) => ({
  openaiBaseUrl: "https://llm.example/v1",
  anthropicBaseUrl: protocols.messages ? "https://llm.example" : null,
  protocols: { messages: false, responses: false, chatCompletions: false, ...protocols },
  routing: { claude: "auto", codex: "auto", opencode: "auto", ...routing },
  adapterCapabilities: {},
  ...extra,
});

test("PR 2 default: auto resolves native routes only", () => {
  assert.equal(ADAPTER_AUTO_ROUTES, false);
  const all = endpoint({ messages: true, responses: true, chatCompletions: true });
  assert.deepEqual(resolveRoute(all, "claude"), { mode: "native", source: "messages" });
  assert.deepEqual(resolveRoute(all, "codex"), { mode: "native", source: "responses" });
  const chat = endpoint({ chatCompletions: true });
  assert.equal(resolveRoute(chat, "claude"), null);
  assert.equal(resolveRoute(chat, "codex"), null);
  assert.deepEqual(resolveRoute(chat, "opencode"), {
    mode: "native",
    source: "chatCompletions",
  });
});

test("explicit adapter routes work while auto adapter routes are off", () => {
  const chat = endpoint(
    { chatCompletions: true },
    { claude: "adapter:chatCompletions", codex: "adapter:chatCompletions" },
  );
  assert.deepEqual(resolveRoute(chat, "claude"), {
    mode: "adapter",
    source: "chatCompletions",
  });
  assert.deepEqual(resolveRoute(chat, "codex"), {
    mode: "adapter",
    source: "chatCompletions",
  });
});

test("flipping the flag (PR 3) makes auto fall back to Responses > Messages > Chat", () => {
  const on = { adapterAuto: true };
  const chat = endpoint({ chatCompletions: true });
  assert.deepEqual(resolveRoute(chat, "claude", on), {
    mode: "adapter",
    source: "chatCompletions",
  });
  assert.deepEqual(resolveRoute(chat, "codex", on), {
    mode: "adapter",
    source: "chatCompletions",
  });
  const responsesOnly = endpoint({ responses: true, chatCompletions: true });
  assert.deepEqual(resolveRoute(responsesOnly, "claude", on), {
    mode: "adapter",
    source: "responses",
  });
  const messagesOnly = endpoint({ messages: true, chatCompletions: true });
  assert.deepEqual(resolveRoute(messagesOnly, "codex", on), {
    mode: "adapter",
    source: "messages",
  });
  const all = endpoint({ messages: true, responses: true, chatCompletions: true });
  assert.deepEqual(resolveRoute(all, "claude", on), {
    mode: "native",
    source: "messages",
  });
});

test("OpenCode auto takes Chat > Responses > Messages through its SDK providers", () => {
  assert.deepEqual(
    resolveRoute(endpoint({ chatCompletions: true, responses: true }), "opencode"),
    { mode: "native", source: "chatCompletions" },
  );
  assert.deepEqual(
    resolveRoute(endpoint({ responses: true, messages: true }), "opencode"),
    { mode: "sdk", source: "responses" },
  );
  assert.deepEqual(resolveRoute(endpoint({ messages: true }), "opencode"), {
    mode: "sdk",
    source: "messages",
  });
});

test("explicit routes resolve only when their source is enabled; off disables the CLI", () => {
  const e = endpoint(
    { chatCompletions: true },
    { claude: "adapter:responses", codex: "off" },
  );
  assert.equal(resolveRoute(e, "claude"), null);
  assert.equal(resolveRoute(e, "codex"), null);
  assert.deepEqual(toolRoutes(e).opencode, { mode: "native", source: "chatCompletions" });
  assert.equal(
    resolveRoute(endpoint({ chatCompletions: true }, { claude: "native" }), "claude"),
    null,
  );
});

test("records without routing behave as auto", () => {
  const legacy = endpoint({ chatCompletions: true, responses: true });
  delete legacy.routing;
  assert.deepEqual(resolveRoute(legacy, "codex"), {
    mode: "native",
    source: "responses",
  });
  assert.equal(resolveRoute(legacy, "claude"), null);
  assert.deepEqual(resolveRoute(legacy, "claude", { adapterAuto: true }), {
    mode: "adapter",
    source: "responses",
  });
});

test("validation rejects unknown values and native sources as adapter sources", () => {
  assert.deepEqual(validateRouting(undefined), {
    claude: "auto",
    codex: "auto",
    opencode: "auto",
  });
  for (const routing of [
    { claude: "adapter:messages" },
    { codex: "adapter:responses" },
    { opencode: "native" },
    { claude: "auto", extra: "auto" },
    { claude: 1 },
    [],
  ])
    assert.throws(() => validateRouting(routing), { status: 400 });
});

test("capabilities: unknown names dropped, invalid values rejected, chat id mapped", () => {
  assert.deepEqual(
    validateAdapterCapabilities({
      chatCompletions: { maxTokensField: "max_completion_tokens", future: 1 },
    }),
    { chatCompletions: { maxTokensField: "max_completion_tokens" } },
  );
  assert.throws(
    () => validateAdapterCapabilities({ chatCompletions: { streamUsage: "yes" } }),
    { status: 400 },
  );
  assert.throws(() => validateAdapterCapabilities({ gemini: {} }), { status: 400 });
  assert.equal(libraryProtocol("chatCompletions"), "chat");
  assert.equal(libraryProtocol("messages"), "messages");
});

test("route base URL and reasoning support follow the source", () => {
  const e = endpoint(
    { messages: true, chatCompletions: true },
    {},
    {
      adapterCapabilities: { chatCompletions: { reasoningEffort: true } },
    },
  );
  assert.equal(
    routeBaseUrl(e, { mode: "adapter", source: "messages" }),
    "https://llm.example",
  );
  assert.equal(
    routeBaseUrl(e, { mode: "adapter", source: "chatCompletions" }),
    "https://llm.example/v1",
  );
  assert.equal(adapterReasoning(e, "messages"), true);
  assert.equal(adapterReasoning(e, "chatCompletions"), true);
  assert.equal(adapterReasoning(endpoint({ responses: true }), "responses"), true);
  assert.equal(
    adapterReasoning(endpoint({ chatCompletions: true }), "chatCompletions"),
    false,
  );
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/unit/endpoint-routing.test.js`
Expected: FAIL with `Cannot find module …/endpoint-routing.js`.

- [ ] **Step 3: Implement `endpoint-routing.js`**

```js
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import {
  assertCapability,
  CAPABILITY_DEFAULTS,
  resolveCapabilities,
} from "../protocol-adapter/capabilities.js";
import { TOOL_PROTOCOL } from "./provider-definitions.js";

const messages = serverMessages.providers;
export const PROTOCOLS = Object.freeze(["messages", "responses", "chatCompletions"]);
export const ROUTE_CHOICES = Object.freeze({
  claude: ["auto", "native", "adapter:responses", "adapter:chatCompletions", "off"],
  codex: ["auto", "native", "adapter:messages", "adapter:chatCompletions", "off"],
  opencode: ["auto", "messages", "responses", "chatCompletions", "off"],
});
export const DEFAULT_ROUTING = Object.freeze({
  claude: "auto",
  codex: "auto",
  opencode: "auto",
});
/**
 * Whether `auto` may fall back to an adapter route. Off until PR 3 ships the "via adapter"
 * labels, so existing connections do not silently start offering translated CLIs.
 * Explicit `adapter:*` choices work regardless.
 */
export const ADAPTER_AUTO_ROUTES = false;
const ADAPTER_ORDER = ["responses", "messages", "chatCompletions"];
const OPENCODE_ORDER = ["chatCompletions", "responses", "messages"];
const LIBRARY = Object.freeze({
  messages: "messages",
  responses: "responses",
  chatCompletions: "chat",
});
const plainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

export const libraryProtocol = (source) => LIBRARY[source];

export function validateRouting(value) {
  if (value === undefined || value === null) return { ...DEFAULT_ROUTING };
  if (
    !plainObject(value) ||
    Object.keys(value).some((tool) => !Object.hasOwn(ROUTE_CHOICES, tool))
  )
    throw problem(messages.invalidEndpointRouting);
  const routing = { ...DEFAULT_ROUTING, ...value };
  for (const [tool, choice] of Object.entries(routing))
    if (!ROUTE_CHOICES[tool].includes(choice))
      throw problem(messages.invalidEndpointRouting);
  return routing;
}

export function validateAdapterCapabilities(value) {
  if (value === undefined || value === null) return {};
  if (!plainObject(value) || Object.keys(value).some((key) => !PROTOCOLS.includes(key)))
    throw problem(messages.invalidEndpointCapabilities);
  const result = {};
  for (const [source, given] of Object.entries(value)) {
    if (!plainObject(given)) throw problem(messages.invalidEndpointCapabilities);
    const upstream = LIBRARY[source];
    const kept = {};
    for (const [name, setting] of Object.entries(given)) {
      if (!Object.hasOwn(CAPABILITY_DEFAULTS[upstream], name)) continue; // unknown → ignored
      try {
        assertCapability(upstream, name, setting);
      } catch {
        throw problem(messages.invalidEndpointCapabilities);
      }
      kept[name] = setting;
    }
    result[source] = kept;
  }
  return result;
}

const enabled = (endpoint, source) =>
  endpoint.protocols?.[source] === true &&
  (source !== "messages" || !!endpoint.anthropicBaseUrl) &&
  (source === "messages" || !!endpoint.openaiBaseUrl);

export function resolveRoute(endpoint, tool, { adapterAuto = ADAPTER_AUTO_ROUTES } = {}) {
  const choice = endpoint?.routing?.[tool] ?? "auto";
  if (choice === "off" || !Object.hasOwn(ROUTE_CHOICES, tool)) return null;
  if (tool === "opencode") {
    const source =
      choice === "auto" ? OPENCODE_ORDER.find((s) => enabled(endpoint, s)) : choice;
    if (!source || !enabled(endpoint, source)) return null;
    return { mode: source === "chatCompletions" ? "native" : "sdk", source };
  }
  const native = TOOL_PROTOCOL[tool];
  if (choice === "native" || choice === "auto") {
    if (enabled(endpoint, native)) return { mode: "native", source: native };
    if (choice === "native" || !adapterAuto) return null;
    const source = ADAPTER_ORDER.find((s) => s !== native && enabled(endpoint, s));
    return source ? { mode: "adapter", source } : null;
  }
  const source = choice.slice("adapter:".length);
  return enabled(endpoint, source) ? { mode: "adapter", source } : null;
}

export const toolRoutes = (endpoint) =>
  Object.fromEntries(
    ["claude", "codex", "opencode"].map((tool) => [tool, resolveRoute(endpoint, tool)]),
  );

export const routeBaseUrl = (endpoint, route) =>
  !route
    ? null
    : route.source === "messages"
      ? endpoint.anthropicBaseUrl || null
      : endpoint.openaiBaseUrl || null;

export const adapterCapabilitiesFor = (endpoint, source) => ({
  ...(endpoint.adapterCapabilities?.[source] ?? {}),
});

export function adapterReasoning(endpoint, source) {
  if (source === "messages") return true;
  return (
    resolveCapabilities(LIBRARY[source], adapterCapabilitiesFor(endpoint, source))
      .reasoningEffort === true
  );
}
```

Add to both catalogs (`server/lib/i18n/de/providers.js`, `server/lib/i18n/en/providers.js`):

- `invalidEndpointRouting`: de "Die CLI-Zuordnung der Verbindung ist ungültig." / en "The connection's CLI routing is invalid."
- `invalidEndpointCapabilities`: de "Die Adapter-Fähigkeiten der Verbindung sind ungültig." / en "The connection's adapter capabilities are invalid."

- [ ] **Step 4: Run the routing tests**

Run: `node --test tests/unit/endpoint-routing.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing endpoint-config and connection tests**

Add to `tests/unit/endpoint-config.test.js`:

```js
test("validateEndpoint fills routing defaults and keeps adapter settings", () => {
  const block = validateEndpoint({ ...base(), models: [{ ...model(), images: true }] });
  assert.deepEqual(block.routing, { claude: "auto", codex: "auto", opencode: "auto" });
  assert.deepEqual(block.adapterCapabilities, {});
  assert.equal(block.thinkTagExtraction, false);
  assert.equal(block.models[0].images, true);
  assert.equal(validateEndpoint(base()).models[0].images, null);
  assert.throws(() => validateEndpoint({ ...base(), thinkTagExtraction: "yes" }), {
    status: 400,
  });
  assert.throws(
    () => validateEndpoint({ ...base(), models: [{ ...model(), images: "x" }] }),
    { status: 400 },
  );
});

test("endpointTools follows the resolved routes", () => {
  const protocols = { messages: false, responses: false, chatCompletions: true };
  const chatOnly = validateEndpoint({ ...base(), protocols });
  assert.deepEqual(
    endpointTools(chatOnly),
    ["opencode"],
    "auto offers no adapter routes in PR 2",
  );
  const explicit = validateEndpoint({
    ...base(),
    protocols,
    routing: { claude: "adapter:chatCompletions" },
  });
  assert.deepEqual(endpointTools(explicit), ["claude", "opencode"]);
  const off = validateEndpoint({
    ...base(),
    protocols,
    routing: { claude: "adapter:chatCompletions", opencode: "off" },
  });
  assert.deepEqual(endpointTools(off), ["claude"]);
});
```

(`base()`/`model()` are the file's existing block and model factories; add them if absent, mirroring `endpointBlock` in `tests/matrix/endpoint-launch.test.js`.)

Add to `tests/integration/provider-connections.test.js` (Review Focus 1):

```js
test("updates from a client without adapter fields keep the stored routing, capabilities and images", (t) => {
  const connections = fixtureConnections(t); // the file's existing ProviderConnections factory
  const created = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: {
      ...endpointInput(),
      routing: { claude: "adapter:chatCompletions", codex: "off" },
      adapterCapabilities: {
        chatCompletions: { maxTokensField: "max_completion_tokens" },
      },
      thinkTagExtraction: true,
      models: endpointInput().models.map((m) => ({ ...m, images: true })),
    },
  });
  const legacyPayload = { ...endpointInput() }; // today's endpointPayload shape: no adapter fields
  const updated = connections.update(created.id, { endpoint: legacyPayload });
  assert.deepEqual(updated.endpoint.routing, {
    claude: "adapter:chatCompletions",
    codex: "off",
    opencode: "auto",
  });
  assert.deepEqual(updated.endpoint.adapterCapabilities, {
    chatCompletions: { maxTokensField: "max_completion_tokens" },
  });
  assert.equal(updated.endpoint.thinkTagExtraction, true);
  assert.equal(updated.endpoint.models[0].images, true);
  assert.deepEqual(updated.toolRoutes.codex, null);
  assert.deepEqual(updated.toolRoutes.claude, {
    mode: "adapter",
    source: "chatCompletions",
  });
});

test("stored records without adapter fields load as auto and gain toolRoutes", (t) => {
  // write provider-connections.json by hand with a PR #176 record (no routing/images, Chat only), then
  // construct ProviderConnections and assert get(id).endpoint.routing is all "auto",
  // models[*].images === null, toolRoutes is { claude: null, codex: null, opencode: native chat }
  // (tools unchanged from PR #176), and the file on disk is untouched until the next save.
});
```

Write the second test fully in the file's style (it already has a helper that writes raw records for the "invalid record" tests; reuse it).

- [ ] **Step 6: Run to verify they fail**

Run: `node --test tests/unit/endpoint-config.test.js tests/integration/provider-connections.test.js`
Expected: FAIL (`routing` undefined, `images` rejected as unknown model key, `toolRoutes` undefined).

- [ ] **Step 7: Implement the record changes**

In `endpoint-config.js`:

- `BLOCK_KEYS` += `"routing"`, `"adapterCapabilities"`, `"thinkTagExtraction"`; `MODEL_KEYS` += `"images"`.
- `model(value)`: reject `images` unless `undefined`, `null` or boolean; return `images: value.images ?? null`.
- `validateEndpoint`: reject `thinkTagExtraction` unless `undefined` or boolean; return `routing: validateRouting(input.routing)`, `adapterCapabilities: validateAdapterCapabilities(input.adapterCapabilities)`, `thinkTagExtraction: input.thinkTagExtraction === true`.
- `endpointTools(endpoint)` → `["codex", "claude", "opencode"].filter((tool) => resolveRoute(endpoint, tool))` (keep the order the UI already shows).
- `endpointModel(...)`: keep its checks (it already calls `endpointTools`), add `images: found.images ?? null`.
- Keep `endpointBaseUrl` for now; Task 3 moves its two callers (`account-store.js`, `profile-validation.js`) to `routeBaseUrl` and deletes it.
- Add:

```js
/** A client that does not know the adapter fields (today's UI) must not reset them. */
export function inheritAdapterSettings(input, stored) {
  if (!plainObject(input) || !stored) return input;
  const images = new Map((stored.models || []).map((m) => [m.modelId, m.images ?? null]));
  return {
    ...input,
    routing: input.routing ?? stored.routing,
    adapterCapabilities: input.adapterCapabilities ?? stored.adapterCapabilities,
    thinkTagExtraction: input.thinkTagExtraction ?? stored.thinkTagExtraction,
    models: Array.isArray(input.models)
      ? input.models.map((m) =>
          plainObject(m) && m.images === undefined && images.has(m.modelId)
            ? { ...m, images: images.get(m.modelId) }
            : m,
        )
      : input.models,
  };
}
```

In `provider-connections.js`: `update` validates `validateEndpoint(inheritAdapterSettings(input.endpoint, current.endpoint))`; `public(record)` adds `...(endpoint ? { toolRoutes: toolRoutes(record.endpoint) } : {})`.

In `endpoint-models.js` `mergeModels`: add `...(old?.images !== undefined ? { images: old.images ?? null } : {})` to the detected-model object.

- [ ] **Step 8: Run tests**

Run: `node --test tests/unit/endpoint-routing.test.js tests/unit/endpoint-config.test.js tests/unit/endpoint-models.test.js tests/integration/provider-connections.test.js tests/integration/endpoint-connections.test.js && npm run lint`
Expected: PASS. Fix existing assertions that compare whole endpoint blocks (they now include the three new fields and `images: null`).

- [ ] **Step 9: Commit**

```bash
git add server/features/providers/endpoint-routing.js server/features/providers/endpoint-config.js \
  server/features/providers/endpoint-models.js server/features/providers/provider-connections.js \
  server/lib/i18n/de/providers.js server/lib/i18n/en/providers.js tests/unit tests/integration
git commit -m "feat: add per-CLI routing and adapter settings to endpoint connections

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Route in the launch description, session record and pipeline snapshot

**Files:**

- Modify: `server/features/providers/launch-description.js`, `server/features/accounts/account-store.js:192-202`, `server/features/sessions/provider-configuration.js`, `server/features/pipelines/profile-validation.js:42-61`, `server/features/pipelines/native-profile.js:36-75`
- Test: `tests/integration/endpoint-pipeline-snapshot.test.js`, `tests/unit/provider-session.test.js`

**Interfaces:**

- Consumes: `resolveRoute`, `routeBaseUrl` (Task 2).
- Produces: `launchTarget(account, endpoint)` and `launchDescription(...)` include `route` (endpoint: `resolveRoute(endpoint, account.tool)`; catalog: `{ mode: "native", source: TOOL_PROTOCOL[account.tool] }`); `endpointSnapshot(endpoint, modelIds, tool)` returns `{ origins, protocols: { [route.source]: true }, route, models }`; `publicProviderConfiguration(provider)` keeps `route` when it is `{ mode ∈ native|adapter|sdk, source ∈ PROTOCOLS }`.

- [ ] **Step 1: Write failing tests**

In `tests/integration/endpoint-pipeline-snapshot.test.js` update the first test's expected opencode snapshot to include `route: { mode: "native", source: "chatCompletions" }` and add:

```js
test("snapshots freeze an explicit adapter route and its source origin", (t) => {
  const { profile, launch, edit } = setup(t, "claude", ["qwen3"], {
    protocols: { messages: false, responses: true, chatCompletions: true },
    routing: { claude: "adapter:chatCompletions" },
  });
  assert.deepEqual(profile.providerConnectionSnapshot.endpoint.route, {
    mode: "adapter",
    source: "chatCompletions",
  });
  assert.deepEqual(profile.providerConnectionSnapshot.endpoint.origins, [
    "http://127.0.0.1:11434",
  ]);
  launch();
  edit({
    protocols: { messages: false, responses: true, chatCompletions: true },
    routing: { claude: "adapter:responses" },
  });
  assert.throws(() => launch(), changed); // route moved to adapter:responses
});

test("legacy snapshots without a route keep launching while the route is native (Review Focus 3)", (t) => {
  const { profile, launch, edit } = setup(t, "codex");
  delete profile.providerConnectionSnapshot.endpoint.route;
  launch();
  edit({
    protocols: { messages: false, responses: false, chatCompletions: true },
    routing: { codex: "adapter:chatCompletions" },
  });
  assert.throws(() => launch(), changed);
});

test("auto never moves a pipeline onto an adapter route in PR 2", (t) => {
  const { launch, edit } = setup(t, "codex");
  edit({ protocols: { messages: false, responses: false, chatCompletions: true } });
  assert.throws(() => launch(), { status: 400 }); // connectionUnsupported: codex is no longer offered
});
```

Extend `setup(t, tool, available, endpointOverrides = {})` to merge `endpointOverrides` into the created endpoint. In `tests/unit/provider-session.test.js` add: `publicProviderConfiguration({ route: { mode: "adapter", source: "chatCompletions" } }).route` round-trips; `{ mode: "bogus" }` and `{ mode: "adapter", source: "x" }` are dropped.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/integration/endpoint-pipeline-snapshot.test.js tests/unit/provider-session.test.js`
Expected: FAIL (`route` missing).

- [ ] **Step 3: Implement**

- `launch-description.js`: import `resolveRoute`; in the endpoint branch add `route: resolveRoute(endpoint, account.tool)`; catalog branch `route: { mode: "native", source: TOOL_PROTOCOL[account.tool] }`. `launchDescription` passes it through (it spreads `target`).
- `account-store.js` `verifyEndpointTarget`: `const url = routeBaseUrl(endpoint, resolveRoute(endpoint, account.tool));`. Then delete `endpointBaseUrl` from `endpoint-config.js` (no callers remain; `git grep endpointBaseUrl` must be empty).
- `profile-validation.js`:

```js
export function endpointSnapshot(endpoint, modelIds, tool) {
  const route = resolveRoute(endpoint, tool);
  const url = routeBaseUrl(endpoint, route);
  return {
    origins: url ? [new URL(url).origin] : [],
    protocols: route ? { [route.source]: true } : {},
    route,
    models: /* unchanged */,
  };
}
```

- `native-profile.js` `validateProfileLaunch`: compare against a route-less copy when the frozen snapshot predates routes:

```js
const frozen = narrowed(profile.providerConnectionSnapshot, modelId);
const legacy = frozen?.endpoint && !Object.hasOwn(frozen.endpoint, "route");
const current = legacy
  ? { ...connection, endpoint: (({ route, ...rest }) => rest)(connection.endpoint) }
  : connection;
// legacy snapshots stored { [nativeProtocol]: true }; a route that is still native yields the same value
if ((profile.providerConnectionSnapshot && !isDeepStrictEqual(current, frozen)) || …)
```

- `provider-configuration.js`: after the token fields add

```js
const route = provider.route;
if (
  route &&
  ["native", "adapter", "sdk"].includes(route.mode) &&
  ["messages", "responses", "chatCompletions"].includes(route.source)
)
  result.route = { mode: route.mode, source: route.source };
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/integration/endpoint-pipeline-snapshot.test.js tests/unit/provider-session.test.js tests/integration/endpoint-account-launch.test.js tests/matrix/pipeline-provider-model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/providers/launch-description.js server/features/accounts/account-store.js \
  server/features/sessions/provider-configuration.js server/features/pipelines tests
git commit -m "feat: carry the resolved CLI route into launches, sessions and pipeline snapshots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: OpenCode SDK routes (no adapter)

**Files:**

- Modify: `server/features/providers/endpoint-launch.js:57-90`
- Test: `tests/matrix/endpoint-launch.test.js`

**Interfaces:**

- Consumes: `description.route` (Task 3), fact R4a/R4b (Task 1).
- Produces: `endpointOpenCodeLaunch` writes provider `npm` by route source: `chatCompletions` → `@ai-sdk/openai-compatible` (`baseURL: openaiBaseUrl`, unchanged), `responses` → `@ai-sdk/openai` (`baseURL: openaiBaseUrl`, `apiKey` reference), `messages` → `@ai-sdk/anthropic` (`baseURL: anthropicBaseUrl + "/v1"`, `authToken` reference — or `apiKey` if fact R4a says `authToken` is not passed through). Custom auth header: `headers: { [authHeader]: reference }` for every SDK, never also `apiKey`/`authToken`.

- [ ] **Step 1: Write the failing test**

```js
for (const [protocols, npm, baseURL, keyOption] of [
  [
    { messages: true, responses: false, chatCompletions: false },
    "@ai-sdk/anthropic",
    "https://llm.example/v1",
    "authToken",
  ],
  [
    { messages: false, responses: true, chatCompletions: false },
    "@ai-sdk/openai",
    "https://llm.example/v1",
    "apiKey",
  ],
  [
    { messages: false, responses: false, chatCompletions: true },
    "@ai-sdk/openai-compatible",
    "https://llm.example/v1",
    "apiKey",
  ],
])
  test(`OpenCode uses ${npm} for its route`, (t) => {
    const { result, files } = launch(t, "opencode", {
      endpoint: endpointBlock({ protocols }),
    });
    const config = JSON.parse(result.env.OPENCODE_CONFIG_CONTENT);
    const provider = config.provider["agentpier-endpoint"];
    assert.equal(provider.npm, npm);
    assert.equal(provider.options.baseURL, baseURL);
    assert.equal(provider.options[keyOption], "{env:AGENTPIER_ENDPOINT_API_KEY}");
    assert.equal(result.adapter, undefined, "OpenCode never uses the adapter");
    assert.equal(
      result.provider.route.mode,
      npm === "@ai-sdk/openai-compatible" ? "native" : "sdk",
    );
    assert.equal(
      files.some((text) => text.includes("endpoint-secret")),
      false,
    );
  });
```

(Adapt to the file's `launch()` helper: return `{ result, files }` if it does not yet; `keyOption` for anthropic follows R4a.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/matrix/endpoint-launch.test.js`
Expected: FAIL (`npm` is always `@ai-sdk/openai-compatible`).

- [ ] **Step 3: Implement**

```js
const SDK = {
  chatCompletions: { npm: "@ai-sdk/openai-compatible", keyOption: "apiKey" },
  responses: { npm: "@ai-sdk/openai", keyOption: "apiKey" },
  messages: { npm: "@ai-sdk/anthropic", keyOption: "authToken" }, // R4a decides authToken vs apiKey
};
// inside endpointOpenCodeLaunch
const source = description.route?.source ?? "chatCompletions";
const sdk = SDK[source];
const baseURL =
  source === "messages"
    ? `${description.endpoints.messages}/v1`
    : description.endpoints.responses;
// provider: { npm: sdk.npm, name, options: { baseURL, ...(key && !auth.header ? { [sdk.keyOption]: reference } : {}),
//             ...(key && auth.header ? { headers: { [auth.header]: reference } } : {}) }, models: … }
```

Set `metadata.route = description.route` in `prepareProviderLaunch` for every endpoint launch (also needed by Task 5).

- [ ] **Step 4: Run tests**

Run: `node --test tests/matrix/endpoint-launch.test.js tests/integration/endpoint-account-launch.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/providers/endpoint-launch.js server/features/providers/provider-launch.js tests/matrix/endpoint-launch.test.js
git commit -m "feat: launch OpenCode through its Anthropic and OpenAI SDK providers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Adapter launch description for Claude Code and Codex

**Files:**

- Create: `server/features/providers/adapter-launch.js`
- Modify: `server/features/providers/provider-environment.js`, `server/features/providers/provider-launch.js`, `server/features/providers/endpoint-launch.js:6-55`, `server/features/providers/native-config.js:34-73`
- Test: `tests/matrix/endpoint-adapter-launch.test.js` (new)

**Interfaces:**

- Consumes: `route`, `libraryProtocol`, `routeBaseUrl`, `adapterCapabilitiesFor`, `adapterReasoning` (Tasks 2–3); facts R2, R3a/R3b.
- Produces (`adapter-launch.js`):
  - `ADAPTER_URL_PLACEHOLDER = "__AGENTPIER_ADAPTER_URL__"`
  - `createSessionToken() → string` (43-char base64url of 32 random bytes)
  - `withLoopbackNoProxy(env) → void` (adds `127.0.0.1` and `localhost` to `NO_PROXY` and `no_proxy`)
  - `adapterBlock({ tool, description, endpoint, secret, token }) → AdapterBlock`:
    `{ token, clientProtocol: "messages"|"responses", upstreamProtocol: "messages"|"responses"|"chat", upstream: { baseUrl, authHeader, apiKey }, model: { modelId, contextTokens, outputTokens, images }, capabilities, thinkTagExtraction }` (no `diagnosticsPath`; Task 6 adds it)
- Produces: `providerEnvironment(account, secret, environment, root, description, { adapterToken } = {})`; `prepareProviderLaunch` returns `result.adapter` (AdapterBlock) on adapter routes and `result.provider.route`; `codexModelCatalog(model, { contextTokens, description, reasoning, images })`.

Rules (adapter routes only):

- Claude Code env: `ANTHROPIC_BASE_URL = ADAPTER_URL_PLACEHOLDER`, `ANTHROPIC_AUTH_TOKEN = token`, `ANTHROPIC_API_KEY = ""`, no `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_ATTRIBUTION_HEADER = "0"`; `CLAUDE_CODE_MAX_OUTPUT_TOKENS` keeps coming from `configureClaudeProvider` (`forceCustom` → `metadata.outputTokens`, already `fallbackOutputTokens`); `customHeader` version gate is not applied (the header is the adapter's business).
- Without `adapterToken` (the `AccountStore.environment()` path used by history, plugins, auth status): no base URL, `ANTHROPIC_AUTH_TOKEN = "agentpier-endpoint"`, never the key.
- Codex env: `env[auth.keyEnv] = token` (never the key). `config.toml`: `model`, `model_provider`, `cli_auth_credentials_store`, `model_context_window`, `model_catalog_json`, `web_search = "disabled"`, provider `{ name, wire_api: "responses", requires_openai_auth: false, env_key: auth.keyEnv }` — **no `base_url`, no `env_http_headers`** (R3b fallback per Task 1). argv: the same keys via `-c`, the provider table additionally with `base_url = "__AGENTPIER_ADAPTER_URL__/v1"`.
- Codex catalog: `apply_patch_tool_type: "freeform"` (unchanged), `input_modalities: images === true ? ["text", "image"] : ["text"]`, `reasoning: adapterReasoning(endpoint, route.source)` on adapter routes; native routes keep `reasoning: false`.
- Both: `withLoopbackNoProxy(env)`.

- [ ] **Step 1: Write the failing matrix test**

```js
// tests/matrix/endpoint-adapter-launch.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { prepareProviderLaunch } from "../../server/features/providers/provider-launch.js";
import { validateEndpoint } from "../../server/features/providers/endpoint-config.js";
import { ADAPTER_URL_PLACEHOLDER } from "../../server/features/providers/adapter-launch.js";

const KEY = "upstream-secret-key";
// Adapter routes are explicit in PR 2 (ADAPTER_AUTO_ROUTES = false): `via(tool, source)`
// enables exactly that source and routes the tool to it.
const via = (tool, source, extra = {}) =>
  endpoint({ [source]: true }, { routing: { [tool]: `adapter:${source}` }, ...extra });
const endpoint = (protocols, extra = {}) =>
  validateEndpoint({
    preset: "custom",
    openaiBaseUrl: "https://llm.example/v1",
    anthropicBaseUrl: "https://llm.example",
    protocols: {
      messages: false,
      responses: false,
      chatCompletions: false,
      ...protocols,
    },
    authHeader: null,
    models: [
      {
        modelId: "qwen3",
        label: "Qwen",
        contextTokens: 65536,
        outputTokens: 8192,
        source: "manual",
        contextEdited: true,
        images: true,
      },
    ],
    lastTest: null,
    ...extra,
  });

function launch(t, tool, block) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-launch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = prepareProviderLaunch(
    { kind: "managed", tool, provider: { id: "endpoint", modelId: "qwen3" } },
    { apiKey: KEY },
    {
      command: `/opt/${tool}`,
      args: [],
      env: {
        PATH: "/bin",
        HOME: root,
        HTTPS_PROXY: "http://proxy:3128",
        NO_PROXY: "corp.example",
      },
    },
    {
      root,
      catalog: new ProviderCatalog(),
      cliVersion: "2.1.291",
      endpoint: block,
      connectionName: "GPU",
    },
  );
  const files = [];
  const walk = (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .forEach((e) =>
        e.isDirectory()
          ? walk(path.join(dir, e.name))
          : files.push([
              path.join(dir, e.name),
              fs.readFileSync(path.join(dir, e.name), "utf8"),
            ]),
      );
  walk(root);
  return { result, files, root };
}

function assertNoLeak(result, files) {
  const token = result.adapter.token;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(result.env).includes(KEY), false, "key in env");
  assert.equal(JSON.stringify(result.args).includes(KEY), false, "key in argv");
  for (const [file, text] of files) {
    for (const forbidden of [KEY, token, ADAPTER_URL_PLACEHOLDER, "127.0.0.1"])
      assert.equal(text.includes(forbidden), false, `${forbidden} in ${file}`);
  }
  assert.equal(result.env.NO_PROXY, "corp.example,127.0.0.1,localhost");
  assert.equal(result.env.no_proxy, "127.0.0.1,localhost");
  assert.equal(result.adapter.upstream.apiKey, KEY);
}

for (const source of ["responses", "chatCompletions"])
  test(`Claude Code via adapter from ${source}`, (t) => {
    const { result, files } = launch(t, "claude", via("claude", source));
    assertNoLeak(result, files);
    assert.equal(result.env.ANTHROPIC_BASE_URL, ADAPTER_URL_PLACEHOLDER);
    assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, result.adapter.token);
    assert.equal(result.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
    assert.equal(result.env.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");
    assert.equal(result.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "8192");
    assert.deepEqual(result.provider.route, { mode: "adapter", source });
    assert.equal(result.adapter.clientProtocol, "messages");
    assert.equal(
      result.adapter.upstreamProtocol,
      source === "chatCompletions" ? "chat" : "responses",
    );
    assert.equal(result.adapter.upstream.baseUrl, "https://llm.example/v1");
  });

for (const source of ["messages", "chatCompletions"])
  test(`Codex via adapter from ${source}`, (t) => {
    const { result, files, root } = launch(t, "codex", via("codex", source));
    assertNoLeak(result, files);
    assert.equal(result.env.AGENTPIER_ENDPOINT_API_KEY, result.adapter.token);
    const argv = result.args.join(" ");
    assert.match(
      argv,
      /base_url = "__AGENTPIER_ADAPTER_URL__\/v1"|base_url="__AGENTPIER_ADAPTER_URL__\/v1"/,
    );
    assert.match(argv, /web_search="disabled"/);
    const toml = parseToml(files.find(([f]) => f.endsWith("config.toml"))[1]);
    assert.equal(toml.web_search, "disabled");
    assert.equal(toml.model_providers["agentpier-endpoint"].base_url, undefined);
    assert.equal(toml.model_providers["agentpier-endpoint"].env_http_headers, undefined);
    const catalog = JSON.parse(files.find(([f]) => f.endsWith("models.json"))[1])
      .models[0];
    assert.equal(catalog.apply_patch_tool_type, "freeform");
    assert.deepEqual(catalog.input_modalities, ["text", "image"]);
    assert.equal(catalog.supports_reasoning_summaries, source === "messages");
    assert.equal(
      result.adapter.upstream.baseUrl,
      source === "messages" ? "https://llm.example" : "https://llm.example/v1",
    );
  });

test("custom auth header stays on the adapter hop", (t) => {
  const { result, files } = launch(
    t,
    "claude",
    via("claude", "chatCompletions", { authHeader: "api-key" }),
  );
  assertNoLeak(result, files);
  assert.equal(result.adapter.upstream.authHeader, "api-key");
  assert.equal(result.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
});

test("a native route after an adapter route removes the adapter from config.toml and env", (t) => {
  // launch codex on via("codex", "chatCompletions"), then on a responses endpoint with the same root:
  // the second result has no `adapter`, config.toml has base_url "https://llm.example/v1",
  // no web_search key is forced, and NO_PROXY is unchanged ("corp.example").
});

test("each launch gets a fresh token", (t) => {
  const a = launch(t, "claude", via("claude", "chatCompletions")).result.adapter.token;
  const b = launch(t, "claude", via("claude", "chatCompletions")).result.adapter.token;
  assert.notEqual(a, b);
});

test("auto on a Chat-only endpoint launches no adapter route in PR 2", (t) => {
  assert.throws(() => launch(t, "claude", endpoint({ chatCompletions: true })), {
    status: 409,
  }); // endpointProtocolDisabled
  assert.throws(() => launch(t, "codex", endpoint({ chatCompletions: true })), {
    status: 409,
  });
});
```

Write the "native after adapter" test body fully (reuse `launch` with a shared root by adding an optional `root` parameter).

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/matrix/endpoint-adapter-launch.test.js`
Expected: FAIL (`adapter-launch.js` missing).

- [ ] **Step 3: Implement `adapter-launch.js`**

```js
import { randomBytes } from "node:crypto";
import {
  adapterCapabilitiesFor,
  libraryProtocol,
  routeBaseUrl,
} from "./endpoint-routing.js";

export const ADAPTER_URL_PLACEHOLDER = "__AGENTPIER_ADAPTER_URL__";
const CLIENT_PROTOCOL = Object.freeze({ claude: "messages", codex: "responses" });

export const createSessionToken = () => randomBytes(32).toString("base64url");

export function withLoopbackNoProxy(env) {
  for (const name of ["NO_PROXY", "no_proxy"]) {
    const hosts = (env[name] || "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean);
    for (const host of ["127.0.0.1", "localhost"])
      if (!hosts.includes(host)) hosts.push(host);
    env[name] = hosts.join(",");
  }
}

export function adapterBlock({ tool, description, endpoint, secret, token }) {
  const { route, model, auth } = description;
  return {
    token,
    clientProtocol: CLIENT_PROTOCOL[tool],
    upstreamProtocol: libraryProtocol(route.source),
    upstream: {
      baseUrl: routeBaseUrl(endpoint, route),
      authHeader: auth.header || null,
      apiKey: secret?.apiKey?.trim() || null,
    },
    model: {
      modelId: model.modelId,
      contextTokens: model.contextTokens,
      outputTokens: model.outputTokens,
      images: model.images ?? null,
    },
    capabilities: adapterCapabilitiesFor(endpoint, route.source),
    thinkTagExtraction: endpoint.thinkTagExtraction === true,
  };
}
```

- [ ] **Step 4: Wire environment, launch and Codex config**

- `provider-environment.js`: new last parameter `{ adapterToken } = {}`; `const adapterRoute = description.route?.mode === "adapter";`. Claude branch: when `adapterRoute`, set the adapter env per the rules above and skip the existing endpoint key logic. Codex branch: `if (adapterRoute) { if (adapterToken) env[description.auth.keyEnv] = adapterToken; } else if (key) env[description.auth.keyEnv] = key;`.
- `provider-launch.js`:

```js
const adapterRoute = description.route?.mode === "adapter";
const token = adapterRoute ? createSessionToken() : null;
const env = providerEnvironment(account, secret, launch.env, root, description, { adapterToken: token });
if (adapterRoute) withLoopbackNoProxy(env);
const metadata = { ...model, …existing…, ...(description.route ? { route: description.route } : {}) };
const result = { ...launch, args: [...launch.args], env, provider: metadata,
  ...(adapterRoute ? { adapter: adapterBlock({ tool: account.tool, description, endpoint, secret, token }) } : {}) };
// claude: customHeader: endpointKind && !adapterRoute && !!description.auth.header && !!secret?.apiKey?.trim()
// codex: endpointCodexLaunch(result, description, secret, connectionName, { endpoint })
```

- `endpoint-launch.js` `endpointCodexLaunch(result, description, secret, connectionName, { endpoint } = {})`:

```js
const adapter = description.route?.mode === "adapter";
const provider = {
  name: connectionName || description.displayName,
  wire_api: "responses",
  requires_openai_auth: false,
  ...(adapter
    ? { env_key: auth.keyEnv }
    : {
        base_url: description.endpoints.responses,
        ...(key && !auth.header ? { env_key: auth.keyEnv } : {}),
        ...(key && auth.header
          ? { env_http_headers: { [auth.header]: auth.keyEnv } }
          : {}),
      }),
};
const config = {
  model: model.modelId,
  model_provider: description.providerKey,
  cli_auth_credentials_store: "file",
  model_context_window: model.contextTokens,
  model_catalog_json: path.join(env.CODEX_HOME, "models.json"),
  model_providers: { [description.providerKey]: provider },
  ...(adapter ? { web_search: "disabled" } : {}),
};
writePrivate(
  config.model_catalog_json,
  codexModelCatalog(model, {
    contextTokens: model.contextTokens,
    description: "Custom endpoint model",
    reasoning: adapter && adapterReasoning(endpoint, description.route.source),
    images: model.images === true,
  }),
);
writeTomlConfig(path.join(env.CODEX_HOME, "config.toml"), config);
const argv = adapter
  ? {
      ...config,
      model_providers: {
        [description.providerKey]: {
          ...provider,
          base_url: `${ADAPTER_URL_PLACEHOLDER}/v1`,
        },
      },
    }
  : config;
for (const [name, value] of Object.entries(argv))
  result.args.push("-c", `${name}=${tomlValue(value)}`);
```

A previous adapter launch leaves `web_search = "disabled"` in `config.toml`; the native branch must write `web_search` back to its previous absence — add `writeTomlConfig(file, additions, { remove = [] } = {})` that deletes the listed top-level keys before merging, and call it with `{ remove: adapter ? [] : ["web_search"] }`.

- `native-config.js` `codexModelCatalog(model, { contextTokens, description, reasoning, images = false })`: `input_modalities: images ? ["text", "image"] : ["text"]`.

- [ ] **Step 5: Run tests**

Run: `node --test tests/matrix/endpoint-adapter-launch.test.js tests/matrix/endpoint-launch.test.js tests/matrix/codex-endpoint-catalog-cli.test.js tests/integration/endpoint-account-launch.test.js tests/matrix/providers-launch.test.js`
Expected: PASS (the codex catalog CLI test runs when Codex is installed).

- [ ] **Step 6: Commit**

```bash
git add server/features/providers tests/matrix/endpoint-adapter-launch.test.js
git commit -m "feat: describe adapter launches for Claude Code and Codex without exposing the key

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Private payload plumbing for the adapter block

**Files:**

- Create: `server/features/adapter-runtime/adapter-config.js`
- Modify: `server/features/sessions/session-creation.js:92-110`, `server/features/sessions/session-replacement.js:50-62`, `server/features/sessions/session-removal.js:11-18`, `server/lib/i18n/de/sessions.js`, `server/lib/i18n/en/sessions.js`
- Test: `tests/unit/adapter-config.test.js`, `tests/integration/session-adapter-payload.test.js`

**Interfaces:**

- Consumes: `AdapterBlock` (Task 5).
- Produces:
  - `validateAdapterConfig(value) → AdapterConfig` (frozen copy; throws `TypeError` with a fixed message, never echoing values). `AdapterConfig` = AdapterBlock + `diagnosticsPath: string | null`.
  - `adapterDiagnosticsPath(directory, id) → path.join(directory, `${id}.adapter.json`)`.
  - Payload: `launch.json` gains `adapter: AdapterConfig` when `options.adapter` / `launch.adapter` is present. The session record (`${id}.json`) never contains `adapter`.

Validation rules: `token` matches `/^[A-Za-z0-9_-]{43}$/`; `clientProtocol ∈ {messages, responses}`; `upstreamProtocol ∈ {messages, responses, chat}` and ≠ `clientProtocol`; `upstream.baseUrl` passes `normalizeEndpointUrl` unchanged; `upstream.authHeader` null or header token; `upstream.apiKey` null or string ≤ 16384 without control characters; `model.modelId` passes `validModelId`; `contextTokens`/`outputTokens` integers 1024…10 000 000 (outputTokens may be null); `images ∈ {true, false, null}`; `capabilities` passes `resolveCapabilities(upstreamProtocol, capabilities)`; `thinkTagExtraction` boolean; `diagnosticsPath` null or absolute path without NUL.

- [ ] **Step 1: Write the failing tests**

`tests/unit/adapter-config.test.js`: one valid config passes and is returned unchanged; for each field above, one invalid value throws `TypeError` whose message does not contain the invalid value (use `apiKey: "secret\u0000x"` and `token: "short"` and assert `!error.message.includes("secret")`).

`tests/integration/session-adapter-payload.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSessionLaunch } from "../../server/features/sessions/session-creation.js";
import { validAdapterConfig } from "../helpers/adapter-fixture.js";

function manager(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-payload-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const saved = [];
  return { directory, file: (id) => path.join(directory, `${id}.json`), save: async (s) => saved.push(s), saved };
}

test("the adapter block reaches only the private launch payload", async (t) => {
  const m = manager(t);
  const adapter = validAdapterConfig({ diagnosticsPath: undefined });
  const { id, launchFile, session } = await buildSessionLaunch(m, {
    tool: "claude", accountId: "local-claude".padEnd(36, "0"), // use a valid id helper from the file under test
    cwd: m.directory, command: process.execPath, args: [], env: {}, adapter,
  });
  const payload = JSON.parse(fs.readFileSync(launchFile, "utf8"));
  assert.equal(payload.adapter.token, adapter.token);
  assert.equal(payload.adapter.diagnosticsPath, path.join(m.directory, `${id}.adapter.json`));
  assert.equal((fs.statSync(launchFile).mode & 0o777), 0o600);
  assert.equal(JSON.stringify(session).includes(adapter.token), false);
  assert.equal(JSON.stringify(m.saved).includes(adapter.upstream.apiKey), false);
});

test("an invalid adapter block is refused before anything is written", async (t) => {
  const m = manager(t);
  await assert.rejects(buildSessionLaunch(m, { …same…, adapter: { token: "x" } }), { status: 400 });
  assert.deepEqual(fs.readdirSync(m.directory), []);
});
```

Use the id/accountId helpers the existing session-creation tests use (search `tests/` for `buildSessionLaunch(`) instead of the padded literal. Add a third test for `replaceSession`'s payload writer if an existing replacement test harness exists (`tests/integration/*reload*.test.js`); otherwise cover it in Task 12's blackbox reload step. Add `"adapter.json"` removal to an existing session-removal test.

Create `tests/helpers/adapter-fixture.js`:

```js
export const TOKEN = "t".repeat(43);
export const KEY = "upstream-secret-key";
export function validAdapterConfig(overrides = {}) {
  return {
    token: TOKEN,
    clientProtocol: "messages",
    upstreamProtocol: "chat",
    upstream: { baseUrl: "http://127.0.0.1:9/v1", authHeader: null, apiKey: KEY },
    model: { modelId: "qwen3", contextTokens: 32768, outputTokens: 8192, images: null },
    capabilities: {},
    thinkTagExtraction: false,
    diagnosticsPath: null,
    ...overrides,
  };
}
export const authorized = (extra = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
  ...extra,
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/unit/adapter-config.test.js tests/integration/session-adapter-payload.test.js`
Expected: FAIL (module missing; payload has no `adapter`).

- [ ] **Step 3: Implement**

- `adapter-config.js` per the rules (import `normalizeEndpointUrl` from `endpoint-config.js`, `validModelId` from `provider-definitions.js`, `resolveCapabilities` from `../protocol-adapter/capabilities.js`; wrap their errors into `new TypeError("adapter: invalid <field>")`).
- `session-creation.js`: before writing, `const adapter = options.adapter ? checkedAdapter(options.adapter, manager.directory, id) : null;` where `checkedAdapter` calls `validateAdapterConfig({ ...value, diagnosticsPath: adapterDiagnosticsPath(directory, id) })` and maps `TypeError` to `failure(serverMessages.sessions.invalidAdapterConfiguration)`; spread `...(adapter ? { adapter } : {})` into the payload only.
- `session-replacement.js`: same for `launch.adapter`.
- `session-removal.js`: add `"adapter.json"` to the removed extensions.
- i18n `sessions.invalidAdapterConfiguration`: de "Die Adapter-Konfiguration der Sitzung ist ungültig." / en "The session's adapter configuration is invalid."

- [ ] **Step 4: Run tests**

Run: `node --test tests/unit/adapter-config.test.js tests/integration/session-adapter-payload.test.js && npm run test:unit`
Expected: PASS (catalog parity tests included).

- [ ] **Step 5: Commit**

```bash
git add server/features/adapter-runtime/adapter-config.js server/features/sessions server/lib/i18n tests
git commit -m "feat: pass the adapter configuration only through the private launch payload

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Streaming upstream client with address policy and keep-alive

**Files:**

- Create: `server/features/providers/endpoint-stream.js`
- Modify: `server/features/providers/endpoint-address.js:95-117`
- Test: `tests/integration/endpoint-stream.test.js`, `tests/integration/endpoint-http.test.js` (unchanged behavior)

**Interfaces:**

- Produces (`endpoint-address.js`): `assertAllowedAddresses(addresses, protocol)` (throws the existing `notAllowed` problem with `reason: "notAllowed"`); `policyLookup(protocol, lookup = dns.lookup)` → Node `lookup(hostname, options, callback)` function that resolves all addresses, applies `assertAllowedAddresses`, and on refusal calls back with an `Error` having `code: "EADDRNOTALLOWED"`, `reason: "notAllowed"`, `adapterKind: "network"`. `resolveEndpointTarget` uses `assertAllowedAddresses` (no behavior change).
- Produces (`endpoint-stream.js`):
  - `transportError(kind, message) → Error` with `adapterKind = kind`.
  - `createUpstreamClient({ baseUrl, lookup, maxSockets = 32 }) → { request(options) → Promise<UpstreamResponse>, close() }`; throws the `notAllowed` problem synchronously when `baseUrl`'s host is an IP literal that the policy refuses.
  - `request({ path, body, headers, signal, idleTimeoutMs = 240_000 })`: POSTs `JSON.stringify(body)` to `baseUrl + path`; never follows redirects; rejects with `transportError("timeout", "upstream idle timeout")` when no response headers arrive within `idleTimeoutMs`, with `signal.reason` when it has an `adapterKind`, else `transportError("network", …)`.
  - `UpstreamResponse = { status, headers, chunks: AsyncIterable<string>, text(limitBytes) → Promise<string> }`; `chunks` resets the idle timer on every chunk and fails with the timeout error after `idleTimeoutMs` of silence; leaving the iteration early destroys the response; `text()` rejects with `transportError("network", "upstream response too large")` beyond `limitBytes`.

Agent: `new (secure ? https : http).Agent({ keepAlive: true, maxSockets, scheduling: "lifo", lookup: policyLookup(protocol, lookup), autoSelectFamily: true })`; requests pass `servername` for TLS hostnames as `endpointRequest` does. No `HTTPS_PROXY` (the adapter env has none; Node's http client ignores it anyway).

- [ ] **Step 1: Write the failing tests**

```js
// tests/integration/endpoint-stream.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createUpstreamClient } from "../../server/features/providers/endpoint-stream.js";
import { scriptedUpstream } from "../helpers/scripted-upstream.js";

const fixed = (address) => (_host, options, callback) =>
  options?.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4);

test("streams chunks and reuses the keep-alive connection", async (t) => {
  const up = await scriptedUpstream(t, async (_entry, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 1\n\n");
    await new Promise((r) => setTimeout(r, 20));
    res.end("data: 2\n\n");
  });
  const client = createUpstreamClient({ baseUrl: `${up.base}/v1` });
  t.after(() => client.close());
  for (let i = 0; i < 2; i++) {
    const response = await client.request({
      path: "/chat/completions",
      body: { a: i },
      headers: {},
    });
    let text = "";
    for await (const chunk of response.chunks) text += chunk;
    assert.equal(text, "data: 1\n\ndata: 2\n\n");
  }
  assert.equal(up.seen[0].url, "/v1/chat/completions");
  assert.equal(
    up.seen[0].remotePort,
    up.seen[1].remotePort,
    "second request reused the socket",
  );
});

test("idle timeout before headers and between chunks carries adapterKind timeout", async (t) => {
  const up = await scriptedUpstream(t, async (entry, res) => {
    if (entry.body.phase === "headers") return; // hang
    res.writeHead(200);
    res.write("data: 1\n\n"); // then hang
  });
  const client = createUpstreamClient({ baseUrl: up.base });
  t.after(() => client.close());
  await assert.rejects(
    client.request({
      path: "/x",
      body: { phase: "headers" },
      headers: {},
      idleTimeoutMs: 80,
    }),
    { adapterKind: "timeout" },
  );
  const response = await client.request({
    path: "/x",
    body: { phase: "chunks" },
    headers: {},
    idleTimeoutMs: 80,
  });
  await assert.rejects(
    async () => {
      for await (const _ of response.chunks);
    },
    { adapterKind: "timeout" },
  );
});

test("an abort with adapterKind network is not reported as a timeout", async (t) => {
  const up = await scriptedUpstream(t, async () => {}); // never answers
  const client = createUpstreamClient({ baseUrl: up.base });
  t.after(() => client.close());
  const controller = new AbortController();
  const pending = client.request({
    path: "/x",
    body: {},
    headers: {},
    signal: controller.signal,
  });
  controller.abort(
    Object.assign(new Error("client disconnected"), { adapterKind: "network" }),
  );
  await assert.rejects(pending, { adapterKind: "network" });
});

test("redirects are returned, not followed; text() is capped", async (t) => {
  const up = await scriptedUpstream(t, async (entry, res) => {
    if (entry.url === "/r")
      return res.writeHead(302, { location: "http://example.com/" }).end();
    res.writeHead(400);
    res.end("x".repeat(2048));
  });
  const client = createUpstreamClient({ baseUrl: up.base });
  t.after(() => client.close());
  assert.equal((await client.request({ path: "/r", body: {}, headers: {} })).status, 302);
  const big = await client.request({ path: "/e", body: {}, headers: {} });
  await assert.rejects(big.text(1024), { adapterKind: "network" });
  assert.equal(up.seen.length, 2);
});

test("each new connection re-resolves and re-checks the address policy (Review Focus 5)", async (t) => {
  const up = await scriptedUpstream(t, async (_e, res) => res.writeHead(200).end("{}"));
  let address = "127.0.0.1";
  const port = new URL(up.base).port;
  const client = createUpstreamClient({
    baseUrl: `http://upstream.test:${port}`,
    lookup: (host, options, callback) => fixed(address)(host, options, callback),
  });
  t.after(() => client.close());
  assert.equal((await client.request({ path: "/a", body: {}, headers: {} })).status, 200);
  client.close(); // drop pooled sockets so the next request opens a new connection
  address = "0.0.0.0";
  const next = createUpstreamClient({
    baseUrl: `http://upstream.test:${port}`,
    lookup: fixed(address),
  });
  t.after(() => next.close());
  await assert.rejects(next.request({ path: "/a", body: {}, headers: {} }), {
    adapterKind: "network",
  });
});

test("an IP-literal upstream outside the policy is refused at creation", () => {
  assert.throws(() => createUpstreamClient({ baseUrl: "http://8.8.8.8/v1" }), {
    reason: "notAllowed",
  });
});
```

(The DNS test must prove re-resolution on one client too: restructure it so the same client's agent is forced to open a new socket — e.g. the upstream answers the first request with `connection: close` — then flip `address` and expect rejection. Keep the second-client variant only if the first proves impractical.)

Create `tests/helpers/scripted-upstream.js`:

```js
import http from "node:http";

/** HTTP server whose handler writes the response itself (SSE, delays, hangs). */
export async function scriptedUpstream(t, script) {
  const seen = [];
  const open = new Set();
  const server = http.createServer(async (request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    for await (const chunk of request) raw += chunk;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const entry = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
      remotePort: request.socket.remotePort,
      closed: false,
    };
    request.on("close", () => (entry.closed = true));
    response.on("close", () => (entry.closed = true));
    seen.push(entry);
    await script(entry, response, seen.length - 1);
  });
  server.on("connection", (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    seen,
    openConnections: () => open.size,
  };
}

export const sse = (response, text) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(text);
};
export const json = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/integration/endpoint-stream.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`endpoint-address.js`: move the `kinds` check of `resolveEndpointTarget` into `assertAllowedAddresses(addresses, protocol)`; add:

```js
export function policyLookup(protocol, lookup = dns.lookup) {
  return (hostname, options, callback) =>
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      try {
        if (!Array.isArray(addresses) || !addresses.length) throw new Error("unresolved");
        assertAllowedAddresses(addresses, protocol);
      } catch {
        return callback(
          Object.assign(new Error("upstream address not allowed"), {
            code: "EADDRNOTALLOWED",
            reason: "notAllowed",
            adapterKind: "network",
          }),
        );
      }
      if (options?.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
}
```

`endpoint-stream.js` (sketch; keep < 200 lines):

```js
export const transportError = (kind, message) =>
  Object.assign(new Error(message), { adapterKind: kind });

export function createUpstreamClient({ baseUrl, lookup, maxSockets = 32 }) {
  const base = new URL(baseUrl);
  const secure = base.protocol === "https:";
  const hostname = base.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname))
    assertAllowedAddresses(
      [{ address: hostname, family: net.isIP(hostname) }],
      base.protocol,
    );
  const agent = new (secure ? https : http).Agent({
    keepAlive: true,
    maxSockets,
    scheduling: "lifo",
    autoSelectFamily: true,
    lookup: policyLookup(base.protocol, lookup),
  });
  const prefix = base.href.replace(/\/+$/, "");
  function request({ path, body, headers = {}, signal, idleTimeoutMs = 240_000 }) {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      let response = null;
      let timer;
      const fail = (error) => (response ?? req).destroy(error);
      const idle = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => fail(transportError("timeout", "upstream idle timeout")),
          idleTimeoutMs,
        );
      };
      const onAbort = () =>
        fail(
          signal.reason?.adapterKind
            ? signal.reason
            : transportError("network", "request aborted"),
        );
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const req = (secure ? https : http).request(`${prefix}${path}`, {
        method: "POST",
        agent,
        headers: { ...headers, "content-length": Buffer.byteLength(payload) },
        ...(secure && !net.isIP(hostname) ? { servername: hostname } : {}),
      });
      req.on("error", (error) => {
        cleanup();
        reject(
          error.adapterKind
            ? error
            : transportError("network", "upstream connection failed"),
        );
      });
      req.on("response", (res) => {
        response = res;
        res.setEncoding("utf8");
        idle();
        res.on("close", cleanup);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          chunks: chunks(res, idle),
          text: (limit) => readText(res, limit, idle),
        });
      });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      idle();
      req.end(payload);
    });
  }
  return { request, close: () => agent.destroy() };
}
```

`chunks(res, idle)`: `async function*` that iterates `res`, calls `idle()` per chunk, rethrows errors as-is when they carry `adapterKind`, otherwise wraps them in `transportError("network", …)`, and `res.destroy()`s in `finally` when the consumer stops early. `readText(res, limit, idle)`: collects up to `limit` bytes (`Buffer.byteLength`), then `res.destroy(transportError("network", "upstream response too large"))`.

- [ ] **Step 4: Run tests**

Run: `node --test tests/integration/endpoint-stream.test.js tests/integration/endpoint-http.test.js tests/unit/endpoint-*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/providers/endpoint-stream.js server/features/providers/endpoint-address.js \
  tests/integration/endpoint-stream.test.js tests/helpers/scripted-upstream.js
git commit -m "feat: add a streaming upstream client under the endpoint address policy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Adapter HTTP server and per-request exchange

**Files:**

- Create: `server/features/adapter-runtime/adapter-http.js`, `adapter-request.js`, `adapter-counters.js`, `adapter-server.js`
- Test: `tests/integration/adapter-server.test.js` (auth, paths, errors), `tests/integration/adapter-server-streams.test.js` (streams, keep-alive, idle, disconnect, shutdown)

**Interfaces:**

- Consumes: `createTranslator`, `classifyTransportError` (`protocol-adapter/translate.js`); `messagesErrorBody`, `responsesErrorBody` (`protocol-adapter/errors.js`); `resolveCapabilities` (`capabilities.js`); `createUpstreamClient`, `transportError` (Task 7); `authHeaders` (`endpoint-http.js`); `AdapterConfig` (Task 6).
- Produces:
  - `createAdapterServer(config, { keepaliveMs = 15_000, idleTimeoutMs = 240_000, maxBodyBytes = 32 * 1024 * 1024, lookup, now = Date.now } = {}) → { listen(port = 0) → Promise<number>, close() → Promise<void>, snapshot() → DiagnosticsSnapshot }`. `listen` binds `127.0.0.1` only.
  - `adapter-http.js`: `tokenMatches(expected, headers) → boolean`, `routeFor(client, method, pathname) → "inference" | "hello" | "notFound"`, `readBody(req, limit) → Promise<string | null>` (null = over limit), `writeRendered(res, rendered)`, `clientError(client, kind, message) → { status, headers, body }`.
  - `adapter-request.js`: `handleInference(ctx, req, res, rawBody) → Promise<void>`; `ctx = { client, upstream, translator, upstreamClient, upstreamAuth, secrets, timing: { keepaliveMs, idleTimeoutMs }, counters, now, retry? }` (`retry` is added in Task 9).
  - `adapter-counters.js`: `createAdapterCounters() → { count(group, name), increment(name), status(code), snapshot() }` with groups `requests`, `upstreamStatus`, `errors`, `capabilityFallbacks` and scalars `unauthorized`, `clientDisconnects`.
  - `createAdapterServer` also accepts `restarts` (number of supervisor restarts before this process, Task 10) and reports it.
  - `DiagnosticsSnapshot = { version: 1, startedAt, updatedAt, route: { client, upstream }, restarts, requests, unauthorized, upstreamStatus, errors, clientDisconnects, dropped, adjustments, compactionDropped, capabilityFallbacks, capabilities, estimatedUsage, cacheReadTokens }`.

Request rules:

- `HEAD /api/hello` → 200 empty, no token needed. Every other request needs the token (`x-api-key` or `Authorization: Bearer`), else 401 in the client's format, body fixed (`"invalid adapter token"`), counted `unauthorized`.
- Messages client: `POST /v1/messages` (query ignored) → inference; `GET /api/hello` → 200 empty; `POST /v1/messages/count_tokens` and everything else → 404 `not_found_error`. Responses client: `POST /responses`, `POST /v1/responses` → inference; everything else → 404 in Responses format. Count `requests[<pathname of known route> | "other"]`.
- Body over `maxBodyBytes` → 400 `invalidRequest` "request body exceeds 32 MB", `connection: close`.
- `requestId`: `msg_<32 hex>` (Messages) / `resp_<32 hex>` (Responses) from `randomBytes(16)`, unique per request; `buildUpstream(body, req.headers, { requestId, now: now() })`; invalid JSON → `body = null` (the translator renders the 400).
- Upstream headers: the translator's protocol headers + `authHeaders(apiKey, authHeader)` + `accept`. No client header is forwarded.
- Streaming Responses clients get `200 text/event-stream` immediately and keep-alives from then on; Messages clients get headers only after the upstream answered 2xx (HTTP error bodies stay possible, which Claude Code needs to recognize "prompt is too long"), and `event: ping` only after the first frame.
- Upstream status outside 2xx (incl. 3xx): read ≤ 1 MB text → `ctx.retry` (Task 9) → else `exchange.translateError({ status, body: text, headers }, { streaming, started })`.
- Transport failure: `exchange.fail(classifyTransportError(error, secrets), { streaming, started })`; counted `errors["transport.<kind>"]` unless the client already disconnected.
- Client disconnect (`res` closes before `writableFinished`): increment `clientDisconnects`, abort the upstream with `transportError("network", "client disconnected")`.
- 2xx streaming: pump `exchange.translateStream(response.chunks)` with backpressure (`drain` or `close`), re-arm keep-alive after each frame, stop on `res.destroyed`; non-streaming: `translateResponse(JSON.parse(text ≤ 32 MB) or null)`; `AdapterUpstreamError` → `error.clientError`.
- Any unexpected exception in a handler: 500 in client format if headers are unsent, else destroy the response; count `errors["adapter.internal"]`. The process never crashes on a request.
- `close()`: `server.close()`, `server.closeAllConnections()`, `upstreamClient.close()`, clear keep-alive timers; resolves within one event-loop turn of all sockets closing.

- [ ] **Step 1: Write the failing tests**

`tests/integration/adapter-server.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createAdapterServer } from "../../server/features/adapter-runtime/adapter-server.js";
import { scriptedUpstream, sse, json } from "../helpers/scripted-upstream.js";
import { loadFixture } from "../helpers/protocol-adapter.js";
import {
  TOKEN,
  KEY,
  validAdapterConfig,
  authorized,
} from "../helpers/adapter-fixture.js";

async function start(t, upstream, overrides = {}, options = {}) {
  const config = validAdapterConfig({
    upstream: { baseUrl: upstream.base + "/v1", authHeader: null, apiKey: KEY },
    ...overrides,
  });
  const server = createAdapterServer(config, options);
  const port = await server.listen(0);
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${port}`, server };
}
const claudeBody = () => loadFixture("clients/claude-code/text.json").body;
const codexBody = () => loadFixture("clients/codex/text.json").body;

test("token auth: Bearer and x-api-key accepted, others 401 without echo", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const { url } = await start(t, up);
  const body = JSON.stringify(claudeBody());
  for (const headers of [{ authorization: `Bearer ${TOKEN}` }, { "x-api-key": TOKEN }])
    assert.equal(
      (
        await fetch(`${url}/v1/messages?beta=true`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body,
        })
      ).status,
      200,
    );
  for (const headers of [
    {},
    { authorization: `Bearer ${"u".repeat(43)}` },
    { authorization: "Bearer short" },
    { "x-api-key": KEY },
  ]) {
    const res = await fetch(`${url}/v1/messages`, { method: "POST", headers, body });
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.match(text, /authentication_error/);
    assert.equal(text.includes(KEY) || text.includes("Bearer"), false);
  }
  assert.equal(up.seen.length, 2);
});

test("hello probes and unknown paths", async (t) => {
  const up = await scriptedUpstream(t, () => assert.fail("no upstream call expected"));
  const { url } = await start(t, up);
  assert.equal((await fetch(`${url}/api/hello`, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(`${url}/api/hello`)).status, 401);
  assert.equal((await fetch(`${url}/api/hello`, { headers: authorized() })).status, 200);
  const counted = await fetch(`${url}/v1/messages/count_tokens`, {
    method: "POST",
    headers: authorized(),
    body: "{}",
  });
  assert.equal(counted.status, 404);
  assert.match(await counted.text(), /not_found_error/);
  assert.equal((await fetch(`${url}/v1/models`, { headers: authorized() })).status, 404);
});

test("Responses client paths and 404 format", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const { url } = await start(t, up, { clientProtocol: "responses" });
  for (const path of ["/responses", "/v1/responses"]) {
    const res = await fetch(url + path, {
      method: "POST",
      headers: authorized(),
      body: JSON.stringify(codexBody()),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /event: response\.completed/);
  }
  const missing = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: "{}",
  });
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /not_found_error/); // Responses error shape, not Anthropic
});

test("upstream sees only the real key and protocol headers", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const { url } = await start(t, up);
  await (
    await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: authorized({ "anthropic-beta": "x", "x-claude-code-session-id": "s" }),
      body: JSON.stringify(claudeBody()),
    })
  ).text();
  const headers = up.seen[0].headers;
  assert.equal(headers.authorization, `Bearer ${KEY}`);
  assert.equal(headers["anthropic-beta"], undefined);
  assert.equal(headers["x-claude-code-session-id"], undefined);
  assert.equal(JSON.stringify(up.seen[0]).includes(TOKEN), false);
  assert.equal(up.seen[0].url, "/v1/chat/completions");
});

test("context overflow maps per client", async (t) => {
  const overflow = loadFixture("upstreams/chat/context-vllm.json");
  const up = await scriptedUpstream(t, (_e, res) =>
    json(res, overflow.status ?? 400, overflow.body ?? overflow),
  );
  const messages = await start(t, up);
  const a = await fetch(`${messages.url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(claudeBody()),
  });
  assert.equal(a.status, 400);
  assert.match(await a.text(), /prompt is too long|exceed context limit/);
  const responses = await start(t, up, { clientProtocol: "responses" });
  const b = await fetch(`${responses.url}/v1/responses`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(codexBody()),
  });
  assert.equal(b.status, 200);
  assert.match(await b.text(), /context_length_exceeded/);
});

test("upstream messages are redacted and request bodies over the cap are refused", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    json(res, 400, { error: { message: `bad key ${KEY} ${TOKEN}` } }),
  );
  const { url } = await start(t, up, {}, { maxBodyBytes: 4096 });
  const text = await (
    await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: authorized(),
      body: JSON.stringify(claudeBody()).slice(0, 4000) + " ".repeat(10),
    })
  ).text();
  assert.equal(text.includes(KEY) || text.includes(TOKEN), false);
  const big = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: "x".repeat(5000),
  });
  assert.equal(big.status, 400);
});

test("non-streaming requests get a JSON message", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    json(res, 200, loadFixture("upstreams/messages/non-stream.json")),
  );
  const { url } = await start(t, up, {
    clientProtocol: "responses",
    upstreamProtocol: "messages",
    upstream: { baseUrl: up.base, authHeader: "x-api-key", apiKey: KEY },
  });
  const res = await fetch(`${url}/v1/responses`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify({ ...codexBody(), stream: false }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).object, "response");
  assert.equal(up.seen[0].headers["x-api-key"], KEY);
});
```

(The redaction test's first body must be valid JSON; build it with `JSON.stringify({ ...claudeBody(), messages: [...] })` sized under 4096 instead of slicing — the slice above only illustrates the size intent.)

`tests/integration/adapter-server-streams.test.js` — write these tests with the same `start` helper (copy it; tests must stay independent):

1. **Keep-alive (Messages):** upstream writes headers + first chat chunk, waits 250 ms, writes the rest; `keepaliveMs: 50` → body contains `event: ping` **after** `event: message_start` and ends with `event: message_stop`.
2. **Keep-alive (Responses, before upstream headers):** upstream waits 250 ms before `writeHead`; `keepaliveMs: 50` → body starts with `event: response.in_progress` and ends with `response.completed`; every `sequence_number` is strictly increasing.
3. **Idle timeout mid-stream:** upstream writes one chunk then hangs; `idleTimeoutMs: 100` → Messages body ends with `event: error`; `server.snapshot().errors["stream.timeout"] === 1`; the upstream request is closed (`up.seen[0].closed` becomes true within 1 s).
4. **Idle timeout before headers (Responses):** upstream hangs → `response.failed` frame in a 200 SSE body; `errors["transport.timeout"] === 1`.
5. **Client disconnect:** use `http.request` to the adapter; after the first frame `req.destroy()`; within 1 s the upstream request is closed; snapshot `clientDisconnects === 1`, no `stream.timeout`/`transport.timeout` entries.
6. **Concurrent requests (Review Focus 4):** start two streaming requests whose upstream answers slowly; disconnect the first; the second completes with `message_stop`; the two `message_start` ids differ.
7. **Shutdown with open sockets:** one hanging stream open; `await server.close()` resolves in < 1 s; the client's fetch body rejects or ends; the upstream request is closed.
8. **Diagnostics snapshot:** after a request with a hosted tool dropped (Codex `web-search-disabled.json` is clean; use `clients/codex/mcp.json` or inject a `{ type: "web_search" }` tool) the snapshot has `dropped` counts and `requests["/v1/responses"] === 1`; `JSON.stringify(snapshot)` contains neither the prompt text, `KEY` nor `TOKEN`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/integration/adapter-server.test.js tests/integration/adapter-server-streams.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `adapter-http.js` and `adapter-counters.js`**

```js
// adapter-http.js
import { createHash, timingSafeEqual } from "node:crypto";
import { messagesErrorBody, responsesErrorBody } from "../protocol-adapter/errors.js";

const digest = (value) => createHash("sha256").update(value).digest();

export function tokenMatches(expected, headers) {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(headers.authorization ?? "")?.[1];
  const candidates = [headers["x-api-key"], bearer].filter((v) => typeof v === "string");
  let ok = false;
  for (const candidate of candidates)
    ok = timingSafeEqual(digest(candidate), digest(expected)) || ok;
  return ok;
}

export function routeFor(client, method, pathname) {
  if (pathname === "/api/hello" && (method === "GET" || method === "HEAD"))
    return "hello";
  if (method !== "POST") return "notFound";
  if (client === "messages")
    return pathname === "/v1/messages" ? "inference" : "notFound";
  return pathname === "/responses" || pathname === "/v1/responses"
    ? "inference"
    : "notFound";
}

export function clientError(client, kind, message) {
  const rendered = (client === "messages" ? messagesErrorBody : responsesErrorBody)({
    kind,
    status: null,
    message,
  });
  return {
    ...rendered,
    headers: { "content-type": "application/json", ...rendered.headers },
  };
}

export function writeRendered(res, rendered) {
  if (rendered === null || res.destroyed) return;
  if (typeof rendered === "string") return void res.end(rendered); // in-stream frames are terminal
  if (!res.headersSent) res.writeHead(rendered.status, rendered.headers);
  res.end(
    typeof rendered.body === "string" ? rendered.body : JSON.stringify(rendered.body),
  );
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners("data");
        req.resume();
        resolve(null);
      } else chunks.push(chunk);
    });
    req.on("end", () => size <= limit && resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
```

Verify `messagesErrorBody`/`responsesErrorBody` accept `{ kind, status: null, message }` and derive the status from `kind` (read `errors.js:384-437`); if they need `status`, pass 401/404/400 explicitly.

`adapter-counters.js`: plain objects; `status(code)` increments `upstreamStatus["<n>xx"]`; `snapshot()` returns `structuredClone`.

- [ ] **Step 4: Implement `adapter-request.js`**

```js
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { classifyTransportError } from "../protocol-adapter/translate.js";
import { transportError } from "../providers/endpoint-stream.js";
import { writeRendered } from "./adapter-http.js";

const SSE = { "content-type": "text/event-stream", "cache-control": "no-cache" };
const MAX_ERROR_TEXT = 1024 * 1024;
const MAX_JSON_TEXT = 32 * 1024 * 1024;
const ok = (status) => status >= 200 && status < 300;
const newRequestId = (client) =>
  `${client === "messages" ? "msg" : "resp"}_${randomBytes(16).toString("hex")}`;

function keepalives(res, current, ms) {
  let timer = null,
    stopped = false;
  const arm = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!stopped && !res.destroyed) {
        res.write(current().keepalive());
        arm();
      }
    }, ms);
  };
  return {
    arm,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

export async function send(ctx, request, streaming, signal) {
  try {
    const response = await ctx.upstreamClient.request({
      path: request.path,
      body: request.body,
      signal,
      idleTimeoutMs: ctx.timing.idleTimeoutMs,
      headers: {
        ...request.headers,
        ...ctx.upstreamAuth,
        accept: streaming ? "text/event-stream" : "application/json",
      },
    });
    ctx.counters.status(response.status);
    return { response };
  } catch (error) {
    const failure = classifyTransportError(error, ctx.secrets);
    if (!signal.aborted) ctx.counters.count("errors", `transport.${failure.kind}`);
    return { failure };
  }
}

export async function handleInference(ctx, req, res, rawBody) {
  const requestId = newRequestId(ctx.client);
  let body = null;
  try {
    body = JSON.parse(rawBody);
  } catch {}
  const built = ctx.translator.buildUpstream(body, req.headers, {
    requestId,
    now: ctx.now(),
  });
  if (!built.ok) return writeRendered(res, built.error);
  const streaming = body?.stream === true;
  const started = streaming && ctx.client === "responses";
  let exchange = built.exchange;
  const controller = new AbortController();
  res.on("close", () => {
    if (res.writableFinished) return;
    ctx.counters.increment("clientDisconnects");
    controller.abort(transportError("network", "client disconnected"));
  });
  const pings = keepalives(res, () => exchange, ctx.timing.keepaliveMs);
  if (started) {
    res.writeHead(200, SSE);
    pings.arm();
  }
  const render = (rendered) => writeRendered(res, rendered);
  try {
    const first = await send(ctx, built.request, streaming, controller.signal);
    if (first.failure)
      return render(exchange.fail(first.failure, { streaming, started }));
    let { response } = first;
    if (!ok(response.status)) {
      let text = "";
      try {
        text = await response.text(MAX_ERROR_TEXT);
      } catch {}
      const outcome =
        (await ctx.retry?.({
          body,
          headers: req.headers,
          requestId,
          streaming,
          status: response.status,
          text,
          responseHeaders: response.headers,
          signal: controller.signal,
        })) ?? null;
      if (outcome?.ok) ({ response, exchange } = outcome);
      else {
        const last = outcome ?? {
          exchange,
          status: response.status,
          text,
          headers: response.headers,
        };
        if (outcome?.exchange) exchange = outcome.exchange;
        return render(
          last.failure
            ? last.exchange.fail(last.failure, { streaming, started })
            : last.exchange.translateError(
                { status: last.status, body: last.text, headers: last.headers },
                { streaming, started },
              ),
        );
      }
    }
    if (!streaming) return await respondJson(res, exchange, response, ctx);
    if (!started) res.writeHead(200, SSE);
    for await (const frame of exchange.translateStream(response.chunks)) {
      if (res.destroyed) break;
      if (!res.write(frame)) await Promise.race([once(res, "drain"), once(res, "close")]);
      pings.arm();
    }
    if (!res.destroyed) res.end();
  } finally {
    pings.stop();
  }
}

async function respondJson(res, exchange, response, ctx) {
  let text;
  try {
    text = await response.text(MAX_JSON_TEXT);
  } catch (error) {
    return writeRendered(
      res,
      exchange.fail(classifyTransportError(error, ctx.secrets), { streaming: false }),
    );
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  try {
    const clientBody = await exchange.translateResponse(json);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(clientBody));
  } catch (error) {
    if (!error?.clientError) throw error;
    writeRendered(res, error.clientError);
  }
}
```

Retry outcome contract (implemented in Task 9): `null` = no retry; `{ ok: true, response, exchange }`; `{ ok: false, exchange, status, text, headers }` (retry answered with an error) or `{ ok: false, exchange, failure }` (retry transport failure).

- [ ] **Step 5: Implement `adapter-server.js`**

```js
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createTranslator } from "../protocol-adapter/translate.js";
import { resolveCapabilities } from "../protocol-adapter/capabilities.js";
import { authHeaders } from "../providers/endpoint-http.js";
import { createUpstreamClient } from "../providers/endpoint-stream.js";
import { createAdapterCounters } from "./adapter-counters.js";
import {
  clientError,
  readBody,
  routeFor,
  tokenMatches,
  writeRendered,
} from "./adapter-http.js";
import { handleInference } from "./adapter-request.js";

export function createAdapterServer(config, options = {}) {
  const {
    keepaliveMs = 15_000,
    idleTimeoutMs = 240_000,
    maxBodyBytes = 32 * 1024 * 1024,
    lookup,
    now = Date.now,
    restarts = 0,
  } = options;
  const client = config.clientProtocol,
    upstream = config.upstreamProtocol;
  const secrets = [config.upstream.apiKey, config.token].filter(Boolean);
  const translator = createTranslator({
    client,
    upstream,
    model: config.model,
    capabilities: config.capabilities,
    thinkTagExtraction: config.thinkTagExtraction,
    sessionKey: randomUUID(),
    secrets,
  });
  const capabilities = resolveCapabilities(upstream, config.capabilities);
  const counters = createAdapterCounters();
  const upstreamClient = createUpstreamClient({
    baseUrl: config.upstream.baseUrl,
    lookup,
  });
  const startedAt = new Date(now()).toISOString();
  const ctx = {
    client,
    upstream,
    translator,
    upstreamClient,
    secrets,
    counters,
    now,
    upstreamAuth: authHeaders(config.upstream.apiKey, config.upstream.authHeader),
    timing: { keepaliveMs, idleTimeoutMs },
    capabilities,
    setCapability(name, value) {
      translator.setCapability(name, value);
      capabilities[name] = value;
    },
    onDone: () => {},
  };
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://adapter.invalid");
      const route = routeFor(client, req.method, pathname);
      if (route === "hello" && req.method === "HEAD")
        return void res.writeHead(200).end();
      if (!tokenMatches(config.token, req.headers)) {
        counters.increment("unauthorized");
        req.resume();
        return writeRendered(res, clientError(client, "auth", "invalid adapter token"));
      }
      if (route === "hello") return void res.writeHead(200).end();
      counters.count("requests", route === "inference" ? pathname : "other");
      if (route !== "inference") {
        req.resume();
        return writeRendered(res, clientError(client, "notFound", "not found"));
      }
      const raw = await readBody(req, maxBodyBytes);
      if (raw === null) {
        res.setHeader("connection", "close");
        return writeRendered(
          res,
          clientError(client, "invalidRequest", "request body exceeds 32 MB"),
        );
      }
      await handleInference(ctx, req, res, raw);
    } catch {
      counters.count("errors", "adapter.internal");
      if (!res.headersSent)
        writeRendered(res, clientError(client, "server", "adapter error"));
      else res.destroy();
    } finally {
      ctx.onDone();
    }
  });
  function snapshot() {
    const t = translator.diagnostics();
    const c = counters.snapshot();
    return {
      version: 1,
      startedAt,
      updatedAt: new Date(now()).toISOString(),
      route: { client, upstream },
      restarts,
      requests: c.requests,
      unauthorized: c.unauthorized,
      upstreamStatus: c.upstreamStatus,
      errors: { ...t.errors, ...c.errors },
      clientDisconnects: c.clientDisconnects,
      dropped: t.dropped,
      adjustments: t.adjustments,
      compactionDropped: t.dropped["input.compaction"] ?? 0,
      capabilityFallbacks: c.capabilityFallbacks,
      capabilities: { ...capabilities },
      estimatedUsage: t.estimatedUsage,
      cacheReadTokens: t.cacheReadTokens ?? 0,
    };
  }
  return {
    ctx, // Task 9 attaches retry and diagnostics hooks
    snapshot,
    listen: (port = 0) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve(server.address().port));
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        upstreamClient.close();
      }),
  };
}
```

Keep `adapter-server.js` < 200 lines; if the `http.createServer` callback grows, move it to `adapter-http.js` as `dispatch(ctx, config, req, res)`.

- [ ] **Step 6: Run tests**

Run: `node --test tests/integration/adapter-server.test.js tests/integration/adapter-server-streams.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/features/adapter-runtime tests/integration/adapter-server*.test.js tests/helpers/adapter-fixture.js
git commit -m "feat: serve one session's protocol translation over a loopback adapter server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Capability retry, diagnostics file and cache-read counting

**Files:**

- Create: `server/features/adapter-runtime/adapter-retry.js`, `server/features/adapter-runtime/adapter-diagnostics.js`
- Modify: `server/features/adapter-runtime/adapter-server.js`, `server/features/protocol-adapter/translate.js` (`observe`, `stats`, `diagnostics`)
- Test: `tests/integration/adapter-retry.test.js`, `tests/unit/adapter-diagnostics.test.js`, `tests/unit/protocol-adapter/translate-diagnostics.test.js`

**Interfaces:**

- Consumes: `capabilityForError` (`translate.js` re-export), `classifyUpstreamError` (`errors.js`), `send` and the retry outcome contract (Task 8).
- Produces:
  - `createRetry(ctx) → (attempt) → Promise<RetryOutcome | null>` assigned to `ctx.retry` by `createAdapterServer`.
  - `createDiagnosticsWriter({ path, intervalMs = 5000, snapshot, now = Date.now }) → { touch(), flush() → Promise<void> }`; `path === null` → no-op.
  - `translator.diagnostics().cacheReadTokens: number` (sum over exchanges of the highest cumulative `cacheRead` each reported).
  - `createAdapterServer(...).close()` flushes diagnostics; `ctx.onDone` = `writer.touch`.

Retry rules: classify `(status, text, responseHeaders)` with `classifyUpstreamError({ protocol: upstream, status, body: text, headers, secrets })`; `change = capabilityForError(upstream, irError)`; no retry when `change` is null or `ctx.capabilities[change.name] === change.value`. Otherwise `previous = ctx.capabilities[change.name]`, `ctx.setCapability(change.name, change.value)`, rebuild with `translator.buildUpstream(body, headers, { requestId, now })` (same requestId: the first exchange never wrote a frame), `send(...)`. 2xx → `{ ok: true, response, exchange }`, count `capabilityFallbacks["<name>=<value>"].kept` (object `{ kept, reverted }`). Otherwise restore `previous`, count `reverted`, read the retry's error text and return `{ ok: false, exchange, status, text, headers }` (or `{ ok: false, exchange, failure }` on transport failure). A rebuilt request rejected by the translator restores `previous` and returns `null`. Exactly one retry per request.

- [ ] **Step 1: Write the failing tests**

```js
// tests/integration/adapter-retry.test.js (start() copied from adapter-server.test.js)
test("Responses upstream rejecting reasoning: retry once, keep the fallback after success", async (t) => {
  const up = await scriptedUpstream(t, (entry, res) => {
    if (entry.body.reasoning)
      return json(res, 400, {
        error: {
          message: "Unsupported parameter: 'reasoning.effort'",
          param: "reasoning.effort",
          code: "unsupported_parameter",
        },
      });
    sse(res, loadFixture("upstreams/responses/text.sse"));
  });
  const { url, server } = await start(t, up, { upstreamProtocol: "responses" });
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: authorized(),
      body: JSON.stringify(claudeBody()),
    });
    assert.match(await res.text(), /event: message_stop/);
  }
  assert.deepEqual(
    up.seen.map((e) => !!e.body.reasoning),
    [true, false, false],
  );
  assert.deepEqual(server.snapshot().capabilityFallbacks["reasoningEffort=false"], {
    kept: 1,
    reverted: 0,
  });
  assert.equal(server.snapshot().capabilities.reasoningEffort, false);
});

test("a failed retry restores the previous capability and shows the retry's error", async (t) => {
  const up = await scriptedUpstream(t, (entry, res) =>
    entry.body.reasoning
      ? json(res, 400, {
          error: { message: "Unsupported parameter: 'reasoning'", param: "reasoning" },
        })
      : json(res, 400, { error: { message: "model not loaded" } }),
  );
  const { url, server } = await start(t, up, { upstreamProtocol: "responses" });
  const res = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(claudeBody()),
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /model not loaded/);
  await (
    await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: authorized(),
      body: JSON.stringify(claudeBody()),
    })
  ).text();
  assert.deepEqual(
    up.seen.map((e) => !!e.body.reasoning),
    [true, false, true, false],
  );
  assert.deepEqual(server.snapshot().capabilityFallbacks["reasoningEffort=false"], {
    kept: 0,
    reverted: 2,
  });
});

test("Chat max_tokens rejection switches to max_completion_tokens", async (t) => {
  const up = await scriptedUpstream(t, (entry, res) =>
    "max_tokens" in entry.body
      ? json(res, 400, {
          error: {
            message:
              "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            param: "max_tokens",
          },
        })
      : sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const { url } = await start(t, up);
  assert.match(
    await (
      await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: authorized(),
        body: JSON.stringify(claudeBody()),
      })
    ).text(),
    /message_stop/,
  );
  assert.equal("max_completion_tokens" in up.seen[1].body, true);
});

test("no retry for errors that name no capability, and never more than one retry", async (t) => {
  // (a) 400 "model not found" → exactly one upstream request;
  // (b) upstream rejects reasoning first, then (without reasoning) rejects prompt_cache_key → 2 upstream requests, client sees the second error.
});

test("a retry in one request does not break a concurrent stream (Review Focus 4)", async (t) => {
  // request A streams slowly from a chat upstream; request B triggers the maxTokensField retry meanwhile;
  // A completes with message_stop and B succeeds.
});
```

Write (a)/(b) and the concurrency test fully in the same style.

`tests/unit/adapter-diagnostics.test.js`: with `intervalMs: 50` and a counter-backed `snapshot`, ten `touch()` calls within 20 ms produce one write; another `touch()` after 60 ms produces a second; `flush()` writes immediately; the file mode is `0o600`; a `.tmp` file never remains; `path: null` writes nothing; a missing directory does not throw.

`tests/unit/protocol-adapter/translate-diagnostics.test.js`: build a translator (`client: "messages"`, `upstream: "chat"`), run one exchange over `upstreams/chat/usage-cached.sse` with `translateStream`, assert `diagnostics().cacheReadTokens` equals the fixture's `cached_tokens`; a second exchange adds to it; an exchange that reports cumulative usage twice (e.g. Responses `cached-usage.sse`) is counted once.

Also add to `adapter-server-streams.test.js`: a Codex request containing `{ type: "compaction", encrypted_content: "x" }` as the first input item yields `snapshot().compactionDropped === 1` (confirm the drop name `input.compaction` in `client-responses.js:233-237`).

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/integration/adapter-retry.test.js tests/unit/adapter-diagnostics.test.js tests/unit/protocol-adapter/translate-diagnostics.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `translate.js`: `stats` gains `cacheReadTokens: 0`; in `observe` keep `let cacheRead = 0;` per exchange and on `usage` events with a finite `event.cacheRead > cacheRead` add the difference to `stats.cacheReadTokens`; `diagnostics()` returns `cacheReadTokens`. Update the JSDoc line for `diagnostics()`.
- `adapter-retry.js`:

```js
import { capabilityForError } from "../protocol-adapter/translate.js";
import { classifyUpstreamError } from "../protocol-adapter/errors.js";
import { send } from "./adapter-request.js";

export function createRetry(ctx) {
  const tally = (change, outcome) =>
    ctx.counters.fallback(`${change.name}=${change.value}`, outcome);
  return async ({
    body,
    headers,
    requestId,
    streaming,
    status,
    text,
    responseHeaders,
    signal,
  }) => {
    const error = classifyUpstreamError({
      protocol: ctx.upstream,
      status,
      body: text,
      headers: responseHeaders,
      secrets: ctx.secrets,
    });
    const change = capabilityForError(ctx.upstream, error);
    if (!change || ctx.capabilities[change.name] === change.value) return null;
    const previous = ctx.capabilities[change.name];
    ctx.setCapability(change.name, change.value);
    const rebuilt = ctx.translator.buildUpstream(body, headers, {
      requestId,
      now: ctx.now(),
    });
    if (!rebuilt.ok) {
      ctx.setCapability(change.name, previous);
      return null;
    }
    const attempt = await send(ctx, rebuilt.request, streaming, signal);
    if (
      attempt.response &&
      attempt.response.status >= 200 &&
      attempt.response.status < 300
    ) {
      tally(change, "kept");
      return { ok: true, response: attempt.response, exchange: rebuilt.exchange };
    }
    ctx.setCapability(change.name, previous);
    tally(change, "reverted");
    if (attempt.failure)
      return { ok: false, exchange: rebuilt.exchange, failure: attempt.failure };
    let retryText = "";
    try {
      retryText = await attempt.response.text(1024 * 1024);
    } catch {}
    return {
      ok: false,
      exchange: rebuilt.exchange,
      status: attempt.response.status,
      text: retryText,
      headers: attempt.response.headers,
    };
  };
}
```

Add `fallback(name, outcome)` to `adapter-counters.js` (`capabilityFallbacks[name] ??= { kept: 0, reverted: 0 }`). Restoring `previous` when another request changed the same capability in between is accepted (documented in a comment).

- `adapter-diagnostics.js`:

```js
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

async function writeAtomic(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function createDiagnosticsWriter({
  path: file,
  intervalMs = 5000,
  snapshot,
  now = Date.now,
}) {
  let last = -Infinity,
    timer = null,
    chain = Promise.resolve();
  const write = () => {
    timer = null;
    last = now();
    const text = JSON.stringify(snapshot());
    chain = chain.then(() => writeAtomic(file, text)).catch(() => {});
    return chain;
  };
  return {
    touch() {
      if (!file || timer) return;
      timer = setTimeout(write, Math.max(0, last + intervalMs - now()));
      timer.unref();
    },
    async flush() {
      if (!file) return;
      clearTimeout(timer);
      await write();
    },
  };
}
```

- `adapter-server.js`: `ctx.retry = createRetry(ctx)`; `const writer = createDiagnosticsWriter({ path: config.diagnosticsPath, snapshot, now })`; `ctx.onDone = () => writer.touch()`; also `writer.touch()` after each unauthorized request; `close()` awaits `writer.flush()` after the sockets closed.

- [ ] **Step 4: Run tests**

Run: `node --test tests/integration/adapter-retry.test.js tests/unit/adapter-diagnostics.test.js tests/unit/protocol-adapter tests/integration/adapter-server*.test.js tests/integration/protocol-adapter-directions*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/adapter-runtime server/features/protocol-adapter/translate.js tests
git commit -m "feat: retry rejected optional parameters once and write adapter diagnostics

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Adapter process entry point and supervisor

**Files:**

- Create: `server/adapter-process.js`, `server/features/adapter-runtime/adapter-supervisor.js`
- Test: `tests/integration/adapter-process.test.js`

**Interfaces:**

- Consumes: `validateAdapterConfig` (Task 6), `createAdapterServer` (Tasks 8–9), fact R5.
- Produces (`adapter-supervisor.js`):
  - `ADAPTER_ENTRY` (absolute path of `server/adapter-process.js`, derived from the module URL)
  - `adapterExecArgv(flags = process.allowedNodeEnvironmentFlags) → string[]` (`["--use-system-ca"]` or `[]`)
  - `adapterEnvironment(cliEnv = {}, own = process.env) → { PATH, NODE_EXTRA_CA_CERTS? }` (never proxies, never keys)
  - `startAdapter(config, { entry = ADAPTER_ENTRY, timeoutMs = 10_000, cliEnv, signal, execArgv, restart: { max = 3, windowMs = 60_000, delayMs = 250 } = {} } = {}) → Promise<SupervisedAdapter>`; rejects with `Error` whose `reason ∈ timeout|config|bind|exited|spawn|aborted`.
  - `SupervisedAdapter = { port, url, child /* current child, replaced on restart */, restarts() → number, stop({ graceMs = 2000 } = {}) → Promise<void> }`.
  - `spawnAdapter(config, { entry, timeoutMs, cliEnv, signal, execArgv, port = 0, restarts = 0 }) → Promise<ChildProcess>` (one start attempt; used for the first start and every restart).
  - `substituteAdapterUrl({ env, args }, url) → { env, args }` (replaces every `__AGENTPIER_ADAPTER_URL__` substring in env values and args).
- IPC protocol: launcher → adapter `{ type: "start", config, port, restarts }` once after `spawn` (`port` 0 on the first start, the original port on restarts; `restarts` = restarts so far, shown in the snapshot); adapter → launcher `{ type: "ready", port }` or `{ type: "failed", reason: "config" | "bind" }`. A restart is ready only when the reported port equals the original port.
- Restart policy: an adapter exit the supervisor did not cause (crash, SIGKILL, OOM) triggers a restart after `delayMs` with the **same** `config` (same token) on the **same** port. Every attempt — successful or not (bind failure because the port was taken, start timeout) — consumes one unit of the budget: at most `max` attempts within any sliding `windowMs`. A failed attempt is retried after `delayMs` while budget remains. When the budget is spent the supervisor stops trying and merges `{ supervisor: { restarts, gaveUpAt, lastReason } }` into the diagnostics file (atomic, mode 0600; read-modify-write of the adapter's last snapshot). The CLI is never touched and nothing is written to stdio. `stop()` during a pending restart cancels the timer, kills a starting child, and resolves once no adapter child remains. The adapter exits on `SIGTERM` (graceful close) and on IPC `disconnect` (launcher died); it ignores `SIGINT`, `SIGQUIT`, `SIGHUP`; `stdio` is `["ignore", "ignore", "ignore", "ipc"]`; it is spawned `detached: true` (own process group: terminal Ctrl+C never reaches it); `uncaughtException`/`unhandledRejection` → close, exit 70.

- [ ] **Step 1: Write the failing tests**

```js
// tests/integration/adapter-process.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import {
  startAdapter,
  adapterExecArgv,
  adapterEnvironment,
  substituteAdapterUrl,
} from "../../server/features/adapter-runtime/adapter-supervisor.js";
import { scriptedUpstream, sse } from "../helpers/scripted-upstream.js";
import { loadFixture } from "../helpers/protocol-adapter.js";
import { KEY, validAdapterConfig, authorized } from "../helpers/adapter-fixture.js";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail("condition not reached");
}

test("the adapter process serves one session and keeps the key out of argv, env and stdio", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-process-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const adapter = await startAdapter(
    validAdapterConfig({
      upstream: { baseUrl: `${up.base}/v1`, authHeader: null, apiKey: KEY },
      diagnosticsPath: path.join(dir, "s.adapter.json"),
    }),
    {
      cliEnv: {
        NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
        HTTPS_PROXY: "http://proxy:1",
        AGENTPIER_ENDPOINT_API_KEY: KEY,
      },
    },
  );
  t.after(() => adapter.stop());
  assert.equal(adapter.child.stdout, null);
  assert.equal(adapter.child.stderr, null);
  const argv = execFileSync("ps", ["-o", "args=", "-p", String(adapter.child.pid)], {
    encoding: "utf8",
  });
  assert.equal(argv.includes(KEY), false);
  assert.match(argv, /adapter-process\.js/);
  const res = await fetch(`${adapter.url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(loadFixture("clients/claude-code/text.json").body),
  });
  assert.match(await res.text(), /message_stop/);
  await adapter.stop();
  assert.equal(alive(adapter.child.pid), false);
  const diagnostics = fs.readFileSync(path.join(dir, "s.adapter.json"), "utf8");
  assert.equal(diagnostics.includes(KEY), false);
  assert.equal(JSON.parse(diagnostics).requests["/v1/messages"], 1);
});

test("environment and exec args", () => {
  assert.deepEqual(adapterExecArgv(new Set(["--use-system-ca"])), ["--use-system-ca"]);
  assert.deepEqual(adapterExecArgv(new Set()), []);
  assert.deepEqual(
    adapterEnvironment(
      { NODE_EXTRA_CA_CERTS: "/ca.pem", HTTPS_PROXY: "x", K: KEY },
      { PATH: "/bin" },
    ),
    { PATH: "/bin", NODE_EXTRA_CA_CERTS: "/ca.pem" },
  );
});

test("substitution touches env values and args only", () => {
  const out = substituteAdapterUrl(
    {
      env: { A: "__AGENTPIER_ADAPTER_URL__", B: "x" },
      args: ["-c", 'p={base_url="__AGENTPIER_ADAPTER_URL__/v1"}'],
    },
    "http://127.0.0.1:5",
  );
  assert.deepEqual(out, {
    env: { A: "http://127.0.0.1:5", B: "x" },
    args: ["-c", 'p={base_url="http://127.0.0.1:5/v1"}'],
  });
});

test("startup failures: invalid config, silent child, bind timeout", async (t) => {
  await assert.rejects(startAdapter({ token: "x" }), { reason: "config" });
  const silent = path.join(os.tmpdir(), `agentpier-silent-${process.pid}.mjs`);
  fs.writeFileSync(silent, "setInterval(() => {}, 1000);\n");
  t.after(() => fs.rmSync(silent, { force: true }));
  const started = Date.now();
  await assert.rejects(
    startAdapter(validAdapterConfig(), { entry: silent, timeoutMs: 200 }),
    { reason: "timeout" },
  );
  assert.ok(Date.now() - started < 2000);
});

test("stop escalates to SIGKILL after the grace period", async (t) => {
  const stubborn = path.join(os.tmpdir(), `agentpier-stubborn-${process.pid}.mjs`);
  fs.writeFileSync(
    stubborn,
    `process.on("SIGTERM", () => {});
process.once("message", () => process.send({ type: "ready", port: 1 }));
setInterval(() => {}, 1000);\n`,
  );
  t.after(() => fs.rmSync(stubborn, { force: true }));
  const adapter = await startAdapter(validAdapterConfig(), { entry: stubborn });
  const started = Date.now();
  await adapter.stop({ graceMs: 200 });
  assert.ok(Date.now() - started >= 180);
  assert.equal(alive(adapter.child.pid), false);
});

test("the adapter exits when its launcher dies", async (t) => {
  // spawn `node -e` script that imports startAdapter, starts it, prints the adapter pid, then waits;
  // SIGKILL that parent; until(() => !alive(adapterPid)).
});

test("SIGINT does not stop the adapter", async (t) => {
  // start an adapter; process.kill(adapter.child.pid, "SIGINT"); wait 200 ms; hello HEAD still returns 200.
});

test("a crashed adapter is restarted on the same port with the same token", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const adapter = await startAdapter(
    validAdapterConfig({
      upstream: { baseUrl: `${up.base}/v1`, authHeader: null, apiKey: KEY },
    }),
    { restart: { delayMs: 50 } },
  );
  t.after(() => adapter.stop());
  const { url } = adapter;
  const first = adapter.child.pid;
  process.kill(first, "SIGKILL");
  await until(() => adapter.child.pid !== first && adapter.restarts() === 1);
  assert.equal(adapter.url, url);
  const res = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(loadFixture("clients/claude-code/text.json").body),
  });
  assert.match(await res.text(), /message_stop/);
});

test("the restart budget is bounded and a taken port counts as a failed restart", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-budget-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const diagnosticsPath = path.join(dir, "s.adapter.json");
  const adapter = await startAdapter(validAdapterConfig({ diagnosticsPath }), {
    restart: { max: 3, windowMs: 60_000, delayMs: 300 },
  });
  t.after(() => adapter.stop());
  // 1st crash: occupy the port during the restart delay → bind failure consumes one attempt; release it → next attempt succeeds
  let pid = adapter.child.pid;
  process.kill(pid, "SIGKILL");
  const blocker = net.createServer().listen(adapter.port, "127.0.0.1");
  await once(blocker, "listening");
  await new Promise((r) => setTimeout(r, 400));
  blocker.close();
  await until(() => adapter.child.pid !== pid && alive(adapter.child.pid), 3000);
  // 2nd crash consumes the 3rd attempt
  pid = adapter.child.pid;
  process.kill(pid, "SIGKILL");
  await until(() => adapter.child.pid !== pid);
  // 3rd crash: budget spent → no new child, diagnostics record the give-up
  pid = adapter.child.pid;
  process.kill(pid, "SIGKILL");
  await until(
    () => JSON.parse(fs.readFileSync(diagnosticsPath, "utf8")).supervisor?.gaveUpAt,
    3000,
  );
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(adapter.child.pid, pid, "no further restart");
  const record = JSON.parse(fs.readFileSync(diagnosticsPath, "utf8")).supervisor;
  assert.equal(record.restarts, 3);
  assert.equal(fs.statSync(diagnosticsPath).mode & 0o777, 0o600);
});

test("stop during a pending restart leaves no adapter behind", async (t) => {
  const adapter = await startAdapter(validAdapterConfig(), { restart: { delayMs: 300 } });
  const pid = adapter.child.pid;
  process.kill(pid, "SIGKILL");
  await until(() => !alive(pid));
  await adapter.stop(); // inside the restart delay
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(adapter.child.pid, pid, "no restart after stop");
  assert.equal(
    await fetch(`${adapter.url}/api/hello`, { method: "HEAD" }).catch(() => null),
    null,
  );
});
```

Import `net` from `node:net` and `once` from `node:events` in this test file. If the budget test exceeds ~120 lines with its helpers, move the three restart tests to `tests/integration/adapter-restart.test.js` (keeps both files < 600 lines).

Write the parent-death and SIGINT tests fully (the parent-death test uses `spawn(process.execPath, ["--input-type=module", "-e", script])` with `stdio: ["ignore", "pipe", "inherit"]` and reads the pid from stdout).

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/integration/adapter-process.test.js`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the supervisor**

```js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ADAPTER_URL_PLACEHOLDER } from "../providers/adapter-launch.js";

export const ADAPTER_ENTRY = fileURLToPath(
  new URL("../../adapter-process.js", import.meta.url),
);

export const adapterExecArgv = (flags = process.allowedNodeEnvironmentFlags) =>
  flags.has("--use-system-ca") ? ["--use-system-ca"] : [];

export function adapterEnvironment(cliEnv = {}, own = process.env) {
  const env = { PATH: own.PATH || "/usr/bin:/bin" };
  const ca = cliEnv.NODE_EXTRA_CA_CERTS || own.NODE_EXTRA_CA_CERTS;
  if (ca) env.NODE_EXTRA_CA_CERTS = ca;
  return env;
}

export function substituteAdapterUrl({ env = {}, args = [] }, url) {
  const swap = (value) => value.replaceAll(ADAPTER_URL_PLACEHOLDER, url);
  return {
    env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, swap(v)])),
    args: args.map(swap),
  };
}

const running = (child) => child.exitCode === null && child.signalCode === null;
const exitOf = (child) =>
  running(child)
    ? new Promise((resolve) => child.once("exit", () => resolve()))
    : Promise.resolve();

export async function startAdapter(config, options = {}) {
  const { restart: { max = 3, windowMs = 60_000, delayMs = 250 } = {}, ...spawnOptions } =
    options;
  let child = await spawnAdapter(config, spawnOptions);
  const port = child.adapterPort;
  const attempts = []; // timestamps of restart attempts (sliding window)
  let total = 0,
    stopping = false,
    timer = null,
    starting = null,
    lastReason = "exited";
  const scheduleRestart = () => {
    if (stopping) return;
    const now = Date.now();
    while (attempts.length && now - attempts[0] > windowMs) attempts.shift();
    if (attempts.length >= max)
      return void recordGiveUp(config.diagnosticsPath, { restarts: total, lastReason });
    timer = setTimeout(async () => {
      timer = null;
      if (stopping) return;
      attempts.push(Date.now());
      total += 1;
      const controller = new AbortController();
      starting = controller;
      try {
        const next = await spawnAdapter(config, {
          ...spawnOptions,
          signal: controller.signal,
          port,
          restarts: total,
        });
        starting = null;
        if (stopping) {
          next.kill("SIGKILL");
          return;
        }
        if (next.adapterPort !== port) {
          next.kill("SIGKILL");
          lastReason = "bind";
          return scheduleRestart();
        }
        watch(next);
      } catch (error) {
        starting = null;
        lastReason = error.reason ?? "exited";
        scheduleRestart(); // a failed rebind or start timeout consumed this attempt
      }
    }, delayMs);
  };
  const watch = (next) => {
    child = next;
    next.once("exit", () => {
      if (!stopping && next === child) {
        lastReason = "exited";
        scheduleRestart();
      }
    });
  };
  watch(child);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    get child() {
      return child;
    },
    restarts: () => total,
    async stop({ graceMs = 2000 } = {}) {
      stopping = true;
      clearTimeout(timer);
      starting?.abort(); // spawnAdapter kills a child that is still starting
      const current = child;
      if (running(current)) {
        current.kill("SIGTERM");
        const kill = setTimeout(() => current.kill("SIGKILL"), graceMs);
        await exitOf(current);
        clearTimeout(kill);
      }
    },
  };
}

/** Merges the give-up record into the adapter's last snapshot (atomic, 0600, never throws). */
async function recordGiveUp(file, { restarts, lastReason }) {
  if (!file) return;
  let current = {};
  try {
    current = JSON.parse(await readFile(file, "utf8"));
  } catch {}
  const text = JSON.stringify({
    ...current,
    supervisor: { restarts, lastReason, gaveUpAt: new Date().toISOString() },
  });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } catch {
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** One start attempt; resolves with the ready child (`child.adapterPort` set). */
export function spawnAdapter(
  config,
  {
    entry = ADAPTER_ENTRY,
    timeoutMs = 10_000,
    cliEnv,
    signal,
    execArgv = adapterExecArgv(),
    port = 0,
    restarts = 0,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...execArgv, entry], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      detached: true,
      env: adapterEnvironment(cliEnv),
    });
    let settled = false;
    const settle = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (reason) => {
      if (settled) return;
      settle();
      child.kill("SIGKILL");
      reject(Object.assign(new Error("the protocol adapter did not start"), { reason }));
    };
    const timer = setTimeout(() => fail("timeout"), timeoutMs);
    const onAbort = () => fail("aborted");
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", () => fail("spawn"));
    child.once("exit", () => fail("exited"));
    child.on("message", (message) => {
      if (settled) return;
      const port = message?.port;
      if (
        message?.type === "ready" &&
        Number.isInteger(port) &&
        port > 0 &&
        port < 65536
      ) {
        settle();
        child.adapterPort = port;
        resolve(child);
      } else fail(message?.reason === "bind" ? "bind" : "config");
    });
    child.once("spawn", () => child.send({ type: "start", config, port, restarts }));
  });
}
```

Imports for the supervisor: `readFile`, `writeFile`, `rename`, `rm` from `node:fs/promises`, `randomUUID` from `node:crypto`. `config` validity is checked by the adapter process (it reports `config`), so an invalid config rejects with `reason: "config"` as the test expects. Keep `adapter-supervisor.js` < 250 lines; if the restart logic pushes it further, move `startAdapter`'s restart loop to `adapter-restart.js`.

- [ ] **Step 4: Implement `server/adapter-process.js`**

```js
// Protocol adapter for one session. terminal-launcher.js starts it and sends the private
// configuration over IPC; the key never appears in argv or env. It never writes to
// stdout/stderr (the launcher's stdio is the CLI's terminal).
import { validateAdapterConfig } from "./features/adapter-runtime/adapter-config.js";
import { createAdapterServer } from "./features/adapter-runtime/adapter-server.js";

for (const signal of ["SIGINT", "SIGQUIT", "SIGHUP"]) process.on(signal, () => {});
let server = null;
let closing = false;
async function shutdown(code) {
  if (closing) return;
  closing = true;
  const force = setTimeout(() => process.exit(code), 1500);
  try {
    await server?.close();
  } catch {}
  clearTimeout(force);
  process.exit(code);
}
process.on("SIGTERM", () => shutdown(0));
process.on("disconnect", () => shutdown(0));
process.on("uncaughtException", () => shutdown(70));
process.on("unhandledRejection", () => shutdown(70));
process.once("message", async (message) => {
  let config;
  try {
    if (message?.type !== "start") throw new TypeError("adapter: unexpected message");
    config = validateAdapterConfig(message.config);
  } catch {
    process.send?.({ type: "failed", reason: "config" });
    return shutdown(78);
  }
  try {
    // Restarts rebind the original port so the CLI's substituted URL stays valid.
    const wanted =
      Number.isInteger(message.port) && message.port > 0 && message.port < 65536
        ? message.port
        : 0;
    server = createAdapterServer(config, {
      restarts: Number.isInteger(message.restarts) ? message.restarts : 0,
    });
    const port = await server.listen(wanted);
    process.send({ type: "ready", port });
  } catch {
    process.send?.({ type: "failed", reason: "bind" });
    shutdown(71);
  }
});
```

`createAdapterServer` must throw synchronously only for a refused IP-literal upstream (`createUpstreamClient`); that path reports `bind` — acceptable because the launcher prints the same sanitized line for every reason.

- [ ] **Step 5: Run tests**

Run: `node --test tests/integration/adapter-process.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/adapter-process.js server/features/adapter-runtime/adapter-supervisor.js tests/integration/adapter-process.test.js
git commit -m "feat: run the protocol adapter as an IPC-configured child process

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Launcher integration and release reference tracking

**Files:**

- Modify: `server/terminal-launcher.js`, `docs/architecture.md:30`, `tests/integration/release-references.test.js`
- Create: `tests/helpers/fake-cli.mjs`, `tests/integration/adapter-launcher.test.js`

**Interfaces:**

- Consumes: `startAdapter`, `substituteAdapterUrl` (Task 10); payload `adapter` (Task 6).
- Produces: launcher behavior — signal handlers (`SIGINT`/`SIGQUIT` ignored; `SIGHUP`/`SIGTERM` forwarded to the CLI or, before the CLI started, abort the adapter start) registered before the adapter starts; with `payload.adapter`: start (10 s), then `Object.assign(payload, substituteAdapterUrl(payload, adapter.url))`, `delete payload.adapter`, then the unchanged CLI/headless logic; on CLI `close` → `await adapter.stop()`; start failure → stderr exactly `Unable to start the protocol adapter.\n`, exit code 127, CLI never spawned; signal during start → exit `128 + signal number` without starting the CLI. The launcher never prints anything about the adapter after the CLI started.

`tests/helpers/fake-cli.mjs` (invoked as `node fake-cli.mjs <out.json> [mode]`):

```js
// Fake CLI: records env and argv, optionally calls the adapter, then exits.
import fs from "node:fs";
const [out, mode = "call"] = process.argv.slice(2);
const record = { env: process.env, args: process.argv.slice(2), calls: [] };
const base = process.env.ANTHROPIC_BASE_URL;
const token = process.env.ANTHROPIC_AUTH_TOKEN;
async function call() {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: process.env.FAKE_CLI_BODY,
  });
  record.calls.push({ status: res.status, text: await res.text() });
}
const save = () => fs.writeFileSync(out, JSON.stringify(record));
if (mode === "call") await call();
if (mode === "wait-sigint") {
  process.on("SIGINT", async () => {
    await call();
    save();
    process.exit(0);
  });
  setInterval(() => {}, 1000);
  save();
  fs.writeFileSync(`${out}.ready`, "");
} else if (mode === "wait") {
  setInterval(() => {}, 1000);
  save(); // tests read the substituted URL from here
  fs.writeFileSync(`${out}.ready`, "");
} else {
  save();
  console.log("FAKE-CLI-STDOUT");
  process.exit(Number(process.env.FAKE_CLI_EXIT || 0));
}
```

- [ ] **Step 1: Write the failing launcher tests**

```js
// tests/integration/adapter-launcher.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scriptedUpstream, sse } from "../helpers/scripted-upstream.js";
import { loadFixture } from "../helpers/protocol-adapter.js";
import { KEY, TOKEN, validAdapterConfig } from "../helpers/adapter-fixture.js";

const launcher = fileURLToPath(
  new URL("../../server/terminal-launcher.js", import.meta.url),
);
const fakeCli = fileURLToPath(new URL("../helpers/fake-cli.mjs", import.meta.url));

function payloadFile(t, payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-launcher-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "s.launch.json");
  fs.writeFileSync(file, JSON.stringify(payload(dir)), { mode: 0o600 });
  return { dir, file };
}
function run(file, { detached = false } = {}) {
  const child = spawn(process.execPath, [launcher, file], {
    stdio: ["ignore", "pipe", "pipe"],
    detached,
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const done = new Promise((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr })),
  );
  return { child, done };
}
const adapterPids = (launcherPid) =>
  execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([, ppid, ...rest]) =>
        ppid === String(launcherPid) && rest.join(" ").includes("adapter-process.js"),
    )
    .map(([pid]) => Number(pid));

async function setup(t, mode = "call") {
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const body = JSON.stringify(loadFixture("clients/claude-code/text.json").body);
  const { dir, file } = payloadFile(t, (d) => ({
    command: process.execPath,
    args: [fakeCli, path.join(d, "out.json"), mode, "--base=__AGENTPIER_ADAPTER_URL__"],
    cwd: d,
    env: {
      PATH: process.env.PATH,
      ANTHROPIC_BASE_URL: "__AGENTPIER_ADAPTER_URL__",
      ANTHROPIC_AUTH_TOKEN: TOKEN,
      FAKE_CLI_BODY: body,
    },
    adapter: validAdapterConfig({
      upstream: { baseUrl: `${up.base}/v1`, authHeader: null, apiKey: KEY },
      diagnosticsPath: path.join(d, "s.adapter.json"),
    }),
  }));
  return { up, dir, file, out: path.join(dir, "out.json") };
}

test("placeholders are substituted in env and argv; the CLI reaches the adapter; no key leaks", async (t) => {
  const { up, file, out } = await setup(t);
  const { code, stdout, stderr } = await run(file).done;
  assert.equal(code, 0, stderr);
  assert.equal(fs.existsSync(file), false, "payload is one-use");
  const record = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.match(record.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(record.args.at(-1), `--base=${record.env.ANTHROPIC_BASE_URL}`);
  assert.equal(JSON.stringify(record).includes(KEY), false);
  assert.match(record.calls[0].text, /message_stop/);
  assert.equal(up.seen[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(stdout, "FAKE-CLI-STDOUT\n");
  assert.equal(stderr, "");
});

test("the adapter stops when the CLI exits", async (t) => {
  const { file, out } = await setup(t, "wait");
  const { child, done } = run(file);
  await until(() => fs.existsSync(`${out}.ready`));
  const [pid] = adapterPids(child.pid);
  assert.ok(pid, "adapter child of the launcher");
  child.kill("SIGTERM");
  await done;
  await until(() => !alive(pid));
});

test("adapter start failure: one sanitized line, exit 127, CLI not started", async (t) => {
  const { dir, file } = payloadFile(t, (d) => ({
    command: process.execPath,
    args: [fakeCli, path.join(d, "out.json")],
    cwd: d,
    env: { PATH: process.env.PATH },
    adapter: { ...validAdapterConfig(), token: "bad" },
  }));
  const { code, stdout, stderr } = await run(file).done;
  assert.equal(code, 127);
  assert.equal(stderr, "Unable to start the protocol adapter.\n");
  assert.equal(stdout, "");
  assert.equal(fs.existsSync(path.join(dir, "out.json")), false);
});

test("an adapter crash is restarted on the same URL and never writes to the CLI's terminal", async (t) => {
  const { file, out } = await setup(t, "wait");
  const { child, done } = run(file);
  await until(() => fs.existsSync(`${out}.ready`));
  const url = JSON.parse(fs.readFileSync(out, "utf8")).env.ANTHROPIC_BASE_URL;
  const [first] = adapterPids(child.pid);
  process.kill(first, "SIGKILL");
  await until(() => adapterPids(child.pid).some((pid) => pid !== first));
  await until(
    async () =>
      (await fetch(`${url}/api/hello`, { method: "HEAD" }).catch(() => null))?.status ===
      200,
  );
  child.kill("SIGTERM");
  const { stdout, stderr } = await done;
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("launcher shutdown during an adapter restart leaves no adapter behind", async (t) => {
  const { file, out } = await setup(t, "wait");
  const { child, done } = run(file);
  await until(() => fs.existsSync(`${out}.ready`));
  const url = JSON.parse(fs.readFileSync(out, "utf8")).env.ANTHROPIC_BASE_URL;
  process.kill(adapterPids(child.pid)[0], "SIGKILL");
  child.kill("SIGTERM"); // inside the supervisor's 250 ms restart delay
  await done;
  await new Promise((r) => setTimeout(r, 600));
  // Nothing serves the session's port any more (a late restart would have rebound it).
  assert.equal(
    await fetch(`${url}/api/hello`, { method: "HEAD" }).catch(() => null),
    null,
  );
});

test("Ctrl+C in the terminal does not stop the adapter (Review Focus 2)", async (t) => {
  const { file, out } = await setup(t, "wait-sigint");
  const { child, done } = run(file, { detached: true }); // launcher leads its own process group, like a tmux pane
  await until(() => fs.existsSync(`${out}.ready`));
  process.kill(-child.pid, "SIGINT");
  const { code } = await done;
  assert.equal(code, 0);
  assert.match(JSON.parse(fs.readFileSync(out, "utf8")).calls[0].text, /message_stop/);
});

test("headless pipelines get the substituted URL through the native process group", async (t) => {
  // payload adds observationPath/outcomePath in dir; fake CLI mode "call" prints FAKE-CLI-STDOUT;
  // assert the observation file contains FAKE-CLI-STDOUT, out.json env has the real URL, outcome exitCode 0.
});
```

Add `alive`/`until` helpers (same as Task 10). Write the headless test fully. Add a SIGTERM-during-start test: payload whose adapter `upstream.baseUrl` is valid but use `entry`? The launcher cannot take an entry override — instead send SIGTERM within 5 ms of spawn and assert exit code 143 and no `out.json` (tolerate the race by accepting either 143 without `out.json` or a normal SIGTERM exit; assert the adapter pid is gone in both cases).

Add to `tests/integration/release-references.test.js`:

```js
test("an adapter process below a session launcher is a helper of that session", () => {
  const output = [
    `  100     1 ${release}/bin/node ${release}/server/terminal-launcher.js ${data}/sessions/${id}.launch.json`,
    `  101   100 ${release}/bin/node --use-system-ca ${release}/server/adapter-process.js`,
  ].join("\n");
  const result = releaseSessionReferences(output, [release]);
  assert.deepEqual(result.sessionIds, [id]);
  assert.deepEqual(result.helperReferences, [{ reference: "server/adapter-process.js" }]);
  assert.deepEqual(result.unidentified, []);
});
```

(use the file's existing `release`, `data`, `id` fixtures.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/integration/adapter-launcher.test.js tests/integration/release-references.test.js`
Expected: launcher tests FAIL (placeholder not substituted, no adapter); the release-references test already PASSES (the current ancestry rule covers it) — keep it as regression coverage.

- [ ] **Step 3: Rewrite `server/terminal-launcher.js`**

Keep every existing behavior (one-use payload, observation, headless group, exit codes, messages). Structure:

```js
// The private tmux server launches this helper so credentials never enter shell commands or tmux metadata.
import {
  readFileSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { spawnNativeProcess } from "./features/pipelines/native-process.js";
import {
  startAdapter,
  substituteAdapterUrl,
} from "./features/adapter-runtime/adapter-supervisor.js";

const payloadPath = process.argv[2];
let payload = null;
try {
  payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  unlinkSync(payloadPath);
} catch {
  try {
    unlinkSync(payloadPath);
  } catch {}
  process.stderr.write("Unable to load the terminal launch configuration.\n");
  process.exitCode = 127;
}
if (payload) await launch(payload);

async function launch(payload) {
  // Terminal-generated SIGINT/SIGQUIT already reach the foreground child. Keep the
  // wrapper alive without forwarding a duplicate cancellation signal.
  process.on("SIGINT", () => {});
  process.on("SIGQUIT", () => {});
  let forward = null; // set once the CLI runs
  let early = null;
  const starting = new AbortController();
  for (const signal of ["SIGHUP", "SIGTERM"])
    process.on(signal, () => {
      if (forward) return forward(signal);
      early ??= signal;
      starting.abort();
    });
  let adapter = null;
  if (payload.adapter) {
    try {
      adapter = await startAdapter(payload.adapter, {
        cliEnv: payload.env,
        signal: starting.signal,
      });
    } catch {
      if (early) process.exitCode = 128 + constants.signals[early];
      else {
        process.stderr.write("Unable to start the protocol adapter.\n");
        process.exitCode = 127;
      }
      return;
    }
    if (early) {
      await adapter.stop();
      process.exitCode = 128 + constants.signals[early];
      return;
    }
    Object.assign(payload, substituteAdapterUrl(payload, adapter.url));
    delete payload.adapter;
  }
  try {
    forward = runCli(payload, () => adapter?.stop());
  } catch {
    await adapter?.stop();
    process.stderr.write("Unable to load the terminal launch configuration.\n");
    process.exitCode = 127;
  }
}
```

`runCli(payload, onClose)` is the existing body (observation, headless group, spawn, stdout piping, close handler) moved into a function that returns the signal-forwarding function (`group ? () => group.stop() : (signal) => { child.kill(signal); shutdown = setTimeout(() => child.kill("SIGKILL"), 1000); }`, guarded by the existing `shutdown` once-flag) and calls `onClose()` at the end of the `close` handler (after the exit code and outcome file are written). If `runCli` grows the file beyond ~180 lines, move it unchanged to `server/features/sessions/terminal-cli.js` and import it (the launcher entry path stays stable).

- [ ] **Step 4: Update `docs/architecture.md`**

Add `server/adapter-process.js` to the sentence listing stable entry points (it is started by running launchers of older releases during migration, so it must stay at that path).

- [ ] **Step 5: Run tests**

Run: `node --test tests/integration/adapter-launcher.test.js tests/integration/release-references.test.js tests/integration/pipeline-terminal.test.js tests/integration/process-group-cleanup.test.js tests/matrix/pipeline-native.test.js tests/matrix/native-launch.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/terminal-launcher.js docs/architecture.md tests/helpers/fake-cli.mjs \
  tests/integration/adapter-launcher.test.js tests/integration/release-references.test.js
git commit -m "feat: start the protocol adapter from the terminal launcher before the CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: End-to-end session through the adapter (blackbox)

**Files:**

- Create: `tests/blackbox/endpoint-adapter-session.test.js`

**Interfaces:**

- Consumes: everything from Tasks 2–11; `applicationFixture` (`tests/helpers/application.js`); `fake-cli.mjs` (Task 11).
- Produces: regression coverage that the adapter block survives the real launch chain (github, agentbus, memory, ssh, MCP, bindings, requests, nono adapters) and reload.

- [ ] **Step 1: Write the test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applicationFixture } from "../helpers/application.js";
import { scriptedUpstream, sse } from "../helpers/scripted-upstream.js";
import { loadFixture } from "../helpers/protocol-adapter.js";

const fakeCli = fileURLToPath(new URL("../helpers/fake-cli.mjs", import.meta.url));
const KEY = "fixture-adapter-session-key";

test("a Claude Code session on a Chat-only endpoint runs through the adapter without exposing the key", async (t) => {
  const f = await applicationFixture(t);
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const created = await f.request("/api/provider-connections", {
    method: "POST",
    body: {
      name: "Chat box",
      providerId: "endpoint",
      apiKey: KEY,
      endpoint: {
        preset: "custom",
        openaiBaseUrl: `${up.base}/v1`,
        anthropicBaseUrl: null,
        protocols: { messages: false, responses: false, chatCompletions: true },
        authHeader: null,
        routing: { claude: "adapter:chatCompletions" }, // explicit: auto offers no adapter routes in PR 2
        models: [
          {
            modelId: "qwen3",
            label: "Qwen",
            contextTokens: 32768,
            outputTokens: null,
            source: "manual",
            contextEdited: true,
          },
        ],
        lastTest: null,
      },
    },
  });
  assert.equal(created.status, 201);
  const connection = await created.json();
  assert.deepEqual(connection.toolRoutes.claude, {
    mode: "adapter",
    source: "chatCompletions",
  });
  const out = path.join(f.root, "cli.json");
  const version = path.join(f.root, "version-fixture");
  await fs.writeFile(version, "#!/bin/sh\nprintf '2.1.291\\n'\n", { mode: 0o755 });
  const original = f.application.accounts.command.bind(f.application.accounts);
  f.application.accounts.command = (id, _binaries, login, mode, options) => {
    const prepared = original(id, { claude: version }, login, mode, options);
    assert.ok(prepared.adapter, "adapter block prepared");
    return {
      ...prepared,
      command: process.execPath,
      args: [fakeCli, out, "call"],
      env: {
        ...prepared.env,
        FAKE_CLI_BODY: JSON.stringify(loadFixture("clients/claude-code/text.json").body),
      },
    };
  };
  const started = await f.request("/api/sessions", {
    method: "POST",
    body: {
      tool: "claude",
      providerConnectionId: connection.id,
      providerModelId: "qwen3",
      cwd: f.home,
    },
  });
  assert.equal(started.status, 201);
  const session = await started.json();
  assert.deepEqual(session.provider.route, {
    mode: "adapter",
    source: "chatCompletions",
  });
  // wait until the fake CLI wrote its record (poll up to 10 s)
  const record = JSON.parse(await waitForFile(out));
  assert.match(record.calls[0].text, /message_stop/);
  assert.equal(up.seen[0].headers.authorization, `Bearer ${KEY}`);
  const sessionsDir = path.join(f.dataDir ?? path.join(f.root, "data"), "sessions");
  const files = await fs.readdir(sessionsDir);
  assert.equal(
    files.some((n) => n.endsWith(".launch.json")),
    false,
    "payload consumed",
  );
  for (const name of files.filter((n) => !n.endsWith(".adapter.json")))
    assert.equal(
      (await fs.readFile(path.join(sessionsDir, name), "utf8")).includes(KEY),
      false,
      name,
    );
  const state = await (await f.request("/api/state")).json();
  assert.equal(JSON.stringify(state).includes(KEY), false);
});
```

Add `waitForFile(file, ms = 10000)` (poll every 50 ms). Add a second test: after the session process exits, `DELETE /api/sessions/:id` removes `<id>.adapter.json`. Add a third test for reload if the fixture can reload a fake-CLI session (search `tests/blackbox` for `reload`); otherwise assert via `session-replacement` unit coverage that a reload payload contains a fresh token.

- [ ] **Step 2: Run**

Run: `node --test tests/blackbox/endpoint-adapter-session.test.js`
Expected: PASS (if it fails, the failing step names which launch-chain adapter dropped `adapter`; fix that adapter to spread the launch it receives, with a focused regression test next to its existing tests).

- [ ] **Step 3: Commit**

```bash
git add tests/blackbox/endpoint-adapter-session.test.js
git commit -m "test: run an endpoint session through the adapter end to end

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Capability probe in the connection test

**Files:**

- Create: `server/features/providers/endpoint-capability-probe.js`
- Modify: `server/features/providers/endpoint-probe.js:56-122`
- Test: `tests/integration/endpoint-capability-probe.test.js`, `tests/integration/endpoint-probe.test.js`

**Interfaces:**

- Consumes: `endpointRequest`, `authHeaders` (`endpoint-http.js`); the base probe results of `runEndpointTest`.
- Produces: `probeCapabilities({ endpoint, apiKey, model, results, signal, lookup, timeoutMs = 30_000 }) → Promise<{ messages?: object, responses?: object, chatCompletions?: object }>`; `runEndpointTest(...)` result gains `capabilities` (same shape; only protocols whose base probe returned 2xx; only keys whose probe answered 2xx or 400/422 — auth, timeouts, 5xx and the deadline omit the key).

Probe table (one request each, `max_tokens`/`max_output_tokens` 16 unless noted; `accepted` = 2xx, `rejected` = 400/422):

| Protocol        | Capability          | Request delta over the base probe                                                                                                                                        | accepted →                  | rejected →                           |
| --------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ------------------------------------ |
| responses       | `reasoningEffort`   | `reasoning: { effort: "low", summary: "auto" }, include: ["reasoning.encrypted_content"]`                                                                                | `true`                      | `false`                              |
| responses       | `promptCacheKey`    | `prompt_cache_key: "agentpier-probe"`                                                                                                                                    | `true`                      | `false`                              |
| responses       | `parallelToolCalls` | `tools: [PROBE_TOOL_RESPONSES], parallel_tool_calls: true`                                                                                                               | `true`                      | `false`                              |
| chatCompletions | `streamUsage`       | `stream: true, stream_options: { include_usage: true }`                                                                                                                  | `true`                      | `false`                              |
| chatCompletions | `reasoningEffort`   | `reasoning_effort: "low"`                                                                                                                                                | `true`                      | `false`                              |
| chatCompletions | `promptCacheKey`    | `prompt_cache_key: "agentpier-probe"`                                                                                                                                    | `true`                      | `false`                              |
| chatCompletions | `parallelToolCalls` | `tools: [PROBE_TOOL_CHAT], parallel_tool_calls: true`                                                                                                                    | `true`                      | `false`                              |
| chatCompletions | `systemMessages`    | `messages: [user "ok", assistant "ok", system "Answer briefly.", user "ok"]`                                                                                             | `"inline"`                  | `"merge"`                            |
| chatCompletions | `maxTokensField`    | only when the base `max_tokens` probe was 400/422: `max_completion_tokens: 16` without `max_tokens`                                                                      | `"max_completion_tokens"`   | omit                                 |
| messages        | `promptCache`       | `system: [{ type: "text", text: "ok", cache_control: { type: "ephemeral" } }]`                                                                                           | `true`                      | `false`                              |
| messages        | `thinkingBudget`    | `thinking: { type: "adaptive" }, output_config: { effort: "low" }`; if rejected, a second request `thinking: { type: "enabled", budget_tokens: 1024 }, max_tokens: 1025` | adaptive accepted → `false` | enabled accepted → `true`, else omit |

`reasoningReplay` is not probed (DeepSeek-style rejections appear only inside tool loops; the runtime retry covers it). `PROBE_TOOL_*` = a function `probe_noop` with `{ type: "object", properties: {} }`. Requests run sequentially under the test's combined signal (180 s total) with `timeoutMs` each.

- [ ] **Step 1: Write the failing tests**

Using `fakeEndpoint` from `tests/helpers/endpoint-servers.js` (JSON answers) — route handlers inspect `entry.body` and answer 200/400 per scenario:

1. Chat server accepting everything except `reasoning_effort` and mid-conversation system → `capabilities.chatCompletions` = `{ streamUsage: true, reasoningEffort: false, promptCacheKey: true, parallelToolCalls: true, systemMessages: "merge" }` and no `maxTokensField`.
2. Chat server rejecting `max_tokens` (base probe 400) but accepting `max_completion_tokens` → `maxTokensField: "max_completion_tokens"`.
3. Responses server rejecting `reasoning` → `reasoningEffort: false`; accepted otherwise.
4. Messages server rejecting adaptive but accepting enabled → `thinkingBudget: true`; rejecting cache_control → `promptCache: false`.
5. A 401 on the capability request omits that key; a hanging capability request ends at `timeoutMs` (set 100 ms in the test) and omits the key; disabled/failed base protocols have no entry.
6. The number of extra requests per protocol equals the table (count `seen`).
7. No result field contains upstream response text.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/integration/endpoint-capability-probe.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`endpoint-capability-probe.js` exports `CAPABILITY_PROBES` (the table as data: `{ protocol, capability, body(base) → body, accepted, rejected, when?(results) }`) and `probeCapabilities`. Base bodies reuse `probes(endpoint, model)` from `endpoint-probe.js` (export it). `runEndpointTest` calls it after the protocol loop when `model` is set and adds `capabilities` to its return value. `EndpointTester.test` passes it through unchanged.

- [ ] **Step 4: Run tests**

Run: `node --test tests/integration/endpoint-capability-probe.test.js tests/integration/endpoint-probe.test.js tests/blackbox/endpoint-routes.test.js`
Expected: PASS (update `endpoint-probe.test.js` expectations that deep-compare the whole result).

- [ ] **Step 5: Commit**

```bash
git add server/features/providers/endpoint-capability-probe.js server/features/providers/endpoint-probe.js tests
git commit -m "feat: propose adapter capabilities from the connection test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: CLI smoke matrix with real CLIs

**Files:**

- Create: `tests/matrix/adapter-cli-smoke.test.js` (split into `adapter-cli-smoke-opencode.test.js` if > 600 lines), `tests/helpers/smoke-upstreams.js`

**Interfaces:**

- Consumes: `prepareProviderLaunch` (Tasks 4–5), the real launcher (Task 11), facts R2–R4.
- Produces: one tool-call round trip per direction: Claude Code ← Responses, Claude Code ← Chat, Codex ← Messages, Codex ← Chat (through the launcher and adapter); OpenCode → `@ai-sdk/anthropic` and → `@ai-sdk/openai` (native SDK, no adapter).

`smoke-upstreams.js` exports `smokeUpstream(t, protocol, { toolName, toolInput })` built on `scriptedUpstream`: turn 1 answers with a streamed tool call to `toolName` (only if the request's `tools` contain it; otherwise it answers 500 with a message the test asserts on, so a renamed CLI tool fails loudly); turn 2 asserts that the translated request carries the tool result (Chat: a `role: "tool"` message; Responses: a `function_call_output` item; Messages: a `tool_result` block) and answers with text `SMOKE-OK`. Turn 1 also streams reasoning (`reasoning_content` for Chat, a reasoning summary + `encrypted_content` for Responses, a thinking block with a signature for Messages) so the carrier round trip is exercised; turn 2 records whether the replayed carrier arrived (Responses/Messages origins) — Claude Code accepting carriers is asserted by the turn-2 request arriving at all (Claude Code drops the conversation on signature rejection). Build the SSE text from the PR 1 fixtures' shapes (`upstreams/<protocol>/function-calls.sse`, `parallel-tool-calls.sse`, `parallel-tool-use.sse`, `text.sse`), replacing names and arguments.

Tool choices: Claude Code `Read` with `{ "file_path": "<cwd>/smoke.txt" }`; Codex `exec_command` with `{ "cmd": "cat smoke.txt" }` (Codex `exec` with `--skip-git-repo-check` and the default read-only sandbox may run it); OpenCode `read` with `{ "filePath": "<cwd>/smoke.txt" }`. `smoke.txt` contains `SMOKE-FILE-CONTENT`, which turn 2 asserts in the tool result.

- [ ] **Step 1: Write the smoke tests**

```js
const installed = (cmd) =>
  spawnSync(cmd, ["--version"], { encoding: "utf8" }).status === 0;
const opencodeBin =
  [
    process.env.AGENTPIER_OPENCODE,
    "opencode",
    path.join(os.homedir(), ".opencode/bin/opencode"),
  ]
    .filter(Boolean)
    .find(installed) ?? null;

for (const source of ["responses", "chatCompletions"])
  test(
    `Claude Code round-trips a tool call through the adapter from ${source}`,
    {
      skip: installed("claude") ? false : "claude CLI is not installed",
      timeout: 120_000,
    },
    async (t) => {
      const up = await smokeUpstream(t, source, {
        toolName: "Read",
        toolInput: (cwd) => ({ file_path: `${cwd}/smoke.txt` }),
      });
      const { cwd, root } = workspace(t); // temp HOME, cwd with smoke.txt
      const launch = prepareProviderLaunch(
        account("claude"),
        { apiKey: KEY },
        {
          command: "claude",
          args: ["-p", "Read smoke.txt and answer."],
          env: { PATH: process.env.PATH, HOME: root },
        },
        {
          root,
          catalog: new ProviderCatalog(),
          endpoint: endpointFor(up, source),
          connectionName: "Smoke",
        },
      );
      const result = await runThroughLauncher(t, launch, cwd); // writes a payload incl. adapter + diagnosticsPath, spawns terminal-launcher.js
      assert.match(result.stdout, /SMOKE-OK/, result.stderr);
      assert.equal(up.turns(), 2);
      assert.equal(
        up.seen.every((e) => e.headers.authorization === `Bearer ${KEY}`),
        true,
      );
    },
  );
```

Write the equivalent Codex tests (`codex exec --skip-git-repo-check …launch.args "Run cat smoke.txt and answer."`, sources `messages` and `chatCompletions`) and OpenCode tests (`opencode run --model <launch.provider.cliModelId> "Read smoke.txt and answer."`, run **directly** with `launch.env` since SDK routes have no adapter; sources `messages`, `responses`). `runThroughLauncher` writes `{ command: resolved absolute CLI path, args: launch.args, cwd, env: launch.env, adapter: { ...launch.adapter, diagnosticsPath } }` to a temp `*.launch.json` (mode 0600) and spawns `node server/terminal-launcher.js <file>` with piped stdio and a 100 s timeout; it also asserts the adapter's diagnostics file has `errors` without `stream.invalid` and `request.invalid`.

`endpointFor(up, source)` enables only `source` and sets the tool's routing explicitly (`claude: "adapter:<source>"`, `codex: "adapter:<source>"`, `opencode: "<source>"`), because `auto` offers no adapter routes in PR 2. Each test's skip message names the missing CLI. Matrix tests never touch the user's real CLI profiles (temp `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_*`).

- [ ] **Step 2: Run**

Run: `node --test tests/matrix/adapter-cli-smoke.test.js`
Expected: PASS with all installed CLIs; SKIP (with the CLI name) for missing ones. A failure here is a real protocol drift: record the failing direction and the upstream/client frames in the task report before changing library code (library fixes need their own regression test under `tests/unit/protocol-adapter/`).

- [ ] **Step 3: Commit**

```bash
git add tests/matrix/adapter-cli-smoke*.test.js tests/helpers/smoke-upstreams.js
git commit -m "test: smoke-test real CLIs through the adapter and OpenCode SDK routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: nono loopback for sandboxed adapter sessions

**Files:**

- Create: `tests/matrix/nono-adapter-loopback.test.js`
- Modify (only if fact R1b requires it): `server/features/nono/nono-launch.js`, `server/features/adapter-runtime/adapter-supervisor.js`, `server/features/providers/adapter-launch.js`

**Interfaces:**

- Consumes: `wrapWithNono` (`nono-launch.js`), launcher (Task 11), `fake-cli.mjs`, fact R1a/R1b.
- Produces: proof that a launch wrapped by `wrapWithNono` (launcher outside, CLI inside nono) reaches the adapter on `127.0.0.1`.

- [ ] **Step 1: Write the test**

Reuse `nonoExecutable()`, `workspace(t)` and the `restrictive` profile from `tests/matrix/nono-confinement.test.js` (copy them; matrix tests stay independent). Build a payload with `wrapWithNono({ launch: { command: process.execPath, args: [fakeCli, out, "call"], env, sandboxGrants: [{ access: "allow", path: dir }] }, executable, profile })`, add the `adapter` block, run `terminal-launcher.js`, assert `out.json` has a `message_stop` call and the fake upstream saw the key. Run it for `profile: "default"` (R1a) and for the restrictive profile with `network: { block: false }`. Skip with "nono is not installed" when missing.

- [ ] **Step 2: Run**

Run: `node --test tests/matrix/nono-adapter-loopback.test.js`
Expected: PASS (or SKIP without nono).

- [ ] **Step 3: Only if R1b showed that `network.block: true` profiles deny loopback**

Add a port placeholder `ADAPTER_PORT_PLACEHOLDER = "__AGENTPIER_ADAPTER_PORT__"` (export from `adapter-launch.js`); `wrapWithNono` adds `"--open-port", ADAPTER_PORT_PLACEHOLDER` before `--` when `launch.adapter` is present; `substituteAdapterUrl` also replaces the port placeholder with `String(port)` (rename the function to `substituteAdapterAddress` and update Task 11's call). Add a third case to the test with the restrictive profile and `network: { block: true }`, and a unit assertion in `tests/unit/nono-*.test.js` that the flag appears only for adapter launches. If R1b showed that `--open-port` does not help either, do not change code (nono profiles are opaque to the server, so the combination cannot be refused up front); record the limitation in the facts file and the PR description instead.

- [ ] **Step 4: Commit**

```bash
git add tests/matrix/nono-adapter-loopback.test.js server/features/nono server/features/adapter-runtime server/features/providers
git commit -m "test: confirm sandboxed CLIs reach the adapter on loopback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Whole-branch verification

**Files:** none new.

- [ ] **Step 1: Format, lint, structure, build, tests**

Run: `npm run format && npm run check`
Expected: PASS. `check:structure` lists no file over 600 lines (watch `terminal-launcher.js`, `endpoint-config.js`, `adapter-request.js`, the smoke test).

- [ ] **Step 2: Matrix and real-CLI suites**

Run: `npm run test:matrix`
Expected: PASS; skipped tests print the missing CLI/nono name.

- [ ] **Step 3: Leak sweep**

Run: `git grep -n "__AGENTPIER_ADAPTER_URL__" -- server` and confirm it appears only in `adapter-launch.js`, `provider-environment.js`, `endpoint-launch.js` and the supervisor. Run `git grep -nE "console\.(log|error)|process\.(stdout|stderr)\.write" -- server/adapter-process.js server/features/adapter-runtime` → no hits.

- [ ] **Step 4: Manual check in English**

`npm run build && npm start` with a disposable data dir (`AGENTPIER_DATA_DIR=$(mktemp -d)` or the documented equivalent), create a Chat-only endpoint against a local fake upstream (`node -e` server from `tests/helpers/scripted-upstream.js` semantics), confirm the connection API returns `toolRoutes` with `claude: null` under `auto`, set `routing: { claude: "adapter:chatCompletions" }` through the API, start a Claude Code session, send one prompt, confirm the answer arrives and `sessions/<id>.adapter.json` holds counters only. No UI changes are expected in PR 2 (the launch dialog simply lists the newly offered CLIs).

- [ ] **Step 5: PR**

Open the PR from `feat/protocol-adapter-runtime` with: problem, resulting behavior (routing, adapter process, OpenCode SDK routes, probe), validation (suites run, CLIs and versions used in the smoke matrix, nono version), the Task 1 facts summary, and known limitations (no HTTP proxy upstream; after 3 adapter restarts within 60 s the session loses model access until reload; `ADAPTER_AUTO_ROUTES` is off, so adapter routes need an explicit per-CLI choice until PR 3). Keep `docs/superpowers/specs/2026-10-07-protocol-adapter-design.md` (PR 3 still needs it); remove this plan file in the final cleanup commit before opening the PR, per AGENTS.md. End the PR body with the Claude Code attribution line.

---

## PR 3 hand-off

- Flip `ADAPTER_AUTO_ROUTES` in `server/features/providers/endpoint-routing.js` to `true` **in the same PR** that adds the "via adapter" labels (connection list, launch dialog, session view from `provider.route`) and the routing select. Then update the tests that pin the PR 2 default: `tests/unit/endpoint-routing.test.js` ("PR 2 default…"), `tests/unit/endpoint-config.test.js` ("endpointTools follows the resolved routes"), `tests/integration/endpoint-pipeline-snapshot.test.js` ("auto never moves a pipeline onto an adapter route in PR 2"), `tests/matrix/endpoint-adapter-launch.test.js` ("auto on a Chat-only endpoint launches no adapter route in PR 2") and the legacy-record case in `tests/integration/provider-connections.test.js`. The flag-flip test (`resolveRoute(..., { adapterAuto: true })`) already covers the target behavior; afterwards the `adapterAuto` option can stay as a test seam or be removed.
- Flipping the flag changes `toolRoutes`/`tools` for existing Chat-, Messages- or Responses-only connections; pipeline profiles are unaffected (their snapshots freeze the route).
- `doctor` reads `sessions/<id>.adapter.json` (snapshot incl. `restarts` and a `supervisor.gaveUpAt` entry after an exhausted restart budget).
