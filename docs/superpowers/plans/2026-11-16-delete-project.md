# Delete a Project Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner can delete a project from AgentPier and its folder from disk permanently (or, when the folder is already gone, remove it from AgentPier), after a server preflight that blocks on running work and warns about unsaved Git work.

**Architecture:** A `ProjectDeletion` service (`server/application/project-deletion.js`) next to `ProjectRebind` resolves a project by its folder path (memory rows, cloned-repo entries and AgentBus sessions all join on the path, as `mergeProjects` does in the web hub), builds a preflight report with a fingerprint token, and runs a resumable deletion recorded in a new `project_deletions` table of `memory.sqlite`: mark → revoke grants → re-check blockers → delete the folder → remove AgentPier data store by store (the mirror of `ProjectRebind.remnants()`/`adopt()`) → drop the record. A `DeletionGuard` built from those records refuses every start path for a folder being deleted. The web app adds a dialog on `ConfirmDialog`, menu items, list states and a ⌘K action, and follows `projects.changed`.

**Tech Stack:** Node.js ES modules, Express, `node:sqlite`, `node:test`, React (JSX), Playwright, `git`, `lsof` / `/proc`, tmux.

**Spec:** `docs/superpowers/specs/2026-11-16-delete-project-design.md`

## Global Constraints

- Work in `.worktrees/delete-project` on branch `feat/delete-project`; never push to `main`.
- Node.js `^24.22.1 || >=26.12.1`; macOS and Linux both supported (process scan and folder state have per-platform paths).
- Every source and test file stays at or below 600 lines (`npm run check:structure`). Files already near the limit must not grow by more than the lines named in a task: `web/app/search-entries.js` (600), `server/features/assistants/assistant-workflows.js` (600, do not touch), `server/application/services.js` (599, do not touch), `server/features/previews/preview-service.js` (595, do not touch), `server/features/audit/audit-schema.js` (590), `server/features/assistants/assistant-access.js` (583), `server/features/memory/project-memory.js` (559).
- Owner only: no route under `/api/me`, no entry in `server/http/route-access.js` `userRoutes`; restricted users never see the action, the route or the ⌘K entry.
- Every UI text in German and English with matching keys and interpolation arguments, read through `web/lib/i18n/messages/`; no hard-coded product copy. Run `npm run i18n:confirm` after every catalog change and commit both `translation-lock.json` files (`web/lib/i18n/`, `server/lib/i18n/`).
- Exact copy pinned by the spec: "Delete project…", "Remove from AgentPier…", "Folder missing" (de „Ordner fehlt“), "Drive not available", "Deleting…", "Deletion failed — Retry", "Stop sessions"; ⌘K "Delete project" with alias "Remove project".
- UI uses only `docs/ui-guide.md` primitives: `ConfirmDialog` (destructive, `confirmDisabled` until the typed name matches), `Checkbox`, `StatusChip`, `Segment`, `.button.danger`, `RowMenu` items with `danger: true`. No new hex colours, no font size below 11px, no new breakpoints, no bespoke dialog or menu.
- Live updates over `projects.changed` (plus the existing `agentbus.changed` watch and `project-groups.changed`); no new timed polling.
- No trash, no undo, no bulk delete, no "remove from AgentPier but keep the folder" for an existing folder; remote ticket systems, Git remotes, SSH hosts and OpenClaw agent workspaces are never touched; audit history is kept.
- Bounds: process scan 10 s (timeout blocks, retry offered); Git check 10 s per worktree (timeout warns as "could not be checked"); foreign process grace period 5 s between SIGTERM and SIGKILL.
- Tests use `node:test` with `node:assert/strict`, isolated fixtures (`tests/helpers/application.js`), never the default tmux server or real user sessions. Backend tests `*.test.js`, browser tests `*.spec.js`.
- Commits in English with `feat:` / `fix:` / `test:` / `docs:` prefixes, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Docs in the same change: `docs/memory.md` (Projects page), `docs/architecture.md` (Live channel, `projects.changed`), `README.md` and `README.de.md` where projects are described; delete this plan and the spec before the pull request.

## Review Focus

- **The same folder known several times:** an older duplicate memory row (`duplicateOf`), a cloned-repo entry and an AgentBus session for one path. All of them are deleted together; nothing about the folder stays listed. Pinned by `scope joins every source of one folder` (Task 6) and `the walk removes every row of the folder and leaves other projects alone` (Task 3).
- **Paths that differ only by links or a trailing slash:** `/tmp` vs `/private/tmp` on macOS, a home folder reached through a link, `/work/app/`. The danger checks and folder matching compare real paths. Pinned by `refuses the home folder reached through a link` (Task 1) and `covers a session cwd given through a link` (Task 2).
- **A stale dialog:** the folder is renamed and a new folder created at the same path, or another project is nested in after the preflight. The server refuses with 409 and deletes nothing. Pinned by `a replaced folder makes the token stale` (Task 7).
- **A folder that only partly deletes:** a read-only subfolder or a file another user owns. The project stays listed as "Deletion failed — Retry" with what is left, and a retry finishes the job. Pinned by `a partial rm leaves a failed record that retry finishes` (Task 7).
- **Odd names in process output:** spaces, unicode, quotes or a newline in a folder or process name in `lsof -F` output. These are neither misread as another folder nor allowed to cut a process record short. Pinned by `parses names with spaces, unicode and newlines` (Task 4).

---

### Task 1: Danger-path guard and folder state

**Files:**

- Create: `server/features/projects/deletion-paths.js`
- Test: `tests/unit/project-deletion-paths.test.js`

**Interfaces:**

- Produces:
  - `inside(parent: string, child: string): boolean`: `child === parent` or `child` starts with `parent + path.sep`.
  - `refusedFolder(folder: string, { home, dataDir, installDir, stat?, lstat?, realpath? }): Promise<null | "symlink" | "not-directory" | "root" | "home" | "home-parent" | "home-child" | "agentpier" | "mount-point">`.
  - `folderState(folder: string, { stat?, timeoutMs = 2000 }): Promise<"present" | "missing" | "unavailable">`.
  - `MOUNT_PARENTS: RegExp[]`.

- [ ] **Step 1: Write the failing tests**

```js
test("refuses root, home, its parents and its direct children", async () => {
  const o = { home: h, dataDir: d, installDir: i };
  assert.equal(await refusedFolder("/", o), "root");
  assert.equal(await refusedFolder(h, o), "home");
  assert.equal(await refusedFolder(path.dirname(h), o), "home-parent");
  assert.equal(await refusedFolder(path.join(h, "Projects"), o), "home-child");
  assert.equal(await refusedFolder(path.join(h, "Projects", "app"), o), null);
});
test("refuses the data dir, the install dir, anything inside or containing them", ...);
// dataDir itself, path.join(dataDir, "x"), path.dirname(dataDir) -> "agentpier"; same for installDir
test("refuses a link and a mount point", ...); // symlink -> "symlink"; fake stat with differing dev for parent -> "mount-point"
test("refuses the home folder reached through a link", ...); // home passed as a link to the real home; real home -> "home"
test("folder state: present, missing, unavailable", async () => {
  assert.equal(await folderState(existing), "present");
  assert.equal(await folderState(path.join(existing, "gone")), "missing");
  assert.equal(await folderState("/Volumes/Unplugged/app", { stat: fakeNoVolumes }), "unavailable");
  assert.equal(await folderState("/net/share/app", { stat: eioStat }), "unavailable");
  assert.equal(await folderState("/slow/app", { stat: never, timeoutMs: 50 }), "unavailable");
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/unit/project-deletion-paths.test.js`
Expected: FAIL with `Cannot find module .../deletion-paths.js`

- [ ] **Step 3: Implement `refusedFolder` and `folderState` in `server/features/projects/deletion-paths.js`**

`refusedFolder`: `lstat` first (`isSymbolicLink()` → `"symlink"`, not a directory → `"not-directory"`), then `realpath(folder) !== folder` → `"symlink"` (a registered path must be canonical; the registered real folder is the only one ever deleted). Resolve `home`, `dataDir`, `installDir` through `realpath` (falling back to `path.resolve`). Order of checks: root (`path.parse(real).root`), home, every ancestor of home, `path.dirname(real) === home`, `inside(own, real) || inside(real, own)` for data and install dir, then mount point (`stat(real).dev !== stat(path.dirname(real)).dev`). The running checkout is `projectDir` from `server/lib/config.js`.

`folderState` (the order is not determined by the signature):

```js
const MOUNT_PARENTS = [
  /^\/Volumes$/,
  /^\/media(\/[^/]+)?$/,
  /^\/run\/media\/[^/]+$/,
  /^\/mnt$/,
];
// every stat races timeoutMs; a timeout or any error but ENOENT/ENOTDIR -> "unavailable"
try {
  return (await stat(folder)).isDirectory() ? "present" : "missing";
} catch (e) {
  if (!["ENOENT", "ENOTDIR"].includes(e.code)) return "unavailable";
}
let dir = path.dirname(folder);
for (;;) {
  try {
    await stat(dir);
    break;
  } catch (e) {
    if (!["ENOENT", "ENOTDIR"].includes(e.code)) return "unavailable";
    dir = path.dirname(dir);
  }
}
return MOUNT_PARENTS.some((re) => re.test(dir)) ? "unavailable" : "missing";
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/unit/project-deletion-paths.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/projects/deletion-paths.js tests/unit/project-deletion-paths.test.js
git commit -m "feat: refuse dangerous folders and read a project folder's state"
```

---

### Task 2: Deletion records, memory purge and the start guard

**Files:**

- Modify: `server/features/memory/memory-database.js` (schema string, one line)
- Create: `server/features/memory/project-deletions.js`
- Modify: `server/features/memory/project-memory.js` (constructor: `this.deletions = new DeletionRecords(this.db);`, at most 3 lines)
- Create: `server/features/projects/deletion-guard.js`
- Create: `server/lib/i18n/de/project-deletion.js`, `server/lib/i18n/en/project-deletion.js`
- Modify: `server/lib/i18n/catalog-de.js`, `server/lib/i18n/catalog-en.js` (register `projectDeletion`)
- Test: `tests/unit/project-deletion-records.test.js`, `tests/unit/project-deletion-guard.test.js`

**Interfaces:**

- Consumes: `inside` (Task 1); `transaction` (`memory-database.js`); `forgetIndexed(memory, entryId)` (`memory-search.js`).
- Produces:
  - Table `project_deletions(path TEXT PRIMARY KEY, state TEXT NOT NULL, body TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`.
  - `DeletionRecords(db)` with `list(): Record[]`, `get(path): Record | null`, `mark(path, body): Record`, `fail(path, code: string): void`, `again(path): Record` (back to `deleting`, error cleared), `drop(path): void`. `Record = { path, state: "deleting" | "failed", error: string | null, body: DeletionBody, createdAt, updatedAt }`.
  - `DeletionBody = { name, folderMissing: boolean, dev: string, ino: string, projectIds: string[], repositoryIds: string[], busIds: string[], sessionIds: string[], runIds: string[], rebuildIds: string[], nested: { path, name }[], report: { unsavedGitWork: boolean, endedSessionIds: string[], endedProcesses: { pid, name }[] } }`. `dev` and `ino` are decimal strings of the bigint `lstat`; empty when the folder is missing.
  - `purgeProjects(memory, ids: string[]): number`.
  - `DeletionGuard(records: () => DeletionRecords | null)` with `covers(cwd): boolean`, `coversProject(projectId): boolean`, `refuse(cwd): void`, `refuseProject(projectId): void`. Both refusals throw `problem(serverMessages.projectDeletion.projectDeleting, 409)` with `code: "PROJECT_DELETING"`.
  - Server catalog `serverMessages.projectDeletion` (keys grow in Tasks 6, 7 and 9).

- [ ] **Step 1: Write the failing tests**

```js
test("a deletion record survives reopening the database", ...); // mark, close ProjectMemory, reopen -> get(path).state === "deleting", body round-trips
test("fail and again switch the state and keep the body", ...); // fail(path,"EACCES") -> {state:"failed", error:"EACCES"}; again -> {state:"deleting", error:null}
test("purgeProjects removes rows, entries, revisions, receipts, tombstones, capabilities, rebinds and merges", async () => {
  // register two folders, write entries to A, forget one (tombstone), add capability row, rebind X->A, merge Y->A
  assert.equal(purgeProjects(memory, [a.id]) > 0, true);
  for (const table of ["projects","entries","revisions","requests","tombstones","capabilities"])
    assert.equal(count(table, a.id), 0, table);
  assert.equal(memory.db.prepare("SELECT COUNT(*) n FROM project_rebinds WHERE from_id=? OR to_id=?").get(a.id,a.id).n, 0);
  assert.equal(memory.hasProject(b.id), true);
  assert.deepEqual(memory.list(b.id, {query: "kept"}).items.length, 1); // search index of the other project intact
});
test("covers a folder and everything below it, only while recorded", ...);
test("covers a session cwd given through a link", ...); // link -> recorded real folder: covers(link) === true
test("refuse throws PROJECT_DELETING with 409", ...);
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/unit/project-deletion-records.test.js tests/unit/project-deletion-guard.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the table, `DeletionRecords`, `purgeProjects`, `DeletionGuard` and the catalog key**

`purgeProjects` runs in one `transaction`: collect the entry ids of `ids`, call `forgetIndexed` for each, then delete from `revisions` (by entry), `requests`, `tombstones`, `capabilities`, `entries`, `project_rebinds` (`from_id IN … OR to_id IN …`), `project_merges` (same) and `projects`. `PRAGMA secure_delete=ON` already overwrites the freed pages. `DeletionGuard.covers` checks `path.resolve(cwd)` and, when it exists, `fs.realpathSync(cwd)` against each record path with `inside`. Catalog key `projectDeletion.projectDeleting` (de: „Dieses Projekt wird gerade gelöscht.“, en: "This project is being deleted.").

- [ ] **Step 4: Run the tests and the catalog parity test**

Run: `node --test tests/unit/project-deletion-records.test.js tests/unit/project-deletion-guard.test.js tests/unit/server-i18n-catalogs.test.js`
Expected: PASS

- [ ] **Step 5: Confirm translations and commit**

```bash
npm run i18n:confirm -- project-deletion
git add server/features/memory server/features/projects/deletion-guard.js server/lib/i18n tests/unit/project-deletion-records.test.js tests/unit/project-deletion-guard.test.js
git commit -m "feat: record project deletions and guard folders being deleted"
```

---

### Task 3: Store removals and the data walk

**Files:**

- Modify: `server/features/tickets/ticket-store.js` (`removeProject`), `server/features/tickets/rule-store.js` (`removeProject`), `server/features/tickets/sequence-store.js` (`removeProject`), `server/features/tickets/project-moves.js` (facade `removeProject`)
- Modify: `server/features/pipelines/run-queue.js` (`removeProject`), `server/features/pipelines/pipeline-definitions.js` (`removeProject`), `server/features/pipelines/workspace-manager.js` (`forget`)
- Modify: `server/features/secrets/secret-store.js`, `server/features/artifacts/artifact-service.js`, `server/features/ssh/ssh-management.js`, `server/features/repositories/repository-store.js`, `server/features/projects/project-groups.js`, `server/features/assistants/agent-project-store.js`
- Create: `server/application/project-data-removal.js`
- Test: `tests/integration/project-data-removal.test.js`

**Interfaces:**

- Consumes: `purgeProjects` (Task 2); `deleteSession(services, session)` (`server/application/session-deletion.js`); `inside` (Task 1); `assistantWorkflows().revokeProject(id, id)` (existing; it fails unstarted approvals and audits); `craftRebuilds.remove(id)` (existing); `requests.approvals.list(projectId)` and `.remove(id)` (existing).
- Produces:
  - `TicketStore#removeProject(id)`, `TicketRuleStore#removeProject(id)`, `TicketSequenceStore#removeProject(id)`; `ticketProjectMoves(...).removeProject(id): Promise<void>` (the sequence queue inside `engine.exclusive(id, …, { step: false })`, then `ticketsProjectChanged`). Reached as `services.projectRebind.tickets`.
  - `RunQueue#removeProject(id): void` (every item in any state, then `notify(id)`).
  - `PipelineDefinitions#removeProject(id): void` (`verification`, `risk`, `queue` keys).
  - `PipelineWorkspace#forget(runId): void` (removes the workspace record file).
  - `SecretStore#removeProject(id, actor = null): number` (through `remove(id, actor)`, so each secret is audited).
  - `ArtifactService#removeProject(id): Promise<number>` (records marked deleted as in `delete`, receipts naming it dropped, then `store.cleanup`).
  - `SshManagement#removeProject(id): Promise<void>` (every key through `ui("removeKey")`, every host and SFTP host through `ui("removeHost")`, then its catalog `projects` row and `receipts`).
  - `RepositoryStore#removeProjects(folder): number` (entries whose path is `inside(folder)`, then `save()`).
  - `ProjectGroups#forget(folder): boolean` (assignments `inside(folder)` dropped through `replace`).
  - `AgentProjectStore#removeProject(id): void`.
  - `removeProjectData(services, body: DeletionBody, folder: string, actor = null): Promise<void>`, idempotent.
  - `projectDataLeft(services, body, folder): string[]` (the store names still holding something; `[]` when done).

- [ ] **Step 1: Write the failing integration test**

```js
test("the walk removes every row of the folder and leaves other projects alone", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  // project A at f.root/doomed with: memory entry, older duplicate row (same cwd),
  // SSH key + host, secret, artifact, verification + risk + queue settings, a queue item,
  // a terminal pipeline run, ticket link + label rule + sequence queue, remembered
  // approval, agent grant (projectIds, sessionProjectIds, talkProjectIds, projectFiles)
  // with an unstarted approval, agent_created_projects row, Craft rebuild record with
  // folder inside, group assignment, repositories.json entry, stopped session record
  // with agentbus dir; project B gets one of each that must survive.
  const body = bodyFor(f, a);
  await removeProjectData(f.application, body, a.cwd);
  assert.deepEqual(projectDataLeft(f.application, body, a.cwd), []);
  assert.equal(f.application.memory.hasProject(older.id), false);
  assert.equal(fs.existsSync(path.join(f.dataDir, "agentbus", "projects", busId)), false);
  assert.equal(stillThere(f.application, b), true);
  // audit history kept
  assert.ok(auditRows(f, "secret.deleted").length >= 1);
});
test("a second walk changes nothing and does not throw", ...);
test("a walk with the agent feature off finishes once it is on", ...); // projectDataLeft lists "agentGrants" until workflows exist
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/integration/project-data-removal.test.js`
Expected: FAIL (module not found / `removeProject is not a function`)

- [ ] **Step 3: Add the store methods**

Each one removes what is still there and never fails on what is gone; none throws for an unknown id.

- [ ] **Step 4: Implement `removeProjectData` and `projectDataLeft` in `server/application/project-data-removal.js`**

Walk order (each id of `body.projectIds`, then the path-keyed stores): stopped sessions in `body.sessionIds` through `deleteSession` (skipped when `sessions.get` 404s), plus their `assistantWorkflows().sessions.store.delete(id)`; AgentBus folders `path.join(services.agentbus.root, "projects", busId)` for `body.busIds` (`fs.rm` recursive, force); runs in `body.runIds` through `pipelines.store.remove(id)` and `pipelineWorkspace.forget(id)`; `pipelineQueue.removeProject`, `pipelineDefinitions.removeProject`, `projectRebind.tickets.removeProject`, `sshManagement.removeProject`, `secrets.removeProject(id, actor)`, `artifacts.removeProject`, remembered approvals, `revokeProject(id, id)`, `agentProjects` rows (`assistantWorkflows().projects.store.removeProject`), lead shares (`shares.list(row => row.projectId === id)` → `shares.remove`) and member grants (`memberGrants.list(...)` → `revoke`), Craft rebuilds in `body.rebuildIds`, then `repositories.removeProjects(folder)`, `projectGroups.forget(folder)`, and last `purgeProjects(memory, projectIds)`. `projectDataLeft` asks the same stores' `ownsProject`/`hasProject`/`holdsProject`/`hasVerification`/`knowsProject` the way `ProjectRebind.remnants()` does, plus the path-keyed stores.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/integration/project-data-removal.test.js tests/integration/project-rebind.test.js tests/integration/sequence-project-moves.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server tests/integration/project-data-removal.test.js
git commit -m "feat: remove everything AgentPier keeps about a project"
```

---

### Task 4: Processes using the folder

**Files:**

- Create: `server/features/projects/folder-processes.js`
- Modify: `server/features/changes/session-workspaces.js` (export `parseWorktrees`; used in Task 5)
- Test: `tests/unit/folder-processes.test.js`

**Interfaces:**

- Consumes: `inside` (Task 1); `readProcessTable`, `processTrees` (`server/features/system-status/process-stats.js`); `sessionPanes(sessions)` (`server/features/system-status/system-status.js`); `readTmuxServer(manager)` (`server/features/sessions/tmux-server-identity.js`); `processIdentity(pid)` (`server/lib/process-identity.js`).
- Produces:
  - `parseLsof(stdout: string, folders: string[]): Map<pid, { pid, name, uid, uses: "cwd" | "files" }>`.
  - `scanFolderProcesses(folders: string[], { timeoutMs = 10000, platform, run, readProc }): Promise<{ status: "ok" | "timeout" | "failed", processes: Found[] }>`.
  - `classifyProcesses(found, { serverPid, gatewayPid, tmuxPid, sessionPanes, table, uid }): Process[]`, where `Process = { pid, startTime, name, uses, owner: "self" | "other", known: null | { kind: "session", sessionId } | { kind: "agent-command" }, endable: boolean, protected: boolean }`.
  - `endProcess({ pid, startTime }, { graceMs = 5000, signal = process.kill, identity = processIdentity }): Promise<"ended" | "gone" | "changed">`.

- [ ] **Step 1: Write the failing tests**

```js
test("parses names with spaces, unicode and newlines", () => {
  const out = "p42\0cvim\0u501\0\nfcwd\0n/work/my app\0\np43\0cnode\0u0\0\nf12\0n/work/my app2/x\0\n";
  // -F0 output: NUL-terminated fields, each field set ended by "\n"
  const found = parseLsof(out, ["/work/my app"]);
  assert.deepEqual([...found.keys()], [42]);
  assert.equal(found.get(42).uses, "cwd");
  assert.equal(parseLsof("p7\0cx\0u1\0f3\0n/work/my app/ü\nzeile\0", ["/work/my app"]).get(7).uses, "files");
});
test("the server, its ancestors, tmux, the Gateway and pid 1 are protected", ...);
test("pane trees are session processes, Gateway children are agent commands", ...);
test("other users' processes are listed but not endable", ...);
test("a scan past its bound reports timeout", async () => {
  const r = await scanFolderProcesses(["/x"], { timeoutMs: 20, run: () => new Promise(() => {}) });
  assert.equal(r.status, "timeout");
});
test("Linux falls back to /proc when lsof is missing", ...); // run rejects ENOENT; readProc fakes cwd + fd links
test("endProcess sends TERM, then KILL after the grace period, never to a reused pid", ...);
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/unit/folder-processes.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `server/features/projects/folder-processes.js`**

Detection: `lsof -w -n -P -F0pcufn` over all processes (`maxBuffer` 64 MiB, `AbortSignal.timeout(timeoutMs)`; exit code 1 with stdout still counts, as in `workspace-processes.js`). `-F0` makes fields NUL-terminated, so a newline inside a name cannot start a new record. Parsing:

```js
let current = null,
  fd = "";
for (const raw of stdout.split("\0")) {
  const field = raw.replace(/^\n/, ""); // each field set ends with NUL then "\n"
  const tag = field[0],
    value = field.slice(1);
  if (tag === "p") current = { pid: Number(value), name: "", uid: null, uses: null };
  else if (!current) continue;
  else if (tag === "c") current.name = value;
  else if (tag === "u") current.uid = Number(value);
  else if (tag === "f") fd = value;
  else if (tag === "n" && folders.some((f) => inside(f, value))) {
    current.uses = fd === "cwd" || current.uses === "cwd" ? "cwd" : "files";
    found.set(current.pid, current);
  }
}
```

Linux fallback when `lsof` is `ENOENT`: for each `/proc/<pid>`, `readlink cwd` and each `fd/*`, `uid` from `stat('/proc/<pid>').uid`, name from `/proc/<pid>/comm`, all under the same deadline. Classification: protected = `serverPid` and its ancestors (walk `ppid` in `table`), `tmuxPid`, `gatewayPid`, `1`; session processes from `processTrees(table, [["gateway", gatewayPid], ...panes.map(p => [p.id, p.pid])])`; owner `self` when `uid === process.getuid()`; `endable = !protected && owner === "self"`; `startTime` from `processIdentity(pid).startTime` (skipped when the process is gone). `endProcess` re-reads the identity before each signal and returns `"changed"` when the start time differs.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/unit/folder-processes.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/projects/folder-processes.js server/features/changes/session-workspaces.js tests/unit/folder-processes.test.js
git commit -m "feat: find and end processes that use a project folder"
```

---

### Task 5: Unsaved Git work

**Files:**

- Create: `server/features/projects/unsaved-git-work.js`
- Test: `tests/integration/project-unsaved-git.test.js`

**Interfaces:**

- Consumes: `git(cwd, args, { timeout })` (`server/features/pipelines/workspace-git.js`); `parseWorktrees` (Task 4 export); `inside` (Task 1).
- Produces: `unsavedGitWork(folder: string, { timeoutMs = 10000 }): Promise<GitReport>`, where `GitReport = { status: "none" | "ok", worktrees: { path, branch, inside: boolean, changes: number | null, unpushed: number | null, checked: boolean }[], unpushedBranches: number | null }`.

- [ ] **Step 1: Write the failing test (real `git` in a temp folder)**

```js
test("reports uncommitted changes and commits on no remote, per worktree", async () => {
  // repo with origin (a bare repo), one pushed commit, one local commit, a dirty file,
  // a worktree in .worktrees/a, one in .agentpier-worktrees/b, one linked outside
  const r = await unsavedGitWork(repo);
  assert.equal(r.status, "ok");
  const main = r.worktrees.find((w) => w.path === repo);
  assert.equal(main.changes, 1);
  assert.equal(main.unpushed, 1);
  assert.deepEqual(r.worktrees.map((w) => w.inside), [true, true, true, false]);
});
test("a plain folder reports none", ...);
test("a worktree that does not answer in time is not checked", ...); // timeoutMs: 1 -> checked:false, counts null
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/integration/project-unsaved-git.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `unsavedGitWork`**

`rev-parse --show-toplevel` (none → `status: "none"`); `worktree list --porcelain -z` from the toplevel; per non-bare worktree, with `timeoutMs` each: `status --porcelain --untracked-files=normal` (line count) and `rev-list --count HEAD --not --remotes`. Once per repository: `rev-list --count --branches --not --remotes`. A failing or timed-out call sets `checked: false` and leaves the counts `null`.

- [ ] **Step 4: Run the test**

Run: `node --test tests/integration/project-unsaved-git.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/projects/unsaved-git-work.js tests/integration/project-unsaved-git.test.js
git commit -m "feat: list unsaved Git work of a folder and its worktrees"
```

---

### Task 6: Scope, blockers and the preflight report

**Files:**

- Create: `server/application/project-deletion-scope.js`
- Create: `server/application/project-deletion-preflight.js`
- Modify: `server/lib/i18n/de/project-deletion.js`, `server/lib/i18n/en/project-deletion.js` (refusal messages)
- Test: `tests/unit/project-deletion-preflight.test.js`

**Interfaces:**

- Consumes: Tasks 1, 4 and 5; `normalizeProjectPath` (`project-groups.js`); `sessionRecords(dataDir)` (`project-cleanup.js`); `terminal(run)` (`server/features/pipelines/graph-navigation.js`); `projectAgents` (`server/features/assistants/project-agent-access.js`); `services.users.get(id)`.
- Produces:
  - `deletionScope(services, rawPath): Promise<Scope>`, where `Scope = { path, name, folderState, dev, ino, projects: { path, name, memoryIds: string[], repositoryIds: string[], busIds: string[], main: boolean }[], projectIds, repositoryIds, busIds, sessionIds, runIds, rebuildIds }`. A path that names no project → `problem(projectDeletion.projectNotFound, 404)`.
  - `deletionBlockers(services, scope): Promise<{ sessions: { id, name, tool, agentId? }[], runs: { id, pipelineName, status }[], queue: { id, projectId, state }[], rebuilds: { id, name }[] }>`.
  - `preflight(services, rawPath): Promise<Report>`, where `Report = { token, path, name, folderState, refused: null | string, projects, blockers, processes: { status: "ok" | "timeout" | "failed" | "skipped", list: Process[] }, git: { path, report: GitReport | null }[], access: { agents: { id, name, via: "grant" | "share" | "member" }[], users: { id, name }[] }, ready: boolean }`.
  - `deletionToken(scope): string`: sha256 of `JSON.stringify([path, folderState, dev, ino, projectIds.sort(), repositoryIds.sort(), busIds.sort()])`.

- [ ] **Step 1: Write the failing tests (fake services)**

```js
test("scope joins every source of one folder", ...); // memory row + duplicate row + repo entry + bus session -> one main project, all ids
test("nested registered projects are in the scope and their sessions block", ...);
test("running sessions, unfinished runs, queued items and running rebuilds block", ...);
test("a process scan timeout blocks; a Git timeout only warns", ...); // ready false / ready true with checked:false
test("a protected AgentPier process in the folder refuses the delete", ...); // refused === "agentpier-process"
test("a dangerous path refuses before any scan", ...); // refused === "home-child", processes.status "skipped"
test("a missing folder skips processes and Git", ...); // folderState "missing", processes.status "skipped", git []
test("the token changes with the folder's inode and with a new nested project", ...);
test("agents with grants, shares or member grants and their users are listed", ...);
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/unit/project-deletion-preflight.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement scope and preflight**

Scope: the main path is `normalizeProjectPath(rawPath)`; it must be absolute. Memory rows with `cwd` inside it, repository entries with `path` inside it, and session records whose `cwd` (or real path) is inside it or whose `memory.projectId`, `sshTools.project.projectId` or `secrets.projectId` is one of the ids. `busIds` are `session.agentbus.projectId` of those records plus `sha256(projectPath)` of each project path. `runIds` are the runs with `projectId` in ids or `cwd` inside the path; `rebuildIds` are the Craft rebuilds whose `folder` is inside it. The name is the main memory row's name, else the repository entry's, else `path.basename`.

Preflight: with `folderState === "present"`, run `refusedFolder` (refusal ends the report with `ready: false`), the process scan (Task 4) and `unsavedGitWork` per project (main and nested). With `"missing"`, skip both. With `"unavailable"`, refuse with `"drive-unavailable"`: nothing is deleted while the drive is away. `ready` is `!refused && no blockers && processes.status in ["ok", "skipped"] && no process left`.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/unit/project-deletion-preflight.test.js`
Expected: PASS

- [ ] **Step 5: Confirm translations and commit**

```bash
npm run i18n:confirm -- project-deletion
git add server/application/project-deletion-scope.js server/application/project-deletion-preflight.js server/lib/i18n tests/unit/project-deletion-preflight.test.js
git commit -m "feat: preflight a project deletion"
```

---

### Task 7: Resumable deletion, audit and start-up recovery

**Files:**

- Create: `server/application/project-deletion.js`
- Create: `server/features/audit/audit-project-deletion-details.js`
- Modify: `server/features/audit/audit-schema.js` (import and one call, at most 3 lines)
- Modify: `server/app.js` (construct `services.deletionGuard` before `createSessionLifecycle`; construct `services.projectDeletion` after `services.projectDuplicates`; `await services.projectDeletion.resume()` after `cleanUpProjects`)
- Test: `tests/unit/project-deletion.test.js`, `tests/integration/project-deletion-resume.test.js`

**Interfaces:**

- Consumes: Tasks 1–6; `assertUnchanged(target, { dev, ino })` (`project-folder.js`, bigint values); `auditActor(principal)` (`server/features/audit/audit-actor.js`); `services.reload.stop(id)` / `services.sessions.stop(id)`; `pipelines.cancel(id)`; `pipelineQueue.remove(projectId, id)`; `craftRebuilds.pause(id)`; `endProcess` (Task 4).
- Produces: class `ProjectDeletion(services)` with:
  - `preflight(path): Promise<Report>`
  - `endBlockers({ path, token, sessions: boolean, processes: { pid, startTime }[] }, principal): Promise<Report>`
  - `start({ path, token, name }, principal): Promise<{ state: "deleting" }>` (resolves once marked; the rest continues in the background)
  - `retry(path, principal): Promise<{ state: "deleting" }>`
  - `resume(): Promise<void>` (never throws)
  - `settled(path): Promise<void>` (for tests: the running background job of a path)
  - Audit `project.deleted`: `resourceType: "project"`, `resourceId` and `projectId` = the main memory id (else the first id), `source: "user"`, `outcome: "success"`, details `{ path, nestedProjectIds, endedSessionIds, endedProcesses, unsavedGitWork, folderMissing }`.

- [ ] **Step 1: Write the failing unit tests (fake services, real temp folders)**

```js
test("start refuses a stale token, a wrong name and a dangerous path", ...); // 409 PROJECT_DELETE_STALE, 400 PROJECT_DELETE_NAME, 409 PROJECT_DELETE_REFUSED; nothing marked
test("a replaced folder makes the token stale", ...); // rename folder away, mkdir same path -> 409, new folder kept
test("start re-checks blockers after marking and clears the mark when one appears", ...);
test("order: mark, revoke grants, delete folder, remove data, drop record", ...); // calls recorded in order
test("a partial rm leaves a failed record that retry finishes", async () => {
  // a read-only subfolder (chmod 0o500 on its parent) makes fs.rm fail with EACCES
  await deletion.start({ path, token, name }, owner);
  await deletion.settled(path);
  assert.equal(memory.deletions.get(path).state, "failed");
  assert.equal(memory.deletions.get(path).error, "EACCES");
  assert.equal(memory.hasProject(id), true); // data kept while the folder is not gone
  chmod back; await deletion.retry(path, owner); await deletion.settled(path);
  assert.equal(memory.deletions.get(path), null);
  assert.equal(fs.existsSync(path), false);
});
test("a missing folder needs no name and skips the folder step", ...);
test("a folder that reappeared refuses the missing-folder removal", ...); // 409 PROJECT_FOLDER_REAPPEARED
test("endBlockers stops sessions and ends only ticked, endable processes", ...);
test("audit project.deleted carries path, nested ids, ended work and the Git flag", ...);
```

- [ ] **Step 2: Write the failing resume test**

```js
test("a deletion interrupted after the folder step finishes at the next start", async (t) => {
  // applicationFixture; folder f.root/doomed with a memory entry; mark the record by hand
  // (state "deleting", body from deletionScope), delete the folder, restart the app
  await f.restart();
  assert.equal(f.application.memory.deletions.get(folder), null);
  assert.equal(f.application.memory.hasProject(id), false);
});
test("resume marks a deletion failed when a session runs again in the folder", ...);
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `node --test tests/unit/project-deletion.test.js tests/integration/project-deletion-resume.test.js`
Expected: FAIL (module not found)

- [ ] **Step 4: Implement `ProjectDeletion` and the audit details**

`start`: serialized per path. Recompute `preflight`; refuse a token mismatch (`PROJECT_DELETE_STALE`, 409), a refusal (`PROJECT_DELETE_REFUSED`, 409, with the reason), a present folder without `name === report.name` (`PROJECT_DELETE_NAME`, 400), a report with `folderState: "missing"` whose path exists again (`PROJECT_FOLDER_REAPPEARED`, 409), and `!ready` (`PROJECT_DELETE_BLOCKED`, 409). Then `memory.deletions.mark(path, body)`, signal `projects.changed`, revoke grants (`revokeProject(id, id)` for every id), then recompute the blockers; if any appeared, `drop(path)`, signal again and throw `PROJECT_DELETE_BLOCKED`. Run `run(path, principal)` in the background. `run`: unless `folderMissing`, `lstat` the path; when it still exists, `assertUnchanged(path, { dev: BigInt(body.dev), ino: BigInt(body.ino) })` then `fs.rm(path, { recursive: true, force: false, maxRetries: 2 })`; then `removeProjectData`; when `projectDataLeft` is empty, audit and `drop`, else `fail(path, "PROJECT_DATA_LEFT")`. Any error → `fail(path, error.code || "PROJECT_DELETE_FAILED")`. Every state change signals `projects.changed` (`services.live?.invalidate("projects.changed")`). `resume`: for every `deleting` record, check session blockers (`fail` with `PROJECT_DELETE_BLOCKED` when one runs) and otherwise `run`; `failed` records wait for `retry`. `retry` refuses anything but a `failed` record (`PROJECT_DELETE_NOT_FAILED`, 409), calls `again(path)`, re-checks the blockers and runs. `endBlockers` refuses a stale token, then with `sessions: true` stops every running session of the scope (`reload.stop(id)`, else `sessions.stop(id)`), cancels its unfinished runs (`pipelines.cancel`), removes its queue items (`pipelineQueue.remove`) and pauses its running Craft rebuilds (`craftRebuilds.pause`); each ticked process must be in a fresh scan, `endable` and of the same start time, and goes through `endProcess`, or through its session's stop when `known.kind === "session"`. Ended ids and processes are kept in memory per path for the audit record. Each error code gets a de/en message in `projectDeletion`.

`audit-project-deletion-details.js`: `projectDeletionAuditDetails(details, event, auditId)` for `action === "project.deleted"`. It keeps `path` (absolute, at most 4096 characters, no control characters), `nestedProjectIds` (each through `auditId`, at most 100), `endedSessionIds` (same), `endedProcesses` (at most 100 `{ pid: safe integer, name: at most 64 characters }`), and `unsavedGitWork` and `folderMissing` (booleans).

- [ ] **Step 5: Run the tests**

Run: `node --test tests/unit/project-deletion.test.js tests/integration/project-deletion-resume.test.js tests/integration/project-cleanup.test.js`
Expected: PASS

- [ ] **Step 6: Confirm translations and commit**

```bash
npm run i18n:confirm -- project-deletion
git add server tests/unit/project-deletion.test.js tests/integration/project-deletion-resume.test.js
git commit -m "feat: delete a project folder and its data, resumably"
```

---

### Task 8: Start paths refuse a folder being deleted

**Files:**

- Modify: `server/application/session-lifecycle.js` (`launch`: `services.deletionGuard?.refuse(body.cwd)` first; covers coding, agent coding, ticket and pipeline-step sessions and AgentBus registration, which runs only through `launch`)
- Modify: `server/application/pipelines.js` (`pipelines.startGuard = (cwd) => services.deletionGuard?.refuse(cwd)`; queue `add` guard through `services.deletionGuard?.refuseProject(projectId)`)
- Modify: `server/features/pipelines/pipeline-engine.js` (`start`: `this.startGuard?.(cwd)` after the input check, 1 line), `server/features/pipelines/run-queue.js` (`add`: `this.startGuard?.(projectId)`, 1 line, set in `pipelines.js`)
- Modify: `server/features/tickets/ticket-worktree.js` (constructor option `startGuard`; `#fence` calls `this.startGuard?.(projectRoot)`), `server/features/tickets/sequence-service.js` (pass it)
- Modify: `server/application/preview-wiring.js` (wrap `open`: a session owner whose session `cwd` the guard covers is refused)
- Modify: `server/features/assistants/project-agent-access.js` (`setProjectAgent`: `refuseProject(projectId)` before saving)
- Test: `tests/integration/project-deletion-start-guard.test.js`

**Interfaces:**

- Consumes: `DeletionGuard` (Task 2) as `services.deletionGuard`.
- Produces: every refusal is HTTP 409 with `code: "PROJECT_DELETING"`.

- [ ] **Step 1: Write the failing integration test**

```js
test("every start path refuses a folder being deleted", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  // mark f.root/doomed as deleting in memory.deletions
  const launch = await f.request("/api/sessions", { method: "POST", body: { cwd: folder, accountId: "local-codex" } });
  assert.equal(launch.status, 409);
  assert.equal((await launch.json()).code, "PROJECT_DELETING");
  await assert.rejects(f.application.pipelines.start({ pipelineId, cwd: folder, task: "x" }), { status: 409 });
  await assert.rejects(() => f.application.pipelineQueue.add(projectId, { pipelineId, task: "x" }), { status: 409 });
  await assert.rejects(ticketWorktrees.createSession({ projectPath: folder, ticket, name: "t" }), { status: 409 });
  // agent grant for the project refused; preview for a session in the folder refused
  assert.equal(fs.existsSync(path.join(f.dataDir, "agentbus", "projects", sha256(folder))), false);
});
test("a folder outside the deletion still starts", ...);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/integration/project-deletion-start-guard.test.js`
Expected: FAIL (status 201 instead of 409)

- [ ] **Step 3: Add the guard calls**

Add the one-line guard calls listed under **Files**, in the places named there.

- [ ] **Step 4: Run the test**

Run: `node --test tests/integration/project-deletion-start-guard.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server tests/integration/project-deletion-start-guard.test.js
git commit -m "feat: refuse new work in a project being deleted"
```

---

### Task 9: HTTP routes, list annotations and live signals

**Files:**

- Create: `server/http/routes/project-deletion.js`
- Modify: `server/app.js` (`mount(projectDeletionRoutes(services))` beside `memoryRoutes`)
- Modify: `server/http/routes/memory.js` (`GET /memory/projects`: each row gets `folder` from `folderState`; the body gets `deletions: memory.deletions.list().map(({ path, state, error }) => ({ path, state, error }))`)
- Modify: `server/http/routes/repositories.js` (`GET /repositories`: each project gets `folder`)
- Modify: `server/features/memory/live-topics.js` (header comment: deletion state changes signal `projects.changed`)
- Test: `tests/integration/project-deletion-routes.test.js`

**Interfaces:**

- Consumes: `ProjectDeletion` (Task 7), `folderState` (Task 1).
- Produces routes (all owner only; deny-by-default keeps users out):
  - `GET /api/project-deletion?path=<abs>` → `Report`
  - `POST /api/project-deletion/blockers` `{ path, token, sessions, processes }` → `Report`
  - `POST /api/project-deletion` `{ path, token, name? }` → `202 { state: "deleting" }`
  - `POST /api/project-deletion/retry` `{ path }` → `202 { state: "deleting" }`
  - `GET /api/memory/projects` → `{ projects: [{ …, folder }], deletions: [{ path, state, error }] }`; `GET /api/repositories` projects carry `folder`.

- [ ] **Step 1: Write the failing integration test**

```js
test("the owner previews and deletes a project; it disappears live", async (t) => {
  const f = await applicationFixture(t);
  // register f.root/doomed with an entry; subscribe projects.changed
  const report = await (await f.request(`/api/project-deletion?path=${enc(folder)}`)).json();
  assert.equal(report.ready, true);
  const started = await f.request("/api/project-deletion", { method: "POST", body: { path: folder, token: report.token, name: report.name } });
  assert.equal(started.status, 202);
  await f.application.projectDeletion.settled(folder);
  assert.equal(fs.existsSync(folder), false);
  assert.equal((await projects(f)).some((p) => p.cwd === folder), false);
  assert.equal((await live.next(changedFrame, 2000)).type, "changed");
  assert.equal(auditRows(f, "project.deleted").at(-1).details.path, folder);
});
test("a missing folder is listed as missing and removed without a name", ...); // folder:"missing", POST without name -> 202
test("a deleting project is listed in deletions", ...);
test("a restricted user cannot reach the deletion routes", ...); // signedInUser -> 404 for all four
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/integration/project-deletion-routes.test.js`
Expected: FAIL (404 for `/api/project-deletion`)

- [ ] **Step 3: Implement the routes and the annotations**

The route module validates `path` (a string, absolute, at most 4096 characters, no control characters) and `token` (64 hex characters) and passes `request.principal` as the actor. The annotation stats every row in parallel through `folderState`.

- [ ] **Step 4: Run the tests, including route inventory and user denial**

Run: `node --test tests/integration/project-deletion-routes.test.js tests/integration/route-inventory.test.js tests/blackbox/user-route-denial.test.js tests/integration/live-projects-topic.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server tests/integration/project-deletion-routes.test.js
git commit -m "feat: add the project deletion routes and folder states"
```

---

### Task 10: Web — hub states, menu, list, detail and the dialog

**Files:**

- Create: `web/lib/i18n/de/project-deletion.js`, `web/lib/i18n/en/project-deletion.js`, `web/lib/i18n/messages/project-deletion.js` (`projectDeletionCopy`)
- Create: `web/features/projects/project-deletion.js` (pure helpers)
- Create: `web/features/projects/DeleteProjectDialog.jsx`, `web/features/projects/ProjectDeletionReport.jsx`
- Modify: `web/features/projects/useProjectHub.js` (`mergeProjects({ …, deletions })`: every project gets `folder` and `deletion`)
- Modify: `web/features/projects/project-menu.js` (`onDelete`, `deleteLabel` → a separated item `{ id: "delete", label, danger: true, restoreFocus: false, run }`)
- Modify: `web/features/projects/ProjectList.jsx` (menu item; missing filter `Segment` shown while any project's folder is missing), `web/features/projects/project-groups.js` (`buildProjectSections({ …, missingOnly })`)
- Modify: `web/features/projects/ProjectListItem.jsx` (state `StatusChip`; `deleting` class greys the row)
- Modify: `web/features/projects/ProjectDetail.jsx` (desktop header `.button.secondary` "Delete project…" / "Remove from AgentPier…"; phone sheet item; state chip; "Retry" on a failed deletion)
- Modify: `web/features/projects/ProjectsPage.jsx` (dialog `"delete"`, `usePageAction("project-delete", …)`), `web/features/projects/projects.css`
- Test: `tests/unit/project-deletion-web.test.js`, extend `tests/unit/project-groups-sections.test.js`

**Interfaces:**

- Consumes: routes (Task 9); `ConfirmDialog`, `Checkbox`, `StatusChip`, `Segment`.
- Produces:
  - `projectState(project): "deleting" | "failed" | "missing" | "unavailable" | null`.
  - `deleteLabel(project): string` ("Delete project…" or "Remove from AgentPier…").
  - `confirmReady(report, typed): boolean` (`report.ready && (report.folderState === "missing" || typed === report.name)`).
  - `endableProcesses(report): Process[]`.
  - `mergeProjects` output adds `folder: "present" | "missing" | "unavailable"` and `deletion: null | { state, error }`, matched by normalized path; deletions for a path no source lists any more are dropped.
  - Copy keys in `projectDeletionCopy`: `deleteAction`, `removeAction`, `deleteTitle(name)`, `removeTitle(name)`, `deleteBody(path)`, `removeBody(path)`, `typeName(name)`, `confirmDelete`, `confirmRemove`, `loading`, `blockersTitle`, `stopSessions`, `processesTitle`, `endProcesses`, `processOther`, `processProtected`, `scanTimeout`, `rescan`, `gitTitle`, `gitChanges(n)`, `gitUnpushed(n)`, `gitUnchecked(path)`, `linkedWorktree(path)`, `nestedTitle`, `accessTitle`, `folderMissing`, `driveUnavailable`, `deleting`, `deletionFailed`, `retry`, `missingFilter(n)`, `allFilter`, `refused(reason)`.

- [ ] **Step 1: Write the failing unit tests**

```js
test("merged projects carry folder state and deletion by path", () => {
  const [p] = mergeProjects({
    memoryProjects: [{ id: "m1", name: "a", cwd: "/w/a", folder: "missing" }],
    repositories: [], busProjects: [],
    deletions: [{ path: "/w/a/", state: "failed", error: "EACCES" }],
  });
  assert.equal(p.folder, "missing");
  assert.deepEqual(p.deletion, { state: "failed", error: "EACCES" });
});
test("the menu offers Delete project… or Remove from AgentPier… as a danger item", ...);
test("the name must match exactly unless the folder is missing", ...); // confirmReady: "A" vs "a" false; missing -> true without typing
test("only endable processes can be ticked", ...);
test("missingOnly keeps projects with a missing folder", ...); // buildProjectSections
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/unit/project-deletion-web.test.js tests/unit/project-groups-sections.test.js`
Expected: FAIL

- [ ] **Step 3: Implement the helpers, catalogs and components**

`DeleteProjectDialog({ project, close, deleted })`:

- Reads `GET /project-deletion?path=` on open and after each blocker action.
- `ConfirmDialog destructive` with title `deleteTitle(name)` or `removeTitle(name)`, and body `deleteBody(path)` naming the full path and stating that the folder and everything in it is deleted from disk permanently and cannot be undone (`removeBody` for a missing folder: only AgentPier's data goes).
- Children: `ProjectDeletionReport` (blockers with "Stop sessions"; processes with a `Checkbox` per endable one and an "End selected" button, other users' and protected ones listed without a box; Git warnings shown prominently; nested projects by name; access, informational) and, for a present folder, a name input.
- `confirmDisabled={!confirmReady(report, typed)}`; `onConfirm` posts `/project-deletion`.
- A 409 `PROJECT_FOLDER_REAPPEARED` reloads the report, which turns the dialog into the full delete flow; `PROJECT_DELETE_STALE` reloads it as well.

The list row shows a `StatusChip`: `neutral` "Folder missing" / "Drive not available", `pending` "Deleting…", `error` "Deletion failed — Retry". While deleting or failed, the delete action is absent and the detail offers "Retry" (`POST /project-deletion/retry`). The filter `Segment` options are `allFilter` and `missingFilter(n)`.

- [ ] **Step 4: Run the tests, catalog parity and lint**

Run: `node --test tests/unit/project-deletion-web.test.js tests/unit/project-groups-sections.test.js tests/unit/i18n-catalogs.test.js tests/unit/ui-guide-rules.test.js && npm run lint`
Expected: PASS

- [ ] **Step 5: Confirm translations, check in English, commit**

Review every de/en pair, run `npm run i18n:confirm -- project-deletion`, and open the dialog once in English (`npm run dev`).

```bash
git add web tests/unit/project-deletion-web.test.js tests/unit/project-groups-sections.test.js web/lib/i18n/translation-lock.json
git commit -m "feat: delete a project from the projects page"
```

---

### Task 11: ⌘K action and documentation

**Files:**

- Create: `web/app/project-search-entries.js` (`projectActionEntries(action, path)`: moves "Start tickets" and "Add label rule" out of `search-entries.js` and adds "Delete project")
- Modify: `web/app/search-entries.js` (use `projectActionEntries`; the file shrinks), `web/app/AppSearch.jsx` (`target.action === "delete-project"` navigates to the current project, or the projects page)
- Modify: `web/lib/i18n/de/search.js`, `web/lib/i18n/en/search.js` (`actions.deleteProject`: "Projekt löschen" / "Delete project"; `aliases.removeProject`: "Projekt entfernen" / "Remove project")
- Modify: `tests/unit/search-index.test.js`, `tests/unit/quick-open.test.js`
- Modify: `docs/memory.md` (Projects page: delete, preflight, folder states, filter, resumable deletion), `docs/architecture.md` (Live channel `projects.changed`: deletion states and folder states are read with the list, no polling), `README.md`, `README.de.md` (projects bullet)

**Interfaces:**

- Consumes: `usePageAction("project-delete", …)` (Task 10).
- Produces: entry `{ id: "action:delete-project", target: { action: "delete-project", pending: "project-delete" }, aliases: [Remove project] }`, owner index only.

- [ ] **Step 1: Write the failing tests**

```js
test("Delete project is an action that opens the delete dialog", () => {
  const target = { action: "delete-project", pending: "project-delete" };
  for (const query of ["Delete project", "Projekt löschen", "Remove project", "Projekt entfernen"]) {
    const top = first(query);
    assert.equal(top.id, "action:delete-project", query);
    assert.deepEqual(top.target, target, query);
  }
});
// quick-open.test.js
test("Delete project is an owner action only, not in the user's search", ...);
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/unit/search-index.test.js tests/unit/quick-open.test.js`
Expected: FAIL

- [ ] **Step 3: Implement the entry and update the docs**

- [ ] **Step 4: Run the tests and the structure check**

Run: `node --test tests/unit/search-index.test.js tests/unit/quick-open.test.js && npm run check:structure`
Expected: PASS

- [ ] **Step 5: Confirm translations and commit**

```bash
npm run i18n:confirm -- search
git add web docs README.md README.de.md tests/unit/search-index.test.js tests/unit/quick-open.test.js
git commit -m "feat: find Delete project in the search; document project deletion"
```

---

### Task 12: Browser test

**Files:**

- Create: `tests/browser/projects-delete.spec.js`

**Interfaces:**

- Consumes: `hubFixture(page, { intercept })` (`tests/browser/projects-fixture.js`); routes (Task 9) mocked through `page.route`.

- [ ] **Step 1: Write the browser tests**

```js
test.use({ locale: "en-GB" });
test("a project is deleted only after its name is typed", async ({ page }) => {
  // intercept GET /api/project-deletion -> ready report with Git warning; POST -> 202
  // open notes' ⋯ menu -> "Delete project…" (danger item); dialog shows /work/notes,
  // "cannot be undone", the Git warning; Delete disabled until "notes" typed; POST body {path, token, name}
});
test("running sessions block until Stop sessions", ...); // first report blockers.sessions=[s1], Delete disabled; Stop -> POST /blockers {sessions:true}; second report ready
test("only ticked processes are ended; another user's process has no box", ...);
test("a missing folder is removed from AgentPier with a plain confirm", ...); // memory row folder:"missing" -> chip "Folder missing", menu "Remove from AgentPier…", no name field
test("the Folder missing filter shows the stale projects", ...);
test("a failed deletion shows Retry", ...); // deletions:[{path,state:"failed"}] -> chip "Deletion failed — Retry"; Retry posts /retry
test("⌘K Delete project opens the dialog for the open project", ...);
```

- [ ] **Step 2: Build and run them**

Run: `npm run build && npx playwright test tests/browser/projects-delete.spec.js`
Expected: PASS on `desktop` and `tablet`

- [ ] **Step 3: Run the full check**

Run: `npm run check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/browser/projects-delete.spec.js
git commit -m "test: cover deleting a project in the browser"
```

- [ ] **Step 5: Before the pull request, delete the working documents**

```bash
git rm docs/superpowers/plans/2026-11-16-delete-project.md docs/superpowers/specs/2026-11-16-delete-project-design.md
git commit -m "docs: remove the delete-project plan and spec"
```
