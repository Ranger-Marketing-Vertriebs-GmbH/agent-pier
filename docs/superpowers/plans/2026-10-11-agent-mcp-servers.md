# Central MCP Servers for Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A central MCP server list in AgentPier whose servers are bound persistently to agents and, through team proposals, to temporary members, compiled into OpenClaw.

**Architecture:** A backend store holds servers (non-secret fields), their secrets and bindings (`target_kind` `agent`, later `cli-profile`). A pure section builder (beside `openclaw-config/web-tools.js`) compiles `mcp.servers`, the global `bundle-mcp` grant and per-agent `<server>__*` globs; the locked `mcp` path is always compiler-owned. Team proposals carry per-member server subsets of the lead's bindings.

**Tech Stack:** Node.js 22 ESM, `node:test`, `node:sqlite` via `privateDatabase`, Express, React with reactive DE/EN catalogs, Playwright, OpenClaw 2026.9.8.

**Spec:** `docs/superpowers/specs/2026-10-11-agent-mcp-servers-design.md`

## Global Constraints

- Builds on AGENTPIER-24 (`feat/agent-capability-profiles`, PR #214): reuse `personalCapabilities` eligibility, `patchConfig`, the owner-confirmed restart flow (`restartGateway`, 409 `ASSISTANT_RESTART_REQUIRED`, `confirmRestart`), and the `web-tools.js` section pattern. Rebase onto `main` once #214 is merged.
- Secrets (header and env values) never appear in HTTP responses, logs or UI state from the server; names only (`publicMcp` pattern).
- stdio: adding a server and binding it require a clear warning and explicit confirmation; commands are stored as absolute paths resolved on save.
- No bindings → compiled configuration byte-identical to before.
- Temporary team members get only servers bound to their lead agent, approved by the owner in the team proposal; bindings end with the member.
- Every UI text in German and English with matching keys; usable at 390 px.
- Team plugin, team tools and the write guard unchanged otherwise; team contract and qualification tests pass.
- Files ≤ 600 lines; commits in English with conventional prefixes and a `Co-Authored-By` trailer for the authoring model.
- Tests never touch the user's instance, `~/.openclaw`, the user's CLI configs, port 4380 or the default tmux server.

## Review Focus

- A server name that sanitises to the same OpenClaw tool prefix as another server (`a.b` vs `a-b`) is rejected on save — pinned in Task 2.
- A bare command that resolves differently later (Homebrew upgrade moves `npx`) keeps working because the stored path is absolute; a resolved path that disappears makes the server's tools fail clearly in the agent, not crash the Gateway start — pinned in Tasks 2 and 4.
- A team proposal naming a server the lead is not bound to is rejected as a whole — pinned in Task 6.
- Removing a server that is still bound removes its bindings and its tools from every agent (and asks for a restart if the global grant changes) — pinned in Task 5.
- A stored server whose secret rows are corrupt is skipped with a name-only diagnostic and never blocks the Gateway start — pinned in Task 4.

---

### Task 1: Probe OpenClaw's MCP client live

**Files:**

- Create: `tests/helpers/mcp-test-servers.js` (a minimal HTTP streamable MCP server on 127.0.0.1 and a stdio MCP server script, each exposing one tool `echo` that returns its input and records calls)
- Create: `tests/integration/assistant-mcp-contract.test.js` (own runtime variable `AGENTPIER_MCP_CONTRACT_RUNTIME`, wired in `scripts/provision-assistant-contracts.mjs` and `.github/workflows/assistant-runtime.yml` like the web tools contract)
- Create: `docs/assistant-mcp-qualification.md`

**Interfaces:**

- Produces verified facts for Tasks 4–5: the exact `mcp.servers.<name>` shapes for HTTP (`url`, `transport`, `headers`) and stdio (`command`, `args`, `env`, `cwd`); the offered tool names for a server name with dots or dashes; whether `tools.allow` needs `bundle-mcp`, `<name>__*` or both; whether adding `bundle-mcp` under team mode's restrictive `plugins.allow` requires a Gateway restart; `config.schema.lookup` reload kind for `mcp.servers`.

- [ ] **Step 1:** Implement the two test servers with the MCP SDK already in the dependency tree (`@modelcontextprotocol/sdk`), stdio script runnable as `node <file>`.
- [ ] **Step 2:** Contract: start the Gateway (pattern of `assistant-web-tools-compiled-contract.test.js`), patch `mcp.servers` with both servers and an agent allow list, have the fake model (`assistantModelServer({ tool })`) call the echo tool, assert the test server recorded the call and an unbound agent is not offered the tools. Repeat in team mode with the restrictive `plugins.allow` and record whether a restart was needed.
- [ ] **Step 3:** Record facts in `docs/assistant-mcp-qualification.md`; run with a provisioned runtime; commit `test: qualify OpenClaw's MCP client for HTTP and stdio servers`.

---

### Task 2: MCP server store, validation and command resolution

**Files:**

- Create: `server/features/mcp-servers/mcp-server-store.js`, `server/features/mcp-servers/command-resolution.js`
- Test: `tests/unit/mcp-server-store.test.js`, `tests/unit/mcp-command-resolution.test.js`

**Interfaces:**

- Consumes: `nameValue`, `values`, URL checks and `publicMcp` from `server/features/extensions/mcp-config.js` (export what is missing, without changing CLI behaviour).
- Produces: `McpServerStore({ dataDir })` with `list() -> PublicServer[]`, `get(id) -> PublicServer`, `create(input) -> PublicServer`, `update(id, { revision, ...input }) -> PublicServer`, `remove(id)`, `secrets(id) -> { headers: {}, env: {} }` (backend only), `bindings(targetKind, targetId) -> serverId[]`, `bind(serverId, targetKind, targetId)`, `unbind(...)`, `setBindings(targetKind, targetId, serverIds)`; `PublicServer = { id, name, transport: "http"|"sse"|"stdio", url?, command?, args?, cwd?, headerNames, envNames, revision }`. `resolveCommand(command, { pathEnv, exists }) -> absolutePath` (throws invalid when unresolvable); `sanitisedPrefix(name)` per the Task 1 rule.

- [ ] **Step 1:** Failing tests: create/update/remove with revision; secrets never in `list/get`; `{ headers: {X: null} }` on update removes a header, omitted keeps; duplicate sanitised prefix rejected; URL with credentials rejected; stdio bare command resolved via fake PATH, absolute kept, unresolvable rejected; remove deletes bindings; `setBindings` replaces a target's set.
- [ ] **Step 2–4:** Implement with `privateDatabase(path.join(dataDir, "mcp-servers"), "servers.sqlite")` (tables per spec), transactions for multi-row writes; login `PATH` obtained once per resolution via the existing helper AgentPier uses to read the user's shell environment (grep `loginShellEnv`/`shellPath`; if none exists, read `process.env.PATH` of the AgentPier service and document); run tests.
- [ ] **Step 5:** Commit `feat: store central MCP servers and their secrets`.

---

### Task 3: Seal MCP environment values in update backups

**Files:**

- Modify: `server/features/assistants/backup-credentials.js` (`secretMembers` gains `env`)
- Test: the backup credentials unit test (grep `secretMembers`/`backup-credentials` in tests)

- [ ] **Step 1:** Failing test: an `openclaw.json` with `mcp.servers.x.env.TOKEN` and `headers` produces a sealed backup with neither value in plaintext.
- [ ] **Step 2–4:** Add `env`; confirm nothing else named `env` in `openclaw.json` (the `env` top-level block is stripped since AGENTPIER-24) is affected; run backup tests.
- [ ] **Step 5:** Commit `fix: seal MCP environment values in assistant backups`.

---

### Task 4: Compile MCP servers into the OpenClaw configuration

**Files:**

- Create: `server/features/assistants/openclaw-config/mcp-servers.js`
- Modify: `server/features/assistants/runtime-config.js`, `native-capabilities.js` (`profileTools` accepts bound server prefixes), `openclaw-config/agent-entry.js`, `assistant-config.js` (same input on the live path and in the readback `allowed`), `runtime-supervisor.js` and `server/application/assistant-graph.js` (pass `mcp: { servers, secrets, bindings }` inputs; key-free snapshot like web tools)
- Test: `tests/unit/openclaw-mcp-config.test.js`; characterisation tests unchanged

**Interfaces:**

- Produces: `mcpSections({ profiles, servers, bindings, secrets }) -> { servers: {name: config}, globalTools: [...], agentTools: { [runtimeAgentId]: [...] } }`, `applyMcp(config, sections)`, `mcpSignature(sections)` (HMAC like `webToolsSignature`, never containing secrets).

- [ ] **Step 1:** Failing tests: no bindings → byte-identical config; one HTTP and one stdio server bound to an eligible agent → `mcp.servers` exactly as verified in Task 1 (secrets in `headers`/`env`), global tools per Task 1, that agent's allow list gains `<prefix>__*`, another agent does not; archived agent's bindings ignored; temporary member gets tools only through its team bindings; a server with unreadable secrets skipped with a name-only diagnostic; existing `mcp` block replaced.
- [ ] **Step 2–4:** Implement following `web-tools.js`; wire inputs; run `tests/unit/openclaw-*.test.js tests/unit/*assistant*.test.js`.
- [ ] **Step 5:** Commit `feat: compile bound MCP servers for agents`.

---

### Task 5: Owner routes and live apply

**Files:**

- Create: `server/http/routes/mcp-servers.js` (owner-only, no-store; mounted like `assistant-web-search.js`)
- Modify: `server/features/assistants/assistant-service.js` (agent PATCH accepts `mcpServers: serverId[]` for eligible agents) and the web tools change helper (generalise `web-tools-changes.js` into a shared "global sections" decision that includes MCP, or add an MCP sibling — the restart decision must consider both)
- Test: `tests/blackbox/mcp-server-routes.test.js`, `tests/integration/assistant-mcp-apply.test.js`

**Interfaces:**

- Routes: `GET /mcp-servers` → `PublicServer[]`; `POST /mcp-servers` (stdio requires `confirmStdio: true`, else 409 `MCP_STDIO_CONFIRMATION_REQUIRED`); `PUT /mcp-servers/:id`; `DELETE /mcp-servers/:id`; agent PATCH `mcpServers` (binding a stdio server requires `confirmStdio: true` likewise). All global-section changes follow 409 `ASSISTANT_RESTART_REQUIRED` + `confirmRestart` only if Task 1 showed a restart is needed; otherwise apply live through `patchConfig` with `replacePaths: ["mcp"]`.

- [ ] **Step 1:** Failing tests: secrets never in any response; stdio confirmation; binding a server to a temporary member via PATCH rejected; removing a bound server removes the agent's tools; restart/live behaviour per Task 1; nothing persisted on refused confirmation.
- [ ] **Step 2–4:** Implement; run route, integration and assistant suites.
- [ ] **Step 5:** Commit `feat: manage MCP servers and agent bindings`.

---

### Task 6: MCP servers for temporary team members

**Files:**

- Modify: `server/features/assistants/team-store.js` (`propose` accepts per-member `mcpServers: string[]` of server names; validated against the lead's bindings), the team plugin tool schema for `agentpier_team_propose` (`server/features/assistants/team-plugin/`), member creation (`reserveMember`/`reserve`) to create `agent` bindings for the member, member end to remove them, approval payloads (`team-service.js` list/proposal data) and the Telegram approval text (`telegram-outbox.js` team proposal message; mark stdio)
- Test: `tests/unit/assistant-team-store.test.js`, `tests/integration/assistant-team-*.test.js` additions

- [ ] **Step 1:** Failing tests: proposal with a server not bound to the lead → invalid, nothing stored; approved proposal → member bound to exactly its list; member end → bindings removed; proposal fingerprint includes the server list (a changed list is a different proposal); Telegram approval text lists servers with a stdio marker in both languages.
- [ ] **Step 2–4:** Implement; run team unit and integration tests and the team plugin contract with a provisioned runtime.
- [ ] **Step 5:** Commit `feat: let lead agents pass their MCP servers to temporary members`.

---

### Task 7: UI

**Files:**

- Create: `web/features/mcp-servers/McpServersSettings.jsx` (list, add/edit form based on `web/features/extensions/McpForm.jsx`, resolved command path, stdio warning confirmation, remove), mounted in the settings area next to the agent/runtime settings
- Modify: agent settings (server selection with stdio marker; stdio binding confirmation), team approval view (servers per member, stdio marker), `web/lib/i18n/en|de/*`, API module
- Test: `tests/browser/agent-mcp-servers.spec.js` (Chromium and WebKit, desktop and 390×844 touch)

- [ ] **Step 1:** Failing spec: add HTTP server with a header (value never shown after save), add stdio server requires confirmation and shows the resolved path, bind to an agent, restart confirmation when the API asks, team approval lists servers per member; English via `agentpier-language=en`; catalog parity.
- [ ] **Step 2–4:** Implement; `npm run build`; run the spec and existing assistant/extension specs in both browsers.
- [ ] **Step 5:** Commit `feat: manage central MCP servers and agent bindings in the UI`.

---

### Task 8: Contract on the compiled configuration, docs, cleanup

**Files:**

- Modify: `tests/integration/assistant-mcp-contract.test.js` (start with store-backed bindings through the real compile path, personal agent + team mode with a temporary member bound via an approved proposal)
- Modify: `docs/assistant-gateway.md` (MCP section), `docs/assistant-mcp-qualification.md`, `docs/assistant-release-qualification.md`, `docs/adr/0002-managed-openclaw-assistants.md` (coupling rows: `mcp.servers`, tool naming, `bundle-mcp`, backup sealing)
- Delete in the final cleanup commit: this plan and its spec

- [ ] **Step 1:** Run the contract with a fresh runtime, plus team plugin, runtime and update contracts; `npm run check`.
- [ ] **Step 2:** Commit docs and contract `test: qualify bound MCP servers against the live Gateway`.
- [ ] **Step 3:** Cleanup commit `chore: remove completed MCP working documents`.
