# Agents Create Their Own Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An eligible agent creates a new, empty project folder in the owner's default working directory with the own tool `agentpier_project`. AgentPier registers the folder as a project, grants the agent write access and optionally coding sessions, and tells the owner in chat and Telegram.

**Architecture:** A new `AgentProjects` service (`agent-projects.js`) runs on `AssistantWorkflows` and is reached through the team bridge as action `project`. Pure rules (name, eligibility, limit) live in `agent-project-rules.js`. The creation record (`agent_created_projects`) lives in `agent-project-store.js`. The narrow grant write lives in `agent-project-grants.js`, beside `AssistantAccess` and modelled on `grantSsh`. The settled action row is rendered as a chat note and mirrored to Telegram (`agent-project-notes.js`). `assistant-access.js`, `team-bridge.js` and `assistant-graph.js` grow by at most a dispatch line.

**Tech Stack:** Node.js ES modules, `node:sqlite` through the assistant store, `git` via `execFile`, React/JSX, `node:test` + fast-check, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-28-agent-created-projects-design.md` (owner-approved, binding). Ticket AGENTPIER-273.

## Global Constraints

- Parent folder: `preferences.get().defaultCwd` (falls back to the home folder, `server/features/settings/preferences.js:35`). Nothing is ever created anywhere else.
- Name rules: the rules of `createDirectory` (`server/lib/directories.js:50`): a string, non-empty after trim, equal to its trim, no `/` or `\`, no control characters, not `.`/`..`, at most 255 bytes. In addition, no leading dot.
- An existing entry of that name (folder, file or link) is refused with `PROJECT_EXISTS`. Nothing existing is ever adopted.
- The registered project's `cwd` must equal the realpath of the new folder, and its id must not have existed before the call. Otherwise the call fails and the new folder is removed.
- `git init` runs by default (`git: true`) before `register`. A failed `git init` fails the call and removes the folder.
- Grant write: `projectIds` += id, `projectFiles[id] = "write"`, and with coding `sessionProjectIds` += id. `revision` + 1, `approvalRevision` unchanged. Never `saveWork`/`prepare`.
- Who: not archived, not `isUserAgent`, no `teamMemberId` (no team member of any kind), not sender-facing (`assistantTelegramSenders.connected`). Leads qualify.
- When: only `directOwnerTurn(origin)` from web chat or the owner's paired Telegram. Routines, hooks, command continuations, team requests, goal continuations and forwarded content are refused with `PROJECT_OWNER_ONLY`.
- Limit: 10 creations per agent per rolling 24 hours (`PROJECT_CREATE_LIMIT`).
- Creation record: table `agent_created_projects(project_id, assistant_id, created_at)`, listed in `agentTables`.
- The `coding` action only works for projects in that table for this agent. Switching coding on needs the project grant to still exist.
- Error codes, exact: `PROJECT_NAME_INVALID`, `PROJECT_EXISTS`, `PROJECT_CREATE_LIMIT`, `PROJECT_OWNER_ONLY`, `PROJECT_NOT_CREATED_BY_YOU`, `PROJECT_NOT_ELIGIBLE`, `PROJECT_FOLDER_UNAVAILABLE`.
- `agentpier_project` is in `senderLockedTools` (and in `lockedTools` for user agents). It is never in `routineTools` or a hook's actions.
- Audit: the agent is the actor (new audit source `"agent"`), never an owner save.
- i18n: German and English in parity. Run `npm run i18n:confirm` and commit both `translation-lock.json` files. German never says "Konto"/"Konten"/"Sitzung" ("Coding-Sessions" is the house term). English uses US spelling and sentence case. UI labels: "Default working directory" / "Standard-Arbeitsverzeichnis".
- Files have at most 600 lines. `assistant-access.js` (597) must not grow. `team-bridge.js` (592) gets only the dispatch. `assistant-graph.js` (596) is not touched. Wire on `AssistantWorkflows` (582) instead.
- Tests use temp dirs (`fs.mkdtempSync(path.join(os.tmpdir(), …))`), never the real data dir or the default tmux server. On macOS `os.tmpdir()` is a symlink, so compare realpaths.
- Commits use `feat:`/`fix:`/`chore:`, one per task, and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Default folder inside a Git repository, `git: false`.** The new folder resolves to the enclosing repository. The call must answer `PROJECT_FOLDER_UNAVAILABLE`, remove the folder, and leave the enclosing repository unregistered. That means a pre-check with `projectScope` before `register` (Task 3 test "inside a repository without git…").
2. **The name is taken by a dangling symlink or a file.** `mkdir` answers `EEXIST`, the call answers `PROJECT_EXISTS`, and the symlink or file is untouched and never removed (Task 3 test "an existing file or link of that name…").
3. **Parallel calls.** Two creates with the same name, or an 11th create racing the 10th, run one after the other per agent. Exactly one folder is created, and the limit holds (Task 3 test "parallel creates are serialized per agent").
4. **The owner removed the grant, or unregistered the project.** `coding` with `enabled: true` answers `PROJECT_NOT_GRANTED` and writes nothing. `list` leaves out unregistered projects (Task 3 test "coding never re-grants…").
5. **The same tool call is retried** (same `attemptId` and `toolCallId`, for example after a bridge timeout). The retry returns the first result, with one folder, one row and one notice (Task 3 test "a retried call returns the first result").

---

### Task 1: Name, eligibility and limit rules with their error codes

**Files:**

- Modify: `server/lib/directories.js` (extract `validDirectoryName`, used by `createDirectory`)
- Create: `server/features/assistants/agent-project-rules.js`
- Modify: `server/features/assistants/goal-turns.js` (add `mayCreateProjects` beside `goalAgent`)
- Create: `server/lib/i18n/de/agent-projects.js`, `server/lib/i18n/en/agent-projects.js`
- Modify: `server/lib/i18n/catalog-de.js`, `server/lib/i18n/catalog-en.js` (register `agentProjects`)
- Modify: `server/features/assistants/assistant-validation.js:7-16` (`assistantProblem` also looks up `serverMessages.agentProjects[key]`)
- Modify: `server/features/assistants/tool-errors.js` (reasons and `byKey`)
- Modify: `server/lib/i18n/translation-lock.json`
- Test: `tests/unit/agent-project-rules.test.js`, `tests/unit/assistant-tool-errors.test.js`

**Interfaces:**

- Produces:
  - `validDirectoryName(name: unknown): boolean` (`server/lib/directories.js`)
  - `projectCreateCaps = { perDay: 10, windowMs: 86400000 }`
  - `projectName(value: unknown): string`. Throws `assistantProblem("projectNameInvalid")` (400).
  - `mayCreateProjects(agent, senderFacing = false): boolean` in `goal-turns.js`, which is `goalAgent(agent) && !agent.teamMemberId && !senderFacing`. It lives there because `assistant-validation.js` imports `native-capabilities.js`, so a rules module that imports `assistant-validation.js` would close a cycle once `native-capabilities.js` imports it in Task 5.
  - `projectCreateLimit(times: number[], now = Date.now()): void`. Throws `assistantProblem("projectCreateLimit", 429)` when `times` within `windowMs` reach `perDay`.
  - Problem keys → codes (in `byKey`): `projectNameInvalid` → `PROJECT_NAME_INVALID`, `projectExists` → `PROJECT_EXISTS`, `projectCreateLimit` → `PROJECT_CREATE_LIMIT`, `projectOwnerOnly` → `PROJECT_OWNER_ONLY`, `projectNotCreatedByYou` → `PROJECT_NOT_CREATED_BY_YOU`, `projectNotEligible` → `PROJECT_NOT_ELIGIBLE`, `projectFolderUnavailable` → `PROJECT_FOLDER_UNAVAILABLE`

- [ ] **Step 1: Write the failing tests**

`tests/unit/agent-project-rules.test.js`:

```js
test("project names follow createDirectory's rules and refuse a leading dot", () => {
  for (const ok of ["Shop", "my project", "Ünïcödé", "a".repeat(255)])
    assert.equal(projectName(ok), ok);
  for (const bad of [
    "",
    " x",
    "x ",
    ".",
    "..",
    ".hidden",
    "a/b",
    "a\\b",
    "a\nb",
    "a\x7fb",
    "ü".repeat(128),
    42,
    null,
  ])
    assert.throws(
      () => projectName(bad),
      (e) => e.key === "projectNameInvalid",
    );
});
test("every name createDirectory accepts without a leading dot is a project name", () =>
  fc.assert(
    fc.property(fc.string({ maxLength: 300 }), (name) =>
      validDirectoryName(name) && !name.startsWith(".")
        ? projectName(name) === name
        : throws(() => projectName(name)),
    ),
  ));
test("own agents and leads may create projects; members, user agents, archived and sender-facing agents may not", () => {
  assert.equal(mayCreateProjects({ id: "a" }), true);
  assert.equal(mayCreateProjects({ id: "a", archivedAt: "x" }), false);
  assert.equal(
    mayCreateProjects({ id: "a", teamMemberId: "m", lifetime: "permanent" }),
    false,
  );
  assert.equal(mayCreateProjects({ id: "a", teamMemberId: "m" }), false);
  assert.equal(mayCreateProjects({ id: "a", userAccess: { userIds: ["u"] } }), false); // isUserAgent shape from user-access.js
  assert.equal(mayCreateProjects({ id: "a" }, true), false);
});
test("ten creations within 24 hours reach the limit; older ones do not count", () => {
  const now = Date.parse("2026-10-28T12:00:00Z"),
    hour = 3600000;
  projectCreateLimit(
    Array.from({ length: 9 }, (_, i) => now - i * hour),
    now,
  );
  projectCreateLimit([...Array.from({ length: 9 }, () => now), now - 24 * hour], now);
  assert.throws(
    () =>
      projectCreateLimit(
        Array.from({ length: 10 }, () => now - hour),
        now,
      ),
    (e) => e.key === "projectCreateLimit" && e.status === 429,
  );
});
```

Check the `isUserAgent` shape in `server/features/users/user-access.js:62` and use a real user-agent profile in the test.

In `tests/unit/assistant-tool-errors.test.js`, add:

```js
test("project tool problems carry their stable codes and English reasons", () => {
  for (const [key, status, code] of [
    ["projectNameInvalid", 400, "PROJECT_NAME_INVALID"],
    ["projectExists", 409, "PROJECT_EXISTS"],
    ["projectCreateLimit", 429, "PROJECT_CREATE_LIMIT"],
    ["projectOwnerOnly", 403, "PROJECT_OWNER_ONLY"],
    ["projectNotCreatedByYou", 403, "PROJECT_NOT_CREATED_BY_YOU"],
    ["projectNotEligible", 403, "PROJECT_NOT_ELIGIBLE"],
    ["projectFolderUnavailable", 409, "PROJECT_FOLDER_UNAVAILABLE"],
  ]) {
    const e = toolError(assistantProblem(key, status));
    assert.equal(e.code, code);
    assert.equal(e.reason, toolReason(code));
    assert.notEqual(e.reason, toolReason("UNAVAILABLE"));
  }
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/unit/agent-project-rules.test.js tests/unit/assistant-tool-errors.test.js`
Expected: FAIL (`agent-project-rules.js` is missing, and the codes resolve to `INVALID_INPUT`/`FORBIDDEN`).

- [ ] **Step 3: Implement**

- `validDirectoryName` holds the exact predicate now inlined in `createDirectory`, which calls it.
- `agent-project-rules.js` imports `assistant-validation.js` and `directories.js`. `native-capabilities.js` never imports it; it imports `mayCreateProjects` from `goal-turns.js`, which it already imports.
- Server copy (`agentProjects` in de/en). This task adds only the seven problem keys; Task 4 adds `telegram`:
  - `projectNameInvalid`: de "Der Projektname ist ungültig: kein / oder \\, keine Steuerzeichen, kein führender Punkt, höchstens 255 Bytes." / en "The project name is invalid: no / or \\, no control characters, no leading dot, at most 255 bytes."
  - `projectExists`: de "Im Standard-Arbeitsverzeichnis gibt es schon einen Eintrag mit diesem Namen." / en "The default working directory already has an entry with this name."
  - `projectCreateLimit`: de "Dieser Agent hat in den letzten 24 Stunden schon zehn Projekte angelegt." / en "This agent already created ten projects in the last 24 hours."
  - `projectOwnerOnly`: de "Projekte kann der Agent nur in einem Zug deiner eigenen Nachricht anlegen oder ändern, nicht aus weitergeleiteten, geplanten oder Hook-Inhalten." / en "The agent can create or change projects only in a turn of your own message, not from forwarded, scheduled or hook content."
  - `projectNotCreatedByYou`: de "Dieses Projekt hat der Agent nicht selbst angelegt." / en "The agent did not create this project itself."
  - `projectNotEligible`: de "Projekte anlegen können nur eigene Agenten, die kein Teammitglied sind und keinen Telegram-Bot für andere Personen haben." / en "Only your own agents that are not team members and have no Telegram bot for other people can create projects."
  - `projectFolderUnavailable`: de "Im Standard-Arbeitsverzeichnis kann kein eigenes Projekt angelegt werden: Es fehlt, ist nicht beschreibbar oder liegt in einem anderen Projekt." / en "No separate project can be created in the default working directory: it is missing, not writable or inside another project."
- Tool reasons (`tool-errors.js` `reasons`, English, for the model):
  - `PROJECT_NAME_INVALID`: "Give name as a plain folder name: no / or \\, no control characters, not . or .., no leading dot, at most 255 bytes. Fix it and try again."
  - `PROJECT_EXISTS`: "The owner's default working directory already has an entry with this name. Pick another name; never reuse an existing folder."
  - `PROJECT_CREATE_LIMIT`: `` `You already created ${projectCreateCaps.perDay} projects in the last 24 hours. Do not retry now; tell the owner.` ``
  - `PROJECT_OWNER_ONLY`: "Projects can only be created, listed or switched in a turn of the owner's own message, not in forwarded, scheduled, hook, team or member-result turns. Do not retry; tell the owner."
  - `PROJECT_NOT_CREATED_BY_YOU`: "You can switch coding sessions only for projects you created yourself (see action list). Ask the owner for anything else."
  - `PROJECT_NOT_ELIGIBLE`: "Only the owner's own agents that are not team members and have no Telegram bot for other people can create projects. Do not retry; ask your lead or the owner."
  - `PROJECT_FOLDER_UNAVAILABLE`: "AgentPier could not create a separate project in the owner's default working directory: it is missing, not writable or inside another project, or git init failed. Nothing was left behind. Do not retry unchanged; tell the owner."

- [ ] **Step 4: Confirm the translations and run the tests**

Run: `npm run i18n:confirm -- agentProjects && node --test tests/unit/agent-project-rules.test.js tests/unit/assistant-tool-errors.test.js tests/unit/i18n-terminology.test.js && npm run test:unit -- --test-name-pattern "catalog|translation"`
Expected: PASS. The lock gains `agentProjects.*` entries.

- [ ] **Step 5: Commit**

```bash
git add server/lib/directories.js server/features/assistants/agent-project-rules.js server/lib/i18n server/features/assistants/assistant-validation.js server/features/assistants/tool-errors.js tests/unit/agent-project-rules.test.js tests/unit/assistant-tool-errors.test.js
git commit -m "feat: add project name, eligibility and limit rules for agents"
```

---

### Task 2: Creation record, narrow grant write, agent audit and deletion

**Files:**

- Create: `server/features/assistants/agent-project-store.js`
- Create: `server/features/assistants/agent-project-grants.js`
- Modify: `server/features/assistants/assistant-access-audit.js` (add `auditAgentProject`)
- Modify: `server/features/audit/audit-schema.js:114` (source `"agent"`), `:162-196` (kind `"agent-project"`, plus a call to the new sanitizer)
- Create: `server/features/audit/audit-agent-project-details.js`
- Modify: `web/features/operations/AuditPage.jsx:10-15` (actor label for source `"agent"`)
- Modify: `web/lib/i18n/de/operations.js`, `web/lib/i18n/en/operations.js` (`byAgent`), `web/lib/i18n/translation-lock.json`
- Modify: `server/features/assistants/agent-deletion.js:24-48` and `:209-213` (table and `remove`)
- Modify: `tests/helpers/agent-lifecycle-fixture.js` (create the store, insert a row, count it in `remains`)
- Test: `tests/unit/agent-project-grants.test.js`, `tests/unit/audit-schema.test.js`, `tests/integration/agent-archive-delete.test.js`

**Interfaces:**

- Consumes: `approvalRevision`, `AssistantAccess#eligible/#stored/#write` (`assistant-access.js`).
- Produces:
  - `class AgentProjectStore { constructor(db); add({ projectId, assistantId, createdAt }): void; list(assistantId): { projectId, createdAt }[]; createdBy(assistantId, projectId): boolean; times(assistantId): number[] }`. Table: `CREATE TABLE IF NOT EXISTS agent_created_projects(project_id TEXT NOT NULL, assistant_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id, assistant_id))`. `list` is ordered by `created_at`. `times` returns `Date.parse(created_at)` values.
  - `grantCreatedProject(access, id, projectId, { coding = false } = {}): policy`
  - `setCreatedProjectCoding(access, id, projectId, enabled): policy`. With `enabled` and `projectId` missing from `projectIds`, it throws `assistantProblem("projectFolderNotGranted", 403)` (`PROJECT_NOT_GRANTED`). With `!enabled` it only removes the id from `sessionProjectIds`.
  - `auditAgentProject(services, { assistantId, projectId, change: "create" | "coding", coding: boolean, git?: boolean })`. It appends `{ action: change === "create" ? "project.created" : "assistant.updated", resourceType: "assistant", resourceId: assistantId, projectId, source: "agent", outcome: "success", details: { kind: "agent-project", change, coding, git } }`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/agent-project-grants.test.js` uses a real `AssistantAccess` on a temp assistant store. Take the setup from an existing access unit test, for example the one that covers `grantSsh`: `grep -rln grantSsh tests`.

```js
test("granting a created project writes only its fields and keeps the approval revision", () => {
  const before = access.stored(id); // revision 4, approvalRevision 4, other grants set
  const after = grantCreatedProject(access, id, "p-new", { coding: true });
  assert.deepEqual(after.projectIds, [...before.projectIds, "p-new"].sort());
  assert.equal(after.projectFiles["p-new"], "write");
  assert.ok(after.sessionProjectIds.includes("p-new"));
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.approvalRevision, approvalRevision(before));
  for (const key of ["pipelineIds", "definitions", "sshAccesses", "mailAccesses", "github"])
    assert.deepEqual(after[key], before[key]);
  assert.equal(changed, 1); // services.assistants.changed()
});
test("without coding the grant leaves sessionProjectIds alone; a second grant adds nothing twice", …);
test("switching coding needs the project grant, and switching off never needs it", () => {
  assert.throws(() => setCreatedProjectCoding(access, id, "gone", true),
    (e) => toolError(e).code === "PROJECT_NOT_GRANTED");
  assert.equal(access.stored(id).revision, revisionBefore);
  setCreatedProjectCoding(access, id, "gone", false); // no throw, no grant added
  assert.ok(!access.stored(id).projectIds.includes("gone"));
});
test("an archived agent or temporary member gets no grant", …); // access.eligible throws
test("the store lists, matches and times only the agent's own rows", …);
```

In `tests/unit/audit-schema.test.js`, add:

```js
test("an agent's project creation is recorded with the agent as actor", () => {
  const e = auditEvent({
    action: "project.created",
    resourceType: "assistant",
    resourceId: "agent-1",
    projectId: "p-1",
    source: "agent",
    outcome: "success",
    details: {
      kind: "agent-project",
      change: "create",
      coding: true,
      git: true,
      path: "/home/x/secret",
      name: "Shop",
    },
  });
  assert.equal(e.source, "agent");
  assert.deepEqual(e.details, {
    kind: "agent-project",
    change: "create",
    coding: true,
    git: true,
  });
  assert.equal(e.projectId, "p-1");
});
```

In `tests/integration/agent-archive-delete.test.js`, the existing "delete removes every store…" test also covers `agent_created_projects`. The lifecycle fixture creates `new AgentProjectStore(db)`, adds a row per populated agent, and counts `createdProjects: q("SELECT 1 FROM agent_created_projects WHERE assistant_id=?", id)` in `remains`. After deletion the agent's row is gone and the other agent's row stays.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/unit/agent-project-grants.test.js tests/unit/audit-schema.test.js tests/integration/agent-archive-delete.test.js`
Expected: FAIL (the modules are missing, `auditEvent` rejects source `"agent"`, and the table is missing from `agentTables`).

- [ ] **Step 3: Implement**

- Model the grant module on `grantSsh` (`assistant-access.js:373-389`): `access.eligible(id)`, `before = access.stored(id)`, `access.write(id, {...before, …, revision: before.revision + 1, approvalRevision: approvalRevision(before)})`, then `access.s.assistants.changed()`. Keep ids sorted and unique.
- `audit-agent-project-details.js` has `agentProjectAuditDetails(details, event)`. When the kind is `"agent-project"`, it copies `change ∈ {"create","coding"}`, `coding` (boolean) and `git` (boolean), and nothing else.
- AuditPage: `if (event.source === "agent") return copy.byAgent;` comes before the owner branch. Copy: en `byAgent: "by an agent"`, de `byAgent: "von einem Agenten"`.
- `agent-deletion.js`: add `"agent_created_projects"` to `agentTables` and `remove(db, "agent_created_projects", "assistant_id=?", id);` next to the grants, with the comment "Which projects it created; the projects stay the owner's."

- [ ] **Step 4: Confirm the translations and run the tests**

Run: `npm run i18n:confirm -- operations && node --test tests/unit/agent-project-grants.test.js tests/unit/audit-schema.test.js tests/integration/agent-archive-delete.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/assistants/agent-project-store.js server/features/assistants/agent-project-grants.js server/features/assistants/assistant-access-audit.js server/features/audit web/features/operations/AuditPage.jsx web/lib/i18n server/features/assistants/agent-deletion.js tests/helpers/agent-lifecycle-fixture.js tests/unit/agent-project-grants.test.js tests/unit/audit-schema.test.js tests/integration/agent-archive-delete.test.js
git commit -m "feat: record agent-created projects and grant them narrowly"
```

---

### Task 3: The AgentProjects service (create, coding, list) behind the team bridge

**Files:**

- Create: `server/features/assistants/agent-projects.js`
- Modify: `server/features/assistants/assistant-workflows.js:46-66` (`this.projects = new AgentProjects(this);`)
- Modify: `server/features/assistants/team-bridge-actions.js` (add `"project"` to `actions` and to the `bridgeTool` own-tool list. Do NOT add it to `routineActions` or `personalActions`.)
- Modify: `server/features/assistants/team-bridge.js:484` (one dispatch: `if (action === "project") return this.assistants.workflows.projects.invoke(invocation, input);`)
- Test: `tests/integration/agent-projects.test.js`

**Interfaces:**

- Consumes: Task 1 `projectName`, `projectCreateLimit` (`agent-project-rules.js`) and `mayCreateProjects` (`goal-turns.js`). Task 2 `AgentProjectStore`, `grantCreatedProject`, `setCreatedProjectCoding`, `auditAgentProject`. `directOwnerTurn` (`goal-turns.js`), `exact` (`assistant-access.js`), `projectScope` (`memory/project-scope.js`), `ProjectMemory#register/#project/#projectNames`, `createDirectory` (`lib/directories.js`).
- Produces:
  - `class AgentProjects { constructor(w, { gitInit = initRepository, now = Date.now } = {}); store: AgentProjectStore; invoke(inv, input): Promise<object> }`
  - `projectTurn(w, inv): { agent, conversation, origin }`. Throws `projectOwnerOnly` (403) when there is no `attemptId`, or for `inv.routine`, `inv.hook`, `inv.continuation`, or `!directOwnerTurn(origin)`. Throws `projectNotEligible` (403) unless `mayCreateProjects(agent, !!w.s.assistantTelegramSenders?.connected(agent.id))`. Same shape as `proposalTurn` in `agent-ssh-proposals.js:96-108`.
  - `initRepository(cwd: string): Promise<void>`: `execFile("git", ["init", "--quiet"], { cwd, timeout: 10000 })` with the owner's normal environment.
  - Results:
    - `create` → `{ projectId, name, path, coding }`
    - `coding` → `{ projectId, coding }`
    - `list` → `{ projects: [{ projectId, name, path, createdAt, folder: "read"|"write"|"none", coding: boolean }] }`, leaving out projects `memory.project` no longer finds
  - The settled action row, reserved in `w.store`. Its `key` is `agent-project:${inv.attemptId}:${inv.toolCallId}`, with `state: "completed"`, `settled: true`, `origin: { kind: "agent-project" }`, `chatNotes: { result: { at, state: "completed" } }` and `payload: { action: "agent_project", change: "create"|"coding", projectId, projectName, path, coding, result }`. Model it on `member-promotion.js:115-140`. Task 4 renders it.

- [ ] **Step 1: Write the failing tests**

`tests/integration/agent-projects.test.js` uses `workflowFixture(t)`. Its `setup(t)` adds:

- `parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-projects-")))`
- `f.services.preferences = { get: () => ({ defaultCwd: parent }) }`
- an audit array through `auditEvent`
- `call = async (input, origin = { kind: "owner" }) => f.workflows.projects.invoke(await f.invocation(randomUUID(), origin), input)`
- `code = (p) => p.then(() => null, (e) => toolError(e).code)`

Tests (names and key assertions):

```js
test("create makes an empty Git project in the default folder and grants it for writing", async (t) => {
  const r = await f.call({ action: "create", name: "Shop" });
  assert.equal(r.path, path.join(parent, "Shop"));
  assert.equal(r.coding, false);
  assert.ok(fs.existsSync(path.join(r.path, ".git")));
  assert.deepEqual(fs.readdirSync(r.path), [".git"]);
  assert.equal(f.memory.project(r.projectId).cwd, r.path);
  const policy = f.workflows.access.get(f.id);
  assert.ok(policy.projectIds.includes(r.projectId));
  assert.equal(policy.projectFiles[r.projectId], "write");
  assert.ok(!policy.sessionProjectIds.includes(r.projectId));
  assert.equal(policy.approvalRevision, approvalBefore);
  assert.ok(f.workflows.projects.store.createdBy(f.id, r.projectId));
  const e = f.audit.find((x) => x.action === "project.created");
  assert.equal(e.source, "agent"); assert.equal(e.resourceId, f.id); assert.equal(e.projectId, r.projectId);
  assert.ok(!JSON.stringify(f.audit).includes(parent));
});
test("create with coding switches coding sessions on; git: false leaves a plain folder", …);
  // sessionsEnabled(f.id, id) === true; the second project has no .git and kind "directory"
test("a pending approval stays valid when the agent creates a project", …);
  // save f.policy for the agent and reserve an awaiting_approval coding action before
  // the call; after create, approvalRevision(f.workflows.access.get(f.id)) equals the
  // value before and that action is still awaiting_approval (not cancelled)
test("invalid names are refused before anything is created", …);
  // "../x", ".hidden", "a/b" → PROJECT_NAME_INVALID; readdirSync(parent) stays []
test("an existing folder, file or link of that name is never adopted", …);
  // mkdir parent/Taken, write parent/File, symlink parent/Link → /nonexistent:
  // each → PROJECT_EXISTS; all three still exist unchanged; no project is registered
test("a missing or unwritable default folder answers PROJECT_FOLDER_UNAVAILABLE", …);
  // defaultCwd → path.join(parent, "missing"); then chmod 0o500 parent (skip as root)
test("inside a repository without git the folder is refused, removed and nothing is registered", …);
  // git init parent; create {name:"Sub", git:false} → PROJECT_FOLDER_UNAVAILABLE;
  // !existsSync(parent/Sub); f.memory.projectNames() unchanged (parent repo not registered)
test("inside a repository with git the new folder is its own project", …);
  // r.path === parent/Sub2 and memory.project(r.projectId).kind === "git"
test("a registration that lands on an existing project is refused and cleaned up", …);
  // f.memory.register = async () => f.memory.project(f.project.id) → PROJECT_FOLDER_UNAVAILABLE,
  // folder removed, no grant or row added
test("a failed git init fails the call and removes the folder", …);
  // f.workflows.projects.gitInit = async () => { throw Error("boom") } → PROJECT_FOLDER_UNAVAILABLE
test("the eleventh project within 24 hours is refused", …);
  // ten store.add rows at now-1h → PROJECT_CREATE_LIMIT; a row at now-25h does not count
test("parallel creates are serialized per agent", …);
  // Promise.allSettled of two creates named "Same" → one fulfilled, one PROJECT_EXISTS;
  // with 9 rows present, two parallel creates of different names → one PROJECT_CREATE_LIMIT
test("only direct owner turns may use the tool", …);
  // origins {kind:"routine"}, {kind:"owner", forwarded:true}, {kind:"member-result"},
  // {kind:"lead-request"}, a goal continuation context, and inv.hook / inv.routine /
  // inv.continuation set → PROJECT_OWNER_ONLY; {kind:"telegram", channelId…} succeeds
test("members, user agents and sender-facing agents are not eligible", …);
  // f.store.updateAssistant(… teamMemberId …) or f.services.assistantTelegramSenders =
  // { connected: () => true } → PROJECT_NOT_ELIGIBLE
test("coding switches only projects the agent created", …);
  // coding on f.project.id → PROJECT_NOT_CREATED_BY_YOU; on own project → {coding:true},
  // sessionsEnabled true; off → false; audit "assistant.updated" kind agent-project change coding
test("coding never re-grants a project the owner took away", …);
  // owner removes the grant via f.workflows.access.revokeProject(id) → coding true → PROJECT_NOT_GRANTED,
  // policy unchanged; list omits a project after f.memory removal
test("list returns the agent's own projects and their state", …);
test("a retried call returns the first result", …);
  // same invocation object (same attemptId/toolCallId) twice → deepEqual results,
  // one folder, one store row, one action row with payload.action "agent_project"
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/integration/agent-projects.test.js`
Expected: FAIL (`f.workflows.projects` is undefined).

- [ ] **Step 3: Implement `AgentProjects#invoke(inv, input)` in `agent-projects.js`**

`inv.assertCurrent()`, then `projectTurn`, then dispatch on `input?.action`. Input shapes (`exact`):

- `create` takes `["action","name","git","coding"]`. `git` and `coding` are optional booleans, defaulting to `true` and `false`.
- `coding` takes `["action","projectId","enabled"]`.
- `list` takes `["action"]`.
- Anything else → `assistantProblem("invalid")`.

Serialize `create` and `coding` per agent with a private promise chain keyed by agent id. The fixture's `serialize` is a pass-through, so do not rely on it. Before any work, return the stored `payload.result` when `w.store.byKey(key)` exists.

`create` order (the cleanup rules depend on it):

1. Validate `projectName(input.name)`, then run `projectCreateLimit(store.times(agent.id), now())`.
2. Set `parent = w.s.preferences.get().defaultCwd`. `fs.realpath` + `stat().isDirectory()` + `fs.access(W_OK)`. If any fails → `projectFolderUnavailable` (409).
3. `createDirectory(parentReal, name)`. On a 409 → `projectExists` (409); on any other failure → `projectFolderUnavailable`. From here on, every failure runs `fs.rm(target, { recursive: true, force: true })` before it throws. Only this folder, which this call created, is ever removed.
4. If `git` is set: `await this.gitInit(target)`. On failure → `projectFolderUnavailable`.
5. Pre-check: `(await projectScope(target)).cwd === target`. Otherwise → `projectFolderUnavailable`. This keeps an enclosing repository unregistered.
6. `known = new Set(memory.projectNames().map((p) => p.id))`, then `project = await memory.register(target)`. Require `project && project.cwd === target && !known.has(project.id)`. Otherwise → `projectFolderUnavailable`.
7. `store.add`, then `grantCreatedProject(..., { coding })`, then `auditAgentProject(change "create")`, then reserve the action row (step 3 of this task's Interfaces), and return `{ projectId, name: project.name, path: project.cwd, coding }`.
8. If the runtime is ready, apply the agent's configuration in the background, as `agent-ssh-proposals.js:306-309` does: `w.a.admit(() => w.a.config.apply(agent.id))`, catching errors. This refreshes the folder and coding-session guidance.

`coding`:

- Not `store.createdBy(agent.id, projectId)` → `projectNotCreatedByYou` (403).
- Otherwise `setCreatedProjectCoding`, `auditAgentProject(change "coding")`, reserve the row, return `{ projectId, coding: enabled }`.

`list`: read only. It builds on `store.list`, `memory.project` (skip 404s) and `access.get`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/integration/agent-projects.test.js tests/integration/agent-ssh-proposals.test.js && wc -l server/features/assistants/team-bridge.js server/features/assistants/assistant-workflows.js server/features/assistants/assistant-access.js`
Expected: PASS. Line counts ≤ 594, ≤ 584 and 597.

- [ ] **Step 5: Commit**

```bash
git add server/features/assistants/agent-projects.js server/features/assistants/assistant-workflows.js server/features/assistants/team-bridge-actions.js server/features/assistants/team-bridge.js tests/integration/agent-projects.test.js
git commit -m "feat: let agents create their own projects in the default folder"
```

---

### Task 4: Owner notice in the agent chat, the action history and Telegram

**Files:**

- Create: `server/features/assistants/agent-project-notes.js`
- Modify: `server/features/assistants/agent-projects.js` (call `notifyAgentProject` after reserving the row)
- Modify: `server/features/assistants/assistant-action-notifications.js:339-359` (`actionNotes`: `agent_project` → `projectNotes(a)`)
- Modify: `server/lib/i18n/de/agent-projects.js`, `server/lib/i18n/en/agent-projects.js` (`telegram`)
- Create: `web/features/assistants/AgentProjectNote.jsx`
- Create: `web/lib/i18n/de/agent-projects.js`, `web/lib/i18n/en/agent-projects.js`, `web/lib/i18n/messages/agent-projects.js`
- Modify: `web/features/assistants/TranscriptItem.jsx:55-62` (event `agent-project`)
- Modify: `web/features/assistants/settings/ActionHistory.jsx:166-181` (`agent_project` renders its note)
- Modify: both `translation-lock.json`
- Test: `tests/integration/agent-projects.test.js` (notice cases), `tests/browser/assistant-agent-projects.spec.js`

**Interfaces:**

- Consumes: the Task 3 action row payload. `pairedTelegram(w, agentId)` (`team-coding.js:49`). `w.s.assistantChannels.{outbox,store}`.
- Produces:
  - `projectNotes(action): object[]` → `[{ id: \`agent-project:${a.id}\`, role: "event", event: "agent-project", change, projectName, path, coding, timestamp: a.chatNotes.result.at, runId: null }]`
  - `notifyAgentProject(w, agent, action): void`. When paired, it enqueues `{ key: \`agent-project:${action.id}\`, source: target, kind: "agent-project", localized: true, text, path: \`/projects/${encodeURIComponent(projectId)}?tab=agents\` }`. Errors are caught and logged, as in `member-promotion.js:142-161`. It sends whatever the turn's origin, Telegram included.
  - `projectMessages(channel)` → `(serverCatalogs[channel?.language] || serverCatalogs.de).agentProjects`
  - Web `agentProjectCopy.note.{created, createdWithCoding, codingOn, codingOff}`

- [ ] **Step 1: Write the failing tests**

Integration (add to `agent-projects.test.js`; the fixture's channel is paired and German):

```js
test("the owner sees a created project in the agent chat and in Telegram", async (t) => {
  const r = await f.call({ action: "create", name: "Shop", coding: true });
  const [note] = actionNotes(f.workflows.store.list(f.id), f.channel.conversationId)
    .filter((n) => n.event === "agent-project");
  assert.deepEqual({ ...note, id: undefined, timestamp: undefined }, { id: undefined,
    role: "event", event: "agent-project", change: "create", projectName: "Shop",
    path: r.path, coding: true, timestamp: undefined, runId: null });
  const sent = f.service.outbox.all(f.channel.id).find((e) => e.kind === "agent-project");
  assert.equal(sent.text, `${agentName} hat das Projekt Shop in ${r.path} angelegt. Coding-Sessions sind eingeschaltet.`);
  assert.equal(sent.path, `/projects/${encodeURIComponent(r.projectId)}?tab=agents`);
});
test("switching coding sessions notes and notifies too", …); // "…hat Coding-Sessions für das Projekt Shop eingeschaltet."
test("without a paired Telegram chat only the chat note is written", …);
```

Browser (`tests/browser/assistant-agent-projects.spec.js`): there is no `tests/helpers/browser-test.js` on main, so follow the pattern in `tests/browser/assistant-member-grants.spec.js`. Import `test`/`expect` from `@playwright/test`, `baseURL` from `../helpers/browser.js` and `fulfillEnabledAssistantFeature`. Route `/api/assistant` with one agent whose `/messages` holds the three note variants:

```js
test("an agent's created project shows in its chat", async ({ page }) => {
  await page.goto(baseURL + "/agents/home/chats/chat-1");
  await expect(page.locator('[data-agent-project="create"]').first()).toHaveText(
    "Created the project Shop in /work/Shop",
  );
  await expect(page.locator('[data-agent-project="create"]').nth(1)).toHaveText(
    "Created the project Shop in /work/Shop with coding sessions on",
  );
  await expect(page.locator('[data-agent-project="coding"]')).toHaveText(
    "Switched coding sessions on for the project Shop",
  );
});
```

The spec runs in English. Set the language the way the member-grants spec does.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/integration/agent-projects.test.js && npm run build && npx playwright test tests/browser/assistant-agent-projects.spec.js`
Expected: FAIL (no note or Telegram entry, and the note is not rendered).

- [ ] **Step 3: Implement**

Copy. Server copy goes in `agentProjects.telegram`, web copy in `agentProjectCopy.note`:

- Telegram `created(agent, name, path, coding)`:
  - de `` `${agent} hat das Projekt ${name} in ${path} angelegt.` `` plus `" Coding-Sessions sind eingeschaltet."` when coding
  - en `` `${agent} created the project ${name} in ${path}.` `` plus `" Coding sessions are on."`
- Telegram `codingOn(agent, name)` / `codingOff(agent, name)`:
  - de `` `${agent} hat Coding-Sessions für das Projekt ${name} eingeschaltet.` `` / `…ausgeschaltet.`
  - en `` `${agent} switched coding sessions on for the project ${name}.` `` / `…off…`
- Web note: `created(name, path)`, `createdWithCoding(name, path)`, `codingOn(name)`, `codingOff(name)`:
  - de "Projekt Shop in /work/Shop angelegt", "Projekt Shop in /work/Shop angelegt, Coding-Sessions eingeschaltet", "Coding-Sessions für das Projekt Shop eingeschaltet", "…ausgeschaltet"
  - en "Created the project Shop in /work/Shop", "Created the project Shop in /work/Shop with coding sessions on", "Switched coding sessions on for the project Shop", "Switched coding sessions off for the project Shop"

`AgentProjectNote({ note })` renders `<p className="assistant-note assistant-event" data-agent-project={note.change}>`, like `MemberGrantNote.jsx`. Use no new styles or colors.

- [ ] **Step 4: Confirm the translations and run the tests**

Run: `npm run i18n:confirm -- agent-projects agentProjects && node --test tests/integration/agent-projects.test.js tests/unit/i18n-terminology.test.js && npm run build && npx playwright test tests/browser/assistant-agent-projects.spec.js tests/browser/assistant-member-grants.spec.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/assistants/agent-project-notes.js server/features/assistants/agent-projects.js server/features/assistants/assistant-action-notifications.js server/lib/i18n web/features/assistants web/lib/i18n tests/integration/agent-projects.test.js tests/browser/assistant-agent-projects.spec.js
git commit -m "feat: tell the owner when an agent creates or switches a project"
```

---

### Task 5: Compile `agentpier_project` for eligible agents and guide them

**Files:**

- Create: `server/features/assistants/team-plugin/project-tool.js`
- Modify: `server/features/assistants/team-plugin/index.js:5-10,28-44,47-58,110-120` (import, `toolTimeouts.project: 30000`, `ownTools` `"project"`, spread definition)
- Modify: `server/features/assistants/team-plugin/openclaw.plugin.json` (`contracts.tools` += `"agentpier_project"`)
- Modify: `server/features/assistants/runtime-config.js:49-62` (`nativeTools` += `"agentpier_project"`)
- Modify: `server/features/assistants/native-capabilities.js`:
  - `:91` `senderLockedTools` += `"agentpier_project"`
  - `:97-108` `lockedTools` += `"agentpier_project"`
  - `profileTools` += `...(nativeReady && mayCreateProjects(assistant) ? ["agentpier_project"] : [])`
- Modify: `server/features/assistants/assistant-bootstrap.js` (new `projectGuidance` section and option `projectCreation = false`)
- Modify: `server/features/assistants/assistant-config.js:285-302` (`projectCreation: nativeReady && mayCreateProjects(assistant, senderFacing)`)
- Modify (pinned tool lists): `tests/unit/openclaw-config-characterization.test.js:89,181`, `tests/unit/openclaw-web-tools-config.test.js:133,364`, `tests/integration/user-agent-tool-guard.test.js:28`
- Test: `tests/unit/assistant-native-capabilities.test.js`, `tests/unit/assistant-bootstrap.test.js`, `tests/integration/agent-projects.test.js` (bridge wiring)

**Interfaces:**

- Consumes: `mayCreateProjects` (Task 1, `goal-turns.js`). Bridge action `"project"` (Task 3).
- Produces: `projectDefinition = { project: { description, parameters } }` with:
  - `parameters`: `{ type: "object", properties: { action: { enum: ["create","coding","list"] }, name: text(255), git: { type: "boolean" }, coding: { type: "boolean" }, projectId: text(100), enabled: { type: "boolean" } }, required: ["action"], additionalProperties: false }`
  - `description`: "Create a new, empty project for new work the owner gives you, switch coding sessions on or off for a project you created, or list the projects you created. Use it only in a turn of the owner's own message (PROJECT_OWNER_ONLY otherwise: do not retry). create takes a plain folder name and makes that folder in the owner's default working directory, initializes Git unless git is false, registers it as an AgentPier project and gives you write access to its folder; coding: true also switches coding sessions on for it. It returns projectId, name, path and coding. AgentPier never adopts an existing folder (PROJECT_EXISTS: pick another name). At most 10 projects per 24 hours (PROJECT_CREATE_LIMIT). coding (projectId, enabled) works only for projects you created and still hold (PROJECT_NOT_CREATED_BY_YOU, PROJECT_NOT_GRANTED). The owner is told about every project you create. Share a project with your permanent members with agentpier_team_grant. You cannot delete, rename or unregister projects."

- [ ] **Step 1: Write the failing tests**

`tests/unit/assistant-native-capabilities.test.js`:

```js
test("agentpier_project is compiled for own agents and leads only", () => {
  const tools = (a) => profileTools(a, { nativeReady: true, teamsReady: true });
  assert.ok(tools(ownAgent).includes("agentpier_project"));
  assert.ok(tools(lead).includes("agentpier_project"));
  for (const a of [permanentMember, taskMember, userAgent, archived])
    assert.ok(!tools(a).includes("agentpier_project"), a.id);
  assert.ok(senderLockedTools.includes("agentpier_project"));
  assert.ok(lockedTools.includes("agentpier_project"));
  assert.ok(!routineTools.includes("agentpier_project"));
  assert.ok(nativeTools.includes("agentpier_project"));
});
```

Use the real `profileTools` signature at `native-capabilities.js:~230`.

`tests/unit/assistant-bootstrap.test.js`:

```js
test("eligible agents learn they can create a project and share it with their team", () => {
  const text = assistantBootstrap(agent, {}, { projectCreation: true });
  assert.match(text, /## Projects/);
  assert.match(text, /agentpier_project/);
  assert.match(text, /agentpier_team_grant/);
  assert.doesNotMatch(assistantBootstrap(agent, {}, {}), /agentpier_project/);
});
```

`tests/integration/agent-projects.test.js`, bridge wiring (in the style of `agent-ssh-proposals.test.js:1-40`, which imports `actions`, `bridgeTool`, `routineActions`, `hookActions`, the plugin and its manifest):

```js
test("the bridge serves agentpier_project only outside routines and hooks", () => {
  assert.ok(actions.has("project"));
  assert.equal(bridgeTool("project"), "agentpier_project");
  assert.ok(!routineActions.has("project"));
  assert.ok(!hookActions.has("project"));
  assert.ok(manifest.contracts.tools.includes("agentpier_project"));
  assert.equal(toolTimeouts.project, 30000);
});
```

Also update the three pinned lists named under **Files** so they include `"agentpier_project"` where an own agent's full list is pinned. In `user-agent-tool-guard.test.js` it goes in the denied list.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/unit/assistant-native-capabilities.test.js tests/unit/assistant-bootstrap.test.js tests/integration/agent-projects.test.js tests/unit/openclaw-config-characterization.test.js tests/unit/openclaw-web-tools-config.test.js tests/integration/user-agent-tool-guard.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`projectGuidance` (English, as in the other sections of `assistant-bootstrap.js`):

```
## Projects
- When the owner gives you new work that needs its own place, create a project with agentpier_project (action create) instead of asking the owner to make a folder. You get write access to it at once; ask the owner before switching coding sessions on unless he asked for them.
- Share it with your permanent team members with agentpier_team_grant (projects and coding), as with any of your projects.
```

Guard it with `projectCreation`, as `sessionGuidance` is guarded.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: the Step 2 command, then `npm run test:unit -- --test-name-pattern "plugin|manifest|tool"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/features/assistants tests/unit tests/integration/agent-projects.test.js tests/integration/user-agent-tool-guard.test.js
git commit -m "feat: offer agentpier_project to eligible agents"
```

---

### Task 6: Native contract against the pinned Gateway

**Files:**

- Create: `tests/integration/assistant-project-contract.test.js`
- Modify: `scripts/assistant-contract-shards.json` (`files` += the test, `seconds` += `60`)

**Interfaces:**

- Consumes: Task 5's compiled tool. Task 3's bridge action. The pattern of `tests/integration/assistant-ssh-runtime-contract.test.js`: `GuardedRuntimeSupervisor`, `provisionTeamPlugin`, `TeamBridge`, `channelFixture(t, { language: () => "en" })`, `proactivityModel()`, skipped without `AGENTPIER_ASSISTANT_ROUTINE_RUNTIME`.

- [ ] **Step 1: Write the contract test**

```js
test(
  "pinned runtime offers agentpier_project in owner turns, creates a project through the bridge and never offers it to a routine",
  { skip: !installed, timeout: 240000 },
  async (t) => { …
    // owner turn "PROJECT_CONTRACT": the model calls agentpier_project
    // { action: "create", name: "contract-shop" }
    assert.equal(done.status, "ok");
    assert.ok(done.terminalReceipt.successfulToolNames.includes("agentpier_project"));
    assert.ok(fs.existsSync(path.join(parent, "contract-shop", ".git")));
    assert.match(toolResults(model.requests.at(-1)), /"projectId"/);
    // a manual routine "PROJECT_ROUTINE_CONTRACT" is not offered the tool
    assert.ok(!offered(first(model.requests, "PROJECT_ROUTINE_CONTRACT")).includes("agentpier_project"));
  },
);
```

`parent` is a temp dir passed as `services.preferences`. Memory is a temp `ProjectMemory`, and the tmux server is isolated as in the SSH contract.

- [ ] **Step 2: Run the shard unit test, then the contract where the runtime is installed**

Run: `node --test tests/unit/assistant-contract-shards.test.js` (expect PASS), then `AGENTPIER_ASSISTANT_ROUTINE_RUNTIME=<installed path> node --test tests/integration/assistant-project-contract.test.js`
Expected: PASS. Without the runtime, the contract reports "skipped".

- [ ] **Step 3: Commit**

```bash
git add tests/integration/assistant-project-contract.test.js scripts/assistant-contract-shards.json
git commit -m "chore: cover agentpier_project in the native contracts"
```

---

### Task 7: Documentation and cleanup

**Files:**

- Modify: `docs/agents.md`. Under "### Access" (line ~491), add "Projects the agent creates": who qualifies, the default working directory, Git, the limit, the notice, and sharing via the lead share in "### Sharing a lead's access with permanent members".
- Modify: `docs/assistant-workflows.md`. Add a "## Projects agents create" section after "## Direct folder access" with the grant, coding switch, audit (source `agent`), deletion and error codes.
- Modify: `docs/assistant-gateway.md`. Add "## Agent-created projects (2026-10-28, AGENTPIER-273)" after "## SSH access proposals" (line ~4590). Cover the compiled-for rule, `senderLockedTools`/`lockedTools`, not in `routineTools`/hooks, `invoke` path, the codes, and the narrow grant write.
- Modify: `README.md:45` and `README.de.md` (matching bullet). Add a half-sentence: agents create their own projects for new work.
- Delete: `docs/superpowers/plans/2026-10-28-agent-created-projects.md` and `docs/superpowers/specs/2026-10-28-agent-created-projects-design.md` (AGENTS.md: working documents never ship).

- [ ] **Step 1: Write the docs** (English, except `README.de.md`, which stays German without "Konto"/"Sitzung". Quote UI labels exactly: "Default working directory", "by an agent".)
- [ ] **Step 2: Run the whole check**

Run: `npm run check`
Expected: PASS (lint, format, structure ≤ 600 lines, build, tests).

- [ ] **Step 3: Commit**

```bash
git add docs README.md README.de.md
git rm docs/superpowers/plans/2026-10-28-agent-created-projects.md docs/superpowers/specs/2026-10-28-agent-created-projects-design.md
git commit -m "chore: document agents creating their own projects"
```

The PR description lists the docs checked: `docs/agents.md`, `docs/assistant-workflows.md`, `docs/assistant-gateway.md`, `README.md`, `README.de.md`, plus `docs/memory.md` (checked; project registration is unchanged).
