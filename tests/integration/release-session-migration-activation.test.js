import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Operations } from "../../server/features/operations/operations.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { ReleaseSessionMigration } from "../../server/features/operations/release-session-migration.js";
import { atomic, readJson } from "../../server/features/operations/files.js";

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

async function fixture(t, sessions, { audit: withAudit = false } = {}) {
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
  sessions.forEach((session, index) => {
    if (session.holdsRelease !== false)
      lines.set(
        session.id,
        `${100 + index}     1 ${old}/bin/node ${old}/bin/node ${old}/server/terminal-launcher.js ${dataDir}/sessions/${session.id}.launch.json`,
      );
  });
  const extra = [];
  let audit;
  if (withAudit) {
    audit = new AuditStore({ dataDir });
    t.after(() => audit.close());
  }
  const operations = new Operations({
    config: { dataDir },
    audit,
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
  return {
    operations,
    migration,
    store,
    reload,
    lines,
    extra,
    installRoot,
    finish,
    old,
    audit,
    launcherPid: (id) => 100 + sessions.findIndex((s) => s.id === id),
  };
}

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

test("a marker for a release that is not the active one is discarded", async (t) => {
  const f = await activationFixture(
    t,
    [{ id: ids[0], tool: "claude", status: "running", activity: "idle" }],
    { status: "succeeded", result: { activated: true } },
  );
  atomic(f.marker, {
    to: "9.9.9",
    jobId: "11111111-2222-4333-8444-555555555555",
    requestedAt: new Date().toISOString(),
  });
  await f.migration.resumeAfterActivation();
  assert.equal(f.reload.requests.length, 0);
  assert.equal(readJson(f.marker, null), null);
});

test("a malformed marker is discarded without requesting any reload", async (t) => {
  const f = await activationFixture(
    t,
    [{ id: ids[0], tool: "claude", status: "running", activity: "idle" }],
    { status: "succeeded", result: { activated: true } },
  );
  await fs.writeFile(f.marker, "{not json");
  await f.migration.resumeAfterActivation();
  assert.equal(f.reload.requests.length, 0);
  await assert.rejects(fs.stat(f.marker));
});

test("a lock present at success time delays the reload until the lock is released", async (t) => {
  const f = await activationFixture(
    t,
    [{ id: ids[0], tool: "claude", status: "running", activity: "idle" }],
    { status: "succeeded", result: { activated: true } },
  );
  const lock = path.join(
    f.operations.config.dataDir,
    "operations/release-activation.lock",
  );
  await fs.writeFile(lock, "{}");
  f.migration.activationPollMs = 10;
  f.migration.activationTimeoutMs = 2000;
  const pending = f.migration.resumeAfterActivation();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.reload.requests.length, 0);
  await fs.rm(lock, { force: true });
  await pending;
  assert.deepEqual(
    f.reload.requests.map((r) => [r.id, r.mode]),
    [[ids[0], "when-idle"]],
  );
  assert.equal(readJson(f.marker, null), null);
});
