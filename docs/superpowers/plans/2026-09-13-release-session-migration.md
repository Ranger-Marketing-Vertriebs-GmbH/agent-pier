# Release Session Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users see which sessions hold an old application release, migrate them to the active release through the existing session reload engine, delete the release automatically afterwards, and optionally migrate all sessions after a release activation.

**Architecture:** A pure classifier maps `ps` lines to session ids, helper children, node-only and unidentified processes. A new `ReleaseSessionMigration` service (operations layer) builds a per-version plan, runs a `release-migrate` operations job that drives `services.reload`, waits for references to disappear and calls the existing cleanup. Activation accepts a `reloadSessions` flag that writes a durable marker; the new server consumes it after `listening` once the activation job has succeeded. The web UI gains a session list with migrate buttons in the cleanup card and a checkbox in the activation confirmation.

**Tech Stack:** Node 22+ ESM, Express, React 18 (JSX, no TypeScript), `node:test` integration tests, Playwright browser specs, Prettier + ESLint.

**Spec:** `docs/superpowers/specs/2026-09-13-release-session-migration-design.md`

## Global Constraints

- Work only inside the worktree `/Users/d.kaulig/Projects/agent-pier/.claude/worktrees/release-session-migration`. Never `cd` to the parent repository.
- Every source and test file must stay at or below 600 lines (`npm run check:structure`). `server/features/sessions/session-manager.js` is exactly 600 lines and must not be modified.
- Integration tests are `tests/integration/*.test.js` run by `npm run test:integration` (`node --test`). Browser specs are `tests/browser/*.spec.js` run by `npx playwright test <file>`; they are not part of `npm test`.
- Server-side error messages are English strings passed to `problem(message, status)` from `server/lib/storage.js`. Job error codes travel as `error.code`; job failure results as `error.result`.
- All user-facing copy goes into both `web/lib/i18n/de/operations.js` and `web/lib/i18n/en/operations.js` inside the exported `operationsCopy` object. Keys must exist in both files.
- Audit actions are `<resource>.<verb>` with verbs from the closed set in `server/features/audit/audit-schema.js`. Use `release.deleted` and `release.refreshed`. `resourceId` must match `/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/` (a job id, never a version string). Versions go into `details.version`.
- Reloads must never be awaited inside `createApplication` in `server/app.js`; post-activation work runs on `server.once("listening", …)`.
- Run `npx prettier --write <files>` before every commit; run `npx eslint <files>` on changed JS/JSX.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_011Saz1VDpLYk54p96dku1sj
  ```

---

## File map

| File                                                            | Responsibility                                                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `server/features/operations/release-references.js` (new)        | Pure classifier of `ps` lines for one release: session ids, helper children, node-only, unidentified.          |
| `server/features/operations/release-cleanup.js`                 | `cleanupState` exposes `sessionIds`, `nodeOnlyProcesses`, `unidentifiedProcesses` per version.                 |
| `server/features/operations/jobs.js`                            | `running(kindPrefix)`, persisted failure `result`, widened `errorCode` passthrough, `closed` flag initialised. |
| `server/features/operations/releases.js`                        | `stagedVersion(stagedId)` helper.                                                                              |
| `server/features/operations/operations.js`                      | Audit fix for cleanup, `reloadSessions` on `activate`, marker write, migrate-job guard.                        |
| `server/features/operations/release-session-migration.js` (new) | `ReleaseSessionMigration` with `plan`, `migrate`, `cancel`, `resumeAfterActivation`.                           |
| `server/http/routes/operations.js`                              | Three new routes under `/operations/releases/cleanup/:version/`.                                               |
| `server/app.js`                                                 | Construct the service after `sessionMcp`, hook `listening`.                                                    |
| `web/features/operations/ReleaseSessions.jsx` (new)             | Session list, state chips, migrate / interrupt / cancel buttons for one version.                               |
| `web/features/operations/ReleaseCleanup.jsx`                    | Mounts `ReleaseSessions` for `inUse` versions, tracks the running migration.                                   |
| `web/features/operations/ConfirmOperation.jsx`                  | Optional `children` slot.                                                                                      |
| `web/features/operations/UpdatesPage.jsx`                       | Activation checkbox.                                                                                           |
| `web/features/operations/OperationJob.jsx`                      | Migrate job result rendering, passes `kind` to `onState`.                                                      |
| `web/lib/i18n/{de,en}/operations.js`                            | New copy.                                                                                                      |
| `tests/integration/release-references.test.js` (new)            | Classifier tests.                                                                                              |
| `tests/integration/release-cleanup.test.js`                     | New fields; cleanup job succeeds with a real `AuditStore`.                                                     |
| `tests/integration/release-session-migration.test.js` (new)     | Service tests with fakes.                                                                                      |
| `tests/integration/operations-activate-flag.test.js` (new)      | `reloadSessions` validation, marker, migrate guard.                                                            |
| `tests/integration/operation-jobs.test.js` (new)                | `running`, failure result persistence.                                                                         |
| `tests/browser/release-cleanup.spec.js`                         | Session list and migration flows.                                                                              |
| `tests/browser/update-activate.spec.js` (new)                   | Activation checkbox.                                                                                           |
| `docs/installation.md`, `docs/session-reload.md`                | Documentation.                                                                                                 |

---

### Task 1: Process reference classifier

**Files:**

- Create: `server/features/operations/release-references.js`
- Test: `tests/integration/release-references.test.js`

**Interfaces:**

- Produces: `releaseSessionReferences(output: string, releasePaths: string[]) → { sessionIds: string[], helpers: number, helperReferences: Array<{ reference: string }>, nodeOnly: number, unidentified: Array<{ reference: string }> }`. `releasePaths` are absolute release directories (with or without trailing slash); a line counts when it contains any of them followed by `/`. `reference` is the release-relative path of the first non-`bin/node` reference on the line.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/release-references.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { releaseSessionReferences } from "../../server/features/operations/release-references.js";

const release = "/opt/agentpier/releases/1.0.0";
const other = "/opt/agentpier/releases/1.1.0";
const data = "/Users/me/Library/Application Support/AgentPier/data";
const id = "6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c";
const second = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

test("launcher lines map to session ids with and without shell quoting", () => {
  const output = [
    `${release}/bin/node ${release}/bin/node ${release}/server/terminal-launcher.js ${data}/sessions/${id}.launch.json`,
    `sh sh -c '${release}/bin/node' '${release}/server/terminal-launcher.js' '${data}/sessions/${second}.launch.json'`,
    `${other}/bin/node ${other}/bin/node ${other}/server/terminal-launcher.js ${data}/sessions/${second}.launch.json`,
  ].join("\n");
  assert.deepEqual(releaseSessionReferences(output, [release]), {
    sessionIds: [id, second],
    helpers: 0,
    helperReferences: [],
    nodeOnly: 0,
    unidentified: [],
  });
});

test("session-owned helpers, node-only processes and foreign processes are classified separately", () => {
  const output = [
    `node ${release}/bin/node ${release}/vendor/agentbus/agentpier/mcp.js`,
    `node ${release}/bin/node ${release}/server/native-session-binding.js hook`,
    `codex codex -c hooks.SessionStart=[{command="\\"$AGENTPIER_HOOK_NODE\\" \\"${release}/server/native-session-binding.js\\""}] -c mcp_servers.agentpier.args=["${release}/vendor/agentbus/agentpier/mcp.js"]`,
    `node ${release}/bin/node /Users/me/project/node_modules/.bin/vite`,
    `node ${release}/bin/node ${release}/server/features/pipelines/verify-supervisor.js /tmp/run`,
    `node ${release}/bin/node ${release}/server/terminal-launcher.js`,
    `bash bash -lc 'echo ${release}/README.md'`,
  ].join("\n");
  assert.deepEqual(releaseSessionReferences(output, [release]), {
    sessionIds: [],
    helpers: 3,
    helperReferences: [
      { reference: "vendor/agentbus/agentpier/mcp.js" },
      { reference: "server/native-session-binding.js" },
      { reference: "server/native-session-binding.js" },
    ],
    nodeOnly: 1,
    unidentified: [
      { reference: "server/features/pipelines/verify-supervisor.js" },
      { reference: "server/terminal-launcher.js" },
      { reference: "README.md" },
    ],
  });
});

test("duplicate session ids across realpath and symlinked release paths collapse", () => {
  const link = "/opt/agentpier-link/releases/1.0.0";
  const output = `${link}/bin/node ${link}/bin/node ${link}/server/terminal-launcher.js ${data}/sessions/${id}.launch.json`;
  assert.deepEqual(releaseSessionReferences(output, [release, link]).sessionIds, [id]);
  assert.deepEqual(releaseSessionReferences("", [release]), {
    sessionIds: [],
    helpers: 0,
    helperReferences: [],
    nodeOnly: 0,
    unidentified: [],
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/integration/release-references.test.js`
Expected: FAIL with `Cannot find module … release-references.js`

- [ ] **Step 3: Write the implementation**

Create `server/features/operations/release-references.js`:

```js
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const launcher = new RegExp(
  `terminal-launcher\\.js'?\\s+'?(?:[^\\s']*/)?sessions/(${uuid})\\.launch\\.json'?`,
  "i",
);
// Helpers a native CLI session spawns from its own release. They exit with the session.
const sessionHelpers = [
  "vendor/agentbus/",
  "server/native-session-binding.js",
  "server/native-session-opencode.js",
  "server/github-credentials.js",
  "server/git-credential.mjs",
  "server/ssh.mjs",
  "server/lib/",
];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Classify every process line that references one of the release directories. */
export function releaseSessionReferences(output, releasePaths) {
  const prefixes = releasePaths.map((value) => value.replace(/\/+$/, "") + "/");
  const pattern = new RegExp(`(?:${prefixes.map(escape).join("|")})([^\\s'"\\\\]*)`, "g");
  const result = {
    sessionIds: [],
    helpers: 0,
    helperReferences: [],
    nodeOnly: 0,
    unidentified: [],
  };
  for (const line of output.split("\n")) {
    const references = [...line.matchAll(pattern)].map((match) => match[1]);
    if (!references.length) continue;
    const session = launcher.exec(line);
    if (session && references.includes("server/terminal-launcher.js")) {
      const id = session[1].toLowerCase();
      if (!result.sessionIds.includes(id)) result.sessionIds.push(id);
      continue;
    }
    const rest = references.filter((reference) => reference !== "bin/node");
    if (!rest.length) {
      result.nodeOnly += 1;
      continue;
    }
    if (
      rest.every((reference) =>
        sessionHelpers.some((helper) => reference.startsWith(helper)),
      )
    ) {
      result.helpers += 1;
      result.helperReferences.push({ reference: rest[0] });
      continue;
    }
    result.unidentified.push({
      reference: rest.find(
        (reference) => !sessionHelpers.some((helper) => reference.startsWith(helper)),
      ),
    });
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/integration/release-references.test.js`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/features/operations/release-references.js tests/integration/release-references.test.js
npx eslint server/features/operations/release-references.js tests/integration/release-references.test.js
git add server/features/operations/release-references.js tests/integration/release-references.test.js
git commit -m "feat: classify release process references by session

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011Saz1VDpLYk54p96dku1sj"
```

---

### Task 2: Expose session references in cleanup state and fix the cleanup audit action

**Files:**

- Modify: `server/features/operations/release-cleanup.js` (the `flatMap` return near the end of `cleanupState`)
- Modify: `server/features/operations/operations.js:100-110` (`cleanupReleases`)
- Test: `tests/integration/release-cleanup.test.js`

**Interfaces:**

- Consumes: `releaseSessionReferences` from Task 1.
- Produces: each entry of `cleanupState().versions` has `sessionIds: string[]`, `nodeOnlyProcesses: number`, `helperProcesses: Array<{ reference }>`, `unidentifiedProcesses: Array<{ reference }>`. `Operations.cleanupReleases({ versions })` audits `release.deleted` once per version with `resourceId: jobId` and `details: { version }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/release-cleanup.test.js` (keep the existing imports, add these):

```js
import { Operations } from "../../server/features/operations/operations.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
```

and the tests:

```js
test("cleanup state lists the sessions and process classes holding each version", async (t) => {
  const r = await fixture(t);
  const id = "6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c";
  const old = `${r.installRoot}/releases/1.1.0`;
  r.processes = () =>
    [
      `${old}/bin/node ${old}/bin/node ${old}/server/terminal-launcher.js ${r.dataDir}/sessions/${id}.launch.json`,
      `node ${old}/bin/node ${old}/vendor/agentbus/agentpier/mcp.js`,
      `node ${old}/bin/node /Users/me/tool.js`,
      `node ${old}/bin/node ${old}/server/features/pipelines/verify-supervisor.js`,
    ].join("\n");
  const state = r.cleanupStatus();
  const held = state.versions.find((v) => v.version === "1.1.0");
  assert.equal(held.deleteReason, "inUse");
  assert.deepEqual(held.sessionIds, [id]);
  assert.equal(held.nodeOnlyProcesses, 1);
  assert.deepEqual(held.helperProcesses, [
    { reference: "vendor/agentbus/agentpier/mcp.js" },
  ]);
  assert.deepEqual(held.unidentifiedProcesses, [
    { reference: "server/features/pipelines/verify-supervisor.js" },
  ]);
  const free = state.versions.find((v) => v.version === "1.0.0");
  assert.deepEqual(
    [
      free.sessionIds,
      free.nodeOnlyProcesses,
      free.helperProcesses,
      free.unidentifiedProcesses,
    ],
    [[], 0, [], []],
  );
});

test("the cleanup job succeeds and records a valid audit event", async (t) => {
  const r = await fixture(t);
  const audit = new AuditStore({ dataDir: r.dataDir });
  t.after(() => audit.close());
  const operations = new Operations({
    config: { dataDir: r.dataDir },
    audit,
    withSnapshotBarrier: (fn) => fn(),
    releaseOptions: { installRoot: r.installRoot, processes: () => "" },
  });
  t.after(() => operations.close());
  const job = operations.cleanupReleases({ versions: ["1.0.0"] });
  await operations.jobs.close();
  const finished = operations.jobs.get(job.id);
  assert.equal(finished.status, "succeeded", finished.error);
  assert.deepEqual(finished.result, { removedVersions: ["1.0.0"] });
  const { events } = audit.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "release.deleted");
  assert.equal(events[0].details.version, "1.0.0");
});
```

`AuditStore#list()` returns `{ events, total, page, pageSize, before }` with the newest event first.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/release-cleanup.test.js`
Expected: the first new test FAILS (`sessionIds` undefined), the second FAILS with status `failed` and error `Invalid audit action.`

- [ ] **Step 3: Extend `cleanupState`**

In `server/features/operations/release-cleanup.js` add the import:

```js
import { releaseSessionReferences } from "./release-references.js";
```

Replace the final `return [{ version, canDelete: !reason, deleteReason: reason }];` inside the `flatMap` with:

```js
const references = releaseSessionReferences(commands, targets);
return [
  {
    version,
    canDelete: !reason,
    deleteReason: reason,
    sessionIds: references.sessionIds,
    nodeOnlyProcesses: references.nodeOnly,
    helperProcesses: references.helperReferences,
    unidentifiedProcesses: references.unidentified,
  },
];
```

- [ ] **Step 4: Fix the audit action in `Operations.cleanupReleases`**

In `server/features/operations/operations.js` replace the method with:

```js
  cleanupReleases({ versions }) {
    return this.jobs.start("release-cleanup", async (jobId) => {
      const result = await this.releases.cleanup(versions);
      for (const version of result.removedVersions)
        this.audit?.append({
          action: "release.deleted",
          resourceType: "release",
          resourceId: jobId,
          outcome: "success",
          source: "user",
          details: { version },
        });
      return result;
    });
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/integration/release-cleanup.test.js`
Expected: PASS, all tests including the three pre-existing ones

- [ ] **Step 6: Commit**

```bash
npx prettier --write server/features/operations/release-cleanup.js server/features/operations/operations.js tests/integration/release-cleanup.test.js
npx eslint server/features/operations/release-cleanup.js server/features/operations/operations.js tests/integration/release-cleanup.test.js
git add server/features/operations/release-cleanup.js server/features/operations/operations.js tests/integration/release-cleanup.test.js
git commit -m "fix: expose release session references and record valid cleanup audit events

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011Saz1VDpLYk54p96dku1sj"
```

---

### Task 3: Operation jobs: running check, persisted failure result, widened error codes

**Files:**

- Modify: `server/features/operations/jobs.js`
- Test: `tests/integration/operation-jobs.test.js` (new)

**Interfaces:**

- Produces: `OperationJobs#running(kindPrefix: string) → boolean`; `OperationJobs#closed: boolean` (false until `close()`); failed job records carry `result` when the thrown error has an object `result`; `errorCode` passthrough accepts `cleanup*` and `migrate*` codes with suffixes `Invalid|Busy|Changed|Failed|Blocked|Interrupted|Cancelled`.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/operation-jobs.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OperationJobs } from "../../server/features/operations/jobs.js";
import { problem } from "../../server/lib/storage.js";

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ap-jobs-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("running reports jobs by kind prefix and closed flips on close", async (t) => {
  const jobs = new OperationJobs(await directory(t));
  assert.equal(jobs.closed, false);
  let release;
  jobs.start("release-migrate", () => new Promise((resolve) => (release = resolve)));
  assert.equal(jobs.running("release-"), true);
  assert.equal(jobs.running("release-migrate"), true);
  assert.equal(jobs.running("backup"), false);
  release({ done: true });
  await jobs.close();
  assert.equal(jobs.closed, true);
  assert.equal(jobs.running("release-"), false);
});

test("failed jobs persist migrate error codes and structured results", async (t) => {
  const jobs = new OperationJobs(await directory(t));
  const job = jobs.start("release-migrate", async () => {
    throw Object.assign(problem("Some sessions failed.", 409), {
      code: "migrateFailed",
      result: { failedSessions: [{ id: "s1", error: "boom" }], reloadedSessions: [] },
    });
  });
  const other = jobs.start("release-cleanup", async () => {
    throw Object.assign(problem("nope", 409), { code: "somethingElse", result: "text" });
  });
  await jobs.close();
  const failed = jobs.get(job.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "migrateFailed");
  assert.deepEqual(failed.result, {
    failedSessions: [{ id: "s1", error: "boom" }],
    reloadedSessions: [],
  });
  const plain = jobs.get(other.id);
  assert.equal(plain.errorCode, undefined);
  assert.equal(plain.result, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/operation-jobs.test.js`
Expected: FAIL — `jobs.closed` is `undefined`, `jobs.running` is not a function

- [ ] **Step 3: Implement**

In `server/features/operations/jobs.js`:

In the constructor, after `this.onFailure = onFailure;` add:

```js
this.closed = false;
```

Replace the failure branch inside `start` (the `(error) => { atomic(file, { … }) … }` callback) with:

```js
        (error) => {
          atomic(file, {
            ...job,
            status: "failed",
            ...(typeof error.code === "string" &&
            /^(?:cleanup|migrate)(?:Invalid|Busy|Changed|Failed|Blocked|Interrupted|Cancelled)$/.test(
              error.code,
            )
              ? { errorCode: error.code }
              : {}),
            ...(error.result && typeof error.result === "object"
              ? { result: error.result }
              : {}),
            error: error.status
              ? error.message
              : "The operation failed. No unverified result was accepted.",
            finishedAt: new Date().toISOString(),
          });
          try {
            this.onFailure(job);
          } catch {}
        },
```

Add the method before `close()`:

```js
  running(kindPrefix) {
    return fs
      .readdirSync(this.directory)
      .filter((name) => /^[a-f0-9-]+\.json$/.test(name))
      .some((name) => {
        const job = this.get(name.slice(0, -".json".length));
        return job.status === "running" && job.kind.startsWith(kindPrefix);
      });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/integration/operation-jobs.test.js tests/integration/release-cleanup.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/features/operations/jobs.js tests/integration/operation-jobs.test.js
npx eslint server/features/operations/jobs.js tests/integration/operation-jobs.test.js
git add server/features/operations/jobs.js tests/integration/operation-jobs.test.js
git commit -m "feat: report running operation jobs and persist failure results

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011Saz1VDpLYk54p96dku1sj"
```

---

### Task 4: Activation flag, marker and migrate guard

**Files:**

- Modify: `server/features/operations/releases.js` (add `stagedVersion`)
- Modify: `server/features/operations/operations.js` (`activate`, `cleanupReleases` guard)
- Test: `tests/integration/operations-activate-flag.test.js` (new)

**Interfaces:**

- Consumes: `OperationJobs#running` from Task 3.
- Produces: `Releases#stagedVersion(stagedId) → string` (404 when unknown). `Operations#activate({ stagedId?, version?, reloadSessions? })` validates `reloadSessions` as boolean, strips it before `launchActivation`, and after the helper spawned writes `<dataDir>/operations/post-activation-reload.json` = `{ to, jobId, requestedAt }` when `reloadSessions === true` and `stagedId` is set. `Operations#postActivationMarker` is that path. `activate` and `cleanupReleases` throw 409 `A release migration is running. Wait for it to finish.` while `jobs.running("release-migrate")`.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/operations-activate-flag.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Operations } from "../../server/features/operations/operations.js";
import { readJson, atomic } from "../../server/features/operations/files.js";

async function fixture(t, { spawnFails = false } = {}) {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ap-activate-")),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, "data"),
    installRoot = path.join(temp, "install");
  await fs.mkdir(dataDir);
  await fs.mkdir(path.join(installRoot, "releases/1.0.0"), { recursive: true });
  await fs.writeFile(
    path.join(installRoot, "releases/1.0.0/release.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  await fs.symlink("releases/1.0.0", path.join(installRoot, "current"));
  const requests = [];
  const operations = new Operations({
    config: { dataDir },
    withSnapshotBarrier: (fn) => fn(),
    releaseOptions: {
      installRoot,
      processes: () => "",
      spawnImpl: (_command, args) => {
        requests.push(readJson(args[1]));
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() =>
          child.emit(spawnFails ? "error" : "spawn", new Error("spawn")),
        );
        return child;
      },
    },
  });
  t.after(() => operations.close());
  atomic(path.join(dataDir, "operations/releases/staged-one.json"), {
    id: "staged-one",
    version: "1.1.0",
  });
  return { operations, dataDir, requests };
}

test("activate with reloadSessions writes the marker after the helper spawned and keeps the flag out of the request", async (t) => {
  const { operations, dataDir, requests } = await fixture(t);
  const job = operations.activate({ stagedId: "staged-one", reloadSessions: true });
  await operations.jobs.close();
  const marker = readJson(path.join(dataDir, "operations/post-activation-reload.json"));
  assert.equal(marker.to, "1.1.0");
  assert.equal(marker.jobId, job.id);
  assert.ok(Date.parse(marker.requestedAt) > 0);
  assert.equal(requests.length, 1);
  assert.equal("reloadSessions" in requests[0], false);
  assert.equal(requests[0].stagedId, "staged-one");
});

test("activate without the flag, with false, or as rollback writes no marker", async (t) => {
  const { operations, dataDir } = await fixture(t);
  operations.activate({ stagedId: "staged-one" });
  operations.activate({ stagedId: "staged-one", reloadSessions: false });
  operations.activate({ version: "1.0.0", reloadSessions: true });
  await operations.jobs.close();
  assert.equal(
    readJson(path.join(dataDir, "operations/post-activation-reload.json"), null),
    null,
  );
});

test("activate rejects non-boolean flags, failed helper spawns leave no marker, and migrations block release jobs", async (t) => {
  const { operations, dataDir } = await fixture(t, { spawnFails: true });
  assert.throws(
    () => operations.activate({ stagedId: "staged-one", reloadSessions: "yes" }),
    /Invalid/,
  );
  const job = operations.activate({ stagedId: "staged-one", reloadSessions: true });
  await operations.jobs.close();
  assert.equal(operations.jobs.get(job.id).status, "failed");
  assert.equal(
    readJson(path.join(dataDir, "operations/post-activation-reload.json"), null),
    null,
  );
});

test("a running migration blocks activation and cleanup", async (t) => {
  const { operations } = await fixture(t);
  let release;
  operations.jobs.start(
    "release-migrate",
    () => new Promise((resolve) => (release = resolve)),
  );
  assert.throws(
    () => operations.activate({ stagedId: "staged-one" }),
    /migration is running/,
  );
  assert.throws(
    () => operations.cleanupReleases({ versions: ["1.0.0"] }),
    /migration is running/,
  );
  release({});
  await operations.jobs.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/operations-activate-flag.test.js`
Expected: FAIL — marker missing / flag not validated

- [ ] **Step 3: Add `stagedVersion` to `Releases`**

In `server/features/operations/releases.js`, after `cleanup(versions) { … }` add:

```js
  stagedVersion(stagedId) {
    const receipt = readJson(
      path.join(this.directory, `${identifier(stagedId)}.json`),
      null,
    );
    if (!receipt) throw problem("Staged release not found.", 404);
    return releaseVersion(receipt.version);
  }
```

- [ ] **Step 4: Update `Operations`**

In `server/features/operations/operations.js`, in the constructor after `this.reportFile = …` add:

```js
this.postActivationMarker = path.join(
  config.dataDir,
  "operations/post-activation-reload.json",
);
```

Add a private helper method (anywhere in the class):

```js
  requireNoMigration() {
    if (this.jobs.running("release-migrate"))
      throw problem("A release migration is running. Wait for it to finish.", 409);
  }
```

At the top of `cleanupReleases({ versions })` (before `return this.jobs.start(`) add `this.requireNoMigration();`.

Replace `activate(input)` with:

```js
  activate({ reloadSessions, ...input }) {
    if (reloadSessions !== undefined && typeof reloadSessions !== "boolean")
      throw problem("Invalid operation options.");
    this.requireNoMigration();
    const target =
      reloadSessions === true && input.stagedId
        ? this.releases.stagedVersion(input.stagedId)
        : null;
    return this.jobs.start(
      input.stagedId ? "release-activate" : "release-rollback",
      async (jobId) => {
        await this.releases.launchActivation(input, jobId);
        if (target)
          atomic(this.postActivationMarker, {
            to: target,
            jobId,
            requestedAt: new Date().toISOString(),
          });
      },
      { external: true },
    );
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/integration/operations-activate-flag.test.js tests/integration/operations-release.test.js tests/integration/release-cleanup.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
npx prettier --write server/features/operations/releases.js server/features/operations/operations.js tests/integration/operations-activate-flag.test.js
npx eslint server/features/operations/releases.js server/features/operations/operations.js tests/integration/operations-activate-flag.test.js
git add server/features/operations/releases.js server/features/operations/operations.js tests/integration/operations-activate-flag.test.js
git commit -m "feat: accept a reload-sessions flag on release activation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011Saz1VDpLYk54p96dku1sj"
```

---

### Task 5: `ReleaseSessionMigration` service — plan and migrate

**Files:**

- Create: `server/features/operations/release-session-migration.js`
- Test: `tests/integration/release-session-migration.test.js` (new)

**Interfaces:**

- Consumes: `Operations` (`releases.cleanupStatus()`, `releases.cleanup([version])`, `jobs`, `audit`, `config.dataDir`), `services.sessions.get(id)` / `.list()` (throw `{ status: 404 }` for unknown ids), `services.reload.status(id)` → `{ eligible, reason, activity: { state }, state, error, requestId }`, `services.reload.request(id, { requestId, mode, interrupt? })`.
- Produces:
  - `new ReleaseSessionMigration({ services, operations, pollMs = 1000, settleAttempts = 30, activationTimeoutMs = 600000, log = console.error })`
  - `plan(version) → Promise<{ version, deleteReason, migratable, nodeOnlyProcesses, unidentifiedProcesses, sessions: Array<{ id, name, tool, status, eligible, reason, activity, reload, reloadError, reloadSince }> }>`
  - `migrate(version, { interrupt = false } = {}) → job record` (synchronous start, throws 409 `migrateBusy`)
  - `cancel(version)` (404 when no migration runs for that version)
  - `resumeAfterActivation() → Promise<void>` (Task 6)
  - Job error codes: `migrateChanged`, `migrateFailed`, `migrateBlocked`, `migrateCancelled`, `migrateInterrupted`; success result `{ reloadedSessions, removedVersions }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/release-session-migration.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Operations } from "../../server/features/operations/operations.js";
import { ReleaseSessionMigration } from "../../server/features/operations/release-session-migration.js";

const ids = [
  "6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c",
  "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
];

/** Fake reload engine: request() moves a session to the state the test configured. */
class FakeReload {
  constructor(store) {
    this.store = store;
    this.requests = [];
    this.onRequest = () => {};
  }
  async status(id) {
    const session = this.store.map.get(id);
    return {
      eligible: session.eligible !== false,
      reason: session.eligible === false ? "unsupported-session" : null,
      activity: { state: session.activity || "idle" },
      state: session.reload?.state || "idle",
      error: session.reload?.error || null,
      requestId: session.reload?.requestId || null,
    };
  }
  async request(id, body) {
    this.requests.push({ id, ...body });
    const session = this.store.map.get(id);
    if (session.rejectRequest)
      throw Object.assign(new Error(session.rejectRequest), { status: 409 });
    session.reload = {
      state: session.nextState || "completed",
      requestId: body.requestId,
      error: session.nextError || null,
      updatedAt: new Date().toISOString(),
    };
    this.onRequest(id, session);
  }
}
class FakeSessions {
  constructor(list) {
    this.map = new Map(list.map((s) => [s.id, s]));
  }
  get(id) {
    const session = this.map.get(id);
    if (!session) throw Object.assign(new Error("missing"), { status: 404 });
    return structuredClone(session);
  }
  list() {
    return [...this.map.values()].map((s) => structuredClone(s));
  }
}

async function fixture(t, sessions) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ap-migrate-")));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, "data"),
    installRoot = path.join(temp, "install");
  await fs.mkdir(dataDir);
  for (const version of ["1.0.0", "1.1.0"]) {
    const dir = path.join(installRoot, "releases", version);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "release.json"), JSON.stringify({ version }));
  }
  await fs.symlink("releases/1.1.0", path.join(installRoot, "current"));
  const old = `${installRoot}/releases/1.0.0`;
  const lines = new Map();
  for (const session of sessions)
    if (session.holdsRelease !== false)
      lines.set(
        session.id,
        `${old}/bin/node ${old}/bin/node ${old}/server/terminal-launcher.js ${dataDir}/sessions/${session.id}.launch.json`,
      );
  const extra = [];
  const operations = new Operations({
    config: { dataDir },
    withSnapshotBarrier: (fn) => fn(),
    releaseOptions: {
      installRoot,
      processes: () => [...lines.values(), ...extra].join("\n"),
    },
  });
  t.after(() => operations.close());
  const store = new FakeSessions(sessions);
  const reload = new FakeReload(store);
  // A completed reload releases the old launcher line, like a real replacement does.
  reload.onRequest = (id, session) => {
    if (session.reload.state === "completed") lines.delete(id);
  };
  const migration = new ReleaseSessionMigration({
    services: { sessions: store, reload, activity: {} },
    operations,
    pollMs: 5,
    settleAttempts: 3,
    log: () => {},
  });
  const finish = async (job) => {
    for (let i = 0; i < 400 && operations.jobs.get(job.id).status === "running"; i++)
      await new Promise((r) => setTimeout(r, 5));
    return operations.jobs.get(job.id);
  };
  return { operations, migration, store, reload, lines, extra, installRoot, finish, old };
}

test("plan lists sessions with eligibility, activity and process classes", async (t) => {
  const f = await fixture(t, [
    { id: ids[0], name: "Alpha", tool: "claude", status: "running", activity: "idle" },
    {
      id: ids[1],
      name: null,
      tool: "codex",
      status: "running",
      activity: "working",
      eligible: false,
    },
    { id: ids[2], status: "running", holdsRelease: false },
  ]);
  f.extra.push(`node ${f.old}/bin/node /Users/me/tool.js`);
  const plan = await f.migration.plan("1.0.0");
  assert.equal(plan.deleteReason, "inUse");
  assert.equal(plan.migratable, false);
  assert.equal(plan.nodeOnlyProcesses, 1);
  assert.deepEqual(plan.unidentifiedProcesses, []);
  assert.deepEqual(
    plan.sessions.map((s) => [s.id, s.name, s.eligible, s.reason, s.activity, s.reload]),
    [
      [ids[0], "Alpha", true, null, "idle", "idle"],
      [ids[1], null, false, "unsupported-session", "working", "idle"],
    ],
  );
  f.store.map.delete(ids[1]);
  f.lines.delete(ids[1]);
  assert.equal((await f.migration.plan("1.0.0")).migratable, true);
  f.extra.push(
    `node ${f.old}/bin/node ${f.old}/server/features/pipelines/verify-supervisor.js`,
  );
  const blocked = await f.migration.plan("1.0.0");
  assert.equal(blocked.migratable, false);
  assert.deepEqual(blocked.unidentifiedProcesses, [
    { reference: "server/features/pipelines/verify-supervisor.js" },
  ]);
  assert.equal((await f.migration.plan("1.1.0")).deleteReason, "active");
  assert.deepEqual((await f.migration.plan("1.1.0")).sessions, []);
  await assert.rejects(f.migration.plan("../x"));
});

test("migrate reloads every session, waits for completion and deletes the release", async (t) => {
  const f = await fixture(t, [
    { id: ids[0], tool: "claude", status: "running", activity: "idle" },
    {
      id: ids[1],
      tool: "codex",
      status: "running",
      activity: "working",
      nextState: "waiting",
    },
  ]);
  const job = f.migration.migrate("1.0.0");
  assert.equal(job.kind, "release-migrate");
  assert.throws(() => f.migration.migrate("1.0.0"), /running/);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.operations.jobs.get(job.id).status, "running");
  // The busy session finishes later; the engine completes its queued reload.
  const waiting = f.store.map.get(ids[1]);
  waiting.reload.state = "completed";
  f.lines.delete(ids[1]);
  const finished = await f.finish(job);
  assert.equal(finished.status, "succeeded", finished.error);
  assert.deepEqual(finished.result, {
    reloadedSessions: [ids[0], ids[1]],
    removedVersions: ["1.0.0"],
  });
  assert.deepEqual(
    f.reload.requests.map((r) => [r.id, r.mode, r.interrupt]),
    [
      [ids[0], "when-idle", undefined],
      [ids[1], "when-idle", undefined],
    ],
  );
  await assert.rejects(fs.stat(path.join(f.installRoot, "releases/1.0.0")));
  assert.equal(f.operations.jobs.running("release-"), false);
});

test("interrupt mode requests immediate reloads and a rejected request fails the job without deleting", async (t) => {
  const f = await fixture(t, [
    { id: ids[0], tool: "claude", status: "running", activity: "working" },
    {
      id: ids[1],
      tool: "codex",
      status: "running",
      activity: "idle",
      rejectRequest: "Finish the current model selection before reloading.",
    },
  ]);
  const finished = await f.finish(f.migration.migrate("1.0.0", { interrupt: true }));
  assert.equal(finished.status, "failed");
  assert.equal(finished.errorCode, "migrateFailed");
  assert.deepEqual(finished.result, {
    failedSessions: [
      { id: ids[1], error: "Finish the current model selection before reloading." },
    ],
    reloadedSessions: [ids[0]],
  });
  assert.deepEqual(f.reload.requests[0], {
    id: ids[0],
    requestId: f.reload.requests[0].requestId,
    mode: "now",
    interrupt: true,
  });
  assert.ok(await fs.stat(path.join(f.installRoot, "releases/1.0.0")));
});

test("a changed plan aborts before any request and a failed engine reload is reported", async (t) => {
  const f = await fixture(t, [
    { id: ids[0], tool: "claude", status: "running", eligible: false },
  ]);
  const changed = await f.finish(f.migration.migrate("1.0.0"));
  assert.equal(changed.errorCode, "migrateChanged");
  assert.equal(f.reload.requests.length, 0);
  f.store.map.get(ids[0]).eligible = true;
  f.store.map.get(ids[0]).nextState = "failed";
  f.store.map.get(ids[0]).nextError = "Die Sitzung konnte nicht neu geladen werden.";
  const failed = await f.finish(f.migration.migrate("1.0.0"));
  assert.equal(failed.errorCode, "migrateFailed");
  assert.deepEqual(failed.result.failedSessions, [
    { id: ids[0], error: "Die Sitzung konnte nicht neu geladen werden." },
  ]);
});

test("transient stopped status during replacement is not treated as released", async (t) => {
  const f = await fixture(t, [
    {
      id: ids[0],
      tool: "claude",
      status: "running",
      activity: "idle",
      nextState: "reloading",
    },
  ]);
  const job = f.migration.migrate("1.0.0");
  await new Promise((r) => setTimeout(r, 30));
  const session = f.store.map.get(ids[0]);
  session.status = "stopped";
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.operations.jobs.get(job.id).status, "running");
  session.status = "running";
  session.reload.state = "completed";
  f.lines.delete(ids[0]);
  assert.equal((await f.finish(job)).status, "succeeded");
});

test("sessions that stop or disappear count as released; lingering helpers are awaited and then block", async (t) => {
  const f = await fixture(t, [
    { id: ids[0], tool: "claude", status: "running", activity: "idle" },
    {
      id: ids[1],
      tool: "codex",
      status: "running",
      activity: "idle",
      nextState: "waiting",
    },
    {
      id: ids[2],
      tool: "codex",
      status: "running",
      activity: "idle",
      nextState: "waiting",
    },
  ]);
  f.extra.push(`node ${f.old}/bin/node ${f.old}/vendor/agentbus/agentpier/mcp.js`);
  const job = f.migration.migrate("1.0.0");
  await new Promise((r) => setTimeout(r, 20));
  const stopped = f.store.map.get(ids[1]);
  stopped.status = "stopped";
  stopped.reload = { state: "idle" };
  f.lines.delete(ids[1]);
  f.store.map.delete(ids[2]);
  f.lines.delete(ids[2]);
  const finished = await f.finish(job);
  assert.equal(finished.errorCode, "migrateBlocked");
  assert.deepEqual(finished.result, {
    remaining: [{ reference: "vendor/agentbus/agentpier/mcp.js" }],
  });
  assert.ok(await fs.stat(path.join(f.installRoot, "releases/1.0.0")));
});

test("cancel and shutdown end a waiting migration without deleting", async (t) => {
  const f = await fixture(t, [
    {
      id: ids[0],
      tool: "claude",
      status: "running",
      activity: "working",
      nextState: "waiting",
    },
  ]);
  assert.throws(() => f.migration.cancel("1.0.0"), /No migration/);
  const job = f.migration.migrate("1.0.0");
  await new Promise((r) => setTimeout(r, 20));
  f.migration.cancel("1.0.0");
  const cancelled = await f.finish(job);
  assert.equal(cancelled.errorCode, "migrateCancelled");
  assert.deepEqual(cancelled.result, { failedSessions: [], reloadedSessions: [] });
  const second = f.migration.migrate("1.0.0");
  await new Promise((r) => setTimeout(r, 20));
  const closing = f.operations.jobs.close();
  const interrupted = await f.finish(second);
  await closing;
  assert.equal(interrupted.errorCode, "migrateInterrupted");
  assert.ok(await fs.stat(path.join(f.installRoot, "releases/1.0.0")));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/release-session-migration.test.js`
Expected: FAIL with `Cannot find module … release-session-migration.js`

- [ ] **Step 3: Implement the service (plan, migrate, cancel)**

Create `server/features/operations/release-session-migration.js`:

```js
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJson } from "./files.js";
import { releaseVersion } from "./release-archive.js";
import { problem } from "../../lib/storage.js";

const migrateError = (code, message, status = 409, result) =>
  Object.assign(problem(message, status), { code, ...(result ? { result } : {}) });
const inFlight = (state) => ["waiting", "reloading"].includes(state);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const partial = (tracked) => ({
  failedSessions: [...tracked]
    .filter(([, item]) => item.outcome === "failed")
    .map(([id, item]) => ({ id, error: item.error || null })),
  reloadedSessions: [...tracked]
    .filter(([, item]) => item.outcome === "reloaded")
    .map(([id]) => id),
});

/** Moves sessions off an old release via session reload, then removes the release. */
export class ReleaseSessionMigration {
  constructor({
    services,
    operations,
    pollMs = 1000,
    settleAttempts = 30,
    activationTimeoutMs = 600000,
    log = console.error,
  }) {
    this.services = services;
    this.operations = operations;
    this.pollMs = pollMs;
    this.settleAttempts = settleAttempts;
    this.activationTimeoutMs = activationTimeoutMs;
    this.log = log;
    this.active = null;
    this.marker = path.join(
      operations.config.dataDir,
      "operations/post-activation-reload.json",
    );
  }
  entry(version) {
    const state = this.operations.releases.cleanupStatus();
    return state.available
      ? state.versions.find((item) => item.version === version) || null
      : null;
  }
  async describe(id) {
    let session;
    try {
      session = await this.services.sessions.get(id);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
    const status = await this.services.reload.status(id);
    return {
      id,
      name: session.name || null,
      tool: session.tool,
      status: session.status,
      eligible: status.eligible,
      reason: status.reason,
      activity: status.activity.state,
      reload: status.state,
      reloadError: status.error,
      reloadSince: session.reload?.updatedAt || null,
    };
  }
  async plan(version) {
    releaseVersion(version);
    const entry = this.entry(version);
    const base = {
      version,
      deleteReason: entry ? entry.deleteReason : "unsafe",
      migratable: false,
      nodeOnlyProcesses: 0,
      unidentifiedProcesses: [],
      sessions: [],
    };
    if (!entry || entry.deleteReason !== "inUse") return base;
    const sessions = (
      await Promise.all(entry.sessionIds.map((id) => this.describe(id)))
    ).filter(Boolean);
    return {
      ...base,
      nodeOnlyProcesses: entry.nodeOnlyProcesses,
      unidentifiedProcesses: entry.unidentifiedProcesses,
      sessions,
      migratable:
        !entry.unidentifiedProcesses.length &&
        sessions.every((session) => session.eligible || inFlight(session.reload)),
    };
  }
  migrate(version, { interrupt = false } = {}) {
    releaseVersion(version);
    if (typeof interrupt !== "boolean") throw problem("Invalid operation options.");
    if (this.active || this.operations.jobs.running("release-"))
      throw migrateError(
        "migrateBusy",
        "Another release operation is running. Wait for it to finish.",
      );
    const control = { version, cancelled: false };
    this.active = control;
    return this.operations.jobs.start("release-migrate", async (jobId) => {
      try {
        return await this.run(version, interrupt, control, jobId);
      } finally {
        if (this.active === control) this.active = null;
      }
    });
  }
  cancel(version) {
    releaseVersion(version);
    if (!this.active || this.active.version !== version)
      throw problem("No migration is running for this release.", 404);
    this.active.cancelled = true;
  }
  checkpoint(control, tracked) {
    if (control.cancelled)
      throw migrateError(
        "migrateCancelled",
        "The migration was cancelled. The release was kept.",
        409,
        partial(tracked),
      );
    if (this.operations.jobs.closed)
      throw migrateError(
        "migrateInterrupted",
        "The web service is shutting down. The release was kept.",
        503,
        partial(tracked),
      );
  }
  async run(version, interrupt, control, jobId) {
    const plan = await this.plan(version);
    if (!plan.migratable)
      throw migrateError(
        "migrateChanged",
        "The sessions of this release changed. Refresh the list.",
      );
    const tracked = new Map();
    for (const session of plan.sessions) {
      if (inFlight(session.reload)) {
        tracked.set(session.id, { requestId: null, wasInFlight: true });
        continue;
      }
      const requestId = randomUUID();
      try {
        await this.services.reload.request(
          session.id,
          interrupt
            ? { requestId, mode: "now", interrupt: true }
            : { requestId, mode: "when-idle" },
        );
        tracked.set(session.id, { requestId });
      } catch (error) {
        tracked.set(session.id, { requestId, outcome: "failed", error: error.message });
      }
    }
    await this.settle(tracked, control);
    const result = partial(tracked);
    if (result.failedSessions.length)
      throw migrateError(
        "migrateFailed",
        "Some sessions could not be reloaded. The release was kept.",
        409,
        result,
      );
    await this.awaitReferences(version, control, tracked);
    const cleanup = await this.operations.releases.cleanup([version]);
    this.operations.audit?.append({
      action: "release.deleted",
      resourceType: "release",
      resourceId: jobId,
      outcome: "success",
      source: "user",
      details: { version, count: result.reloadedSessions.length },
    });
    return {
      reloadedSessions: result.reloadedSessions,
      removedVersions: cleanup.removedVersions,
    };
  }
  async settle(tracked, control) {
    for (;;) {
      let pending = false;
      for (const [id, item] of tracked) {
        if (item.outcome) continue;
        let session;
        try {
          session = await this.services.sessions.get(id);
        } catch (error) {
          if (error.status !== 404) throw error;
          item.outcome = "released";
          continue;
        }
        const state = session.reload?.state;
        const ours = item.wasInFlight || session.reload?.requestId === item.requestId;
        if (inFlight(state)) pending = true;
        else if (ours && state === "completed") item.outcome = "reloaded";
        else if (ours && state === "failed") {
          item.outcome = "failed";
          item.error = session.reload?.error || null;
        } else if (session.status !== "running") item.outcome = "released";
        else {
          item.outcome = "failed";
          item.error = "The reload was cancelled before it completed.";
        }
      }
      if (!pending) return;
      this.checkpoint(control, tracked);
      await sleep(this.pollMs);
    }
  }
  async awaitReferences(version, control, tracked) {
    for (let attempt = 0; ; attempt++) {
      const entry = this.entry(version);
      if (!entry)
        throw migrateError(
          "migrateChanged",
          "The release is no longer available for cleanup.",
        );
      if (entry.canDelete) return;
      const remaining = [
        ...entry.unidentifiedProcesses,
        ...entry.sessionIds.map((id) => ({ reference: `sessions/${id}` })),
        ...entry.helperProcesses,
      ];
      if (
        entry.deleteReason !== "inUse" ||
        entry.unidentifiedProcesses.length ||
        attempt >= this.settleAttempts
      )
        throw migrateError(
          "migrateBlocked",
          "Processes still use this release. The release was kept.",
          409,
          { remaining },
        );
      this.checkpoint(control, tracked);
      await sleep(this.pollMs);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/integration/release-session-migration.test.js tests/integration/release-references.test.js tests/integration/release-cleanup.test.js`
Expected: PASS. If the `transient stopped` test flakes on timing, raise the two `setTimeout(r, 30)` waits to `60`.

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/features/operations/release-session-migration.js tests/integration/release-session-migration.test.js
npx eslint server/features/operations/release-session-migration.js tests/integration/release-session-migration.test.js
git add server/features/operations/release-session-migration.js tests/integration/release-session-migration.test.js
git commit -m "feat: migrate sessions off an old release and remove it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011Saz1VDpLYk54p96dku1sj"
```

---

### Task 6: Post-activation reload

**Files:**

- Modify: `server/features/operations/release-session-migration.js`
- Test: `tests/integration/release-session-migration.test.js`

**Interfaces:**

- Consumes: marker `{ to, jobId, requestedAt }` from Task 4; `operations.jobs.get(jobId)`.
- Produces: `resumeAfterActivation()` — never throws; deletes the marker once the activation outcome is known; requests `when-idle` reloads for eligible running sessions when the job succeeded with `result.activated === true` and no `operations/release-activation.lock` exists; audits `release.refreshed`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/release-session-migration.test.js`:

```js
import { atomic } from "../../server/features/operations/files.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";

async function activationFixture(t, sessions, job) {
  const f = await fixture(t, sessions);
  const dataDir = f.operations.config.dataDir;
  f.operations.audit = new AuditStore({ dataDir });
  t.after(() => f.operations.audit.close());
  const jobId = "11111111-2222-4333-8444-555555555555";
  if (job)
    atomic(path.join(dataDir, "operations/jobs", `${jobId}.json`), {
      id: jobId,
      kind: "release-activate",
      createdAt: new Date().toISOString(),
      ...job,
    });
  atomic(path.join(dataDir, "operations/post-activation-reload.json"), {
    to: "1.1.0",
    jobId,
    requestedAt: new Date().toISOString(),
  });
  f.migration.activationTimeoutMs = 200;
  f.marker = path.join(dataDir, "operations/post-activation-reload.json");
  return f;
}

test("after a verified activation every eligible running session is reloaded when idle", async (t) => {
  const f = await activationFixture(
    t,
    [
      { id: ids[0], tool: "claude", status: "running", activity: "idle" },
      { id: ids[1], tool: "codex", status: "running", eligible: false },
      { id: ids[2], tool: "claude", status: "stopped" },
    ],
    { status: "succeeded", result: { activated: true } },
  );
  await f.migration.resumeAfterActivation();
  assert.deepEqual(
    f.reload.requests.map((r) => [r.id, r.mode]),
    [[ids[0], "when-idle"]],
  );
  assert.equal(readJson(f.marker, null), null);
  const { events } = f.operations.audit.list();
  assert.equal(events[0].action, "release.refreshed");
  assert.equal(events[0].details.version, "1.1.0");
  assert.equal(events[0].details.count, 1);
  await f.migration.resumeAfterActivation();
  assert.equal(f.reload.requests.length, 1);
});

test("failed, interrupted, locked or missing activations discard the marker without reloading", async (t) => {
  for (const job of [
    { status: "failed" },
    { status: "succeeded", result: { activated: false, rolledBack: true } },
    null,
  ]) {
    const f = await activationFixture(
      t,
      [{ id: ids[0], tool: "claude", status: "running", activity: "idle" }],
      job,
    );
    await f.migration.resumeAfterActivation();
    assert.equal(f.reload.requests.length, 0);
    assert.equal(readJson(f.marker, null), null);
  }
  const locked = await activationFixture(
    t,
    [{ id: ids[0], tool: "claude", status: "running", activity: "idle" }],
    { status: "succeeded", result: { activated: true } },
  );
  await fs.writeFile(
    path.join(locked.operations.config.dataDir, "operations/release-activation.lock"),
    "{}",
  );
  await locked.migration.resumeAfterActivation();
  assert.equal(locked.reload.requests.length, 0);
});

test("a still-running activation is awaited and a rejected request never throws", async (t) => {
  const f = await activationFixture(
    t,
    [
      {
        id: ids[0],
        tool: "claude",
        status: "running",
        activity: "idle",
        rejectRequest: "nope",
      },
      { id: ids[1], tool: "claude", status: "running", activity: "idle" },
    ],
    { status: "running", external: true, heartbeatAt: new Date().toISOString() },
  );
  f.migration.activationTimeoutMs = 2000;
  f.migration.activationPollMs = 10;
  const pending = f.migration.resumeAfterActivation();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.reload.requests.length, 0);
  atomic(
    path.join(
      f.operations.config.dataDir,
      "operations/jobs",
      `${"11111111-2222-4333-8444-555555555555"}.json`,
    ),
    {
      id: "11111111-2222-4333-8444-555555555555",
      kind: "release-activate",
      createdAt: new Date().toISOString(),
      status: "succeeded",
      result: { activated: true },
    },
  );
  await pending;
  assert.deepEqual(
    f.reload.requests.map((r) => r.id),
    [ids[0], ids[1]],
  );
});
```

Add `import { readJson } from "../../server/features/operations/files.js";` alongside the `atomic` import (merge into one import line).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/integration/release-session-migration.test.js`
Expected: FAIL — `resumeAfterActivation is not a function`

- [ ] **Step 3: Implement**

In the constructor of `ReleaseSessionMigration` add `this.activationPollMs = 2000;` after `this.activationTimeoutMs = activationTimeoutMs;`.

Add the methods to the class:

```js
  async awaitActivation(marker) {
    const lock = path.join(
      this.operations.config.dataDir,
      "operations/release-activation.lock",
    );
    const deadline = Date.now() + this.activationTimeoutMs;
    while (Date.now() < deadline) {
      let job;
      try {
        job = this.operations.jobs.get(marker.jobId);
      } catch {
        return false;
      }
      if (job.status === "succeeded") {
        if (!fs.existsSync(lock)) return job.result?.activated === true;
      } else if (job.status !== "running") return false;
      if (this.operations.jobs.closed) return false;
      await sleep(this.activationPollMs);
    }
    return false;
  }
  async resumeAfterActivation() {
    let marker;
    try {
      marker = readJson(this.marker, null);
    } catch {
      marker = null;
    }
    if (!marker) return;
    try {
      const verified =
        typeof marker.to === "string" && typeof marker.jobId === "string"
          ? await this.awaitActivation(marker)
          : false;
      fs.rmSync(this.marker, { force: true });
      if (!verified) return;
      let count = 0;
      for (const session of await this.services.sessions.list()) {
        if (session.status !== "running") continue;
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
      this.operations.audit?.append({
        action: "release.refreshed",
        resourceType: "release",
        resourceId: marker.jobId,
        outcome: "success",
        source: "system",
        details: { version: marker.to, count },
      });
    } catch (error) {
      fs.rmSync(this.marker, { force: true });
      this.log(`Post-activation reload skipped: ${error.message}`);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/integration/release-session-migration.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/features/operations/release-session-migration.js tests/integration/release-session-migration.test.js
npx eslint server/features/operations/release-session-migration.js tests/integration/release-session-migration.test.js
git add server/features/operations/release-session-migration.js tests/integration/release-session-migration.test.js
git commit -m "feat: reload running sessions after a verified release activation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011Saz1VDpLYk54p96dku1sj"
```

---

### Task 7: Routes and app wiring

**Files:**

- Modify: `server/http/routes/operations.js`
- Modify: `server/app.js`
- Test: `tests/integration/release-migration-routes.test.js` (new)

**Interfaces:**

- Consumes: `ReleaseSessionMigration#plan/migrate/cancel`.
- Produces: `GET /api/operations/releases/cleanup/:version/sessions`, `POST …/migrate` (`{ interrupt?: boolean }` → 202 `{ job }`), `DELETE …/migrate` (204 / 404). `services.releaseMigration` is available to routes.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/release-migration-routes.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { operationsRoutes } from "../../server/http/routes/operations.js";
import { registerResponses } from "../../server/http/responses.js";

function app(releaseMigration) {
  const application = express();
  application.use(express.json());
  application.use("/api", operationsRoutes({ operations: {}, releaseMigration }));
  registerResponses(application);
  return application;
}
async function request(application, method, path, body) {
  const server = application.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  } finally {
    server.close();
  }
}

test("migration routes validate the version and forward to the service", async () => {
  const calls = [];
  const migration = {
    plan: async (version) => (calls.push(["plan", version]), { version, sessions: [] }),
    migrate: (version, body) => (calls.push(["migrate", version, body]), { id: "job-1" }),
    cancel: (version) => calls.push(["cancel", version]),
  };
  const application = app(migration);
  assert.deepEqual(
    await request(application, "GET", "/api/operations/releases/cleanup/1.0.0/sessions"),
    { status: 200, body: { version: "1.0.0", sessions: [] } },
  );
  assert.deepEqual(
    await request(application, "POST", "/api/operations/releases/cleanup/1.0.0/migrate", {
      interrupt: true,
    }),
    { status: 202, body: { job: { id: "job-1" } } },
  );
  assert.equal(
    (
      await request(
        application,
        "POST",
        "/api/operations/releases/cleanup/1.0.0/migrate",
        { other: 1 },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        application,
        "DELETE",
        "/api/operations/releases/cleanup/1.0.0/migrate",
      )
    ).status,
    204,
  );
  assert.equal(
    (
      await request(
        application,
        "GET",
        "/api/operations/releases/cleanup/..%2Fx/sessions",
      )
    ).status,
    400,
  );
  assert.deepEqual(calls, [
    ["plan", "1.0.0"],
    ["migrate", "1.0.0", { interrupt: true }],
    ["cancel", "1.0.0"],
  ]);
});
```

`registerResponses` (from `server/http/responses.js`) installs the `/api` 404 fallback and the error middleware that turns a thrown `problem("…", 400)` into a JSON 400. Express 5 forwards rejected async handlers to it.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/integration/release-migration-routes.test.js`
Expected: FAIL with 404 responses

- [ ] **Step 3: Add the routes**

In `server/http/routes/operations.js`:

Add import: `import { releaseVersion } from "../../features/operations/release-archive.js";`

Change the signature to `export function operationsRoutes({ operations, releaseMigration }) {`.

After the existing `router.post(\`${root}/releases/cleanup\`, …)` block add:

```js
router.get(`${root}/releases/cleanup/:version/sessions`, async (req, res) =>
  res.json(await releaseMigration.plan(releaseVersion(req.params.version))),
);
router.post(`${root}/releases/cleanup/:version/migrate`, (req, res) =>
  res.status(202).json({
    job: releaseMigration.migrate(
      releaseVersion(req.params.version),
      fields(req.body, ["interrupt"]),
    ),
  }),
);
router.delete(`${root}/releases/cleanup/:version/migrate`, (req, res) => {
  releaseMigration.cancel(releaseVersion(req.params.version));
  res.status(204).end();
});
```

- [ ] **Step 4: Wire the service in `server/app.js`**

Add import near the other feature imports:

```js
import { ReleaseSessionMigration } from "./features/operations/release-session-migration.js";
```

After `await services.sessionMcp.ready;` add:

```js
services.releaseMigration = new ReleaseSessionMigration({
  services,
  operations: services.operations,
});
server.once("listening", () => services.releaseMigration.resumeAfterActivation());
```

`operationsRoutes(services)` already receives the whole services object, so `releaseMigration` reaches the router.

- [ ] **Step 5: Run tests**

Run: `node --test tests/integration/release-migration-routes.test.js && npm run test:integration 2>&1 | tail -8`
Expected: route test PASS; integration suite shows the same two pre-existing environment failures as before this work (`api.test.js` deep links without a web build, `shell.test.js` local shell) and nothing else. Run `npm run build` once if you want the deep-link test green.

- [ ] **Step 6: Commit**

```bash
npx prettier --write server/http/routes/operations.js server/app.js tests/integration/release-migration-routes.test.js
npx eslint server/http/routes/operations.js server/app.js tests/integration/release-migration-routes.test.js
git add server/http/routes/operations.js server/app.js tests/integration/release-migration-routes.test.js
git commit -m "feat: expose release session migration over HTTP

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011Saz1VDpLYk54p96dku1sj"
```

---

### Task 8: Copy (German and English)

**Files:**

- Modify: `web/lib/i18n/de/operations.js` (inside `operationsCopy`, next to `cleanupReasons`)
- Modify: `web/lib/i18n/en/operations.js` (same place)

**Interfaces:**

- Produces the keys used by Tasks 9–11: `cleanupErrors.migrate*`, `migrateSessions`, `migrateStart`, `migrateInterrupt`, `migrateCancel`, `migrateConfirm(version, count)`, `migrateInterruptConfirm(version, count)`, `migrateIneligibleHint`, `migrateUnidentifiedHint(references)`, `migrateNodeOnly(count)`, `migrateLoading`, `migrateEmpty`, `migrateStates.{ready,busy,unknown,queued,reloading,approval,failed,ineligible,"unsupported-session","native-session-unverified"}`, `migrateSucceeded(count)`, `migrateFailedSessions`, `migrateRemaining`, `activateReload`, `activateReloadHelp`.

- [ ] **Step 1: Add German copy**

In `web/lib/i18n/de/operations.js` extend `cleanupErrors`:

```js
    migrateBusy: "Ein anderer Release-Vorgang läuft. Versuche es nach dessen Abschluss erneut.",
    migrateChanged:
      "Die Sessions dieser Version haben sich geändert. Lade die Liste neu.",
    migrateFailed:
      "Einige Sessions konnten nicht neu geladen werden. Die Version bleibt erhalten.",
    migrateBlocked:
      "Prozesse verwenden diese Version weiterhin. Die Version bleibt erhalten.",
    migrateInterrupted:
      "Der Webdienst wurde beendet, bevor der Umzug abgeschlossen war. Die Version bleibt erhalten.",
    migrateCancelled: "Der Umzug wurde abgebrochen. Die Version bleibt erhalten.",
```

After `cleanupReasons: { … },` add:

```js
  migrateSessions: "Sessions anzeigen",
  migrateLoading: "Sessions werden geladen …",
  migrateEmpty: "Keine AgentPier-Session hält diese Version.",
  migrateStart: "Sessions umziehen und Version löschen",
  migrateInterrupt: "Sofort umziehen und löschen",
  migrateCancel: "Umzug abbrechen",
  migrateConfirm: (version, count) =>
    `${count} Session(s) auf die aktive Version umziehen und Version ${version} danach löschen? Beschäftigte Sessions ziehen erst nach Abschluss ihres aktuellen Schritts um; Sessions mit unbekanntem Zustand warten, bis das CLI erkennbar bereit ist.`,
  migrateInterruptConfirm: (version, count) =>
    `${count} Session(s) sofort neu starten und Version ${version} danach löschen? Laufende Arbeit wird abgebrochen. Gespeicherte Unterhaltungen bleiben erhalten.`,
  migrateIneligibleHint:
    "Einige Sessions können nicht neu geladen werden. Beende sie manuell, um die Version freizugeben.",
  migrateUnidentifiedHint: (references) =>
    `Prozesse außerhalb einer Session verwenden diese Version: ${references}. Beende sie, um die Version freizugeben.`,
  migrateNodeOnly: (count) =>
    `${count} Node-Prozess(e) aus dieser Version werden nach dem Umzug erneut geprüft.`,
  migrateStates: {
    ready: "Bereit",
    busy: "Beschäftigt",
    unknown: "Zustand unbekannt",
    queued: "Wartet auf Bereitschaft",
    reloading: "Wird neu geladen",
    approval: "Wartet auf Freigabe im Terminal",
    failed: "Fehlgeschlagen",
    ineligible: "Nicht neu ladbar",
    "unsupported-session": "Pipeline-, Login- oder Shell-Session",
    "native-session-unverified": "Keine verifizierte Unterhaltung",
  },
  migrateSucceeded: (count) => `Version gelöscht, ${count} Session(s) neu geladen.`,
  migrateFailedSessions: "Nicht neu geladen",
  migrateRemaining: "Weiterhin verwendet von",
  activateReload: "Laufende Sessions danach auf die neue Version umziehen",
  activateReloadHelp:
    "Der Umzug beginnt, nachdem die neue Version ihre Zustandsprüfung bestanden hat. Beschäftigte Sessions ziehen nach Abschluss ihres aktuellen Schritts um; nichts wird unterbrochen. Sessions, die nicht neu geladen werden können, laufen auf der bisherigen Version weiter.",
```

- [ ] **Step 2: Add English copy**

In `web/lib/i18n/en/operations.js` extend `cleanupErrors`:

```js
    migrateBusy: "Another release operation is running. Try again after it finishes.",
    migrateChanged: "The sessions of this version changed. Refresh the list.",
    migrateFailed: "Some sessions could not be reloaded. The version was kept.",
    migrateBlocked: "Processes still use this version. The version was kept.",
    migrateInterrupted:
      "The web service stopped before the migration finished. The version was kept.",
    migrateCancelled: "The migration was cancelled. The version was kept.",
```

After `cleanupReasons: { … },` add:

```js
  migrateSessions: "Show sessions",
  migrateLoading: "Loading sessions …",
  migrateEmpty: "No AgentPier session holds this version.",
  migrateStart: "Migrate sessions and delete version",
  migrateInterrupt: "Migrate now and delete",
  migrateCancel: "Cancel migration",
  migrateConfirm: (version, count) =>
    `Move ${count} session(s) to the active version and delete version ${version} afterwards? Busy sessions move after finishing their current step; sessions with unknown state wait until the CLI is recognisably idle.`,
  migrateInterruptConfirm: (version, count) =>
    `Restart ${count} session(s) immediately and delete version ${version} afterwards? Running work is interrupted. Saved conversations are preserved.`,
  migrateIneligibleHint:
    "Some sessions cannot be reloaded. Stop them manually to release the version.",
  migrateUnidentifiedHint: (references) =>
    `Processes outside a session use this version: ${references}. Stop them to release the version.`,
  migrateNodeOnly: (count) =>
    `${count} Node process(es) from this version are re-checked after the migration.`,
  migrateStates: {
    ready: "Ready",
    busy: "Busy",
    unknown: "State unknown",
    queued: "Waiting to become idle",
    reloading: "Reloading",
    approval: "Waiting for approval in the terminal",
    failed: "Failed",
    ineligible: "Cannot reload",
    "unsupported-session": "Pipeline, login or shell session",
    "native-session-unverified": "No verified conversation",
  },
  migrateSucceeded: (count) => `Version deleted, ${count} session(s) reloaded.`,
  migrateFailedSessions: "Not reloaded",
  migrateRemaining: "Still used by",
  activateReload: "Move running sessions to the new version afterwards",
  activateReloadHelp:
    "The migration starts after the new version passes its health check. Busy sessions move after finishing their current step; nothing is interrupted. Sessions that cannot be reloaded keep running on the previous version.",
```

- [ ] **Step 3: Verify both files parse and have matching keys**

Run:

```bash
node --input-type=module -e '
const de = (await import("./web/lib/i18n/de/operations.js")).operationsCopy;
const en = (await import("./web/lib/i18n/en/operations.js")).operationsCopy;
const keys = (o) => Object.keys(o).sort().join(",");
if (keys(de) !== keys(en)) throw new Error("top-level keys differ");
if (keys(de.migrateStates) !== keys(en.migrateStates)) throw new Error("migrateStates differ");
if (keys(de.cleanupErrors) !== keys(en.cleanupErrors)) throw new Error("cleanupErrors differ");
console.log("copy ok");
'
```

Expected: `copy ok`

- [ ] **Step 4: Commit**

```bash
npx prettier --write web/lib/i18n/de/operations.js web/lib/i18n/en/operations.js
git add web/lib/i18n/de/operations.js web/lib/i18n/en/operations.js
git commit -m "feat: add release migration copy

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011Saz1VDpLYk54p96dku1sj"
```

---

### Task 9: Cleanup card with session list and migration buttons

**Files:**

- Create: `web/features/operations/ReleaseSessions.jsx`
- Modify: `web/features/operations/ReleaseCleanup.jsx`
- Modify: `web/features/operations/OperationJob.jsx` (pass `kind` in `onState`)
- Test: `tests/browser/release-cleanup.spec.js`

**Interfaces:**

- Consumes: routes from Task 7, copy from Task 8. `ReleaseCleanup` props stay `{ busy, job, navigate }`; `job` now is `{ id, status, kind }`.
- Produces: `ReleaseSessions({ version, busy, migrating, onMigrate })` where `onMigrate(jobId)` is called after a migrate job was started; `ReleaseCleanup` tracks `migratingVersion` and renders the cancel button.

- [ ] **Step 1: Write the failing browser test**

Append a second `test(…)` inside the `test.describe` loop in `tests/browser/release-cleanup.spec.js`, after the existing test:

```js
test("blocked versions list their sessions and migrate them before deletion", async ({
  page,
}) => {
  const en = locale === "en-GB";
  const state = await operationsFixture(page);
  const versions = [
    { version: "0.9.0", canDelete: false, deleteReason: "inUse" },
    { version: "1.0.0", canDelete: false, deleteReason: "active" },
  ];
  let plan = {
    version: "0.9.0",
    deleteReason: "inUse",
    migratable: true,
    nodeOnlyProcesses: 1,
    unidentifiedProcesses: [],
    sessions: [
      {
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        name: "Alpha",
        tool: "claude",
        status: "running",
        eligible: true,
        reason: null,
        activity: "idle",
        reload: "idle",
        reloadError: null,
        reloadSince: null,
      },
      {
        id: "aaaaaaaa-0000-4000-8000-000000000002",
        name: null,
        tool: "codex",
        status: "running",
        eligible: true,
        reason: null,
        activity: "working",
        reload: "idle",
        reloadError: null,
        reloadSince: null,
      },
    ],
  };
  const migrations = [];
  let cancelled = 0;
  await page.route("**/api/operations/releases/cleanup", (route) =>
    route.fulfill({ json: { available: true, versions } }),
  );
  await page.route("**/api/operations/releases/cleanup/0.9.0/sessions", (route) =>
    route.fulfill({ json: plan }),
  );
  await page.route("**/api/operations/releases/cleanup/0.9.0/migrate", async (route) => {
    if (route.request().method() === "DELETE") {
      cancelled += 1;
      return route.fulfill({ status: 204 });
    }
    migrations.push(route.request().postDataJSON());
    const id = `migrate-${migrations.length}`;
    state.jobs[id] = {
      id,
      kind: "release-migrate",
      result: {
        reloadedSessions: plan.sessions.map((s) => s.id),
        removedVersions: ["0.9.0"],
      },
    };
    return route.fulfill({ status: 202, json: { job: { id } } });
  });
  state.jobStatus = "running";
  await page.goto("/settings/updates");
  await page
    .getByText(en ? "Remove old versions" : "Alte Versionen aufräumen", { exact: true })
    .click();
  await page
    .getByRole("button", {
      name: en ? "Show sessions" : "Sessions anzeigen",
      exact: true,
    })
    .click();
  const list = page.getByRole("list", {
    name: en ? "Sessions: 0.9.0" : "Sessions: 0.9.0",
  });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list).toContainText("Alpha");
  await expect(list).toContainText(en ? "Ready" : "Bereit");
  await expect(list).toContainText(en ? "Busy" : "Beschäftigt");
  await expect(page.getByText(en ? /1 Node process/ : /1 Node-Prozess/)).toBeVisible();
  await page
    .getByRole("button", {
      name: en ? "Migrate now and delete" : "Sofort umziehen und löschen",
      exact: true,
    })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    en ? "interrupted" : "abgebrochen",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: en ? "Cancel" : "Abbrechen", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: en
        ? "Migrate sessions and delete version"
        : "Sessions umziehen und Version löschen",
      exact: true,
    })
    .click();
  await expect(page.getByRole("dialog")).toContainText("0.9.0");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: en ? "Confirm" : "Bestätigen", exact: true })
    .click();
  expect(migrations).toEqual([{}]);
  const cancel = page.getByRole("button", {
    name: en ? "Cancel migration" : "Umzug abbrechen",
    exact: true,
  });
  await expect(cancel).toBeVisible();
  await cancel.click();
  expect(cancelled).toBe(1);
  state.jobStatus = "succeeded";
  await expect(
    page.getByText(
      en
        ? "Version deleted, 2 session(s) reloaded."
        : "Version gelöscht, 2 Session(s) neu geladen.",
    ),
  ).toBeVisible();
  await expect(cancel).toHaveCount(0);
  // Ineligible sessions and foreign processes disable migration with a hint.
  plan = {
    ...plan,
    migratable: false,
    sessions: [{ ...plan.sessions[0], eligible: false, reason: "unsupported-session" }],
    unidentifiedProcesses: [
      { reference: "server/features/pipelines/verify-supervisor.js" },
    ],
  };
  await page.reload();
  await page
    .getByText(en ? "Remove old versions" : "Alte Versionen aufräumen", { exact: true })
    .click();
  await page
    .getByRole("button", {
      name: en ? "Show sessions" : "Sessions anzeigen",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: en
        ? "Migrate sessions and delete version"
        : "Sessions umziehen und Version löschen",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      en ? /Pipeline, login or shell session/ : /Pipeline-, Login- oder Shell-Session/,
    ),
  ).toBeVisible();
  await expect(page.getByText(/verify-supervisor\.js/)).toBeVisible();
});
```

Notes for the implementer: the fixture's `/jobs/:id` handler returns `{ ...state.jobs[id], status: state.jobStatus }`, so setting `state.jobStatus` before/after drives the job panel. The `Show sessions` control must be a `<button>` (a `<summary>` element is not exposed as a button reliably), so `ReleaseSessions` uses a button toggling local state rather than `<details>`.

- [ ] **Step 2: Run the browser test to verify it fails**

Run: `npx playwright test tests/browser/release-cleanup.spec.js -g "blocked versions"`
Expected: FAIL — no "Show sessions" button

- [ ] **Step 3: Create `ReleaseSessions.jsx`**

```jsx
import React, { useState } from "react";
import useResource from "../../lib/useResource.js";
import api from "../../lib/api.js";
import ConfirmOperation from "./ConfirmOperation.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";

const inFlight = (state) => ["waiting", "reloading"].includes(state);
function stateLabel(session) {
  const states = copy.migrateStates;
  if (!session.eligible && !inFlight(session.reload))
    return states[session.reason] || states.ineligible;
  if (session.reload === "failed")
    return session.reloadError
      ? `${states.failed}: ${session.reloadError}`
      : states.failed;
  if (session.reload === "reloading")
    return session.reloadSince && Date.now() - Date.parse(session.reloadSince) > 30000
      ? states.approval
      : states.reloading;
  if (session.reload === "waiting") return states.queued;
  if (session.activity === "idle") return states.ready;
  if (session.activity === "unknown") return states.unknown;
  return states.busy;
}

export default function ReleaseSessions({
  version,
  busy,
  migrating,
  onMigrate,
  onCancel,
}) {
  const [open, setOpen] = useState(false),
    [confirm, setConfirm] = useState(null),
    [cancelError, setCancelError] = useState("");
  const resource = useResource(
    open ? `/operations/releases/cleanup/${encodeURIComponent(version)}/sessions` : null,
    { poll: 3000 },
  );
  const plan = resource.data;
  const sessions = plan?.sessions || [];
  const hasBusy = sessions.some(
    (session) =>
      !inFlight(session.reload) && session.eligible && session.activity !== "idle",
  );
  const ineligible = sessions.some((s) => !s.eligible && !inFlight(s.reload));
  return (
    <div className="operations-sessions">
      <button className="button secondary" onClick={() => setOpen((value) => !value)}>
        {copy.migrateSessions}
      </button>
      {open && (
        <>
          <ErrorMessage error={resource.error} />
          {resource.loading && <p role="status">{copy.migrateLoading}</p>}
          {plan && !sessions.length && <p>{copy.migrateEmpty}</p>}
          {sessions.length > 0 && (
            <ul aria-label={`Sessions: ${version}`}>
              {sessions.map((session) => (
                <li key={session.id}>
                  <strong>{session.name || session.id.slice(0, 8)}</strong> ·{" "}
                  {session.tool} · {stateLabel(session)}
                </li>
              ))}
            </ul>
          )}
          {plan?.nodeOnlyProcesses > 0 && (
            <p className="field-description">
              {copy.migrateNodeOnly(plan.nodeOnlyProcesses)}
            </p>
          )}
          {ineligible && <p>{copy.migrateIneligibleHint}</p>}
          {plan?.unidentifiedProcesses?.length > 0 && (
            <p>
              {copy.migrateUnidentifiedHint(
                plan.unidentifiedProcesses.map((item) => item.reference).join(", "),
              )}
            </p>
          )}
          <div className="operations-actions">
            <button
              className="button primary"
              disabled={busy || !plan?.migratable || Boolean(migrating)}
              onClick={() => setConfirm("migrate")}
            >
              {copy.migrateStart}
            </button>
            {hasBusy && (
              <button
                className="button secondary"
                disabled={busy || !plan?.migratable || Boolean(migrating)}
                onClick={() => setConfirm("interrupt")}
              >
                {copy.migrateInterrupt}
              </button>
            )}
            {migrating && (
              <button
                className="button secondary"
                onClick={async () => {
                  try {
                    await api(
                      `/operations/releases/cleanup/${encodeURIComponent(version)}/migrate`,
                      "DELETE",
                    );
                    onCancel?.();
                  } catch (error) {
                    setCancelError(error.message);
                  }
                }}
              >
                {copy.migrateCancel}
              </button>
            )}
          </div>
          <ErrorMessage error={cancelError} />
        </>
      )}
      {confirm && (
        <ConfirmOperation
          description={(confirm === "interrupt"
            ? copy.migrateInterruptConfirm
            : copy.migrateConfirm)(version, sessions.length)}
          close={() => setConfirm(null)}
          action={async () => {
            const result = await api(
              `/operations/releases/cleanup/${encodeURIComponent(version)}/migrate`,
              "POST",
              confirm === "interrupt" ? { interrupt: true } : {},
            );
            setConfirm(null);
            onMigrate(result.job.id);
          }}
        />
      )}
    </div>
  );
}
```

Note: `api()` sends a body only when `body` is truthy; `{}` is truthy, so the migrate request carries `{}` as the test expects.

- [ ] **Step 4: Update `ReleaseCleanup.jsx`**

Replace the file content with:

```jsx
import React, { useEffect, useState } from "react";
import useResource from "../../lib/useResource.js";
import api from "../../lib/api.js";
import ConfirmOperation from "./ConfirmOperation.jsx";
import ReleaseSessions from "./ReleaseSessions.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";

export default function ReleaseCleanup({ busy, job, navigate }) {
  const resource = useResource("/operations/releases/cleanup");
  const [selection, setSelection] = useState(null);
  const [migration, setMigration] = useState(null);
  const { refresh } = resource;
  const jobId = job?.id,
    jobStatus = job?.status;
  useEffect(() => {
    if (jobId && jobStatus !== "running") refresh();
  }, [jobId, jobStatus, refresh]);
  useEffect(() => {
    if (migration && jobId === migration.jobId && jobStatus && jobStatus !== "running")
      setMigration(null);
  }, [migration, jobId, jobStatus]);
  const versions =
    resource.data?.versions.filter((item) => item.deleteReason !== "active") || [];
  const removable = versions.filter((item) => item.canDelete).map((item) => item.version);
  return (
    <details className="operations-card">
      <summary>{copy.cleanupReleases}</summary>
      <p>{copy.cleanupHelp}</p>
      {(resource.error || resource.data?.available === false) && (
        <p>{copy.cleanupUnavailable}</p>
      )}
      <button
        className="button secondary"
        disabled={busy || !removable.length}
        onClick={() => setSelection(removable)}
      >
        {copy.cleanupAll}
      </button>
      {versions.map((item) => (
        <div className="operations-actions" key={item.version}>
          <strong>{item.version}</strong>
          {item.deleteReason && <span>{copy.cleanupReasons[item.deleteReason]}</span>}
          <button
            className="button secondary"
            disabled={busy || !item.canDelete}
            aria-label={`${copy.cleanupOne}: ${item.version}`}
            onClick={() => setSelection([item.version])}
          >
            {copy.cleanupOne}
          </button>
          {item.deleteReason === "inUse" && (
            <ReleaseSessions
              version={item.version}
              busy={busy}
              migrating={migration?.version === item.version}
              onMigrate={(id) => {
                setMigration({ version: item.version, jobId: id });
                navigate({ operationId: id });
              }}
              onCancel={() => setMigration(null)}
            />
          )}
        </div>
      ))}
      {selection && (
        <ConfirmOperation
          description={copy.cleanupConfirm(selection.join(", "))}
          close={() => setSelection(null)}
          action={async () => {
            const result = await api("/operations/releases/cleanup", "POST", {
              versions: selection,
            });
            setSelection(null);
            navigate({ operationId: result.job.id });
          }}
        />
      )}
    </details>
  );
}
```

- [ ] **Step 5: Pass `kind` from `OperationJob`**

In `web/features/operations/OperationJob.jsx` change the `onState` effect to:

```jsx
useEffect(() => {
  if (job?.id) onState?.({ id: job.id, status: job.status, kind: job.kind });
}, [job?.id, job?.status, job?.kind, onState]);
```

and add the migrate result rendering inside the `{job && (<>…</>)}` block, after the `healthConfirmed` paragraph:

```jsx
{
  job.kind === "release-migrate" && job.status === "succeeded" && (
    <p>{copy.migrateSucceeded(job.result?.reloadedSessions?.length || 0)}</p>
  );
}
{
  job.result?.failedSessions?.length > 0 && (
    <>
      <h3>{copy.migrateFailedSessions}</h3>
      <ul>
        {job.result.failedSessions.map((item) => (
          <li key={item.id}>
            {item.id.slice(0, 8)}
            {item.error ? `: ${item.error}` : ""}
          </li>
        ))}
      </ul>
    </>
  );
}
{
  job.result?.remaining?.length > 0 && (
    <>
      <h3>{copy.migrateRemaining}</h3>
      <ul>
        {job.result.remaining.map((item, index) => (
          <li key={`${item.reference}-${index}`}>{item.reference}</li>
        ))}
      </ul>
    </>
  );
}
```

- [ ] **Step 6: Run the browser spec**

Run: `npm run build && npx playwright test tests/browser/release-cleanup.spec.js`
Expected: PASS for both locales and both tests. Check `playwright.config.js` for whether a build is required before specs (look for `webServer`); run `npm run build` if the config serves `dist/`.

- [ ] **Step 7: Commit**

```bash
npx prettier --write web/features/operations/ReleaseSessions.jsx web/features/operations/ReleaseCleanup.jsx web/features/operations/OperationJob.jsx tests/browser/release-cleanup.spec.js
npx eslint web/features/operations/ReleaseSessions.jsx web/features/operations/ReleaseCleanup.jsx web/features/operations/OperationJob.jsx tests/browser/release-cleanup.spec.js
git add web/features/operations/ReleaseSessions.jsx web/features/operations/ReleaseCleanup.jsx web/features/operations/OperationJob.jsx tests/browser/release-cleanup.spec.js
git commit -m "feat: migrate blocking sessions from the release cleanup card

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011Saz1VDpLYk54p96dku1sj"
```

---

### Task 10: Activation checkbox

**Files:**

- Modify: `web/features/operations/ConfirmOperation.jsx`
- Modify: `web/features/operations/UpdatesPage.jsx`
- Test: `tests/browser/update-activate.spec.js` (new)

**Interfaces:**

- Consumes: copy `activateReload`, `activateReloadHelp` from Task 8; `POST /operations/releases/activate` accepting `reloadSessions` from Task 4.
- Produces: `ConfirmOperation({ description, action, close, children })`.

- [ ] **Step 1: Write the failing browser test**

Create `tests/browser/update-activate.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`update activation ${locale}`, () => {
    test.use({ locale, viewport: { width: 390, height: 844 } });
    test("activation offers to migrate sessions and rollback does not", async ({
      page,
    }) => {
      const en = locale === "en-GB";
      const state = await operationsFixture(page);
      state.releases.staged = [{ id: "staged-one", version: "1.1.0" }];
      await page.goto("/settings/updates");
      const activate = page.getByRole("button", {
        name: `${en ? "Activate staged release" : "Vorbereitete Version aktivieren"}: 1.1.0`,
        exact: true,
      });
      await activate.click();
      const checkbox = page.getByRole("checkbox", {
        name: en
          ? "Move running sessions to the new version afterwards"
          : "Laufende Sessions danach auf die neue Version umziehen",
      });
      await expect(checkbox).not.toBeChecked();
      await expect(page.getByRole("dialog")).toContainText(
        en ? "health check" : "Zustandsprüfung",
      );
      await page
        .getByRole("dialog")
        .getByRole("button", { name: en ? "Confirm" : "Bestätigen", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const first = state.calls.find(
        (call) => call.path === "/operations/releases/activate" && call.method === "POST",
      );
      expect(first.body).toEqual({ stagedId: "staged-one" });
      await page.goto("/settings/updates");
      await activate.click();
      await checkbox.check();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: en ? "Confirm" : "Bestätigen", exact: true })
        .click();
      const posts = state.calls.filter(
        (call) => call.path === "/operations/releases/activate" && call.method === "POST",
      );
      expect(posts.at(-1).body).toEqual({ stagedId: "staged-one", reloadSessions: true });
      await page.goto("/settings/updates");
      await page
        .getByText(
          en ? "Previous versions and rollback" : "Frühere Versionen und Rollback",
          { exact: true },
        )
        .click();
      await page
        .getByRole("button", {
          name: en ? "Roll back version" : "Version zurücksetzen",
          exact: true,
        })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByRole("checkbox")).toHaveCount(0);
    });
  });
}
```

If `state.calls` is not exposed by `operationsFixture`, check `tests/browser/operations-fixture.js`: it pushes `{ path, method, body }` into `state.calls` for every API call (first lines of the route handler). Adjust the property name only if it differs.

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test tests/browser/update-activate.spec.js`
Expected: FAIL — no checkbox in the dialog

- [ ] **Step 3: Add the `children` slot to `ConfirmOperation`**

In `web/features/operations/ConfirmOperation.jsx` change the signature to
`export default function ConfirmOperation({ description, action, close, children }) {`
and render `{children}` directly after `<p>{description}</p>`.

- [ ] **Step 4: Add the checkbox to `UpdatesPage`**

In `web/features/operations/UpdatesPage.jsx`:

Add `[reloadSessions, setReloadSessions] = useState(false)` to the `useState` declarations at the top of the component.

Reset it whenever a confirmation opens: in both `setConfirm({ kind: "activate", … })` and `setConfirm({ kind: "rollback", … })` call sites, wrap as:

```jsx
                onClick={() => {
                  setReloadSessions(false);
                  setConfirm({ kind: "activate", stagedId: staged.id, version: staged.version });
                }}
```

(and likewise for rollback with `{ kind: "rollback", version: release.version }`).

Replace the `ConfirmOperation` at the bottom with:

```jsx
{
  confirm && (
    <ConfirmOperation
      description={`${confirm.kind === "activate" ? copy.activateConfirmation : copy.rollbackConfirmation} ${confirm.version}`}
      close={() => setConfirm(null)}
      action={() =>
        start(
          confirm.kind,
          confirm.kind === "activate"
            ? {
                stagedId: confirm.stagedId,
                ...(reloadSessions ? { reloadSessions: true } : {}),
              }
            : { version: confirm.version },
        )
      }
    >
      {confirm.kind === "activate" && (
        <div className="operations-form">
          <label>
            <input
              type="checkbox"
              checked={reloadSessions}
              onChange={(event) => setReloadSessions(event.target.checked)}
            />{" "}
            {copy.activateReload}
          </label>
          <p className="field-description">{copy.activateReloadHelp}</p>
        </div>
      )}
    </ConfirmOperation>
  );
}
```

- [ ] **Step 5: Run the spec**

Run: `npm run build && npx playwright test tests/browser/update-activate.spec.js tests/browser/release-cleanup.spec.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
npx prettier --write web/features/operations/ConfirmOperation.jsx web/features/operations/UpdatesPage.jsx tests/browser/update-activate.spec.js
npx eslint web/features/operations/ConfirmOperation.jsx web/features/operations/UpdatesPage.jsx tests/browser/update-activate.spec.js
git add web/features/operations/ConfirmOperation.jsx web/features/operations/UpdatesPage.jsx tests/browser/update-activate.spec.js
git commit -m "feat: offer session migration when activating a release

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011Saz1VDpLYk54p96dku1sj"
```

---

### Task 11: Documentation and full verification

**Files:**

- Modify: `docs/installation.md` (section "Alte Versionen entfernen", around line 138)
- Modify: `docs/session-reload.md` (append a section)

- [ ] **Step 1: Update `docs/installation.md`**

Replace the paragraph beginning "Die aktive Version, vorbereitete neuere Versionen und Versionen mit laufenden Prozessen bleiben erhalten." with:

```markdown
Die aktive Version, vorbereitete neuere Versionen und Versionen mit laufenden Prozessen bleiben erhalten. Kann die bestehende Prozessprüfung über `ps` nicht zuverlässig ausgeführt werden, wird nichts gelöscht. Während einer Aktivierung, eines Rollbacks oder eines Session-Umzugs ist das Aufräumen gesperrt. Die Funktion verändert weder Sitzungsdaten noch Profile.

#### Sessions umziehen

Eine Version mit laufenden Prozessen zeigt über **Sessions anzeigen** die AgentPier-Sessions, die sie halten, mit ihrem Zustand: bereit, beschäftigt, Zustand unbekannt, wird neu geladen oder nicht neu ladbar. **Sessions umziehen und Version löschen** lädt jede Session mit [Reload & resume](session-reload.md) auf die aktive Version neu und löscht die Version, sobald die letzte Session umgezogen ist. Beschäftigte Sessions ziehen erst nach Abschluss ihres aktuellen Schritts um; Sessions mit unbekanntem Zustand warten, bis das CLI erkennbar bereit ist. **Sofort umziehen und löschen** startet alle Sessions nach Bestätigung sofort neu und bricht laufende Arbeit ab. Ein laufender Umzug lässt sich abbrechen; bereits angestoßene Reloads laufen dann eigenständig weiter, die Version bleibt erhalten.

Sessions, die nicht neu geladen werden können (Pipeline-, Login-, Shell- oder unverifizierte Sessions), müssen manuell beendet werden. Prozesse außerhalb einer Session, etwa ein laufender Pipeline-Supervisor oder der Release-Helfer, blockieren den Umzug und werden mit ihrem Pfad genannt. Node-Prozesse, die nur das Node-Binary der Version nutzen, blockieren nicht; sie werden nach dem Umzug erneut geprüft. Verwenden nach dem Umzug weiterhin Prozesse die Version, bleibt sie erhalten und der Vorgang nennt die verbleibenden Verweise.

Beim Aktivieren einer vorbereiteten Version bietet die Bestätigung **Laufende Sessions danach auf die neue Version umziehen** an. Der Umzug beginnt erst, nachdem die neue Version ihre Zustandsprüfung bestanden hat, und unterbricht nichts. Schlägt die Aktivierung fehl oder wird sie zurückgerollt, findet kein Umzug statt.
```

- [ ] **Step 2: Update `docs/session-reload.md`**

Append:

```markdown
## Release migration

**Settings → Updates → Remove old versions** uses the same reload to move sessions off an old application release before deleting it. The same exclusions apply: login, shell, pipeline and imported historical sessions cannot be reloaded and must be stopped by hand. A session whose CLI activity cannot be identified keeps waiting until it is recognisably idle; a reload waiting for hook or project approval keeps the migration open until you approve it in the terminal or cancel the migration. Cancelling the migration never cancels reloads that are already running.
```

- [ ] **Step 3: Run the full check**

Run:

```bash
npm run check 2>&1 | tail -25
npx playwright test tests/browser/release-cleanup.spec.js tests/browser/update-activate.spec.js tests/browser/session-reload.spec.js
```

Expected: lint, format, structure and build pass; `npm test` reports only the two pre-existing environment failures (`api.test.js` deep links — passes once `npm run build` has produced `dist/`, which `npm run check` does before `npm test` — and `shell.test.js` local shell), all browser specs pass. If `npm test` shows any other failure, fix it before continuing.

- [ ] **Step 4: Commit**

```bash
npx prettier --write docs/installation.md docs/session-reload.md
git add docs/installation.md docs/session-reload.md
git commit -m "docs: describe release session migration

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011Saz1VDpLYk54p96dku1sj"
```

- [ ] **Step 5: Final review against the spec**

Walk through the spec's "Error handling summary" table and confirm each row maps to a test in `tests/integration/release-session-migration.test.js` or `operations-activate-flag.test.js`. Then invoke `superpowers:finishing-a-development-branch`.
