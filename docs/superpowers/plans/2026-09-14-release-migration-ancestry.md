# Release Migration Ancestry Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-maintained denylist in the release process classifier with process ancestry, reload only sessions that still hold an old release after an activation, close the remaining test gaps, and link the activation checkbox to its help text.

**Architecture:** `releaseProcesses()` adds `pid` and `ppid` columns to its `ps` call. `releaseSessionReferences` parses them, identifies session launcher processes, and classifies every other release-referencing process as a helper when it descends from a launcher, node-only when it only uses the release's Node binary without descending from a launcher, and unidentified otherwise. `awaitReferences` waits its bounded budget for any remaining reference before failing. `resumeAfterActivation` limits reloads to sessions listed in `cleanupStatus()` for non-active releases.

**Tech Stack:** Node 22+ ESM, `node:test`, Playwright, React 18.

**Spec:** `docs/superpowers/specs/2026-09-13-release-session-migration-design.md` (section 1 is amended in Task 1 of this plan).

## Global Constraints

- Work only inside the worktree `/Users/d.kaulig/Projects/agent-pier/.claude/worktrees/release-session-migration`; never `cd` to the parent repository.
- Every source and test file at or below 600 lines (`npm run check:structure`).
- `ps` output lines now start with `<pid> <ppid> ` (`ps -ww -u <uid> -o pid=,ppid=,comm=,command=`). Fixture lines in every test must carry those two columns; a line without them is classified as if it had no ancestry.
- Run `npx prettier --write` and `npx eslint` on every touched JS/JSX file; `npx prettier --write` on touched markdown.
- Commit messages end with exactly:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_011Saz1VDpLYk54p96dku1sj
  ```

---

### Task 1: Ancestry-based classification

**Files:**

- Modify: `server/features/operations/release-references.js`
- Modify: `server/features/operations/release-cleanup.js` (`releaseProcessReferences`, `releaseProcesses`)
- Modify: `tests/integration/release-references.test.js`
- Modify: `tests/integration/release-cleanup.test.js` (fixture lines in the two tests that use process lines)
- Modify: `tests/integration/release-session-migration.test.js` (fixture lines: launcher lines and every `extra.push`)
- Modify: `docs/superpowers/specs/2026-09-13-release-session-migration-design.md` (section 1)

**Interfaces:**

- Produces: `releaseSessionReferences(output, releasePaths) → { sessionIds, helpers, helperReferences, nodeOnly, unidentified }` (same shape as today). Input lines are `<pid> <ppid> <comm> <command…>`; `releaseProcessReferences` keeps the pid/ppid prefix when collapsing tmux lines.

- [ ] **Step 1: Rewrite the classifier tests**

Replace the content of `tests/integration/release-references.test.js` with:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { releaseSessionReferences } from "../../server/features/operations/release-references.js";

const release = "/opt/agentpier/releases/1.0.0";
const other = "/opt/agentpier/releases/1.1.0";
const data = "/Users/me/Library/Application Support/AgentPier/data";
const id = "6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c";
const second = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const proc = (pid, ppid, command) =>
  `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${command}`;
const launcher = (pid, ppid, session, root = release) =>
  proc(
    pid,
    ppid,
    `${root}/bin/node ${root}/bin/node ${root}/server/terminal-launcher.js ${data}/sessions/${session}.launch.json`,
  );

test("launcher lines map to session ids with and without shell quoting", () => {
  const output = [
    launcher(100, 50, id),
    proc(
      101,
      50,
      `sh sh -c '${release}/bin/node' '${release}/server/terminal-launcher.js' '${data}/sessions/${second}.launch.json'`,
    ),
    launcher(102, 50, second, other),
  ].join("\n");
  assert.deepEqual(releaseSessionReferences(output, [release]), {
    sessionIds: [id, second],
    helpers: 0,
    helperReferences: [],
    nodeOnly: 0,
    unidentified: [],
  });
});

test("descendants of a session launcher are helpers whatever they run", () => {
  const output = [
    launcher(100, 50, id),
    proc(200, 100, `claude claude --plugin-dir ${data}/plugins/x`),
    proc(
      300,
      200,
      `node ${release}/bin/node ${release}/vendor/agentbus/agentpier/mcp.js`,
    ),
    proc(
      301,
      200,
      `node ${release}/bin/node ${release}/server/features/memory/memory-mcp.js --data-dir "${data}" --session ${id}`,
    ),
    proc(302, 200, `node ${release}/bin/node /Users/me/project/node_modules/.bin/vite`),
    proc(400, 302, `node ${release}/bin/node /Users/me/project/worker.js`),
    proc(
      101,
      50,
      `codex codex -c mcp_servers.agentpier_session={command="${release}/bin/node",args=["${release}/server/features/mcp/session-stdio.js","--socket","/tmp/x.sock","--capability","SECRET-TOKEN"]}`,
    ),
  ].join("\n");
  const result = releaseSessionReferences(output, [release]);
  assert.deepEqual(result, {
    sessionIds: [id],
    helpers: 4,
    helperReferences: [
      { reference: "vendor/agentbus/agentpier/mcp.js" },
      { reference: "server/features/memory/memory-mcp.js" },
      { reference: "bin/node" },
      { reference: "bin/node" },
    ],
    nodeOnly: 0,
    unidentified: [{ reference: "server/features/mcp/session-stdio.js" }],
  });
  assert.ok(!JSON.stringify(result).includes("SECRET-TOKEN"));
});

test("processes outside any session are node-only or unidentified", () => {
  const output = [
    launcher(100, 50, id),
    proc(500, 1, `node ${release}/bin/node /Users/me/tool.js`),
    proc(
      501,
      1,
      `node ${release}/bin/node ${release}/server/features/pipelines/verify-supervisor.js /tmp/run`,
    ),
    proc(
      502,
      7,
      `node ${release}/bin/node ${release}/server/features/operations/release-helper.js /tmp/req.json`,
    ),
    proc(503, 1, `node ${release}/bin/node ${release}/server/index.js`),
    proc(504, 1, `node ${release}/bin/node ${release}/server/terminal-launcher.js`),
    proc(505, 1, `bash bash -lc 'echo ${release}/README.md'`),
    proc(506, 1, `node ${release}/bin/node ${release}/vendor/agentbus/agentpier/mcp.js`),
  ].join("\n");
  assert.deepEqual(releaseSessionReferences(output, [release]), {
    sessionIds: [id],
    helpers: 0,
    helperReferences: [],
    nodeOnly: 1,
    unidentified: [
      { reference: "server/features/pipelines/verify-supervisor.js" },
      { reference: "server/features/operations/release-helper.js" },
      { reference: "server/index.js" },
      { reference: "server/terminal-launcher.js" },
      { reference: "README.md" },
      { reference: "vendor/agentbus/agentpier/mcp.js" },
    ],
  });
});

test("ancestry survives parent cycles and lines without pid columns have no ancestry", () => {
  const output = [
    launcher(100, 50, id),
    proc(600, 601, `node ${release}/bin/node ${release}/server/a.js`),
    proc(601, 600, `node ${release}/bin/node ${release}/server/b.js`),
    `node ${release}/bin/node ${release}/server/c.js`,
  ].join("\n");
  assert.deepEqual(releaseSessionReferences(output, [release]).unidentified, [
    { reference: "server/a.js" },
    { reference: "server/b.js" },
    { reference: "server/c.js" },
  ]);
});

test("duplicate session ids across realpath and symlinked release paths collapse and empty inputs are inert", () => {
  const link = "/opt/agentpier-link/releases/1.0.0";
  assert.deepEqual(
    releaseSessionReferences(launcher(100, 50, id, link), [release, link]).sessionIds,
    [id],
  );
  const empty = {
    sessionIds: [],
    helpers: 0,
    helperReferences: [],
    nodeOnly: 0,
    unidentified: [],
  };
  assert.deepEqual(releaseSessionReferences("", [release]), empty);
  assert.deepEqual(releaseSessionReferences(launcher(100, 50, id), []), empty);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test tests/integration/release-references.test.js`
Expected: FAIL (helpers counted by path, launcher lines with pid columns still match, but descendant/unidentified expectations differ).

- [ ] **Step 3: Rewrite the classifier**

Replace the content of `server/features/operations/release-references.js` with:

```js
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const launcher = new RegExp(
  `terminal-launcher\\.js'?\\s+'?.*?sessions/(${uuid})\\.launch\\.json'?`,
  "i",
);
const columns = /^\s*(\d+)\s+(\d+)\s+(.*)$/;
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Classify every process that references one of the release directories.
 * Lines are `<pid> <ppid> <comm> <command…>`; a process is session-owned when it
 * descends from a session's terminal launcher, whatever it runs.
 */
export function releaseSessionReferences(output, releasePaths) {
  const result = {
    sessionIds: [],
    helpers: 0,
    helperReferences: [],
    nodeOnly: 0,
    unidentified: [],
  };
  if (!releasePaths.length) return result;
  const prefixes = releasePaths.map((value) => value.replace(/\/+$/, "") + "/");
  const pattern = new RegExp(`(?:${prefixes.map(escape).join("|")})([^\\s'"\\\\]*)`, "g");
  const parents = new Map();
  const launchers = new Set();
  const candidates = [];
  for (const line of output.split("\n")) {
    const match = columns.exec(line);
    const pid = match ? match[1] : null;
    const command = match ? match[3] : line;
    if (match) parents.set(pid, match[2]);
    const references = [...command.matchAll(pattern)].map((item) => item[1]);
    if (!references.length) continue;
    const session = launcher.exec(command);
    if (session && references.includes("server/terminal-launcher.js")) {
      const id = session[1].toLowerCase();
      if (!result.sessionIds.includes(id)) result.sessionIds.push(id);
      if (pid !== null) launchers.add(pid);
      continue;
    }
    candidates.push({ pid, references });
  }
  const descendsFromLauncher = (pid) => {
    const seen = new Set();
    for (let cursor = pid; cursor !== null && !seen.has(cursor);) {
      seen.add(cursor);
      const parent = parents.get(cursor);
      if (parent === undefined) return false;
      if (launchers.has(parent)) return true;
      cursor = parent;
    }
    return false;
  };
  for (const { pid, references } of candidates) {
    const rest = references.filter((reference) => reference !== "bin/node");
    if (pid !== null && descendsFromLauncher(pid)) {
      result.helpers += 1;
      result.helperReferences.push({ reference: rest[0] || "bin/node" });
    } else if (!rest.length) result.nodeOnly += 1;
    else result.unidentified.push({ reference: rest[0] });
  }
  return result;
}
```

- [ ] **Step 4: Add pid/ppid columns to `ps` and keep them when collapsing tmux lines**

In `server/features/operations/release-cleanup.js` replace `releaseProcessReferences` and `releaseProcesses` with:

```js
export function releaseProcessReferences(output) {
  return output
    .split("\n")
    .map((line) => {
      // tmux keeps the first client's launch command in its process title for its
      // entire lifetime. Only its executable is a live dependency, not those old args.
      const tmux = /^(\s*\d+\s+\d+\s+)?((?:\S*\/)?tmux)\s+/.exec(line);
      return tmux ? `${tmux[1] || ""}${tmux[2]}` : line;
    })
    .join("\n");
}
export function releaseProcesses() {
  return releaseProcessReferences(
    execFileSync(
      "ps",
      ["-ww", "-u", String(process.getuid()), "-o", "pid=,ppid=,comm=,command="],
      { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
    ),
  );
}
```

- [ ] **Step 5: Give the cleanup and migration fixtures pid columns**

In `tests/integration/release-cleanup.test.js`:

- In the test "bulk cleanup rechecks every version …" the line
  `${r.installRoot}/releases/1.1.0/bin/node ${r.installRoot}/releases/1.1.0/server/terminal-launcher.js` becomes ` 100     1` + that text (any pid/ppid works; the test only checks `inUse`).
- In the test "a tmux server's historical startup arguments …" prefix each line with ` 100     1` (keep the `releaseProcessReferences(...)` wrapper); add one assertion that `releaseProcessReferences("  100     1 tmux tmux new-session '/x/releases/1.0.0/bin/node'")` equals `"  100     1 tmux"`.
- In the test "cleanup state lists the sessions and process classes holding each version" build the lines as:
  ```js
  `  100     1 ${old}/bin/node ${old}/bin/node ${old}/server/terminal-launcher.js ${r.dataDir}/sessions/${id}.launch.json`,
  `  200   100 claude claude`,
  `  300   200 node ${old}/bin/node ${old}/vendor/agentbus/agentpier/mcp.js`,
  `  500     1 node ${old}/bin/node /Users/me/tool.js`,
  `  501     1 node ${old}/bin/node ${old}/server/features/pipelines/verify-supervisor.js`,
  ```
  Expectations stay: `sessionIds [id]`, `nodeOnlyProcesses 1`, `helperProcesses [{ reference: "vendor/agentbus/agentpier/mcp.js" }]`, `unidentifiedProcesses [{ reference: "server/features/pipelines/verify-supervisor.js" }]`.

In `tests/integration/release-session-migration.test.js` `fixture()`: number launcher lines with `pid = 100 + index`, `ppid = 1`:

```js
sessions.forEach((session, index) => {
  if (session.holdsRelease !== false)
    lines.set(
      session.id,
      `${100 + index}     1 ${old}/bin/node ${old}/bin/node ${old}/server/terminal-launcher.js ${dataDir}/sessions/${session.id}.launch.json`,
    );
});
```

Expose `f.launcherPid = (id) => 100 + sessions.findIndex((s) => s.id === id)`. Update every `f.extra.push(...)`:

- plan test: `f.extra.push(\` 500 1 node ${f.old}/bin/node /Users/me/tool.js\`)` (stays node-only) and `f.extra.push(\`  501     1 node ${f.old}/bin/node ${f.old}/server/features/pipelines/verify-supervisor.js\`)` (stays unidentified).
- lingering-helpers test (`vendor/agentbus/agentpier/mcp.js`): `f.extra.push(\` 600 1 node ${f.old}/bin/node ${f.old}/vendor/agentbus/agentpier/mcp.js\`)`— an orphan; with Task 2's`awaitReferences`change it is awaited for the settle budget and then reported as`remaining: [{ reference: "vendor/agentbus/agentpier/mcp.js" }]`, so the assertion stays the same. Until Task 2 lands this test fails with the same code but immediately; that is expected and noted in the report.

- [ ] **Step 6: Amend spec section 1**

Replace the four class bullets in section "1. Session mapping" of the spec with:

```markdown
- **session**: a launcher line — `terminal-launcher.js` followed by a path ending in
  `sessions/<uuid>.launch.json`, optionally single-quoted. The launch file is unlinked
  at spawn but its path stays in the launcher's argv. The launcher's pid identifies the
  session's process tree.
- **helper**: any other release-referencing process that descends from a session
  launcher (`ps` reports `pid` and `ppid`; ancestry is walked up to the launcher). What
  it runs does not matter: MCP servers, hooks, credential helpers, and user processes
  the CLI started with the release's Node binary all exit with the session.
- **node-only**: a process outside any session tree whose only release reference is
  `<release>/bin/node`.
- **unidentified**: every other process that references the release and does not
  descend from a session launcher: detached scripts (pipeline verify supervisor, release
  helper, the web service itself), orphaned helpers of a CLI that already exited, and
  anything foreign. Lines without pid columns have no ancestry and fall here.
```

and change the following paragraph's `reference` sentence to "`reference` is the release-relative path of the first non-`bin/node` reference on that line (never the full command line, which can carry tokens)".

- [ ] **Step 7: Run the tests**

Run: `node --test tests/integration/release-references.test.js tests/integration/release-cleanup.test.js tests/integration/release-session-migration.test.js`
Expected: all pass except the migration test "sessions that stop or disappear count as released; lingering helpers are awaited and then block", which now fails only because `awaitReferences` blocks immediately on an unidentified orphan (fixed in Task 2). Everything else PASS.

- [ ] **Step 8: Commit**

```bash
npx prettier --write server/features/operations/release-references.js server/features/operations/release-cleanup.js tests/integration/release-references.test.js tests/integration/release-cleanup.test.js tests/integration/release-session-migration.test.js docs/superpowers/specs/2026-09-13-release-session-migration-design.md
npx eslint server/features/operations/release-references.js server/features/operations/release-cleanup.js tests/integration/release-references.test.js tests/integration/release-cleanup.test.js tests/integration/release-session-migration.test.js
git add <those files>
git commit -m "feat: classify release processes by session ancestry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011Saz1VDpLYk54p96dku1sj"
```

---

### Task 2: Service follow-ups and test gaps

**Files:**

- Modify: `server/features/operations/release-session-migration.js` (`awaitReferences`, `resumeAfterActivation`)
- Modify: `tests/integration/release-session-migration.test.js`
- Modify: `tests/integration/operation-jobs.test.js`

**Interfaces:**

- Consumes: `cleanupStatus().versions[*].{ deleteReason, sessionIds }` (Task 1 shape unchanged).
- Produces: `awaitReferences` waits `settleAttempts` polls for any remaining reference (unidentified included) before `migrateBlocked`; `resumeAfterActivation` requests reloads only for running sessions whose id appears in `sessionIds` of a version whose `deleteReason` is not `"active"` (falls back to all running sessions when `cleanupStatus().available` is false).

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/release-session-migration.test.js`:

```js
test("after activation only sessions still holding an old release are reloaded", async (t) => {
  const f = await activationFixture(
    t,
    [
      { id: ids[0], tool: "claude", status: "running", activity: "idle" },
      {
        id: ids[1],
        tool: "claude",
        status: "running",
        activity: "idle",
        holdsRelease: false,
      },
    ],
    { status: "succeeded", result: { activated: true } },
  );
  await f.migration.resumeAfterActivation();
  assert.deepEqual(
    f.reload.requests.map((r) => r.id),
    [ids[0]],
  );
});

test("after activation every running session is reloaded when process inspection is unavailable", async (t) => {
  const f = await activationFixture(
    t,
    [
      {
        id: ids[0],
        tool: "claude",
        status: "running",
        activity: "idle",
        holdsRelease: false,
      },
    ],
    { status: "succeeded", result: { activated: true } },
  );
  f.operations.releases.processes = () => {
    throw Error("ps failed");
  };
  await f.migration.resumeAfterActivation();
  assert.deepEqual(
    f.reload.requests.map((r) => r.id),
    [ids[0]],
  );
});

test("stopped sessions holding a lingering launcher line are released without a reload request", async (t) => {
  const f = await fixture(t, [
    { id: ids[0], tool: "claude", status: "running", activity: "idle" },
    { id: ids[1], tool: "codex", status: "stopped", activity: "stopped" },
  ]);
  const job = f.migration.migrate("1.0.0");
  await new Promise((r) => setTimeout(r, 20));
  f.lines.delete(ids[1]);
  const finished = await f.finish(job);
  assert.equal(finished.status, "succeeded", finished.error);
  assert.deepEqual(
    f.reload.requests.map((r) => r.id),
    [ids[0]],
  );
  assert.deepEqual(finished.result.reloadedSessions, [ids[0]]);
});

test("a release that leaves the inUse state while reloads run ends the job with migrateChanged", async (t) => {
  const f = await fixture(t, [
    {
      id: ids[0],
      tool: "claude",
      status: "running",
      activity: "working",
      nextState: "waiting",
    },
  ]);
  const job = f.migration.migrate("1.0.0");
  await new Promise((r) => setTimeout(r, 20));
  await fs.writeFile(
    path.join(f.operations.config.dataDir, "operations/release-activation.lock"),
    "{}",
  );
  f.store.map.get(ids[0]).reload.state = "completed";
  f.lines.delete(ids[0]);
  const finished = await f.finish(job);
  assert.equal(finished.errorCode, "migrateChanged");
  assert.ok(await fs.stat(path.join(f.installRoot, "releases/1.0.0")));
});

test("migrate rejects invalid options before touching any job", async (t) => {
  const f = await fixture(t, [{ id: ids[0], tool: "claude", status: "running" }]);
  for (const options of [null, "now", [], { interrupt: "yes" }])
    assert.throws(() => f.migration.migrate("1.0.0", options), /Invalid/);
  assert.equal(f.operations.jobs.running("release-"), false);
});
```

Append to `tests/integration/operation-jobs.test.js`:

```js
test("running skips job files that cannot be read", async (t) => {
  const dir = await directory(t);
  const jobs = new OperationJobs(dir);
  await fs.writeFile(
    path.join(dir, "operations/jobs/0000aaaa-0000-4000-8000-000000000000.json"),
    "{not json",
  );
  assert.equal(jobs.running("release-"), false);
  let release;
  jobs.start("release-migrate", () => new Promise((resolve) => (release = resolve)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.running("release-"), true);
  release({});
  await jobs.close();
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test tests/integration/release-session-migration.test.js tests/integration/operation-jobs.test.js`
Expected: the first two new migration tests FAIL (both sessions reloaded / none reloaded), the lingering-helpers test from Task 1 FAILS (immediate block), the `migrateChanged` and stopped-session tests may already pass; the jobs test passes if `running` already guards `get` (it does) — keep it as regression coverage.

- [ ] **Step 3: Implement**

In `awaitReferences` replace the condition
`if (entry.unidentifiedProcesses.length || attempt >= this.settleAttempts)` with
`if (attempt >= this.settleAttempts)` and update the comment above `remaining` to say that orphaned helpers of a killed CLI exit within seconds, so every remaining reference is awaited for the settle budget before the release is reported as blocked.

In `resumeAfterActivation`, replace the session loop with:

```js
const held = this.heldSessionIds();
let count = 0;
for (const session of await this.services.sessions.list()) {
  if (session.status !== "running") continue;
  if (held && !held.has(session.id)) continue;
  try {
    const status = await this.services.reload.status(session.id);
    if (!status.eligible || inFlight(status.state)) continue;
    await this.services.reload.request(session.id, {
      requestId: randomUUID(),
      mode: "when-idle",
    });
    count += 1;
  } catch (error) {
    this.log(`Session ${session.id} was not reloaded after activation: ${error.message}`);
  }
}
```

and add the method:

```js
  /** Ids of running sessions that still hold a non-active release, or null when unknown. */
  heldSessionIds() {
    const state = this.operations.releases.cleanupStatus();
    if (!state.available) return null;
    return new Set(
      state.versions
        .filter((item) => item.deleteReason !== "active")
        .flatMap((item) => item.sessionIds),
    );
  }
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/integration/release-session-migration.test.js tests/integration/operation-jobs.test.js tests/integration/release-cleanup.test.js tests/integration/release-references.test.js` three times.
Expected: PASS, no flakiness.

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/features/operations/release-session-migration.js tests/integration/release-session-migration.test.js tests/integration/operation-jobs.test.js
npx eslint server/features/operations/release-session-migration.js tests/integration/release-session-migration.test.js tests/integration/operation-jobs.test.js
git add <those files>
git commit -m "fix: reload only sessions holding old releases and await orphaned helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011Saz1VDpLYk54p96dku1sj"
```

---

### Task 3: Link the activation help text to the checkbox

**Files:**

- Modify: `web/features/operations/UpdatesPage.jsx`
- Modify: `tests/browser/update-activate.spec.js`

- [ ] **Step 1: Extend the browser test**

In `tests/browser/update-activate.spec.js`, right after `await expect(checkbox).not.toBeChecked();` add:

```js
await expect(checkbox).toHaveAttribute("aria-describedby", "activate-reload-help");
await expect(page.locator("#activate-reload-help")).toContainText(
  en ? "health check" : "Zustandsprüfung",
);
```

- [ ] **Step 2: Run to see it fail**

Run: `npm run build && npx playwright test tests/browser/update-activate.spec.js`
Expected: FAIL on the `aria-describedby` assertion.

- [ ] **Step 3: Implement**

In `web/features/operations/UpdatesPage.jsx` add `aria-describedby="activate-reload-help"` to the checkbox `<input>` and `id="activate-reload-help"` to the help `<p>`.

- [ ] **Step 4: Run the specs**

Run: `npm run build && npx playwright test tests/browser/update-activate.spec.js tests/browser/release-cleanup.spec.js`
Expected: PASS in both locales.

- [ ] **Step 5: Commit**

```bash
npx prettier --write web/features/operations/UpdatesPage.jsx tests/browser/update-activate.spec.js
npx eslint web/features/operations/UpdatesPage.jsx tests/browser/update-activate.spec.js
git add web/features/operations/UpdatesPage.jsx tests/browser/update-activate.spec.js
git commit -m "fix: describe the activation reload checkbox for assistive technology

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011Saz1VDpLYk54p96dku1sj"
```

---

### Task 4: Full verification

- [ ] Run `npm run check 2>&1 | tail -20` and `npx playwright test tests/browser/release-cleanup.spec.js tests/browser/update-activate.spec.js tests/browser/session-reload.spec.js`. Expected: lint, format, structure, build pass; `npm test` reports only the known `shell.test.js` environment failure; all browser specs pass. No commit unless something needed fixing.
