import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeUpdates } from "../../server/features/assistants/runtime-updates.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";

// An installation updated from AgentPier v2.19.0 still selects OpenClaw 2026.10.9,
// which this build cannot start: 2026.10.9 is neither the pin nor its rollback
// target, so provisionTeamPlugin refuses it ("Incompatible assistant team
// runtime."), the Gateway reports START_FAILED, and the agents wait for the owner to
// activate the pin. When that activation fails after the stop (here: validation),
// the rollback used to restore 2026.10.9 and start it again (wasRunning is true, as
// "failed" is not "disabled"), which threw, so the update ended in
// recovery_required, recover() failed the same way and activate() was refused: no
// way forward from AgentPier (AGENTPIER-490). Found while qualifying the v2.19.0 ->
// 2026.11.6 upgrade path on real runtimes.
function fixture(
  t,
  { previous = "2026.10.9", startable = previous !== "2026.10.9" } = {},
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-unstartable-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const paths = runtimePaths(dataDir);
  const selected = path.join(paths.root, "runtime.json");
  const old = { version: previous, nodeVersion: "26.12.1" };
  const target = { version: "2026.11.6", nodeVersion: "26.12.1" };
  writePrivate(selected, old);
  fs.writeFileSync(path.join(paths.state, "history"), "before");
  const starts = [];
  // Like the real start: the previous selection fails before any Gateway runs, unless
  // it is one this build runs and nothing else keeps it from starting.
  const runtime = {
    availability: "failed",
    failStarts: !startable,
    asserts: 0,
    stuckAt: 0,
    status() {
      return { availability: this.availability };
    },
    async stop() {
      this.availability = "disabled";
    },
    async assertStopped() {
      if (++this.asserts === this.stuckAt) throw Error("Injected stuck Gateway");
    },
    async start() {
      const version = readJSON(selected).version;
      starts.push(version);
      if (version !== target.version && this.failStarts) {
        this.availability = "failed";
        throw Error("Incompatible assistant team runtime.");
      }
      this.availability = "ready";
    },
  };
  let rejectCandidate = true;
  const maintenance = {
    enter: async () => {},
    blockers: async () => [],
    quiesce: async () => {},
    leave: async () => {},
    async validate() {
      if (rejectCandidate && readJSON(selected).version === target.version)
        throw Error("Injected candidate validation failure");
    },
  };
  const options = {
    dataDir,
    runtime,
    maintenance,
    stage: async () => target,
    migrate: async () => {},
  };
  const updates = new RuntimeUpdates(options);
  return {
    updates,
    options,
    runtime,
    starts,
    paths,
    selected,
    old,
    target,
    accept: () => (rejectCandidate = false),
  };
}

test("a failed activation from a runtime this build cannot start leaves a way to retry it", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  await assert.rejects(f.updates.activate(), { code: "UPDATE_ROLLED_BACK" });
  // The previous state and selection are back, and 2026.10.9 was never started.
  assert.deepEqual(readJSON(f.selected), f.old);
  assert.equal(fs.readFileSync(path.join(f.paths.state, "history"), "utf8"), "before");
  assert.deepEqual(f.starts, ["2026.11.6"]);
  assert.equal(f.runtime.availability, "disabled");
  const status = f.updates.status();
  assert.equal(status.phase, "rolled_back");
  assert.equal(status.recoveryRequired, false);
  assert.equal(status.diagnostic, "UPDATE_ROLLED_BACK");
  assert.equal(status.diagnosticStep, "validate");
  assert.equal(status.candidateReady, true);
  // The owner retries the pin; the agents were meant to run, so it starts.
  f.accept();
  await f.updates.activate();
  assert.equal(f.updates.status().phase, "complete");
  assert.deepEqual(readJSON(f.selected), f.target);
  assert.equal(f.runtime.availability, "ready");
});

test("recover() ends a rollback stranded on a runtime this build cannot start", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  // The rollback (the second stop check) fails once after the snapshot, as the old
  // rollback did at the start of 2026.10.9: the journal records recovery_required
  // with the snapshot to restore.
  f.runtime.stuckAt = 2;
  await assert.rejects(f.updates.activate(), { code: "UPDATE_RECOVERY_REQUIRED" });
  assert.equal(f.updates.status().phase, "recovery_required");
  // Like a restart of AgentPier with a journal the previous build wrote, which knew
  // nothing of a failed Gateway: a new journal reader over the same files.
  const file = path.join(f.paths.root, "update.json");
  const journal = readJSON(file);
  delete journal.wasFailed;
  writePrivate(file, journal);
  const updates = new RuntimeUpdates(f.options);
  await assert.rejects(updates.activate(), { code: "UPDATE_RECOVERY_REQUIRED" });
  const recovered = await updates.recover();
  assert.equal(recovered.phase, "rolled_back");
  assert.equal(recovered.recoveryRequired, false);
  assert.deepEqual(readJSON(f.selected), f.old);
  assert.equal(fs.readFileSync(path.join(f.paths.state, "history"), "utf8"), "before");
  assert.deepEqual(f.starts, ["2026.11.6"]);
  f.accept();
  await updates.activate();
  assert.equal(updates.status().phase, "complete");
  assert.equal(f.runtime.availability, "ready");
});

test("the rollback target is restarted after a failed activation as before", async (t) => {
  const f = fixture(t, { previous: "2026.11.3" });
  f.runtime.availability = "ready";
  await f.updates.stage();
  await assert.rejects(f.updates.activate(), { code: "UPDATE_ROLLED_BACK" });
  assert.deepEqual(f.starts, ["2026.11.6", "2026.11.3"]);
  assert.equal(f.runtime.availability, "ready");
  assert.equal(f.updates.status().phase, "rolled_back");
});

test("a rollback target that failed before the activation and fails again is left as it was", async (t) => {
  const f = fixture(t, { previous: "2026.11.3", startable: false });
  await f.updates.stage();
  await assert.rejects(f.updates.activate(), { code: "UPDATE_ROLLED_BACK" });
  assert.deepEqual(f.starts, ["2026.11.6", "2026.11.3"]);
  const status = f.updates.status();
  assert.equal(status.phase, "rolled_back");
  assert.equal(status.recoveryRequired, false);
  assert.deepEqual(readJSON(f.selected), f.old);
  f.accept();
  await f.updates.activate();
  assert.equal(f.updates.status().phase, "complete");
  assert.equal(f.runtime.availability, "ready");
});

test("a rollback target that was running and fails to start again requires recovery", async (t) => {
  const f = fixture(t, { previous: "2026.11.3", startable: false });
  f.runtime.availability = "ready";
  await f.updates.stage();
  await assert.rejects(f.updates.activate(), { code: "UPDATE_RECOVERY_REQUIRED" });
  assert.equal(f.updates.status().phase, "recovery_required");
});
