# Diff Annotations 2: Session Changes Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fourth session tab **Changes** / **Änderungen** that shows everything the session and its `.worktrees/` worktrees changed, lets the owner comment on lines and appends all open comments to the chat composer as one batch.

**Architecture:** The session records its start commit at launch. A read-only server service lists the session's workspaces (the session directory and the repo's `.worktrees/` worktrees), picks each one's diff base, and returns bounded, parsed diffs with the hardened flags of `WorkspaceManager.diff`. A sampled live topic carries the per-workspace summary that drives the picker and the tab badge. The tab reuses plan 1's `DiffReview` and comment store; **Send to agent** appends the batch to the composer through a small registry of mounted chat drafts, or copies it to the clipboard.

**Tech Stack:** Node.js ES modules, `node:child_process` `spawn`, Express, `node:test`, React 18, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-04-diff-annotations-design.md`

**Depends on:** plan 1 (`2026-11-04-diff-annotations-1-component.md`) merged.

## Global Constraints

- AGENTS.md applies in full: DE+EN catalogs with `npm run i18n:confirm`; ui-guide components and tokens only; no font size below 11px; breakpoints only from `web/lib/breakpoints.js`; files ≤ 600 lines; live updates, not polling; ⌘K entries with tests; docs in the same PR.
- Git safety: read-only git only, with `--no-ext-diff --no-textconv --no-color` on every diff; never follow a client-supplied path: a client names a workspace by the `id` the server listed, nothing else; output bounded at 1 MB (`DIFF_BYTE_LIMIT = 1048576`) with `truncated`; every git call is asynchronous with a 30 s timeout.
- Workspaces are only the session directory (its git toplevel) and worktrees under the main repository's `.worktrees/`. `.agentpier-worktrees/` (pipeline runs) and any other worktree are excluded. The badge counts only listed workspaces.
- Diff base: a workspace on a branch other than the default branch → `merge-base(HEAD, <default>)`; the default branch or a detached HEAD → the session start commit (the session directory) or HEAD (a worktree). Uncommitted and untracked (not ignored) files are included.
- Default branch: `origin/HEAD` → `main` → `master` via `ticket-worktree.js`.
- Anti-goals: the tab is closed until the owner opens it; nothing is sent without the owner's own Send in the chat.
- Append rule of `chat-draft-reuse.js`: a non-blank draft gets `"\n" + batch`, a blank one is replaced. A locked draft (pending outbox), a session without chat composer and a terminal-only session get the clipboard fallback.
- Chat messages are limited to 32,000 characters (`server/features/sessions/session-chat-input.js`); a draft plus batch above it is refused with a notice, never truncated.
- Routes, comments and ⌘K are owner-only; `web/features/users/user-search-entries.js` gets no entry.
- Phone: 390 px width keeps horizontal containment.

## Review Focus

- A session whose directory is not a Git repository opens the tab on a short "not a Git repository" note, shows no badge and never answers 500 (Task 4 test `a plain folder has no workspaces`).
- A worktree removed after the list was read: its diff request answers 404 `unknownWorkspace` and the tab reads the list again (Task 4 test `a vanished worktree is unknown`; Task 5 handles the 404).
- A long draft plus a large batch over 32,000 characters: Send to agent refuses with a notice and changes neither the draft nor the comments (Task 6 test `an over-long batch is refused`).
- A session reload or account switch keeps the recorded start commit, so the diff base does not jump to the new HEAD (Task 2 test `a replaced session keeps its start commit`).
- A repository whose build output is not ignored (thousands of untracked files, binaries): the listing stops at 200 untracked files, binaries render as "Binary file", and the 1 MB bound holds (Task 1 test `untracked files are bounded and binaries are marked`).

## Builder's calls recorded here

- **Working-tree change detection:** the `session.changes:<id>` topic is sampled on the server every 15 s (`CHANGES_SAMPLE_MS = 15000`) while a visible tab watches it, and read at once on every `native-activity` chat event of the session (a turn starting or ending). A digest-equal read sends nothing; a hidden tab unsubscribes at once (`sampled: true`). No file watcher: recursive watches on large repos cost more than a 15 s `git status`.
- **Untracked files:** listed with `git ls-files --others --exclude-standard -z` (at most 200, `UNTRACKED_LIMIT`) and diffed one by one with `git diff --no-index … -- /dev/null <path>` (exit code 1 means "differs" and is accepted). Their lines count into +/− when the file is ≤ 256 KB and text.
- **Bounded reading:** a `spawn`ed git whose stdout is read up to the byte limit and then killed (`readBounded`), so a 50 MB lockfile diff never fails the view.
- **Default branch without a remote:** fall back to a local `main`, then `master`; with none, every workspace uses the start-commit / HEAD rule.
- **Workspace ids:** POSIX paths relative to the session toplevel (`""` for it, `.worktrees/feat/x` or `../feat/y` when the session itself runs in a worktree), which is also the batch's path prefix, so the agent can open the files from its own directory.
- **Batch scope:** Send to agent sends every open comment of the session across all workspaces; it first reads the diff of each workspace that holds open comments to re-locate them.
- **Sent marking:** comments are marked "sent in batch N" when the batch was appended to the composer or copied to the clipboard; not when the clipboard also failed and the batch is only shown.
- **Clipboard wording and placement:** a `role="status"` line under the Send button; if the clipboard refuses, a `Modal` shows the batch in a `CodeBlock` with its copy button.
- **Badge:** the existing `.badge` class with the changed-file count; the tab's accessible name includes it.
- **⌘K:** one action **Show changes** / **Änderungen anzeigen** (`action:session-changes`) in `web/app/search-entries.js`, offered while a single session is open; it opens that session's Changes tab.
- **User doc:** a new `docs/diff-review.md` (English) for the Changes tab, comments and batches; plan 3 adds the pipeline part.

---

### Task 1: Bounded git reading, untracked files and the default branch

**Files:**

- Create: `server/features/changes/git-read.js`
- Modify: `server/features/tickets/ticket-worktree.js:106-134` (export the default-branch lookup; the class delegates)
- Test: `tests/integration/changes-git-read.test.js`, `tests/integration/ticket-worktree.test.js` (must stay green)

**Interfaces:**

- Consumes: `gitEnvironment` from `server/features/pipelines/workspace-git.js`.
- Produces:
  - `DIFF_BYTE_LIMIT = 1048576`, `UNTRACKED_LIMIT = 200`
  - `readBounded(cwd: string, args: string[], { limit = DIFF_BYTE_LIMIT, timeout = 30000, okCodes = [0] } = {}) -> Promise<{ text: string, truncated: boolean }>` — throws `problem(serverMessages.pipelineWorkspaces.gitOperationFailed, 409)` on another exit code or timeout; a cut text ends at its last complete line
  - `headCommit(cwd: string) -> Promise<string|null>` (null outside a repository or without commits)
  - `untrackedFiles(cwd: string) -> Promise<{ paths: string[], more: boolean }>`
  - `workspaceDiff(cwd: string, base: string, { limit = DIFF_BYTE_LIMIT } = {}) -> Promise<{ text: string, truncated: boolean }>` — `git -c core.quotePath=false diff --no-ext-diff --no-textconv --no-color --find-renames <base> --`, then each untracked file while room is left; `truncated` also when untracked files were left out
  - `diffStat(cwd: string, base: string) -> Promise<{ files: number, added: number, removed: number }>` (`git diff --numstat -z <base>` plus untracked files)
  - `remoteDefaultBranch(projectRoot: string) -> Promise<string>` exported from `ticket-worktree.js` (same rule and error as the former `#defaultBranch`)

- [ ] **Step 1: Write the failing tests**

```js
// temp repo per test: git init -b main, commit, add origin as a bare clone so
// refs/remotes/origin/HEAD exists (see tests/integration/ticket-worktree.test.js setup)
test("a working-tree diff includes staged, unstaged and untracked changes", async (t) => {
  const repo = await gitRepo(t, { "a.js": "one\n" });
  const base = await headCommit(repo);
  write(repo, "a.js", "two\n");
  write(repo, "new.txt", "hello\n");
  const { text, truncated } = await workspaceDiff(repo, base);
  assert.equal(truncated, false);
  assert.deepEqual(
    parseGitDiff(text).map((f) => [f.path, f.status]),
    [
      ["a.js", "modified"],
      ["new.txt", "added"],
    ],
  );
  assert.deepEqual(await diffStat(repo, base), { files: 2, added: 2, removed: 1 });
});
test("output past the limit is cut at a line and flagged", async (t) => {
  write(repo, "big.txt", "x".repeat(100) + "\n".repeat(30000));
  const { text, truncated } = await workspaceDiff(repo, base, { limit: 64 * 1024 });
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(text) <= 64 * 1024);
  assert.ok(text.endsWith("\n"));
});
test("untracked files are bounded and binaries are marked", async (t) => {
  for (let i = 0; i < 205; i++) write(repo, `out/f${i}.txt`, "a\n");
  write(repo, "img.bin", Buffer.from([0, 1, 2]));
  const listed = await untrackedFiles(repo);
  assert.equal(listed.paths.length, 200);
  assert.equal(listed.more, true);
  assert.equal((await workspaceDiff(repo, base)).truncated, true);
});
test("ignored files and external diff drivers are never used", async (t) => {
  // .gitignore lists dist/; .gitattributes sets "*.js diff=evil" with a config
  // diff.evil.command that would write a marker file
  assert.ok(!text.includes("dist/"));
  assert.equal(fs.existsSync(marker), false);
});
test("the remote default branch follows origin/HEAD, then main, then master", async (t) => {
  assert.equal(await remoteDefaultBranch(repoWithOriginHead("trunk")), "trunk");
  assert.equal(await remoteDefaultBranch(repoWithOnly("master")), "master");
  await assert.rejects(remoteDefaultBranch(repoWithoutRemote()), { status: 409 });
});
test("no repository has no head", async (t) => {
  assert.equal(await headCommit(fs.mkdtempSync(path.join(os.tmpdir(), "plain-"))), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/changes-git-read.test.js`
Expected: FAIL with `Cannot find module .../git-read.js`

- [ ] **Step 3: Implement `git-read.js` and export `remoteDefaultBranch`**

`readBounded` spawns `git` with `gitEnvironment()`, `stdio: ["ignore", "pipe", "ignore"]`, collects chunks up to `limit`, then `kill("SIGTERM")` and resolves with `truncated: true` (the kill's exit code is not an error then). Untracked diffs use `okCodes: [0, 1]` and `--no-index --no-ext-diff --no-textconv --no-color -- /dev/null <path>`; paths come from git and are passed after `--`. Line counting for untracked +/− reads files ≤ 256 KB with `fs.promises.readFile` after an `lstat` that rejects symlinks; a `\0` byte means binary (no lines).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/integration/changes-git-read.test.js tests/integration/ticket-worktree.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/changes/git-read.js server/features/tickets/ticket-worktree.js tests/integration/changes-git-read.test.js
git commit -m "feat: read bounded working-tree diffs with untracked files"
```

---

### Task 2: Record the session start commit

**Files:**

- Modify: `server/features/sessions/session-creation.js:153-185` (record `startCommit`)
- Modify: `server/features/sessions/session-manager.js:254-262` (add `setStartCommit` next to `setInterruption`)
- Test: `tests/integration/session-start-commit.test.js`

**Interfaces:**

- Consumes: `headCommit` (Task 1).
- Produces:
  - Session record fields `startCommit?: string` and `startCommitSource?: "start"|"first-open"` (both absent for login and pipeline sessions and outside a repository)
  - `SessionManager.setStartCommit(id: string, sha: string, source: "first-open") -> Promise<Session>` — serial like `setInterruption`; never overwrites an existing `startCommit`

- [ ] **Step 1: Write the failing tests**

```js
test("a session started in a repository records HEAD", async (t) => {
  const session = await launchFixture(t, { cwd: repo });
  assert.equal(session.startCommit, await headCommit(repo));
  assert.equal(session.startCommitSource, "start");
});
test("login sessions, pipeline sessions and plain folders record nothing", async (t) => {
  for (const options of [
    { purpose: "login" },
    { pipeline: { runId: "r" } },
    { cwd: plainDir },
  ])
    assert.equal((await launchFixture(t, options)).startCommit, undefined);
});
test("a replaced session keeps its start commit", async (t) => {
  // replaceSession (session-replacement.js) after a new commit: startCommit unchanged
});
test("first-open sets a missing start commit once", async (t) => {
  await manager.setStartCommit(legacy.id, "a".repeat(40), "first-open");
  await manager.setStartCommit(legacy.id, "b".repeat(40), "first-open");
  const saved = await manager.get(legacy.id);
  assert.deepEqual(
    [saved.startCommit, saved.startCommitSource],
    ["a".repeat(40), "first-open"],
  );
});
```

(`launchFixture` builds a `SessionManager` on a disposable data directory and isolated tmux socket as the existing session tests do; never the default tmux server.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/session-start-commit.test.js`
Expected: FAIL (`startCommit` undefined)

- [ ] **Step 3: Implement**

In `buildSessionLaunch`, before `manager.save(session)`: when `options.purpose !== "login" && !pipeline`, `const sha = await headCommit(cwd)`; if set, `session.startCommit = sha; session.startCommitSource = "start"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/integration/session-start-commit.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/sessions tests/integration/session-start-commit.test.js
git commit -m "feat: record the commit a session starts on"
```

---

### Task 3: Session workspaces and their diff bases

**Files:**

- Create: `server/features/changes/session-workspaces.js`
- Test: `tests/integration/session-workspaces.test.js`

**Interfaces:**

- Consumes: `remoteDefaultBranch`, `headCommit` (Task 1); `git`, `exactCommit` from `server/features/pipelines/workspace-git.js`.
- Produces:
  - `MAX_WORKSPACES = 50`
  - `Workspace = { id: string, path: string, branch: string|null, head: string|null }` (`path` absolute and real; `branch` without `refs/heads/`, null when detached)
  - `listWorkspaces(sessionDir: string) -> Promise<{ root: string, workspaces: Workspace[] }|null>` — null when `sessionDir` is no repository; the session toplevel first, then the `.worktrees/` worktrees by id
  - `DefaultBranch = { name: string, ref: string }`
  - `resolveDefaultBranch(root: string) -> Promise<DefaultBranch|null>` (`refs/remotes/origin/<name>`, else `refs/heads/main|master`, else null)
  - `Base = { kind: "merge-base"|"start-commit"|"head", sha: string, ref?: string }`
  - `workspaceBase(workspace: Workspace, { isSessionDir: boolean, defaultBranch: DefaultBranch|null, startCommit: string|null }) -> Promise<Base>`

- [ ] **Step 1: Write the failing tests**

```js
test("the session directory and .worktrees/ worktrees are listed, nothing else", async (t) => {
  // main repo + git worktree add .worktrees/feat/x, .agentpier-worktrees/run1, ../outside
  const { workspaces } = await listWorkspaces(repo);
  assert.deepEqual(
    workspaces.map((w) => [w.id, w.branch]),
    [
      ["", "main"],
      [".worktrees/feat/x", "feat/x"],
    ],
  );
});
test("a session inside a worktree lists its siblings relative to itself", async (t) => {
  const { workspaces } = await listWorkspaces(path.join(repo, ".worktrees/feat/x"));
  assert.deepEqual(
    workspaces.map((w) => w.id),
    ["", "../feat/y"],
  );
});
test("a subfolder session uses its repository toplevel", async (t) => {
  assert.equal(
    (await listWorkspaces(path.join(repo, "server"))).root,
    await fs.realpath(repo),
  );
});
test("bases: feature branch → merge-base, default or detached → start commit or HEAD", async (t) => {
  const defaultBranch = await resolveDefaultBranch(repo);
  assert.deepEqual(defaultBranch, { name: "main", ref: "refs/remotes/origin/main" });
  assert.equal(
    (
      await workspaceBase(feature, {
        isSessionDir: false,
        defaultBranch,
        startCommit: null,
      })
    ).kind,
    "merge-base",
  );
  assert.deepEqual(
    await workspaceBase(sessionOnMain, {
      isSessionDir: true,
      defaultBranch,
      startCommit: start,
    }),
    { kind: "start-commit", sha: start },
  );
  assert.equal(
    (
      await workspaceBase(detachedWorktree, {
        isSessionDir: false,
        defaultBranch,
        startCommit: start,
      })
    ).kind,
    "head",
  );
  assert.equal(
    (
      await workspaceBase(sessionOnFeature, {
        isSessionDir: true,
        defaultBranch,
        startCommit: start,
      })
    ).kind,
    "merge-base",
  );
});
test("a lost start commit falls back to HEAD; no remote falls back to local main", async (t) => {
  assert.equal(
    (
      await workspaceBase(sessionOnMain, {
        isSessionDir: true,
        defaultBranch,
        startCommit: "f".repeat(40),
      })
    ).kind,
    "head",
  );
  assert.deepEqual(await resolveDefaultBranch(localOnly), {
    name: "main",
    ref: "refs/heads/main",
  });
});
test("a plain folder is no repository; more than 50 worktrees are cut", async (t) => {
  assert.equal(await listWorkspaces(plainDir), null);
  assert.equal((await listWorkspaces(repoWith60Worktrees)).workspaces.length, 50);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/session-workspaces.test.js`
Expected: FAIL with `Cannot find module`

- [ ] **Step 3: Implement**

The main root is the parent of `git rev-parse --path-format=absolute --git-common-dir`; worktrees come from `git worktree list --porcelain -z`; an entry is kept when its real path is the session toplevel or lies under `<main root>/.worktrees/`. Ids use `path.relative(sessionToplevel, workspacePath)` in POSIX form. A worktree whose real path differs from the listed path (a link swapped in) is dropped.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/integration/session-workspaces.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/features/changes/session-workspaces.js tests/integration/session-workspaces.test.js
git commit -m "feat: list a session's workspaces with their diff bases"
```

---

### Task 4: Changes service, routes and the `session.changes` topic

**Files:**

- Create: `server/features/changes/session-changes.js`
- Create: `server/features/changes/changes-topic.js`
- Create: `server/http/routes/session-changes.js`
- Modify: `server/app.js` (`services.sessionChanges = new SessionChanges({ sessions: services.sessions })`; mount the router)
- Modify: `server/application/live-wiring.js` (define the topic)
- Modify: `web/lib/live/live-topics.js` (`"session.changes"`: path `/sessions/:id/changes`, interval 15000, `sampled: true`)
- Modify: `server/lib/i18n/{de,en}/changes.js` (`notARepository`, `unknownWorkspace`)
- Modify: `docs/architecture.md` (Topics: `session.changes:<id>`; Hidden tabs: add it to the sampled list; the 15 s sample and the native-activity read)
- Test: `tests/integration/session-changes-routes.test.js`, `tests/unit/live-topics.test.js` (extend)

**Interfaces:**

- Consumes: `listWorkspaces`, `resolveDefaultBranch`, `workspaceBase` (Task 3); `workspaceDiff`, `diffStat` (Task 1); `parseGitDiff` (plan 1); `SessionManager.get`, `setStartCommit` (Task 2); `SESSION_PARAM`.
- Produces:
  - `class SessionChanges { constructor({ sessions }) }`
    - `summary(sessionId) -> Promise<ChangesSummary>`
    - `diff(sessionId, workspaceId: string) -> Promise<WorkspaceDiff>`
  - `ChangesSummary = { repository: boolean, startCommit: { sha: string, source: "start"|"first-open" }|null, workspaces: { id, branch, base: Base, files, added, removed }[], changedFiles: number }` — workspaces with `files > 0` first, then by id; `changedFiles` sums the listed workspaces
  - `WorkspaceDiff = { workspace: string, base: Base, files: DiffFile[], truncated: boolean }`
  - Routes: `GET /sessions/:id/changes` → `ChangesSummary`; `GET /sessions/:id/changes/diff?workspace=<id>` → `WorkspaceDiff` (400 for a non-string workspace, 404 `unknownWorkspace` for an id not listed now)
  - `CHANGES_SAMPLE_MS = 15000`; `sessionChangesTopic(services, { sampleMs = CHANGES_SAMPLE_MS } = {})` (`name: "session.changes"`, `mode: "state"`, owner-only, `read` = `summary`, `watch` nudges on `native-activity` events of `services.chatEvents` for the session, like `sessionReloadTopic`)

- [ ] **Step 1: Write the failing tests**

```js
test("the summary lists workspaces, bases and counts; changed ones first", async (t) => {
  const body = (await get("/api/sessions/s1/changes")).body;
  assert.equal(body.repository, true);
  assert.deepEqual(
    body.workspaces.map((w) => [w.id, w.base.kind, w.files]),
    [
      [".worktrees/feat/x", "merge-base", 2],
      ["", "start-commit", 0],
    ],
  );
  assert.equal(body.changedFiles, 2);
});
test("a legacy session gets its start commit at first open", async (t) => {
  const body = (await get("/api/sessions/legacy/changes")).body;
  assert.equal(body.startCommit.source, "first-open");
  assert.equal((await sessions.get("legacy")).startCommit, body.startCommit.sha);
});
test("the diff of one workspace is parsed, bounded and read-only", async (t) => {
  const body = (
    await get("/api/sessions/s1/changes/diff?workspace=.worktrees%2Ffeat%2Fx")
  ).body;
  assert.deepEqual(
    body.files.map((f) => f.path),
    ["server/a.js", "notes.md"],
  );
  assert.equal(body.truncated, false);
  assert.equal(await gitStatus(worktree), statusBefore); // nothing staged or written
});
test("workspaces are never paths", async (t) => {
  for (const workspace of ["../outside", "/etc", ".agentpier-worktrees/run1", "%00"])
    assert.equal(
      (
        await get(
          `/api/sessions/s1/changes/diff?workspace=${encodeURIComponent(workspace)}`,
        )
      ).status,
      404,
    );
});
test("a vanished worktree is unknown", async (t) => {
  await git(repo, ["worktree", "remove", "--force", worktree]);
  assert.equal(
    (await get("/api/sessions/s1/changes/diff?workspace=.worktrees%2Ffeat%2Fx")).status,
    404,
  );
});
test("a plain folder has no workspaces", async (t) => {
  assert.deepEqual((await get("/api/sessions/plain/changes")).body, {
    repository: false,
    startCommit: null,
    workspaces: [],
    changedFiles: 0,
  });
});
test("the topic samples, reads at native activity and equals the route", async (t) => {
  // LiveHub + sessionChangesTopic with sampleMs from manualTimers; a file write is
  // seen after one sample; a native-activity event nudges an immediate read
});
// tests/unit/live-topics.test.js
test("the changes topic names its route and is sampled", () => {
  assert.equal(topicInfo("session.changes:s1").path, "/sessions/s1/changes");
  assert.equal(liveTopics["session.changes"].sampled, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/session-changes-routes.test.js tests/unit/live-topics.test.js`
Expected: FAIL (modules missing)

- [ ] **Step 3: Implement the service, routes and topic**

`diff()` lists the workspaces again and looks the id up in that list (the only way to a path); it never joins a client string onto a path. `summary()` runs `diffStat` for all workspaces with `Promise.all`, at most 4 at a time.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/integration/session-changes-routes.test.js tests/unit/live-topics.test.js tests/unit/route-access.test.js`
Expected: PASS
Run: `npm run i18n:confirm -- changes` (review the pairs)

- [ ] **Step 5: Commit**

```bash
git add server tests web/lib/live/live-topics.js docs/architecture.md
git commit -m "feat: serve and push a session's working-tree changes"
```

---

### Task 5: The Changes tab

**Files:**

- Create: `web/features/sessions/SessionChanges.jsx`
- Create: `web/features/sessions/useSessionChanges.js`
- Create: `web/features/sessions/session-changes.css`
- Modify: `web/app/routes.js:205-214, 364` (`/sessions/:id/changes`, mode `"changes"`)
- Modify: `web/app/session-view-memory.js:4` (`modes` gets `"changes"`; `preferred` stays reader/terminal)
- Modify: `web/app/useWorkspaceNavigation.js:270` (shell sessions may open `"changes"`)
- Modify: `web/features/views/split-tree.js:7`, `web/features/views/click-rule.js:45-48`, `server/features/views/view-layout.js:26` (tab `"changes"`)
- Modify: `web/features/sessions/SessionPaneHeader.jsx:104-112` and `web/features/sessions/SessionWorkspace.jsx:232-262, 278-283` (fourth tab with badge; lazy `SessionChanges`)
- Modify: `web/lib/i18n/{de,en}/sessions.js` (`sessionWorkspaceCopy.changesTab`: "Changes" / "Änderungen", and the keys below)
- Test: `tests/unit/routes.test.js`, `tests/unit/session-view-memory.test.js`, `tests/unit/split-tree.test.js`, `tests/unit/click-rule.test.js`, `tests/unit/view-store.test.js` (extend)

**Interfaces:**

- Consumes: `ChangesSummary`, `WorkspaceDiff`, routes (Task 4); `DiffReview` (plan 1); `useReviewComments({ kind: "session", id })` (plan 1); `fileLanguage` from `web/features/chat/tool-output.js`.
- Produces:
  - `useSessionChanges(sessionId: string|null) -> { summary: ChangesSummary|null, loading, error }` (follows `session.changes:<id>`)
  - `SessionChanges({ session, active: boolean, onSend: (result) => void })` — renders only while `active`; picker (`AnchoredSelect`) of workspaces labelled `"<id or session directory> · <branch> · +a −r"`; a base line ("Since the branch point with main", "Since the session started", "Since this tab was first opened — the session started before changes were recorded", "Uncommitted changes only"); `truncated` note; `DiffReview` with the workspace's comments; the Send area of Task 6 as `toolbar`
  - Tab badge: `.badge` with `summary.changedFiles` when > 0; accessible name `copy.changesTabCount(n)`
  - Diff loading: `GET /sessions/:id/changes/diff?workspace=` when the tab opens, when the picked workspace changes and when the summary's entry for it changes (base sha, files, added or removed) — push-driven, no timer; a 404 re-reads the summary and falls back to the first workspace

- [ ] **Step 1: Write the failing unit tests**

```js
test("the changes tab has its own address", () => {
  assert.deepEqual(read("/sessions/demo/changes"), {
    view: "workspace",
    sessionId: "demo",
    mode: "changes",
  });
  assert.equal(
    routePath({ view: "workspace", sessionId: "demo", mode: "changes" }),
    "/sessions/demo/changes",
  );
});
test("the changes tab is remembered but never becomes the preferred view", () => {
  memory.remember(codingSession, "changes");
  assert.equal(memory.mode(codingSession, false), "changes");
  assert.equal(memory.mode(otherSession, false), defaultFor(otherSession));
});
test("a pane may show the changes tab and saved views keep it", () => {
  assert.equal(setTab(layout, key, "changes") !== layout, true);
  assert.equal(tabOfMode("changes"), "changes");
  // view-store.test.js: a saved layout with tab "changes" passes view-layout.js validation
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/routes.test.js tests/unit/session-view-memory.test.js tests/unit/split-tree.test.js tests/unit/click-rule.test.js tests/unit/view-store.test.js`
Expected: FAIL on the new cases

- [ ] **Step 3: Implement the mode, the tab and `SessionChanges`**

The tab is closed by default: no route lands on `"changes"` unless the owner picks it (the default mode logic is unchanged). `SessionWorkspace` mounts `SessionChanges` lazily only while `mode === "changes"`.

- [ ] **Step 4: Run tests, lint and structure**

Run: `node --test tests/unit/routes.test.js tests/unit/session-view-memory.test.js tests/unit/split-tree.test.js tests/unit/click-rule.test.js tests/unit/view-store.test.js tests/unit/ui-guide-rules.test.js`
Expected: PASS
Run: `npm run i18n:confirm -- sessions && npm run lint && npm run check:structure`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add web server/features/views tests/unit
git commit -m "feat: add a Changes tab to sessions"
```

---

### Task 6: Send to agent

**Files:**

- Create: `web/features/chat/composer-registry.js`
- Create: `web/features/sessions/changes-send.js`
- Create: `web/features/sessions/ChangesSend.jsx`
- Modify: `web/features/chat/chat-draft-reuse.js` (export `appendedDraftText`; `reusedDraft` uses it)
- Modify: `web/features/chat/useChatDelivery.js` (register the draft while mounted)
- Modify: `web/features/sessions/SessionWorkspace.jsx` (`onSend` switches to `"reader"` after an append)
- Modify: `web/lib/i18n/{de,en}/sessions.js`
- Test: `tests/unit/composer-registry.test.js`, `tests/unit/changes-send.test.js`, `tests/browser/session-changes.spec.js`

**Interfaces:**

- Consumes: `reviewEntries`, `formatReviewBatch` (plan 1); `useReviewComments().markSent` (plan 1); `writeClipboard` (`web/lib/clipboard.js`); `deliveryScope` (`chat-draft.js`); `Modal`, `CodeBlock`.
- Produces:
  - `appendedDraftText(current: string, text: string) -> string` (`current.trim() ? \`${current}\n${text}\` : text`)
  - `MAX_CHAT_TEXT = 32000`
  - `registerComposer(scope: string, draft: ChatDraft) -> () => void`
  - `appendToComposer(scope: string, text: string) -> Promise<"appended"|"locked"|"missing"|"too-long">` — `"locked"` when the draft has an outbox or is unreadable; `"too-long"` when `appendedDraftText(...).length > MAX_CHAT_TEXT`; otherwise `draft.change({ text })`
  - `sessionBatch(comments: Comment[], diffs: Map<string, DiffFile[]>) -> { text: string, ids: string[] }`
  - `sendBatch({ session, comments, readDiff: (workspaceId) => Promise<DiffFile[]|null>, markSent, clipboard = writeClipboard }) -> Promise<{ outcome: "appended"|"copied"|"shown"|"too-long"|"empty", batch?: number, text?: string, reason?: "locked"|"no-chat" }>`
  - `ChangesSend({ session, comments, onSend })` — "Send to agent (n)" (`.button.primary`, disabled at 0 open comments) and the status line or Modal

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/composer-registry.test.js (ChatDraft on an in-memory storage + lock)
test("a blank draft is replaced, a written one gets a new line", async () => {
  assert.equal(appendedDraftText("  ", "batch"), "batch");
  assert.equal(appendedDraftText("note", "batch"), "note\nbatch");
  registerComposer("scope", draft);
  await draft.change({ text: "note" });
  assert.equal(await appendToComposer("scope", "batch"), "appended");
  assert.equal(draft.getSnapshot().text, "note\nbatch");
});
test("a pending outbox locks the draft; an unknown scope is missing", async () => {
  await draft.enqueue("m1", [], {});
  assert.equal(await appendToComposer("scope", "batch"), "locked");
  assert.equal(await appendToComposer("other", "batch"), "missing");
});
test("an over-long batch is refused", async () => {
  await draft.change({ text: "x".repeat(31990) });
  assert.equal(await appendToComposer("scope", "y".repeat(20)), "too-long");
  assert.equal(draft.getSnapshot().text.length, 31990);
});
// tests/unit/changes-send.test.js
test("the batch spans workspaces and marks what was sent", async () => {
  const result = await sendBatch({ session, comments: [inWorktree, inSessionDir, resolved], readDiff, markSent, clipboard });
  assert.equal(result.outcome, "appended");
  assert.match(composerText(), /^Review notes \(2\):[\s\S]*1\. server\/b\.js:3[\s\S]*2\. \.worktrees\/feat\/x\/server\/a\.js:41/);
  assert.deepEqual(marked, [[inSessionDir.id, inWorktree.id]]);
});
test("shell sessions and locked drafts copy; a refused clipboard shows the text", async () => {
  assert.deepEqual(pick(await sendBatch({ session: shell, … })), { outcome: "copied", reason: "no-chat" });
  assert.equal((await sendBatch({ session: locked, clipboard: async () => false, … })).outcome, "shown");
  assert.equal(marked.length, 1); // only the copied one
});
```

```js
// tests/browser/session-changes.spec.js (live stub "rest"; page.route mocks for
// /api/sessions/s1/changes, /changes/diff, /review-comments)
test("comment, send to agent, land in the composer", async ({ page }) => {
  await page.goto("/sessions/s1/changes");
  await expect(
    page.getByRole("button", { name: /Changes, 2 changed files/ }),
  ).toBeVisible();
  // pick a row, comment, Send to agent (1)
  await expect(page).toHaveURL(/\/sessions\/s1\/chat$/);
  await expect(page.getByRole("textbox", { name: /message/i })).toHaveValue(
    /Review notes \(1\):/,
  );
});
test("the tab is closed by default", async ({ page }) => {
  await page.goto("/sessions/s1");
  await expect(page).not.toHaveURL(/changes/);
});
test("a terminal-only session copies the batch", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await expect(page.getByRole("status")).toHaveText(/clipboard/);
});
test("phone: picker, rows and send fit 390 px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
```

- [ ] **Step 2: Run unit tests to verify they fail**

Run: `node --test tests/unit/composer-registry.test.js tests/unit/changes-send.test.js`
Expected: FAIL with `Cannot find module`

- [ ] **Step 3: Implement the registry, the send flow and the button**

`useChatDelivery` calls `registerComposer(scope, draft)` in an effect keyed on `draft` and unregisters on cleanup. The Changes tab looks the session's composer up with `deliveryScope(session)`; a session with `tool === "shell"` or `purpose === "login"` goes straight to the clipboard (`reason: "no-chat"`). Copy (EN; DE in the catalog): `sendToAgent: (n) => \`Send to agent (${n})\``, `copiedLocked: "The chat is still delivering a message, so the review notes were copied to the clipboard instead."`, `copiedNoChat: "This session has no chat. The review notes were copied to the clipboard."`, `batchTooLong: "The review notes and the current draft are longer than 32,000 characters. Resolve some comments or send the draft first."`, `showBatchTitle: "Review notes"`.

- [ ] **Step 4: Run all tests of the task**

Run: `node --test tests/unit/composer-registry.test.js tests/unit/changes-send.test.js tests/unit/chat-delivery-reason.test.js`
Expected: PASS
Run: `npm run build && npx playwright test tests/browser/session-changes.spec.js tests/browser/chat-code-diffs.spec.js`
Expected: PASS
Run: `npm run i18n:confirm -- sessions`

- [ ] **Step 5: Commit**

```bash
git add web tests
git commit -m "feat: send open review comments to the session's composer"
```

---

### Task 7: ⌘K entry, docs and PR cleanup

**Files:**

- Modify: `web/app/search-entries.js:439-511` (action `session-changes`, `sessionOnly: true`; `buildSearchIndex({ …, sessionOpen = false })` drops `sessionOnly` entries when false)
- Modify: `web/app/SearchDialog.jsx` (pass `sessionOpen`), `web/app/AppSearch.jsx:80-110` (pass `sessionOpen={route?.view === "workspace" && Boolean(route.sessionId)}`; handle `target.action === "session-changes"` with `navigate({ ...route, mode: "changes" })`)
- Modify: `web/lib/i18n/{de,en}/search.js` (`actions.showChanges`: "Show changes" / "Änderungen anzeigen"; aliases `diffReview`: "Diff" / "Diff", "Review changes" / "Änderungen prüfen")
- Modify: `tests/unit/search-index.test.js`, `tests/unit/quick-open.test.js`
- Create: `docs/diff-review.md` (Changes tab: workspaces, bases, start commit and first-open fallback, comments and their states, Send to agent, clipboard fallback, limits)
- Modify: `docs/views.md:16, 44` (tabs: terminal, chat, files or changes), `README.md:22` and `README.de.md:24` (one clause on the Changes tab in the sessions bullet, linking `docs/diff-review.md`), `docs/README.md` (index entry if it lists guides)

**Interfaces:**

- Consumes: the `"changes"` mode (Task 5).
- Produces: search entry `{ id: "action:session-changes", group: "actions", target: { action: "session-changes" }, sessionOnly: true }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/search-index.test.js
test("Show changes opens the open session's Changes tab and only then", () => {
  const withSession = buildSearchIndex({ agentsEnabled: true, sessionOpen: true });
  const hit = searchIn(withSession, "Änderungen anzeigen").find(
    (i) => i.group === "actions",
  );
  assert.deepEqual(hit.target, { action: "session-changes" });
  assert.ok(searchIn(withSession, "diff").some((i) => i.id === "action:session-changes"));
  assert.ok(
    !buildSearchIndex({ agentsEnabled: true }).some(
      (i) => i.id === "action:session-changes",
    ),
  );
});
// tests/unit/quick-open.test.js
test("Show changes is an owner action only, not in the user's search", () => {
  assert.ok(!userIndex().some((i) => i.id === "action:session-changes"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/search-index.test.js tests/unit/quick-open.test.js`
Expected: FAIL on the new cases

- [ ] **Step 3: Implement the entry and write the docs**

- [ ] **Step 4: Full checks for the PR**

Run: `npm run i18n:confirm -- search` (review the pairs), then `npm run lint && npm run format:check && npm run check:structure && npm test`
Expected: all green
Run: `npm run build && npx playwright test tests/browser/session-changes.spec.js tests/browser/split-views-page.spec.js`
Expected: PASS

- [ ] **Step 5: Commit and clean up before PR 2**

```bash
git rm docs/superpowers/plans/2026-11-04-diff-annotations-2-sessions.md
git add web docs README.md README.de.md tests
git commit -m "feat: find a session's changes from the search"
```

The spec and plan 3 stay (unfinished work of AGENTPIER-222). PR description lists the docs checked: `docs/diff-review.md` (new), `docs/architecture.md`, `docs/views.md`, `README.md`, `README.de.md`.

## Carried rulings from PR 1 (binding)

- Every server `git diff` call passes `-c core.quotePath=false --src-prefix=a/ --dst-prefix=b/` together with `--no-ext-diff --no-textconv --no-color`, so user git config cannot break the parser's `a/`/`b/` assumption.
- Import `fileLanguage` from `web/components/diff/file-language.js`, not from `web/features/chat/tool-output.js`.
- Fix the double save in `web/components/diff/DiffFile.jsx`: when the files refresh during an in-flight save, the editor remounts and loses its `busy` flag. Keep `busy` in a ref, like the draft text, and add a test.
- Add the `DiffFile` and `Row` JSDoc typedefs to `server/features/changes/diff-parse.js` when the session routes first return files.
- The hook's write functions come from `writesOf()` in `web/features/review/review-comment-requests.js`; they are stable and reject when the scope is null.
