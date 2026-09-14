import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { ids, fixture } from "../helpers/release-migration-fixture.js";

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
  f.extra.push(` 500 1 node ${f.old}/bin/node /Users/me/tool.js`);
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
    `  501     1 node ${f.old}/bin/node ${f.old}/server/features/pipelines/verify-supervisor.js`,
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
  const f = await fixture(
    t,
    [
      { id: ids[0], tool: "claude", status: "running", activity: "idle" },
      {
        id: ids[1],
        tool: "codex",
        status: "running",
        activity: "working",
        nextState: "waiting",
      },
    ],
    { audit: true },
  );
  const job = f.migration.migrate("1.0.0");
  assert.equal(job.kind, "release-migrate");
  assert.throws(() => f.migration.migrate("1.0.0"), /running/);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.operations.jobs.get(job.id).status, "running");
  // A running migration is visible in the plan, so any page can offer to cancel it.
  assert.equal((await f.migration.plan("1.0.0")).migrating, true);
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
  assert.equal((await f.migration.plan("1.0.0")).migrating, false);
  assert.equal(f.operations.jobs.running("release-"), false);
  const events = f.audit.list().events;
  assert.equal(events[0].action, "release.deleted");
  assert.equal(events[0].details.version, "1.0.0");
  assert.equal(events[0].details.count, 2);
  assert.equal(events[0].resourceId, job.id);
});

test("cancelling right after migrate() returns is observed on the fast path", async (t) => {
  const f = await fixture(t, [
    { id: ids[0], tool: "claude", status: "running", activity: "idle" },
    { id: ids[1], tool: "codex", status: "running", activity: "idle" },
  ]);
  const job = f.migration.migrate("1.0.0");
  f.migration.cancel("1.0.0");
  const finished = await f.finish(job);
  assert.equal(finished.errorCode, "migrateCancelled");
  assert.ok(await fs.stat(path.join(f.installRoot, "releases/1.0.0")));
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
  const job = f.migration.migrate("1.0.0");
  await new Promise((r) => setTimeout(r, 20));
  f.extra.push(` 600 1 node ${f.old}/bin/node ${f.old}/vendor/agentbus/agentpier/mcp.js`);
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

test("stopped sessions holding a lingering launcher line are released without a reload request", async (t) => {
  const f = await fixture(t, [
    { id: ids[0], tool: "claude", status: "running", activity: "idle" },
    { id: ids[1], tool: "codex", status: "stopped", activity: "stopped" },
  ]);
  const job = f.migration.migrate("1.0.0");
  await new Promise((r) => setTimeout(r, 5));
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
