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
