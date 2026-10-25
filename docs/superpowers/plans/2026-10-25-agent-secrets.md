# Agent Secrets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner stores named secrets (e.g. `ZABBIX_TOKEN`) in **Settings → Access → Secrets**; AgentPier delivers the granted ones as a read-only, sh-sourceable file to agents (in their workspace) and to coding-CLI sessions (outside the repository).

**Architecture:** A new `server/features/secrets/` feature owns a private SQLite store (`<data>/secrets/secrets.sqlite`, like the MCP server values), the env-file format and two deliverers: `AgentSecrets` (writes `<workspace>/.agentpier/secrets.env` for granted agents, per turn and on every change) and `SessionSecrets` (a launch-chain step writing `<data>/secrets/sessions/<sessionId>/secrets.env`). Agent grants live in the existing `assistant_access` policy (`secretIds`), the team-plugin write guard refuses writes under `.agentpier/`, the SSH SessionStart hook names the session file, and credential backups seal the store like SFTP passwords.

**Tech Stack:** Node.js ES modules, `node:sqlite` via `server/lib/private-database.js`, Express, React/JSX, `node:test`, Playwright, OpenClaw 2026.10.7 team plugin.

**Spec:** `docs/superpowers/specs/2026-10-25-agent-secrets-design.md` (binding).

## Global Constraints

- Values never appear in Git, logs, audit details, HTTP responses, AgentPier-generated messages, ordinary (non-credential) backups or tool results produced by AgentPier.
- Delivered as a file only, never as an environment variable holding a value (a variable holding the *path* is fine).
- Name syntax `^[A-Z_][A-Z0-9_]{0,63}$`, unique across all secrets; description ≤ 200 chars; value 1–8192 UTF-8 bytes, no NUL; at most 200 secrets; at most 50 secrets per agent and per session.
- File format, one line per secret sorted by name: `NAME='value'` with every `'` in the value written as `'\''`; first line `# Managed by AgentPier. Do not edit; changes are overwritten.` Files 0600, folders 0700.
- Recipients: the owner's agents and permanent team members; never restricted users' agents (`isUserAgent`), temporary members, archived agents, agents with their own Telegram bot for other people; sessions: codex, claude, opencode, shell; never login or headless pipeline sessions.
- AGENTS.md: files ≤ 600 lines (`assistant-access.js` is at 583, `tool-guard.js` at 567 — put new logic in new modules), Prettier, de/en i18n with matching keys and `npm run i18n:confirm` + committed `translation-lock.json` files, `docs/ui-guide.md` components only (no new hex colours, breakpoints, dialogs), disposable data dirs in tests, never the default tmux server.
- Out of scope: the webhook (AGENTPIER-216) per-hook "Secrets" switch (216 is not merged) — record as follow-up in `docs/secrets.md`; changing a running session's explicit secret assignment (launch-time only; project secrets follow changes live).
- Commits end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never bare `git stash`. Do not push.

## Review Focus

- **Workspace backups:** agent workspaces are backed up publicly — `.agentpier/secrets.env` must be excluded from every backup capture (Task 3 test).
- **A value containing `'`, `$`, backticks, `\`, newlines** must survive `set -a; . file; set +a` byte-for-byte with no expansion (Task 1 test runs `sh`).
- **An agent with shell deletes or edits the file:** the guard covers only file tools; the per-turn sync must restore it before the next turn (Task 3 test), and the docs must say shell is not covered.
- **A deleted secret or a revoked grant** must vanish from every delivered file at once, and a secret's deletion must leave no inert grant that blocks a later agent save (Task 3 test).
- **A restricted-user agent or temporary member** must neither be grantable nor receive a file, even if a grant row exists from before (Task 3 test).

---

### Task 1: Secret store, env format and audit

**Files:**
- Create: `server/features/secrets/secret-store.js`, `server/features/secrets/secret-format.js`, `server/features/audit/audit-secret-details.js`
- Modify: `server/features/audit/audit-schema.js` (resource `secret`, verbs, details dispatch), `server/lib/i18n/de/secrets.js` + `server/lib/i18n/en/secrets.js` (+ catalog index if the server catalogs are aggregated), `server/features/system-status/data-areas.js` (`secrets` area)
- Test: `tests/unit/secret-store.test.js`, `tests/unit/secret-format.test.js`

**Interfaces:**
- Produces:
  - `secretEnvFile(entries: {name, value}[]) -> string` (sorted by name, header line, trailing newline; empty array → `""`).
  - `writeSecretFile(file: string, entries) -> Promise<"written"|"removed"|"unchanged">`: entries empty → unlink (ignore ENOENT); else atomic tmp (`wx`, 0600) + rename, skipped when content is identical; refuses a symlinked parent folder; creates the folder 0700.
  - `class SecretStore({ dataDir, audit, clock })` with `list() -> PublicSecret[]`, `get(id) -> PublicSecret`, `create(input, actor) -> PublicSecret`, `update(id, input, actor) -> PublicSecret`, `remove(id, actor)`, `entries(ids: string[]) -> {name, value}[]` (unknown ids skipped), `projectEntries(projectId) -> {id,name,value}[]`, `moveProject(fromId, toId)`, `exportSealed() -> {version:1, secrets:[{id,name,description,projectId,value}]}`, `importRestored()` (Task 5), `onChange(listener)`; `PublicSecret = {id, name, description, projectId, updatedAt, hasValue: true}`.
  - Input: `{name, description?, projectId?: string|null, value?}`; `create` requires `value`; `update` keeps the value when `value` is absent. Errors via `problem(serverMessages.secrets.<key>, status)` with codes `SECRET_INVALID` (400), `SECRET_NAME_TAKEN` (409), `SECRET_LIMIT` (409), `SECRET_NOT_FOUND` (404).
  - Audit: `secret.created|secret.updated|secret.deleted`, `resourceType:"secret"`, `resourceId:id`, `source:"user"`, `details:{name, changed?: ["name"|"description"|"project"|"value"]}`; the details filter drops everything else.

- [ ] **Step 1: Write failing tests**: `secret-format.test.js` — `secretEnvFile([{name:"B",value:"x"},{name:"A",value:"it's $HOME `id` \\ \nline2"}])` starts with the header, lists `A` before `B`; writing it to a temp file and running `sh -c 'set -a; . "$1"; set +a; printf %s "$A"' _ file` returns the exact value; `writeSecretFile` creates mode 0600 in a 0700 folder, returns `"unchanged"` on a second identical write and `"removed"` for `[]`. `secret-store.test.js` (temp `dataDir`) — create/list never returns `value`; name `zabbix` or `1X` → 400; duplicate name → 409; NUL in value or 8193-byte value → 400; update without `value` keeps it (`entries([id])`); audit stub receives `secret.created` with `details:{name}` and no value anywhere in `JSON.stringify(calls)`; `onChange` fires on create/update/remove; database file mode 0600.
- [ ] **Step 2: Run** `node --test tests/unit/secret-format.test.js tests/unit/secret-store.test.js` → FAIL (modules missing).
- [ ] **Step 3: Implement** the two modules (schema `secrets(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT NOT NULL DEFAULT '', project_id TEXT, value TEXT NOT NULL, updated_at INTEGER NOT NULL)` via `privateDatabase(path.join(dataDir,"secrets"),"secrets.sqlite")`), the audit resource and details filter, server messages (de + en), data area.
- [ ] **Step 4: Run** the tests plus `node --test tests/unit/audit*.test.js` → PASS.
- [ ] **Step 5: Commit** `feat: add a store for agent secrets`.

### Task 2: HTTP routes and settings summary

**Files:**
- Create: `server/http/routes/secrets.js`
- Modify: `server/app.js` (mount), `server/application/services.js` (construct `SecretStore` with `audit`; export `secrets`), `server/http/route-access.js` / `api-registry.js` / `route-inventory.js` as their tests require (owner-only), `server/features/settings/settings-summary.js` (`access.secrets = {count}`)
- Test: `tests/blackbox/secrets-routes.test.js`

**Interfaces:**
- Consumes: `SecretStore` (Task 1).
- Produces: `GET /api/secrets -> {secrets: PublicSecret[]}`, `POST /api/secrets` body `{name, description?, projectId?, value}` → 201 `PublicSecret`, `PATCH /api/secrets/:id` body subset → `PublicSecret`, `DELETE /api/secrets/:id` → 204. Unknown body keys → 400. Owner session only; restricted users get 403. `services.secrets` is the store.

- [ ] **Step 1: Write failing test** with the existing blackbox app harness (see `tests/blackbox/ssh-routes.test.js`): create → list has the entry without a `value` key and the response text never contains the value; patch description only keeps the value; delete → 204 then 404; a restricted user's request is refused; `GET /api/settings/summary` has `access.secrets.count`.
- [ ] **Step 2: Run** `node --test tests/blackbox/secrets-routes.test.js` → FAIL.
- [ ] **Step 3: Implement** the router, wiring and summary entry.
- [ ] **Step 4: Run** the test plus `node --test tests/unit/route-*.test.js tests/blackbox/settings*.test.js` → PASS.
- [ ] **Step 5: Commit** `feat: add secrets API`.

### Task 3: Agent grants and the agent secrets file

**Files:**
- Create: `server/features/secrets/agent-secrets.js`, `server/features/assistants/agent-secret-grants.js`
- Modify: `server/features/assistants/assistant-access.js` (accept `secretIds` in `prepare`'s `exact` list, delegate to `secretGrantList`, call the audit helper in `save`, expose `secretIds(id)`), `server/features/users/user-agent-lock.js` (lock `secretIds` for user agents), the Telegram-senders refusal (where `sshGranted` is wired in `server/application/assistant-graph.js` / `team-service.js`: add `secretsGranted` so a bot for other people is refused for an agent with secrets), `server/features/assistants/assistant-config.js` (sync before each turn next to `mirrorMemory`), `server/application/services.js` / `server/application/assistants.js` (construct `AgentSecrets`, `secrets.onChange(() => agentSecrets.syncAll())`, sync after `access.save`, `syncAll()` at startup), `server/features/operations/assistant-backup.js` (+ `server/features/assistants/runtime-update-snapshot.js` if it copies workspaces) to skip `workspaces/<id>/.agentpier/secrets.env`, `server/lib/i18n/{de,en}/assistants.js` (error copy)
- Test: `tests/unit/agent-secrets.test.js`, `tests/unit/assistant-access-secrets.test.js`, extend the backup capture test that covers workspaces

**Interfaces:**
- Consumes: `SecretStore.entries`, `writeSecretFile` (Task 1).
- Produces:
  - Policy field `secretIds: string[]` (sorted, unique, ≤ 50; absent in input keeps the stored list; unknown id → 409 `secretUnavailable`; agent with own bot for other people → 409 `telegramSendersSecrets`; ids of deleted secrets are silently dropped on read and save).
  - `secretGrantList(services, id, value) -> string[]`, `auditSecretGrants(audit, id, before, next)` (`assistant.updated`, `details.kind:"secret-grants"`, added/removed **names**).
  - `class AgentSecrets({ store, access, assistants, workspaces })` with `file(agentId) -> string` (`<workspaces>/<agentId>/.agentpier/secrets.env`), `eligible(agent) -> boolean` (`personalEligible(agent) && !isUserAgent(agent) && !telegramSendersConnected`), `sync(agentId) -> Promise<status>` (writes the granted entries or removes the file), `syncAll()`.

- [ ] **Step 1: Write failing tests**: granting `[s1]` writes the file with `S1='…'`, 0600; updating the value rewrites it; revoking or deleting the secret removes the file; deleting the file and calling `sync` (as the pre-turn hook does) restores it; a temporary member, an archived agent and a user agent (`userAccess` set) get no file even with a stored grant row; `access.save` with `secretIds:["missing"]` → 409; user agent save with `secretIds` → refused by the lock; audit details contain names, not values; backup capture of a workspace with `.agentpier/secrets.env` leaves that file out (other workspace files stay).
- [ ] **Step 2: Run** `node --test tests/unit/agent-secrets.test.js tests/unit/assistant-access-secrets.test.js` → FAIL.
- [ ] **Step 3: Implement**; keep `assistant-access.js` ≤ 600 lines (move code out if needed).
- [ ] **Step 4: Run** the new tests plus `npm run test:unit` (or the unit strategy script) → PASS; `npm run check:structure`.
- [ ] **Step 5: Commit** `feat: deliver granted secrets to agents`.

### Task 4: Write guard for `.agentpier/` and the 10.7 native contract

**Files:**
- Modify: `server/features/assistants/team-plugin/tool-guard.js` (`.agentpier` joins the protected folders so `write`/`edit`/`apply_patch` on any path below it, including `Delete File`/`Move to` hunks and link targets, are refused for every turn, the owner's included, with the message `Files in .agentpier are managed by AgentPier.`; `guardedWorkspaceEntry(".agentpier")` → true so agent SFTP downloads and browser uploads cannot write there; stay ≤ 600 lines — extract helpers to a sibling module if needed), `scripts/assistant-contract-shards.json` if the shard test requires it, `docs/assistant-gateway.md` (write-guard section)
- Create: `tests/integration/assistant-secrets-guard-contract.test.js`
- Test: extend `tests/integration/user-agent-tool-guard.test.js` or add `tests/unit/secrets-write-guard.test.js` using `tests/helpers/native-write-guard.js`

**Interfaces:**
- Consumes: the file path convention from Task 3 (`.agentpier/secrets.env`).

- [ ] **Step 1: Write failing fast test** with `nativeWriteGuard`: `write` to `.agentpier/secrets.env`, `edit` of it, `apply_patch` `*** Delete File: .agentpier/secrets.env`, `*** Move to: .agentpier/x`, `./.agentpier/secrets.env` and case variant `.AgentPier/secrets.env` are all refused in an owner turn; `write` to `notes.md` still passes.
- [ ] **Step 2: Run** it → FAIL.
- [ ] **Step 3: Implement** the guard change.
- [ ] **Step 4: Write the native contract** modelled on `tests/integration/assistant-write-guard-contract.test.js` (gate `AGENTPIER_ASSISTANT_ROUTINE_RUNTIME`, `timeout: 300000`): the workspace holds `.agentpier/secrets.env`; the scripted model calls `write`, `edit` and `apply_patch` (delete) on it in an owner turn; assert the file bytes are unchanged and each tool result matches `/managed by AgentPier/`; and that a `read` of it succeeds.
- [ ] **Step 5: Run** the fast test → PASS; provision 2026.10.7 into a scratch dir with `scripts/provision-assistant-contracts.mjs` (`provisionContractRuntime(dir)`) and run `AGENTPIER_ASSISTANT_ROUTINE_RUNTIME=<runtime> node --test tests/integration/assistant-secrets-guard-contract.test.js tests/integration/assistant-write-guard-contract.test.js` → PASS on 10.7; `node --test tests/unit/assistant-contract-shards.test.js tests/unit/assistant-write-guard-coverage.test.js` → PASS.
- [ ] **Step 6: Commit** `feat: refuse agent writes to their secrets file`.

### Task 5: Secrets in credential backups

**Files:**
- Create: `server/features/secrets/secret-backup.js`
- Modify: `server/features/operations/backup.js` (plan component `sealed-secrets` with credentials; omission `"Secrets (only in backups with a passphrase, then encrypted)"` otherwise, only when secrets exist), `server/features/operations/snapshot.js` (capsule member when `withCredentials`), `server/features/operations/restore.js` (allow the capsule member only; call `restoreSecrets(stage, projectMappings)`; report `secrets: {restored, withoutProject}`), `SecretStore.importRestored()` (reads `<data>/secrets/secrets-restore.json` on open, adds entries whose name is free, keeps ids, deletes the file), server i18n for the omission text; make sure the public capture never includes `<data>/secrets/`
- Test: `tests/integration/secret-backup.test.js` (or extend the SFTP backup test file's pattern)

**Interfaces:**
- Consumes: `SecretStore.exportSealed`, `importRestored` (Task 1).
- Produces: `secretsMember = "secrets/secrets.json"`, `secretsOmission`, `secretsPresent(dataDir)`, `captureSecrets(dataDir) -> {version:1, secrets}|null`, `restoreSecrets(stage, projectMappings) -> {restored, withoutProject}|null`, `secretsRestoreFile = "secrets-restore.json"`.

- [ ] **Step 1: Write failing test** (disposable data dirs): a backup without credentials contains no member under `secrets/`, no value bytes anywhere in the archive, and lists the omission; a credential backup with passphrase seals `secrets/secrets.json`; restoring it into a fresh data dir yields the same names, ids and values with mapped project ids (unmapped → `null`, counted in `withoutProject`); a name already present is not duplicated.
- [ ] **Step 2: Run** it → FAIL.
- [ ] **Step 3: Implement** mirroring `server/features/ssh/sftp-backup.js` and its call sites.
- [ ] **Step 4: Run** it plus `node --test tests/integration/*backup*.test.js tests/integration/*restore*.test.js` → PASS.
- [ ] **Step 5: Commit** `feat: seal secrets in credential backups`.

### Task 6: Secrets for coding-CLI sessions

**Files:**
- Create: `server/features/secrets/session-secrets.js`, `server/features/secrets/secrets-hint.js`
- Modify: `server/application/session-lifecycle.js` (step after `sshIntegration.prepare`, discard on failure; accept `body.secretIds` in launch validation), the session stop/remove path that calls `sshSessions.discard` (also discard secrets), the reload lifecycle so a reloaded session keeps its secrets, `server/features/ssh/ssh-hook.js` and `server/features/ssh/ssh-opencode.js` (append the secrets hint), `server/application/project-rebind.js` (`secrets.moveProject`), `server/application/services.js` (construct, `secrets.onChange(() => sessionSecrets.syncAll())`, `syncAll()` at startup), `server/http/routes/` launch body schema if it whitelists keys
- Test: `tests/unit/session-secrets.test.js`, `tests/unit/secrets-hint.test.js`, extend `tests/unit/ssh-integration.test.js` or the lifecycle test that covers the chain

**Interfaces:**
- Consumes: `SecretStore.projectEntries`, `entries`, `writeSecretFile`.
- Produces:
  - `SECRETS_FILE_ENV = "AGENTPIER_SECRETS_FILE"`; `secretsReminder(file) -> string` = ``AgentPier secrets for this session are in ${file}. When a task needs them, load them in the same shell command with `set -a; . '${file}'; set +a`. Never print, log, commit or paste their values.``; the hook appends it (with a leading space) only when the env var is set **and** the file exists at hook time.
  - `class SessionSecrets({ dataDir, store, sessions })` with `file(sessionId) -> "<data>/secrets/sessions/<id>/secrets.env"`, `prepare({id, account, launch, purpose, headless, secretIds}) -> launch` (ineligible → launch unchanged; else creates the folder 0700, writes the file, sets `launch.env[SECRETS_FILE_ENV]`, adds a nono `{access:"read", path: folder}` grant via `addGrant`, and sets `launch.secrets = {projectId, assignedIds}` from `launch.sshTools.project.projectId`; unknown `secretIds` → 409 `SECRET_NOT_FOUND`, > 50 → 400), `sync(session)`, `syncAll()` (running sessions with `session.secrets`), `discard(sessionId)` (removes the folder).
  - Effective secrets of a session = secrets with `projectId === session.secrets.projectId` ∪ `assignedIds` (deleted ids skipped).

- [ ] **Step 1: Write failing tests**: a claude session in project P with one P secret and an explicitly assigned global secret gets a file containing both, the env var, the nono read grant and `launch.secrets`; the env never contains a value; a login session, a headless pipeline session and a session without secrets get no env var; adding a P secret / changing its value / deleting it updates the running session's file via `syncAll`; `discard` removes the folder; `secretsReminder` text matches; `sshReminder` output includes the secrets hint only when the env var points to an existing file; `moveProject` re-points project secrets.
- [ ] **Step 2: Run** `node --test tests/unit/session-secrets.test.js tests/unit/secrets-hint.test.js` → FAIL.
- [ ] **Step 3: Implement**; verify the session record keeps `secrets` (`...finalLaunch` is spread into `sessions.create`) and that reload re-sets the env and grant.
- [ ] **Step 4: Run** the tests plus `node --test tests/unit/ssh-*.test.js tests/integration/ssh-discovery.test.js` and the session lifecycle tests → PASS.
- [ ] **Step 5: Commit** `feat: give coding sessions their project secrets`.

### Task 7: Settings → Access → Secrets page

**Files:**
- Create: `web/features/secrets/SecretsSettings.jsx`, `web/features/secrets/SecretForm.jsx`, `web/features/secrets/secrets.css` (tokens only, if any CSS is needed), `web/lib/i18n/de/secrets.js`, `web/lib/i18n/en/secrets.js`, `web/lib/i18n/messages/secrets.js` (`secretsCopy`), `tests/browser/secrets-settings.spec.js`, `tests/browser/secrets-fixture.js`
- Modify: `web/features/operations/routes.js` (`sections` + `settingsSectionGroups.access` after `ssh`), `web/features/settings/SettingsSubpage.jsx` (lazy page; add to `wideSections`), `web/features/settings/settings-summary-rows.js` (row with count), `web/lib/i18n/{de,en}/operations.js` (`sections.secrets`) and `settings.js` (`secretsSub`), `web/lib/api.js` error-code mapping for `SECRET_*`, `tests/browser/operations-fixture.js` (`summary.access.secrets`), both `translation-lock.json`

**Interfaces:**
- Consumes: the API of Task 2; project list from `GET /api/ssh-projects` (or the projects endpoint the SSH form uses) for the owner field.
- UI: `ListDetail` with list items name, description, owner ("Global" or project name); **New secret** button; detail form fields **Name**, **Description**, **Project** (Global / project), **Value** (password input; on an existing secret shows "Value saved" with a **Replace value** button that reveals an empty password field — the stored value is never fetched), **Save**, **Delete** (existing confirm-dialog component). A short notice: "Agents and sessions that receive a secret can read its value. Use tokens with the fewest rights the task needs." English labels: page title "Secrets", sub "Tokens and URLs for agents and coding CLIs".

- [ ] **Step 1: Write failing Playwright spec** (English, stubbed API via the fixture): the Access tab shows **Secrets** with its count; creating `ZABBIX_TOKEN` posts `{name, description, projectId:null, value}`; the list shows it; opening it shows "Value saved" and no value input content; **Replace value** + Save sends `value`, Save without replacing sends no `value` key; invalid name shows the translated error; delete asks for confirmation and sends DELETE; narrow viewport can close the detail.
- [ ] **Step 2: Run** `npx playwright test tests/browser/secrets-settings.spec.js --project=chromium` (after `npm run build`) → FAIL.
- [ ] **Step 3: Implement** the page and copy (de + en, same keys and arguments).
- [ ] **Step 4: Run** the spec on chromium and webkit, `node --test tests/unit/ui-guide-rules.test.js tests/unit/i18n*.test.js`, then `npm run i18n:confirm -- secrets operations settings` after reviewing each pair, and the lock test → PASS.
- [ ] **Step 5: Commit** `feat: manage secrets in the access settings`.

### Task 8: Pick secrets for agents and new sessions

**Files:**
- Create: `web/features/assistants/settings/SecretGrantPage.jsx`, `web/features/secrets/LaunchSecretChoices.jsx`, `tests/browser/assistant-secrets.spec.js`, `tests/browser/launch-secrets.spec.js` (or extend the launch spec)
- Modify: `web/features/assistants/settings/WorkTab.jsx` (page `secrets` + summary row, locked for user agents like `ssh`), `web/features/assistants/settings/agent-settings-fields.js` (draft `secretIds`), the assistant catalog payload (`AssistantAccess.catalog()` adds `secrets: PublicSecret[]`), `web/features/sessions/LaunchAccessFields.jsx` (secrets choice next to SSH; sends `secretIds` of chosen global or other-project secrets; project secrets are listed as **Project**, preselected and fixed), `web/lib/i18n/{de,en}/assistant-settings` catalog (or a new `assistant-secrets.js`), `secrets.js`, both `translation-lock.json`

**Interfaces:**
- Consumes: policy field `secretIds` (Task 3), launch body `secretIds` (Task 6), `GET /api/secrets`.
- UI: checkbox list of secrets (name, description, owner badge) using the existing choice components; the page notes that the agent finds them in `.agentpier/secrets.env` and can read the values.

- [ ] **Step 1: Write failing specs**: agent Work → Secrets shows the secrets, checking one and saving sends `secretIds:["…"]` in the PATCH; a user agent shows the locked notice; the new-session dialog lists a global secret and sends its id as `secretIds`.
- [ ] **Step 2: Run** them on chromium → FAIL.
- [ ] **Step 3: Implement** and add de/en copy.
- [ ] **Step 4: Run** the specs (chromium), `tests/browser/assistant-ssh-*.spec.js` and launch specs as regression, ui-guide and i18n tests, `npm run i18n:confirm -- <catalogs>` → PASS.
- [ ] **Step 5: Commit** `feat: grant secrets to agents and sessions`.

### Task 9: Documentation

**Files:**
- Create: `docs/secrets.md`
- Modify: `README.md`, `README.de.md` (feature list), `docs/agents.md` (Work → Secrets), `docs/backups.md` (credential list + "Secrets in backups" section incl. "requires AgentPier 2.7.0 or newer to restore"; older releases reject the unknown capsule member), `docs/assistant-gateway.md` (write guard covers `.agentpier/`), `docs/ssh-access.md` (startup hint also names the secrets file), `docs/README.md` index, `docs/ui-glossary.md` if it lists settings pages

**Content of `docs/secrets.md`:** what a secret is; Settings → Access → Secrets; agents (`.agentpier/secrets.env`, rewritten at once and before every turn, file tools refuse writes, **shell is not covered — an agent with shell can read and change any file of the owner's user; the next turn restores the file**); sessions (file path under the data dir, project vs explicit assignment at launch, hint and `set -a; . <path>; set +a`, new project secrets appear in the hint after **Reload & resume**, the file updates immediately); who receives them; trust model (agents see values, use least-privilege tokens; no proxy); storage (private SQLite 0600, not encrypted at rest, like MCP server values); audit (names only); backups; follow-up: per-webhook "Secrets" switch once AGENTPIER-216 lands; running-session assignment changes.

- [ ] **Step 1: Write the docs** (English; German README in German).
- [ ] **Step 2: Run** `npx prettier --check docs README.md README.de.md` and any docs link test (`node --test tests/unit/docs*.test.js`) → PASS.
- [ ] **Step 3: Commit** `docs: document agent secrets`.
