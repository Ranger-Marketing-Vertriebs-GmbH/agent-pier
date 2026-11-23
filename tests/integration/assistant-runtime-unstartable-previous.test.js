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
// the rollback restores 2026.10.9 and starts it again (wasRunning is true, since
// "failed" is not "disabled"), which throws, so the update ends in
// recovery_required. recover() rolls back and starts 2026.10.9 once more, and
// activate() is refused while recovery is required: the installation keeps its
// agents stopped with no way forward from AgentPier. Found while qualifying the
// v2.19.0 -> 2026.11.6 upgrade path on real runtimes; a todo until it is decided how
// such a rollback should end.
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-unstartable-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const paths = runtimePaths(dataDir);
  const selected = path.join(paths.root, "runtime.json");
  const old = { version: "2026.10.9", nodeVersion: "26.12.1" };
  const target = { version: "2026.11.6", nodeVersion: "26.12.1" };
  writePrivate(selected, old);
  fs.writeFileSync(path.join(paths.state, "history"), "before");
  // Like the real start: the previous selection fails before any Gateway runs.
  const runtime = {
    availability: "failed",
    status() {
      return { availability: this.availability };
    },
    async stop() {
      this.availability = "disabled";
    },
    async start() {
      if (readJSON(selected).version !== target.version) {
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
  const updates = new RuntimeUpdates({
    dataDir,
    runtime,
    maintenance,
    stage: async () => target,
    migrate: async () => {},
  });
  return { updates, selected, old, target, accept: () => (rejectCandidate = false) };
}

test(
  "a failed activation from a runtime this build cannot start leaves a way to retry it",
  { todo: "a rollback to an unstartable previous runtime ends in recovery_required" },
  async (t) => {
    const f = fixture(t);
    await f.updates.stage();
    await assert.rejects(f.updates.activate());
    // The previous state and selection are back either way.
    assert.deepEqual(readJSON(f.selected), f.old);
    // What the owner needs: no dead end. Today the phase is recovery_required, and
    // recover() and activate() both fail.
    assert.equal(f.updates.status().recoveryRequired, false, f.updates.status().phase);
    f.accept();
    await f.updates.activate();
    assert.equal(f.updates.status().phase, "complete");
    assert.deepEqual(readJSON(f.selected), f.target);
  },
);

test("today: the failed activation strands the update in recovery", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  await assert.rejects(f.updates.activate(), { code: "UPDATE_RECOVERY_REQUIRED" });
  assert.equal(f.updates.status().phase, "recovery_required");
  assert.deepEqual(readJSON(f.selected), f.old);
  f.accept();
  await assert.rejects(f.updates.recover(), { code: "UPDATE_RECOVERY_REQUIRED" });
  await assert.rejects(f.updates.activate(), { code: "UPDATE_RECOVERY_REQUIRED" });
  assert.equal(f.updates.status().phase, "recovery_required");
});
