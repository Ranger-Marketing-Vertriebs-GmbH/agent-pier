# Craft Anything rebuilds (PR 2 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner (and the owner's sessions and agents) start Craft Anything rebuilds from AgentPier; each becomes an AgentPier project; AgentPier supervises the builder Craft Anything starts — account, folder, auto mode, questions and approvals, progress, shutdown.

**Architecture:** A `CraftRebuilds` service (`server/features/craft/`) owns one `craft-anything-cli mcp --all-tools --allow-run --clean-room|--deep` child per (Claude account, mode) through a small stdio MCP client, started on demand and closed when idle. It is the only caller of `rebuild_start`. Rebuild records live in `<dataDir>/craft-anything/rebuilds.json`; status, checks, usage and activity are read from the project folder's files (`craft.json`, `usage.json`, `build-activity.log`), open questions from the child (`project_show`) while a build runs. A sampler signals live topics `craft.rebuilds` / `craft.rebuild:<id>`, the inbox and push. Web: an owner page **Rebuilds** (`/craft`, `/craft/<id>`).

**Tech Stack:** Node.js ES modules, Express, React/JSX, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-08-craft-anything-design.md` (decisions 4–7; 1–3 shipped in PR #669, which this branch builds on).

## Global Constraints

- AGENTS.md in full (Prettier, ≤ 600 lines per file, ui-guide components/tokens only, i18n de+en with `npm run i18n:confirm` + committed locks, live topics instead of polling with the topic documented in `docs/architecture.md`, ⌘K search entries in `web/app/search-entries.js` with tests, docs updated, plan and spec deleted before the PR).
- Owner only: routes under `/api/craft/…` (owner-only by `server/http/route-access.js` default), topics authorize owner, nothing in the user app or `web/features/users/user-search-entries.js`.
- Facts from the spike against the real 0.5.0 binary (binding):
  - `rebuild_start {request, target ("-" | URL | absolute path), build_with?, rounds?, project_folder?, existing?, project?, resume?}` → `{project, started}`; needs the child started with `--allow-run`. Follow-ups: `rebuild_start {project, request}`; resume after a pause: `rebuild_start {project, resume: true}`.
  - `rebuild_status {project}` → `{running, queued, status, status_label, note, waiting, last_check}`; `project_show {project}` → `{status, note, checks, usage, last_reply, questions: [{id, kind: "question"|"approval", title, detail, choices, allow_text, action}], conversation}`; `project_inbox_answer {project, id, choice? | text? | allow?, always?}`; `project_questions_set {project, mode: "ask"|"decide"}`; `rebuild_stop {project}` → `{stopping}`, kills the builder (status becomes `stopped`, label "Paused"); `rebuild_activity_show {project, limit}` → `{lines}`.
  - Builds run inside the MCP child; the builder (`claude -p …`) runs in its **own process group**; the child ignores SIGTERM for > 2 s; closing its stdin ends it at once. Shutdown order: `rebuild_stop` for every running project → close stdin → wait ≤ 3 s → SIGKILL the child's group → SIGKILL every process group of the child's descendants recorded before closing.
  - The builder inherits the child's environment: `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` select the account; `claude` is found on `PATH`.
  - Craft Anything writes into the folder given as `project_folder`: records at the root, the app in `app/`.
- Supervisor config dir `<dataDir>/craft-anything/rebuilds` (separate from the sessions' `…/sessions`): `writeCraftConfig` with the same Ghidra rules as PR 1 and `auto_mode = false`.
- `build_with` values (0.5.0): `Builder's choice`, `Plain HTML and CSS`, `React + TypeScript (Vite)`, `Next.js + TypeScript`, `Python`, `Electron`, `Rust (console)`, `Rust + egui (eframe)`, `unity`, `unreal`, `godot` — pinned beside `craftManifest` as `craftStacks`.
- Every rebuild creates a fresh folder in the owner's default projects folder (`preferences.defaultCwd`), named from the request (made unique), registered as an AgentPier project; then `.gitignore` (`capture/`, `checks/`, `inbox/`, `investigation.cany/`) and `git init`; AgentPier makes no commits.
- Auto mode (one switch, default off, global default in Craft settings): off → `project_questions_set ask`, every question and approval goes to the owner; on → `project_questions_set decide` and the supervisor answers approvals with `allow: true` itself.
- Callers: the owner (UI), the owner's coding sessions (session MCP), the owner's own agents (agent tool). A caller other than the UI may set only `request`, `target`, `stack`; account, mode and auto mode follow the owner's defaults.
- Accounts: Claude accounts that `preferences` deems eligible (local or managed, no provider, not internal); default `defaultAccountIds.claude`, else `local-claude`. Environment from `services.accounts.environment(accountId)` plus the supervisor's Craft env.
- Tests never start real Claude or reach the network: a fake MCP server (`tests/helpers/fake-craft-mcp.mjs`, Node) implements the tools above with file state and spawns a fake builder in its own group.

## Review Focus

1. **AgentPier stops or restarts mid-build** → builder and children are gone after shutdown; after the next start the rebuild shows Paused and **Continue** resumes it (Task 3 tests `shutdown leaves no builder process` and `a rebuild running at shutdown reads paused after restart`).
2. **The child dies unexpectedly** → its rebuilds read failed/paused, no orphan builder stays (Task 2 test `descendant groups are killed when the child is gone`).
3. **Two rebuilds on different accounts** → two children, each builder with its own `CLAUDE_CONFIG_DIR` (Task 3 test `each account gets its own child`).
4. **A question answered twice** (inbox and page at once) → second answer is refused cleanly as already answered (Task 5 test).
5. **The default projects folder is not writable / the name is taken** → start refused with a clear message, nothing left behind; taken names get a suffix (Task 1 tests).

---

### Task 1: Shared project-folder creation

**Files:**

- Create: `server/features/projects/project-folder.js`
- Modify: `server/features/assistants/agent-projects.js` (use it; behaviour unchanged)
- Test: `tests/unit/project-folder.test.js`; existing `tests/integration/agent-projects-*.test.js` stay green

**Interfaces:**

- Produces: `createProjectFolder({ preferences, memory, name, git = true, unique = false }) → Promise<{ project, path, rollback: () => Promise<void> }>` — the safe sequence now in `AgentProjects.create`/`register`/`unchanged`/`rollback` (folder in `defaultCwd`, held open, unchanged check, optional `git init`, `memory.register`, rollback on failure). `unique: true` appends ` 2`, ` 3`, … to a taken name instead of refusing. `projectFolderName(text) → string` (a valid directory name from free text, ≤ 60 chars, falls back to `Rebuild`).
- [ ] **Step 1:** Tests: `creates, registers and git-inits a fresh folder`; `a taken name gets a suffix when unique`; `refuses an unwritable default folder and leaves nothing`; `rollback removes only the folder it made`; `projectFolderName turns a request into a folder name`.
- [ ] **Step 2:** Run `node --test tests/unit/project-folder.test.js` → FAIL.
- [ ] **Step 3:** Implement by moving the existing logic; `AgentProjects` calls it with `unique: false`.
- [ ] **Step 4:** Run the new test plus `node --test tests/integration/agent-projects-*.test.js` → PASS.
- [ ] **Step 5:** Commit `refactor: share the safe project folder creation`.

### Task 2: Stdio MCP client for Craft Anything

**Files:**

- Create: `server/features/craft/craft-mcp-client.js`, `tests/helpers/fake-craft-mcp.mjs`
- Test: `tests/integration/craft-mcp-client.test.js`

**Interfaces:**

- Produces: `class CraftMcpClient` — `static async start({ command, args, env, cwd, spawnImpl? }) → CraftMcpClient` (spawn `detached: true`, stdio pipes, stderr to a bounded ring for diagnostics, `initialize` + `notifications/initialized`, refuse when the server does not list `rebuild_start`); `call(name, args, { timeoutMs = 30000 }) → Promise<object>` (returns `structuredContent.result` or the parsed text's `result`; a tool error becomes `Error` with `.code`); `get alive`; `onExit(listener)`; `async close({ stopProjects = [] })` implementing the shutdown order from Global Constraints (descendants found via `ps -eo pid=,ppid=,pgid=` walk before closing).
- Fake server: `node tests/helpers/fake-craft-mcp.mjs` speaks line-delimited JSON-RPC, keeps per-project state under the given `project_folder` (`craft.json`, `usage.json`, `build-activity.log`), spawns a fake builder (`sleep`) in its own group on `rebuild_start`, can post a question/approval (controlled by env `FAKE_CRAFT_SCRIPT`), ignores SIGTERM like the real one, and exits on stdin close.
- [ ] **Step 1:** Tests: `calls a tool and returns its result`; `a tool error carries its code`; `close stops projects, ends the child and leaves no builder process`; `descendant groups are killed when the child is gone` (SIGKILL the child externally, then `close()`); `a call after exit is refused`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: talk to Craft Anything over stdio MCP`.

### Task 3: `CraftRebuilds` supervisor

**Files:**

- Create: `server/features/craft/craft-rebuilds.js`, `server/features/craft/rebuild-store.js`, `server/features/craft/rebuild-view.js`, `server/features/craft/craft-stacks.js`
- Modify: `server/features/tools/craft-config.js` (`rebuildsConfigDir(dataDir)`)
- Test: `tests/integration/craft-rebuilds.test.js`, `tests/helpers/craft-rebuilds-fixture.js`

**Interfaces:**

- Consumes: Task 1 `createProjectFolder`, Task 2 `CraftMcpClient`, PR 1 `CraftTool` (`state().installed`, `component()`/`craftCommand`, `craftEnvironment`, `writeCraftConfig`, Ghidra components), `services.accounts.environment(id)`, `services.preferences`, `services.memory`.
- Produces: `class CraftRebuilds` with `constructor({ dataDir, craft, accounts, preferences, memory, clientFactory = CraftMcpClient.start, now })`, `list() → RebuildView[]`, `get(id) → RebuildView | null`, `async start(input, { source: "owner"|"session"|"agent" }) → RebuildView` (input `{ request, target?, stack?, accountId?, mode?, autoMode?, rounds? }`, non-owner sources ignore all but request/target/stack), `async followUp(id, request)`, `async continue(id)` (resume), `async pause(id)` (`rebuild_stop`), `async answer(id, questionId, { choice?, text?, allow?, always? })`, `async setAutoMode(id, on)`, `async activity(id, { limit })`, `settings() / saveSettings({ accountId, mode, autoMode })` (owner defaults in `rebuilds.json`), `onChange(listener)` (fires `{ id }` or `{ list: true }`), `async start()` (server start: every record whose status was running/queued becomes paused — nothing restarts on its own), `async close()`.
- `RebuildView`: `{ id, projectId, folder, name, request, target, stack, accountId, mode, autoMode, source, createdAt, status ("starting"|"building"|"checking"|"needs_you"|"ready"|"paused"|"failed"), statusLabel, note, step ("study"|"build"|"check"|"ready"), checks, similarity, usage {inputTokens, outputTokens, costUsd}, lastReply, questions[] }`.
- Children: keyed `accountId + mode`, env = `accounts.environment(accountId)` + `craftEnvironment(dataDir)` with `CRAFT_ANYTHING_CONFIG_DIR = rebuildsConfigDir(dataDir)`; args `mcp --all-tools --allow-run --clean-room|--deep`; closed 60 s after their last rebuild stopped running.
- Sampler: every 2 s while any rebuild runs (stops when none), `rebuild_status` + `project_show` per running rebuild; emits `onChange` only when the view changed; with auto mode on answers approvals `allow: true`.
- Refuses (409, `craft` server messages): Craft Anything not installed; account not eligible; empty request; a second `start` with the same request id is idempotent if `requestId` is given (session/agent retries).
- [ ] **Step 1:** Tests (fake server via `clientFactory` wrapper pointing at `fake-craft-mcp.mjs`): `start creates and registers a project, inits git and writes .gitignore`; `start passes project_folder, build_with and rounds`; `each account gets its own child with its own CLAUDE_CONFIG_DIR`; `deep mode uses its own child`; `a non-owner source cannot choose account, mode or auto mode`; `auto mode off asks, on decides and allows approvals`; `answer forwards to project_inbox_answer`; `pause stops the build and continue resumes it`; `followUp sends a request to the same project`; `shutdown leaves no builder process`; `a rebuild running at shutdown reads paused after restart`; `an idle child closes after 60 s` (fake clock); `refuses when Craft Anything is not installed`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: supervise Craft Anything rebuilds`.

### Task 4: Routes, live topics, wiring

**Files:**

- Create: `server/http/routes/craft-rebuilds.js`, `server/features/craft/live-topics.js`, `server/application/craft-rebuilds-wiring.js`
- Modify: `server/application/services.js` (≤ 600 lines: put construction in the wiring module), `server/application/shutdown.js` (close **before** inbox and notifications), `server/app.js` (start after `craft.start()`; mount routes), `server/application/live-wiring.js`, `web/lib/live/live-topics.js`
- Test: `tests/integration/craft-rebuilds-routes.test.js`, extend `tests/unit/live-topics.test.js`, `tests/blackbox/user-socket-denial.test.js`

**Interfaces:**

- Routes (owner only, `no-store`, 503 without the service): `GET /api/craft/rebuilds` → `{ rebuilds, settings, accounts: [{id, name}], stacks }`; `POST /api/craft/rebuilds` → 201 view; `GET /api/craft/rebuilds/:id` → view (404 unknown); `POST /:id/follow-up {request}`, `POST /:id/continue`, `POST /:id/pause`, `POST /:id/answer {questionId, choice?, text?, allow?, always?}`, `POST /:id/auto-mode {on}`, `GET /:id/activity?limit=` → `{ lines }`; `PUT /api/craft/settings`.
- Topics: `craft.rebuilds` (state: the `GET /api/craft/rebuilds` body) and `craft.rebuild:<id>` (state: the view, `{ rebuild: null }` when unknown), owner only, invalidated from `CraftRebuilds#onChange`; web entries `{ mode: "state", path, interval: 5000 }`.
- [ ] Steps 1–5 as usual; commit `feat: serve rebuilds over HTTP and the live channel`.

### Task 5: Questions and approvals in the inbox and push

**Files:**

- Modify: `server/features/inbox/inbox-items.js` (type `craft`, tab of questions), `inbox-sources.js` (`read("craft", …)`), `inbox-history.js`, `server/http/routes/inbox.js`; push: `server/features/notifications/push-validation.js` (kind `craft-question`, payload `rebuildId`, link `/craft/<id>`), `push-preferences.js` (default on, blocking), `push-content.js`, `public/pwa-de.js`, `public/pwa-en.js`, `web/features/notifications/NotificationPreferences.jsx`, i18n; web inbox: `web/features/inbox/routes.js`, `InboxDetail.jsx`, `InboxSourceDetails.jsx` (new `InboxCraftDetail` following `craft.rebuild:<id>`), `inbox-presentation.js`
- Create: `web/features/craft/CraftQuestion.jsx` (one question/approval with its choices, free text when `allow_text`, Allow/Deny/Always for approvals) — reused by the Rebuilds page
- Test: extend `tests/unit/inbox-items.test.js`, `tests/integration/owner-inbox.test.js`, `tests/unit/push-kinds-deliverable.test.js`, `tests/unit/push-preferences.test.js`; browser test in Task 8

**Interfaces:**

- Inbox item per open question: `{ type: "craft", id: "<rebuildId>:<questionId>", source: { kind: "craft", id: rebuildId, name, project }, title, createdAt, link: "/craft/<rebuildId>" }`; `services.inbox.changed()` on every change of open questions.
- Push: one `notify({ kind: "craft-question", eventId: "<rebuildId>:<questionId>", rebuildId, label, project, preview: title, inbox: { type: "craft", id } })` per new question; no decide buttons (answers happen in AgentPier).
- [ ] Steps 1–5; test `a question answered twice is refused as already answered`; commit `feat: bring rebuild questions to the inbox and push`.

### Task 6: Start from sessions (session MCP)

**Files:**

- Create: `server/features/craft/craft-mcp-tools.js`
- Modify: `server/features/mcp/tool-service.js` (list + dispatch like `preview-mcp.js`), `server/features/mcp/http-transport.js` (instructions, idempotent hint for `craft_rebuild_start`)
- Test: `tests/integration/craft-mcp-tools.test.js`

**Interfaces:**

- Tools, offered only with `grant.allResources && context.sessionId` and Craft Anything installed: `craft_rebuild_start { request, target?, stack?, requestId }` → `{ id, project, status, link }` (source `session`); `craft_rebuild_status { id }` → the view without questions' detail.
- [ ] Steps 1–5 (tests mirror `preview-mcp.test.js`: listed only for full session context, revoked grant refused, non-owner fields ignored, idempotent requestId); commit `feat: let sessions start rebuilds`.

### Task 7: Start from the owner's agents

**Files:**

- Create: `server/features/assistants/team-plugin/craft-tool.js`, `server/features/craft/agent-craft.js`
- Modify: the agent tool path for a new action `craft` exactly like `agentpier_project`: `team-plugin/index.js` (`ownTools`, `toolTimeouts`), `team-plugin/openclaw.plugin.json`, Hermes `team-plugin.js`, `team-bridge.js`, `team-bridge-actions.js`, `owner-runs.js`, `native-capabilities.js` (grant only when `mayCreateProjects(agent)` and Craft Anything installed), `runtimes/openclaw/runtime-config.js`, `assistant-bootstrap.js` (one guidance line), audit vocabulary
- Test: `tests/integration/agent-craft.test.js`, extend `tests/unit/assistant-native-capabilities.test.js`, `openclaw-config-characterization.test.js`, `hermes-config-golden.test.js`

**Interfaces:**

- Tool `agentpier_craft { action: "start", request, target?, stack? } | { action: "status", id }`; gated by `ownerChatCall` + `mayCreateProjects`; deduplicated by `attemptId`; start uses source `agent`; the agent never receives questions (they go to the owner).
- [ ] Steps 1–5; commit `feat: let the owner's agents start rebuilds`.

### Task 8: The Rebuilds page

**Files:**

- Create: `web/features/craft/CraftPage.jsx` (list + start form), `web/features/craft/RebuildDetail.jsx`, `web/features/craft/useRebuilds.js`, `web/features/craft/routes.js`, `web/lib/i18n/{de,en}/craft.js`, `web/lib/i18n/messages/craft.js`, `tests/browser/craft-rebuilds.spec.js`, `tests/browser/craft-rebuilds-fixture.js`
- Modify: `web/app/routes.js`, `web/app/App.jsx`, `web/app/sidebar-menu-model.js` (work group, after Projects), `web/app/SidebarMenu.jsx`, `web/app/search-entries.js`, tests `sidebar-menu-model.test.js`, `search-index.test.js` (query "craft" now opens the Rebuilds page; "Craft Anything" still opens the installation page), `quick-open.test.js`, route tests
- **Content:** label en **Rebuilds**, de **Nachbauten** (aliases: Craft, Craft Anything, rebuild, Nachbau). When Craft Anything is not installed the page says so and links to its card. Start form: what to make, target (web address / local path / none), stack (`craftStacks`, default Builder's choice), account (eligible Claude accounts), Clean room / Deep, Auto mode (switch), rounds (default 2), consent note. List rows: name, status, step, updated. Detail: steps Study → Build → Check → Ready, note, latest check + similarity, open questions (`CraftQuestion`), activity (last 200 lines), usage, last reply, buttons Pause / Continue, follow-up box, Auto mode switch, links Open project (`/projects/<id>`), Open folder (`/files?path=<app folder>`), Open a session here (launch modal with `cwd`). Settings (owner defaults) in a small section of the page.
- [ ] Steps 1–5; browser tests: start a rebuild (stubbed API), answer a question, approval Allow, pause/continue, follow-up, not-installed state, phone layout; commit `feat: add the Rebuilds page`.

### Task 9: Docs, spec removal, full check

**Files:**

- Create: `docs/craft.md` (Rebuilds guide: what it does, accounts, clean room/deep, auto mode, projects, questions/inbox/push, sessions and agents tools, shutdown/pause/continue, limits — no preview yet)
- Modify: `docs/mcp.md` (session tools `craft_rebuild_start`/`craft_rebuild_status`; Managed Craft Anything links to the guide), `docs/agents.md` (`agentpier_craft`), `docs/inbox.md`, `docs/notifications.md` (push kind), `docs/architecture.md` (topics `craft.rebuilds`, `craft.rebuild:<id>`, sampler 2 s while running), `README.md`, `README.de.md`, `docs/README.md` (index)
- Delete: `docs/superpowers/specs/2026-11-08-craft-anything-design.md`, this plan
- [ ] Step 1 docs; Step 2 `npm run check` exit 0; Step 3 `npm run test:e2e -- tests/browser/craft-rebuilds.spec.js tests/browser/craft-anything.spec.js`; Step 4 manual check in a disposable data dir with the real pinned binary and a fake `claude` on PATH (start, question, answer, pause, continue, stop AgentPier → no builder process left); Step 5 commit `docs: describe Craft Anything rebuilds`.
