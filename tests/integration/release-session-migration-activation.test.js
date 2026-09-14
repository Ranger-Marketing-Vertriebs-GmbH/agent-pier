import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { atomic, readJson } from "../../server/features/operations/files.js";
import { ids, fixture } from "../helpers/release-migration-fixture.js";

async function activationFixture(t, sessions, job, options = {}) {
  const f = await fixture(t, sessions, options);
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
  const logs = [];
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
    { log: (message) => logs.push(message) },
  );
  await f.migration.resumeAfterActivation();
  assert.deepEqual(
    f.reload.requests.map((r) => r.id),
    [ids[0]],
  );
  assert.ok(logs.some((line) => line.includes("skipped 1 session")));
  const { events } = f.operations.audit.list();
  assert.equal(events[0].details.skipped, 1);
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
