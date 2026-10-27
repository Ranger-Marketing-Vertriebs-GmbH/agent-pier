import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StorageCleanup } from "../../server/features/system-status/storage-cleanup.js";

function cleanup(t, lists) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-summary-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const instance = new StorageCleanup({ dataDir, services: {}, audit: null });
  const calls = [];
  instance.snapshots = async () => (calls.push("snapshots"), lists.snapshots);
  instance.transcripts = async () => (calls.push("transcripts"), { profiles: [] });
  instance.dependencies = async () => (calls.push("dependencies"), { agents: [] });
  return { instance, calls };
}

test("the summary counts only the update backups that may be deleted now", async (t) => {
  const { instance } = cleanup(t, {
    snapshots: {
      blocked: true,
      snapshots: [
        { id: "a", bytes: 10, reason: "updating" },
        { id: "b", bytes: 20, reason: "recovery" },
      ],
    },
  });
  const { updateBackups } = (await instance.measureSummary()).groups;
  assert.deepEqual(
    {
      bytes: updateBackups.bytes,
      count: updateBackups.count,
      blocked: updateBackups.blocked,
    },
    { bytes: 0, count: 0, blocked: true },
  );
  const free = cleanup(t, {
    snapshots: {
      blocked: false,
      snapshots: [
        { id: "a", bytes: 10, reason: null },
        { id: "b", bytes: 20, reason: "recovery" },
      ],
    },
  });
  const ready = (await free.instance.measureSummary()).groups.updateBackups;
  assert.deepEqual({ bytes: ready.bytes, count: ready.count }, { bytes: 10, count: 1 });
});

test("a shutdown stops the summary between its lists", async (t) => {
  const { instance, calls } = cleanup(t, {
    snapshots: { blocked: false, snapshots: [] },
  });
  let closed = false;
  instance.snapshots = async () => {
    calls.push("snapshots");
    closed = true;
    return { blocked: false, snapshots: [] };
  };
  assert.equal(await instance.measureSummary(() => closed), null);
  assert.deepEqual(calls, ["snapshots"]);
});
