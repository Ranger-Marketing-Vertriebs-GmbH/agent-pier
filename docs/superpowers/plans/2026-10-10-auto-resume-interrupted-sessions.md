# Auto-resume Interrupted Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions whose tmux server disappears (host reboot or killed server) resume their native conversation automatically, one at a time, once per interruption.

**Architecture:** `SessionManager.current()` classifies a running→stopped transition as an interruption only when the session's tmux server is gone or replaced (identity = server pid + start time recorded at launch) and persists `session.interruption`. A new `SessionAutoResume` service drains pending interruptions through the existing `SessionReload.request(..., { mode: "now" })`. A preference toggles it; the session view shows failed or skipped resumes.

**Tech Stack:** Node.js 22 ES modules, Express, tmux, React/Vite, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-10-auto-resume-interrupted-sessions-design.md`

## Global Constraints

- Interruption marker shape: `{ cause: "tmux-server-lost", at: <ISO>, resume: "pending" | "started" | "failed" | "skipped", reason?: <stable code> }`.
- Reason codes (stable identifiers, translated in the UI): `unsupported-session`, `native-session-unverified`, `prepare-failed`, `reload-failed`, `timeout`, `attempt-interrupted`.
- A successful replacement (manual or automatic reload) deletes `session.interruption`; a user stop deletes it too.
- Preference key `autoResumeInterrupted`, boolean, default `true`.
- Audit: action `session.restored`, source `system`, outcome `success`/`failure`, details `{ tool }`.
- Every UI text in German and English with identical keys (`web/lib/i18n/de/`, `web/lib/i18n/en/`); no hardcoded copy.
- Tests use isolated data directories and their own tmux socket; never the default tmux server.
- Files checked by `check:structure` stay ≤ 600 lines.
- Run every command from the worktree root. Split compound shell commands into single commands.

## Review Focus

1. A session whose CLI exits on its own (dead pane, `remain-on-exit on`) must never be marked interrupted — Task 1 test "dead pane exit is no interruption".
2. A user stop followed by a later server loss must stay stopped — Task 2 test "a stopped session is not marked when the server dies later".
3. `onInterrupted` must not be awaited inside the per-session lock, or the resume service deadlocks on `sessions.get()` — Task 1 test "interruption callback runs after the lock is released".
4. A server restart during a resume attempt must not retry it (no loop on a crashing CLI) — Task 4 test "an attempt cut off by a restart is not repeated".
5. With the setting off, interruptions stay visible but nothing relaunches — Task 4 test "disabled setting leaves interruptions pending".

---

### Task 1: Interruption detection in `SessionManager`

**Files:**

- Create: `server/features/sessions/tmux-server-identity.js`
- Modify: `server/features/sessions/session-manager.js` (constructor, `current()`, `create()`, `stop()`, new `setInterruption()`)
- Test: `tests/unit/session-interruption.test.js`

**Interfaces:**

- Produces: `tmuxServerGone(message: string): boolean`, `readTmuxServer(manager): Promise<{pid:number,startTime:number}|null>`, `sameTmuxServer(a, b): boolean`.
- Produces: `SessionManager#onInterrupted` (assignable callback, default no-op, called with a session copy, never awaited), `SessionManager#setInterruption(id, interruption|null): Promise<session>`.
- Produces: `session.tmuxServer = { pid, startTime }` after `create()`.

- [ ] **Step 1: Write the failing unit tests**

```js
// tests/unit/session-interruption.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "../../server/features/sessions/session-manager.js";

async function fixture(t, initial = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentpier-interruption-"));
  const manager = new SessionManager({ dataDir });
  const interrupted = [];
  manager.onInterrupted = (session) => interrupted.push(session.id);
  await manager.ready;
  await manager.save({
    id: "owned-fixture",
    status: "running",
    createdAt: "2026-10-10T00:00:00.000Z",
    ...initial,
  });
  // Model tmux at the subprocess boundary; no native server is started.
  const tmux = {
    panes: "0||",
    paneError: null,
    server: "100|1700000000",
    serverError: null,
  };
  t.mock.method(manager, "tmux", async (args) => {
    if (args[0] === "list-sessions") {
      if (tmux.serverError) throw new Error(tmux.serverError);
      return tmux.server + "\n";
    }
    if (["capture-pane", "kill-session", "run-shell"].includes(args[0])) return "";
    assert.equal(args[0], "list-panes");
    if (tmux.paneError) throw new Error(tmux.paneError);
    return tmux.panes + "\n";
  });
  t.after(async () => {
    await manager.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(path.dirname(manager.socketPath), { recursive: true, force: true });
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { manager, tmux, interrupted, settle, read: () => manager.get("owned-fixture") };
}

test("an unreachable tmux server marks a running session as interrupted", async (t) => {
  const { tmux, interrupted, settle, read } = await fixture(t);
  tmux.paneError = "no server running on /tmp/tuiui-501-x/tmux.sock";
  const session = await read();
  assert.equal(session.status, "stopped");
  assert.equal(session.interruption.cause, "tmux-server-lost");
  assert.equal(session.interruption.resume, "pending");
  assert.ok(!Number.isNaN(Date.parse(session.interruption.at)));
  await settle();
  assert.deepEqual(interrupted, ["owned-fixture"]);
  await read();
  await settle();
  assert.deepEqual(interrupted, ["owned-fixture"]);
});

test("a missing session on a replaced tmux server is an interruption", async (t) => {
  const { tmux, read } = await fixture(t, {
    tmuxServer: { pid: 100, startTime: 1700000000 },
  });
  tmux.paneError = "can't find session: tuiui-owned-fixture";
  tmux.server = "100|1790000000"; // Same pid after a reboot, new start time.
  assert.equal((await read()).interruption?.resume, "pending");
});

test("a missing session on the same tmux server is no interruption", async (t) => {
  const { tmux, interrupted, settle, read } = await fixture(t, {
    tmuxServer: { pid: 100, startTime: 1700000000 },
  });
  tmux.paneError = "can't find session: tuiui-owned-fixture";
  const session = await read();
  assert.equal(session.status, "stopped");
  assert.equal(session.interruption, undefined);
  await settle();
  assert.deepEqual(interrupted, []);
});

test("dead pane exit is no interruption", async (t) => {
  const { tmux, read } = await fixture(t);
  tmux.panes = "1|0|";
  const session = await read();
  assert.equal(session.status, "stopped");
  assert.equal(session.interruption, undefined);
});

test("interruption callback runs after the lock is released", async (t) => {
  const { manager, tmux, read } = await fixture(t);
  let reread;
  manager.onInterrupted = (session) => {
    reread = manager.get(session.id); // Would deadlock if called inside the lock.
  };
  tmux.paneError = "no server running";
  await read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await reread).interruption.resume, "pending");
});

test("a user stop clears the interruption and setInterruption persists changes", async (t) => {
  const { manager, read } = await fixture(t);
  await manager.setInterruption("owned-fixture", {
    cause: "tmux-server-lost",
    at: "2026-10-10T00:00:00.000Z",
    resume: "failed",
    reason: "timeout",
  });
  assert.equal((await manager.metadata("owned-fixture")).interruption.reason, "timeout");
  await manager.stop("owned-fixture");
  assert.equal((await read()).interruption, undefined);
  await manager.setInterruption("owned-fixture", null);
  assert.equal((await manager.metadata("owned-fixture")).interruption, undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/session-interruption.test.js`
Expected: FAIL — `interruption` is `undefined` and `setInterruption` is not a function.

- [ ] **Step 3: Create the identity helper**

```js
// server/features/sessions/tmux-server-identity.js
// Errors that mean the whole tmux server is gone, not one session or pane.
const SERVER_GONE = /no server running|failed to connect|error connecting|no such file/i;

export function tmuxServerGone(message) {
  return SERVER_GONE.test(String(message || ""));
}

/** pid alone is reused after a reboot; the start time makes the identity unique. */
export async function readTmuxServer(manager) {
  let output;
  try {
    output = await manager.tmux(["list-sessions", "-F", "#{pid}|#{start_time}"]);
  } catch (error) {
    if (tmuxServerGone(error.message)) return null;
    throw error;
  }
  const [pid, startTime] = String(output).split("\n")[0].trim().split("|");
  return /^\d+$/.test(pid) && /^\d+$/.test(startTime)
    ? { pid: Number(pid), startTime: Number(startTime) }
    : null;
}

export function sameTmuxServer(a, b) {
  return !!a && !!b && a.pid === b.pid && a.startTime === b.startTime;
}
```

- [ ] **Step 4: Wire detection into `SessionManager`**

In `server/features/sessions/session-manager.js`:

1. Import: `import { readTmuxServer, sameTmuxServer, tmuxServerGone } from "./tmux-server-identity.js";`
2. Constructor, after `this.onRemoving = onRemoving;`: `this.onInterrupted = () => {};`
3. Add a method next to `reconcileStopped`:

```js
  async serverLost(session, error) {
    if (session.status !== "running") return false;
    if (tmuxServerGone(error.message)) return true;
    if (!session.tmuxServer) return false;
    return !sameTmuxServer(session.tmuxServer, await readTmuxServer(this).catch(() => null));
  }
```

4. In `current()`: declare `let lost = false;` next to `let state;`. In the `catch` block, after `state = null;` add `lost = await this.serverLost(session, error);`.
5. Replace the block `if (session.status !== status || (exit !== undefined && session.exitCode !== exit)) { ... }` with:

```js
let interrupted = false;
if (session.status !== status || (exit !== undefined && session.exitCode !== exit)) {
  if (lost && status === "stopped") {
    session.interruption = {
      cause: "tmux-server-lost",
      at: new Date().toISOString(),
      resume: "pending",
    };
    interrupted = true;
  }
  session.status = status;
  if (exit !== undefined && Number.isFinite(exit)) session.exitCode = exit;
  if (state !== null && status === "stopped") await this.remember(id);
  await this.save(session);
}
if (interrupted) {
  // Never call back inside the per-session lock: the callback reads sessions.
  const copy = structuredClone(session);
  setImmediate(() => Promise.resolve(this.onInterrupted(copy)).catch(() => {}));
}
```

6. In `create()`, after the `try { await this.tmux(["new-session", ...]) } catch { ... }` block and before `return session;`:

```js
const server = await readTmuxServer(this).catch(() => null);
if (server) {
  session.tmuxServer = server;
  await this.save(session);
}
```

7. In `stop()`, after `session.status = "stopped";` add `delete session.interruption;`.
8. Add after `updateReload`:

```js
  setInterruption(id, interruption) {
    return this.serial(async () => {
      const session = await this.metadata(id);
      if (interruption) session.interruption = interruption;
      else delete session.interruption;
      await this.save(session);
      return session;
    }, id);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/unit/session-interruption.test.js tests/unit/session-exit-state.test.js`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add server/features/sessions/tmux-server-identity.js server/features/sessions/session-manager.js tests/unit/session-interruption.test.js
git commit -m "feat: detect sessions interrupted by a lost tmux server"
```

### Task 2: Replacement records the new server and clears the interruption (real tmux)

**Files:**

- Modify: `server/features/sessions/session-replacement.js` (after the `new-session` call)
- Test: `tests/integration/session-interruption.test.js`

**Interfaces:**

- Consumes: `readTmuxServer`, `sameTmuxServer` (Task 1), `SessionManager#onInterrupted`.
- Produces: after `manager.replace()`, `session.tmuxServer` is the new identity and `session.interruption` is absent.

- [ ] **Step 1: Write the failing integration tests**

```js
// tests/integration/session-interruption.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "../../server/features/sessions/session-manager.js";

const launch = { command: "/bin/sh", args: ["-c", "sleep 120"], env: {} };
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ap-interruption-"));
  const manager = new SessionManager({ dataDir });
  const interrupted = [];
  manager.onInterrupted = (session) => interrupted.push(session.id);
  t.after(async () => {
    await manager.close();
    await manager.tmux(["kill-server"]).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
    await rm(path.dirname(manager.socketPath), { recursive: true, force: true });
  });
  const create = (id) =>
    manager.create({
      id,
      name: id,
      tool: "codex",
      accountId: "a",
      cwd: dataDir,
      ...launch,
    });
  return { manager, interrupted, create };
}

test("a killed tmux server marks every running session as interrupted", async (t) => {
  const { manager, interrupted, create } = await fixture(t);
  const one = await create("lost-one");
  await create("lost-two");
  assert.equal(typeof one.tmuxServer.pid, "number");
  assert.equal(typeof one.tmuxServer.startTime, "number");
  await manager.tmux(["kill-server"]);
  for (const id of ["lost-one", "lost-two"]) {
    const session = await manager.get(id);
    assert.equal(session.status, "stopped");
    assert.equal(session.interruption.resume, "pending");
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(interrupted.sort(), ["lost-one", "lost-two"]);
});

test("a stopped session is not marked when the server dies later", async (t) => {
  const { manager, create } = await fixture(t);
  await create("kept-stopped");
  await create("still-running");
  await manager.stop("kept-stopped");
  await manager.tmux(["kill-server"]);
  assert.equal((await manager.get("kept-stopped")).interruption, undefined);
  assert.equal((await manager.get("still-running")).interruption.resume, "pending");
});

test("a replacement after an interruption records the new server and clears the marker", async (t) => {
  const { manager, create } = await fixture(t);
  const before = await create("replaced");
  await manager.tmux(["kill-server"]);
  assert.equal((await manager.get("replaced")).interruption.resume, "pending");
  await manager.updateReload("replaced", { state: "reloading", nativeId: "native" });
  const after = await manager.replace("replaced", async () => launch);
  assert.equal(after.status, "running");
  assert.equal(after.interruption, undefined);
  assert.notDeepEqual(after.tmuxServer, before.tmuxServer);
  assert.equal((await manager.metadata("replaced")).interruption, undefined);
});
```

- [ ] **Step 2: Run the tests to verify the replacement test fails**

Run: `node --test tests/integration/session-interruption.test.js`
Expected: the first two tests PASS (Task 1), the third FAILS — `interruption` still present after `replace`.

- [ ] **Step 3: Update `replaceSession`**

In `server/features/sessions/session-replacement.js`, import `import { readTmuxServer } from "./tmux-server-identity.js";`. After the `await manager.tmux(["new-session", ...])` call and before the `for (const key of [...])` loop insert:

```js
const server = await readTmuxServer(manager).catch(() => null);
if (server) session.tmuxServer = server;
delete session.interruption;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/integration/session-interruption.test.js tests/integration/session-replacement.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add server/features/sessions/session-replacement.js tests/integration/session-interruption.test.js
git commit -m "feat: clear interruptions when a session is relaunched"
```

### Task 3: `autoResumeInterrupted` preference

**Files:**

- Modify: `server/features/settings/preferences.js` (`get()`, `update()`)
- Test: `tests/integration/preferences.test.js`, plus every existing `deepEqual` on `Preferences#get()` or `GET /preferences`

**Interfaces:**

- Produces: `preferences.get().autoResumeInterrupted: boolean` (default `true`); `PATCH /preferences` accepts `{ autoResumeInterrupted: boolean }`. `GET /state` exposes it through the existing `...preferences.get()` spread.

- [ ] **Step 1: Write the failing test** (append to `tests/integration/preferences.test.js`)

```js
test("automatic resume of interrupted sessions defaults on and persists a boolean", async (t) => {
  const dir = directory(t);
  const prefs = new Preferences({ dataDir: dir, home: dir });
  assert.equal(prefs.get().autoResumeInterrupted, true);
  await prefs.update({ autoResumeInterrupted: false });
  assert.equal(
    new Preferences({ dataDir: dir, home: dir }).get().autoResumeInterrupted,
    false,
  );
  for (const autoResumeInterrupted of ["false", 0, null])
    await assert.rejects(() => prefs.update({ autoResumeInterrupted }));
  await prefs.update({ autoResumeInterrupted: true });
  assert.equal(prefs.get().autoResumeInterrupted, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/integration/preferences.test.js`
Expected: FAIL — `autoResumeInterrupted` is `undefined`.

- [ ] **Step 3: Implement**

In `preferences.js`:

- `get()` returns `{ defaultCwd: ..., defaultAccountIds, autoResumeInterrupted: this.value.autoResumeInterrupted !== false }`.
- In `update()`, allow the key: `!["defaultCwd", "defaultAccountIds", "autoResumeInterrupted"].includes(key)`; after the key check add:

```js
if (
  Object.hasOwn(body, "autoResumeInterrupted") &&
  typeof body.autoResumeInterrupted !== "boolean"
)
  throw problem(serverMessages.settings.invalidPreferences);
```

- In the merge section: `if (Object.hasOwn(body, "autoResumeInterrupted")) next.autoResumeInterrupted = body.autoResumeInterrupted;`

- [ ] **Step 4: Update existing exact-shape assertions**

Run: `grep -rn "defaultAccountIds: {}" tests/integration tests/unit`
For each `assert.deepEqual(<prefs>.get() | <GET /preferences body>, { defaultCwd: ..., defaultAccountIds: ... })`, add `autoResumeInterrupted: true` to the expected object.

- [ ] **Step 5: Run to verify**

Run: `node --test tests/integration/preferences.test.js tests/integration/default-accounts.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/features/settings/preferences.js tests/integration/preferences.test.js tests/integration/default-accounts.test.js
git commit -m "feat: add preference for resuming interrupted sessions"
```

### Task 4: `SessionAutoResume` service and wiring

**Files:**

- Create: `server/features/sessions/session-auto-resume.js`
- Modify: `server/app.js` (create + start on `listening`), `server/application/shutdown.js` (close)
- Test: `tests/unit/session-auto-resume.test.js`

**Interfaces:**

- Consumes: `sessions.list()`, `sessions.get(id)`, `sessions.setInterruption(id, value|null)` (Task 1), `reload.status(id) → { eligible, reason, state }`, `reload.request(id, { requestId, mode: "now" }) → { state }`, `audit.append(event)`, `preferences.get().autoResumeInterrupted` (Task 3).
- Produces: `new SessionAutoResume({ services, enabled, timeoutMs = 120000, pollMs = 1000 })`, `initialize(): Promise`, `notify(): Promise`, `close(): Promise`.

- [ ] **Step 1: Write the failing unit tests**

```js
// tests/unit/session-auto-resume.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { SessionAutoResume } from "../../server/features/sessions/session-auto-resume.js";

const at = (minute) => `2026-10-10T10:${String(minute).padStart(2, "0")}:00.000Z`;
const interrupted = (id, minute, extra = {}) => ({
  id,
  tool: "claude",
  status: "stopped",
  interruption: { cause: "tmux-server-lost", at: at(minute), resume: "pending" },
  ...extra,
});

function fixture(list, { status = {}, request, enabled = () => true } = {}) {
  const store = new Map(list.map((session) => [session.id, structuredClone(session)]));
  const calls = [];
  const audit = [];
  let active = 0;
  let maxActive = 0;
  const complete = (session) => {
    session.status = "running";
    delete session.interruption;
    return { state: "completed" };
  };
  const services = {
    sessions: {
      list: async () => [...store.values()].map((session) => structuredClone(session)),
      get: async (id) => {
        if (!store.has(id)) throw Object.assign(new Error("gone"), { status: 404 });
        return structuredClone(store.get(id));
      },
      setInterruption: async (id, value) => {
        const session = store.get(id);
        if (value) session.interruption = value;
        else delete session.interruption;
        return structuredClone(session);
      },
    },
    reload: {
      status: async (id) => ({
        eligible: true,
        reason: null,
        state: store.get(id).reloadState || "idle",
        ...status[id],
      }),
      request: async (id, body) => {
        calls.push({ id, body, started: store.get(id).interruption?.resume });
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return request ? request(store.get(id)) : complete(store.get(id));
      },
    },
    audit: { append: (event) => audit.push(event) },
  };
  const resume = new SessionAutoResume({ services, enabled, timeoutMs: 30, pollMs: 1 });
  return { resume, store, calls, audit, maxActive: () => maxActive };
}

test("pending interruptions resume oldest first, one at a time, with a fresh request", async () => {
  const { resume, store, calls, audit, maxActive } = fixture([
    interrupted("late", 5),
    interrupted("early", 1),
  ]);
  await resume.initialize();
  assert.deepEqual(
    calls.map((call) => call.id),
    ["early", "late"],
  );
  assert.equal(maxActive(), 1);
  for (const call of calls) {
    assert.equal(call.body.mode, "now");
    assert.match(call.body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(call.started, "started");
  }
  assert.equal(store.get("early").status, "running");
  assert.equal(store.get("early").interruption, undefined);
  assert.deepEqual(
    audit.map((event) => [
      event.action,
      event.outcome,
      event.sessionId,
      event.details.tool,
    ]),
    [
      ["session.restored", "success", "early", "claude"],
      ["session.restored", "success", "late", "claude"],
    ],
  );
});

test("only pending interruptions of stopped sessions are resumed", async () => {
  const { resume, calls } = fixture([
    { id: "plain-stop", tool: "claude", status: "stopped" },
    interrupted("running", 1, { status: "running" }),
    interrupted("failed-before", 2, {
      interruption: { cause: "tmux-server-lost", at: at(2), resume: "failed" },
    }),
  ]);
  await resume.initialize();
  assert.deepEqual(calls, []);
});

test("an attempt cut off by a restart is not repeated", async () => {
  const { resume, store, calls, audit } = fixture([
    interrupted("cut-off", 1, {
      interruption: { cause: "tmux-server-lost", at: at(1), resume: "started" },
    }),
  ]);
  await resume.initialize();
  assert.deepEqual(calls, []);
  assert.equal(store.get("cut-off").interruption.resume, "failed");
  assert.equal(store.get("cut-off").interruption.reason, "attempt-interrupted");
  assert.equal(audit[0].outcome, "failure");
});

test("ineligible sessions are skipped with the reload reason", async () => {
  const { resume, store, calls } = fixture([interrupted("pipeline", 1)], {
    status: { pipeline: { eligible: false, reason: "unsupported-session" } },
  });
  await resume.initialize();
  assert.deepEqual(calls, []);
  assert.equal(store.get("pipeline").interruption.resume, "skipped");
  assert.equal(store.get("pipeline").interruption.reason, "unsupported-session");
});

test("preparation errors, failed reloads and timeouts are recorded as failures", async () => {
  const cases = [
    [() => Promise.reject(new Error("binary missing")), "prepare-failed"],
    [() => ({ state: "failed" }), "reload-failed"],
    [
      (session) => {
        session.reloadState = "reloading";
        return { state: "reloading" };
      },
      "timeout",
    ],
  ];
  for (const [request, reason] of cases) {
    const { resume, store, audit } = fixture([interrupted("broken", 1)], { request });
    await resume.initialize();
    assert.equal(store.get("broken").interruption.resume, "failed");
    assert.equal(store.get("broken").interruption.reason, reason);
    assert.equal(audit.at(-1).outcome, "failure");
  }
});

test("disabled setting leaves interruptions pending until it is enabled", async () => {
  let enabled = false;
  const { resume, store, calls } = fixture([interrupted("waiting", 1)], {
    enabled: () => enabled,
  });
  await resume.initialize();
  assert.deepEqual(calls, []);
  assert.equal(store.get("waiting").interruption.resume, "pending");
  enabled = true;
  await resume.notify();
  assert.deepEqual(
    calls.map((call) => call.id),
    ["waiting"],
  );
});

test("concurrent notifications resume each session once", async () => {
  const { resume, calls } = fixture([interrupted("once", 1)]);
  await Promise.all([resume.notify(), resume.notify(), resume.notify()]);
  assert.deepEqual(
    calls.map((call) => call.id),
    ["once"],
  );
});

test("closing stops further resumes", async () => {
  const { resume, calls } = fixture([interrupted("one", 1), interrupted("two", 2)]);
  await resume.close();
  await resume.notify();
  assert.deepEqual(calls, []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/unit/session-auto-resume.test.js`
Expected: FAIL — module `session-auto-resume.js` not found.

- [ ] **Step 3: Implement the service**

```js
// server/features/sessions/session-auto-resume.js
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const IN_PROGRESS = ["waiting", "reloading"];

/** Resumes sessions whose tmux server was lost: oldest first, one at a time, once each. */
export class SessionAutoResume {
  constructor({ services, enabled = () => true, timeoutMs = 120_000, pollMs = 1000 }) {
    this.services = services;
    this.enabled = enabled;
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
    this.queue = Promise.resolve();
    this.closed = false;
  }
  async initialize() {
    // An attempt that a restart cut off is not repeated; a crashing CLI must not loop.
    for (const session of await this.services.sessions.list())
      if (session.interruption?.resume === "started")
        await this.finish(session, "failure", {
          ...session.interruption,
          resume: "failed",
          reason: "attempt-interrupted",
        });
    return this.notify();
  }
  notify() {
    const next = this.queue.then(() => this.drain());
    this.queue = next.catch(() => {});
    return next;
  }
  async drain() {
    if (this.closed || !this.enabled()) return;
    const pending = (await this.services.sessions.list())
      .filter((s) => s.status === "stopped" && s.interruption?.resume === "pending")
      .sort((a, b) => a.interruption.at.localeCompare(b.interruption.at));
    for (const { id } of pending) {
      if (this.closed || !this.enabled()) return;
      await this.resume(id);
    }
  }
  async resume(id) {
    const { sessions, reload } = this.services;
    let session;
    try {
      session = await sessions.get(id);
    } catch (error) {
      if (error.status === 404) return;
      throw error;
    }
    if (session.status !== "stopped" || session.interruption?.resume !== "pending")
      return;
    const interruption = { ...session.interruption, resume: "started" };
    await sessions.setInterruption(id, interruption);
    const status = await reload.status(id);
    if (!status.eligible)
      return this.finish(session, "failure", {
        ...interruption,
        resume: "skipped",
        reason: status.reason || "unsupported-session",
      });
    let result;
    try {
      result = await reload.request(id, { requestId: randomUUID(), mode: "now" });
      const deadline = Date.now() + this.timeoutMs;
      while (
        IN_PROGRESS.includes(result.state) &&
        Date.now() < deadline &&
        !this.closed
      ) {
        await delay(this.pollMs);
        result = await reload.status(id);
      }
    } catch {
      return this.finish(session, "failure", {
        ...interruption,
        resume: "failed",
        reason: "prepare-failed",
      });
    }
    // A completed replacement already removed the marker.
    if (result.state === "completed") return this.finish(session, "success", null);
    return this.finish(session, "failure", {
      ...interruption,
      resume: "failed",
      reason: result.state === "failed" ? "reload-failed" : "timeout",
    });
  }
  async finish(session, outcome, interruption) {
    if (interruption)
      await this.services.sessions.setInterruption(session.id, interruption);
    try {
      this.services.audit?.append({
        action: "session.restored",
        resourceType: "session",
        resourceId: session.id,
        sessionId: session.id,
        source: "system",
        outcome,
        details: { tool: session.tool },
      });
    } catch {
      /* The audit trail is supplemental; the session marker stays authoritative. */
    }
  }
  async close() {
    this.closed = true;
    await this.queue;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/unit/session-auto-resume.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Wire it into the application**

`server/app.js`: import `import { SessionAutoResume } from "./features/sessions/session-auto-resume.js";`. After `services.reload = new SessionReload({ services }); await services.reload.initialize();` add:

```js
services.autoResume = new SessionAutoResume({
  services,
  enabled: () => services.preferences.get().autoResumeInterrupted,
});
```

Next to the existing `server.once("listening", () => services.mcpAccess.initialize());` add (resume needs session MCP access, which initializes on listening):

```js
server.once("listening", () => {
  const report = (error) =>
    console.error(
      `AgentPier could not resume interrupted sessions: ${error?.code || error?.message || "unknown error"}`,
    );
  services.sessions.onInterrupted = () => services.autoResume.notify().catch(report);
  services.autoResume.initialize().catch(report);
});
```

`server/application/shutdown.js`: before `await services.reload?.close();` add `await services.autoResume?.close();`.

- [ ] **Step 6: Run the application tests**

Run: `node --test tests/integration/api.test.js tests/unit/session-auto-resume.test.js`
Expected: PASS (`api.test.js` deep links need `dist/`; run `npm run build` first if they fail with a missing build).

- [ ] **Step 7: Commit**

```bash
git add server/features/sessions/session-auto-resume.js server/app.js server/application/shutdown.js tests/unit/session-auto-resume.test.js
git commit -m "feat: resume interrupted sessions automatically"
```

### Task 5: End-to-end resume over a real tmux server

**Files:**

- Test: `tests/integration/session-auto-resume.test.js`

**Interfaces:**

- Consumes: real `SessionManager` (Tasks 1–2), real `SessionReload` (`server/features/sessions/session-reload.js`), `SessionAutoResume` (Task 4). Reload dependencies that need provider CLIs are replaced at the service boundary.

- [ ] **Step 1: Write the test**

```js
// tests/integration/session-auto-resume.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "../../server/features/sessions/session-manager.js";
import { SessionReload } from "../../server/features/sessions/session-reload.js";
import { SessionAutoResume } from "../../server/features/sessions/session-auto-resume.js";

test("sessions on a killed tmux server come back with their own conversation", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ap-auto-resume-"));
  const sessions = new SessionManager({ dataDir });
  t.after(async () => {
    await sessions.close();
    await sessions.tmux(["kill-server"]).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
    await rm(path.dirname(sessions.socketPath), { recursive: true, force: true });
  });
  const cli = (id, args) => ({
    command: "/bin/sh",
    args: [
      "-c",
      `printf '%s\\n' "$*" > '${path.join(dataDir, id)}.args'; sleep 120`,
      "cli",
      ...args,
    ],
    env: {},
  });
  const services = {
    sessions,
    activity: { read: async () => ({ state: "idle" }), remove() {} },
    bindings: { resolve: async (session) => ({ id: `native-${session.id}` }) },
    prepareReload: async (session, nativeId) => ({
      nativeId,
      launch: cli(session.id, ["--resume", nativeId]),
    }),
    restartReload: (session, plan) =>
      sessions.replace(session.id, async () => plan.launch),
  };
  const reload = new SessionReload({ services, pollMs: 0 });
  await reload.initialize();
  const audit = [];
  const autoResume = new SessionAutoResume({
    services: { sessions, reload, audit: { append: (event) => audit.push(event) } },
    pollMs: 20,
  });
  for (const id of ["first", "second", "stopped-by-user"])
    await sessions.create({
      id,
      name: id,
      tool: "claude",
      accountId: "a",
      cwd: dataDir,
      ...cli(id, []),
    });
  await sessions.stop("stopped-by-user");
  await sessions.tmux(["kill-server"]);
  await sessions.list(); // Observes the lost server, as the operations poll does.
  await autoResume.initialize();
  for (const id of ["first", "second"]) {
    const session = await sessions.get(id);
    assert.equal(session.status, "running");
    assert.equal(session.interruption, undefined);
    for (let n = 0; n < 50; n++) {
      const args = await readFile(path.join(dataDir, `${id}.args`), "utf8").catch(
        () => "",
      );
      if (args.includes("--resume")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      (await readFile(path.join(dataDir, `${id}.args`), "utf8")).trim(),
      `--resume native-${id}`,
    );
  }
  assert.equal((await sessions.get("stopped-by-user")).status, "stopped");
  assert.deepEqual(
    audit.map((event) => [event.sessionId, event.outcome]),
    [
      ["first", "success"],
      ["second", "success"],
    ],
  );
  await autoResume.close();
  await reload.close();
});
```

- [ ] **Step 2: Run it**

Run: `node --test tests/integration/session-auto-resume.test.js`
Expected: PASS. If it fails, the failure points to a gap in Tasks 1, 2 or 4; fix the production code there, not the test. In particular, if `SessionReload.inspect()` rejects the stopped session, verify `bindings.resolve` is consulted for stopped sessions (`session-reload.js`, `inspect`).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/session-auto-resume.test.js
git commit -m "test: cover automatic resume after a lost tmux server"
```

### Task 6: Settings toggle and interruption notice

**Files:**

- Create: `web/features/settings/SessionRecoverySettings.jsx`
- Modify: `web/features/settings/DirectorySettings.jsx` (render the new section after `<DirectoryForm …/>`)
- Modify: `web/features/sessions/SessionWorkspace.jsx` (notice next to the reload notice, around line 208)
- Modify: `web/lib/i18n/de/settings.js`, `web/lib/i18n/en/settings.js`, `web/lib/i18n/de/sessions.js`, `web/lib/i18n/en/sessions.js`, `web/lib/i18n/messages/sessions.js`
- Test: `tests/browser/session-auto-resume.spec.js`

**Interfaces:**

- Consumes: `state.autoResumeInterrupted` from `GET /state`, `PATCH /preferences { autoResumeInterrupted }` (Task 3), `session.interruption` (Tasks 1, 4).
- Produces: `sessionInterruptionCopy` export in `web/lib/i18n/messages/sessions.js`.

- [ ] **Step 1: Write the failing browser test**

```js
// tests/browser/session-auto-resume.spec.js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`automatic session resume ${locale}`, () => {
    test.use({ locale });
    test("the setting saves a boolean and a failed resume explains why", async ({
      page,
    }) => {
      const en = locale === "en-GB";
      const state = await operationsFixture(page);
      await page.goto(baseURL + "/settings");
      const toggle = page.getByRole("switch", {
        name: en
          ? "Resume interrupted sessions automatically"
          : "Unterbrochene Sitzungen automatisch fortsetzen",
      });
      await expect(toggle).toBeChecked();
      await toggle.click();
      await expect
        .poll(
          () =>
            state.calls.find((c) => c.method === "PATCH" && c.path === "/preferences")
              ?.body,
        )
        .toEqual({ autoResumeInterrupted: false });
      await page.route("**/api/state", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.sessions = body.sessions.map((session) => ({
          ...session,
          status: "stopped",
          interruption: {
            cause: "tmux-server-lost",
            at: "2026-10-10T10:00:00.000Z",
            resume: "failed",
            reason: "reload-failed",
          },
        }));
        await route.fulfill({ response, json: body });
      });
      await page.goto(baseURL + "/sessions/fixture-session");
      await expect(
        page.getByText(
          en
            ? "This session was interrupted and could not be resumed automatically: the reload failed."
            : "Diese Sitzung wurde unterbrochen und konnte nicht automatisch fortgesetzt werden: Das Neuladen ist fehlgeschlagen.",
        ),
      ).toBeVisible();
    });
  });
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build` then `npx playwright test tests/browser/session-auto-resume.spec.js --project=chromium`
Expected: FAIL — no switch with that name.

- [ ] **Step 3: Add the copy**

`web/lib/i18n/en/settings.js`, inside `settingsPageCopy`:

```js
  autoResumeLabel: "Resume interrupted sessions automatically",
  autoResumeDescription:
    "After a restart or a lost terminal server, AgentPier resumes every interrupted session with its own conversation, one after another. Sessions you stopped stay stopped.",
```

`web/lib/i18n/de/settings.js`, inside `settingsPageCopy`:

```js
  autoResumeLabel: "Unterbrochene Sitzungen automatisch fortsetzen",
  autoResumeDescription:
    "Nach einem Neustart oder dem Verlust des Terminal-Servers setzt AgentPier jede unterbrochene Sitzung nacheinander mit ihrer eigenen Unterhaltung fort. Von dir beendete Sitzungen bleiben beendet.",
```

`web/lib/i18n/en/sessions.js`:

```js
export const sessionInterruptionCopy = {
  resuming: "This session was interrupted and is being resumed automatically …",
  failed: (reason) =>
    `This session was interrupted and could not be resumed automatically: ${reason}`,
  reasons: {
    "unsupported-session": "this session type cannot be resumed.",
    "native-session-unverified": "its conversation could not be verified.",
    "prepare-failed": "the restart could not be prepared.",
    "reload-failed": "the reload failed.",
    timeout: "the CLI did not confirm the conversation in time.",
    "attempt-interrupted": "AgentPier restarted during the attempt.",
  },
};
```

`web/lib/i18n/de/sessions.js`:

```js
export const sessionInterruptionCopy = {
  resuming: "Diese Sitzung wurde unterbrochen und wird automatisch fortgesetzt …",
  failed: (reason) =>
    `Diese Sitzung wurde unterbrochen und konnte nicht automatisch fortgesetzt werden: ${reason}`,
  reasons: {
    "unsupported-session": "Diese Art Sitzung lässt sich nicht fortsetzen.",
    "native-session-unverified": "Ihre Unterhaltung konnte nicht bestätigt werden.",
    "prepare-failed": "Der Neustart konnte nicht vorbereitet werden.",
    "reload-failed": "Das Neuladen ist fehlgeschlagen.",
    timeout: "Die CLI hat die Unterhaltung nicht rechtzeitig bestätigt.",
    "attempt-interrupted": "AgentPier wurde während des Versuchs neu gestartet.",
  },
};
```

`web/lib/i18n/messages/sessions.js` — add next to the existing exports, following the same `localizedCopy(de.x, en.x)` pattern:

```js
export const sessionInterruptionCopy = localizedCopy(
  de.sessionInterruptionCopy,
  en.sessionInterruptionCopy,
);
```

- [ ] **Step 4: Settings component**

```jsx
// web/features/settings/SessionRecoverySettings.jsx
import React, { useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { settingsPageCopy as copy } from "../../lib/i18n/messages/settings.js";

export default function SessionRecoverySettings({ state, refresh, ready }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const enabled = state.autoResumeInterrupted !== false;
  return (
    <section className="settings-form">
      <label className="switch-row">
        <input
          type="checkbox"
          role="switch"
          aria-label={copy.autoResumeLabel}
          checked={enabled}
          disabled={busy || !ready}
          onChange={async (event) => {
            setBusy(true);
            setError("");
            try {
              await api("/preferences", "PATCH", {
                autoResumeInterrupted: event.target.checked,
              });
              await refresh();
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        />
        {copy.autoResumeLabel}
      </label>
      <p className="field-description">{copy.autoResumeDescription}</p>
      <ErrorMessage error={error} />
    </section>
  );
}
```

In `DirectorySettings.jsx`, import it and render `<SessionRecoverySettings state={state} refresh={refresh} ready={ready} />` directly after the `<DirectoryForm … />` element.

- [ ] **Step 5: Interruption notice in the session view**

In `SessionWorkspace.jsx`, import `sessionInterruptionCopy` from `../../lib/i18n/messages/sessions.js` (extend the existing import from that module). Directly after the existing reload notice block (`{reloadable && ["waiting", "reloading", "failed"].includes(...) && (...)}`) add:

```jsx
{
  reloadable && session.status === "stopped" && session.interruption && (
    <div className="session-reload-notice" role="status">
      <span>
        {["failed", "skipped"].includes(session.interruption.resume)
          ? sessionInterruptionCopy.failed(
              sessionInterruptionCopy.reasons[session.interruption.reason] ||
                sessionInterruptionCopy.reasons["reload-failed"],
            )
          : sessionInterruptionCopy.resuming}
      </span>
    </div>
  );
}
```

The existing "Reload & resume" action in the header stays the manual retry.

- [ ] **Step 6: Run the browser test and catalog parity**

Run: `npm run build`
Run: `npx playwright test tests/browser/session-auto-resume.spec.js --project=chromium`
Run: `npm run test:unit`
Expected: PASS, including the i18n catalog parity tests.

- [ ] **Step 7: Commit**

```bash
git add web/features/settings/SessionRecoverySettings.jsx web/features/settings/DirectorySettings.jsx web/features/sessions/SessionWorkspace.jsx web/lib/i18n/de/settings.js web/lib/i18n/en/settings.js web/lib/i18n/de/sessions.js web/lib/i18n/en/sessions.js web/lib/i18n/messages/sessions.js tests/browser/session-auto-resume.spec.js
git commit -m "feat: show and configure automatic session resume"
```

### Task 7: Documentation, full check and cleanup

**Files:**

- Modify: `docs/linux.md` (line ~87, the sentence that a reboot ends all CLI processes), `docs/installation.md` (service section near line 167)
- Delete: `docs/superpowers/specs/2026-10-10-auto-resume-interrupted-sessions-design.md`, `docs/superpowers/plans/2026-10-10-auto-resume-interrupted-sessions.md`

- [ ] **Step 1: Update the operating docs**

In `docs/linux.md`, after the sentence stating that a host reboot still ends all CLI processes, add (German, matching the file):

```markdown
Nach dem nächsten Start setzt AgentPier unterbrochene Sitzungen automatisch mit ihrer eigenen Unterhaltung fort, sofern „Unterbrochene Sitzungen automatisch fortsetzen" in den Einstellungen aktiv ist. Laufende Antworten und Prozesse zum Zeitpunkt des Neustarts gehen verloren.
```

Add the same paragraph to the service section of `docs/installation.md`.

- [ ] **Step 2: Full check**

Run: `npm run check`
Expected: PASS except the known environment failure in `tests/integration/shell.test.js` on the author's Mac; report any other failure by name.

- [ ] **Step 3: Browser suite for changed UI (WebKit too)**

Run: `npx playwright test tests/browser/session-auto-resume.spec.js`
Expected: PASS on all configured projects.

- [ ] **Step 4: Remove the temporary design documents and commit**

```bash
git rm docs/superpowers/specs/2026-10-10-auto-resume-interrupted-sessions-design.md docs/superpowers/plans/2026-10-10-auto-resume-interrupted-sessions.md
git add docs/linux.md docs/installation.md
git commit -m "chore: document automatic session resume and remove working documents"
```
