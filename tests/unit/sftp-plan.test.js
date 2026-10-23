import test from "node:test";
import assert from "node:assert/strict";
import { sftpLimits } from "../../server/features/sftp/sftp-limits.js";
import {
  capPlan,
  planSummary,
  planTransfer,
} from "../../server/features/sftp/sftp-plan.js";

const entry = (path, size = 10, mtimeMs = 1_700_000_000_000) => ({ path, size, mtimeMs });

test("limits match the plan", () => {
  assert.deepEqual(sftpLimits, {
    maxBytes: 2 * 1024 ** 3,
    maxFiles: 10000,
    maxScanEntries: 50000,
    scanMs: 60000,
    jobMs: 7200000,
    listEntries: 1000,
    pathChars: 4096,
    excludes: 50,
    excludeChars: 200,
    planListLimit: 500,
    resultListLimit: 200,
    mtimeToleranceMs: 2000,
    runningJobs: 2,
  });
  assert.equal(Object.isFrozen(sftpLimits), true);
});

test("copy counts overwrites", () => {
  const plan = planTransfer({
    source: [entry("b"), entry("a", 5)],
    target: [entry("a", 5), entry("old")],
  });
  assert.deepEqual(
    plan.create.map((e) => e.path),
    ["b"],
  );
  assert.deepEqual(
    plan.update.map((e) => e.path),
    ["a"],
  );
  assert.deepEqual(plan.delete, []);
  assert.equal(plan.unchanged, 0);
  assert.equal(plan.files, 2);
  assert.equal(plan.bytes, 15);
  assert.equal(plan.overwrites, 1);
  assert.equal(plan.deletes, 0);
  assert.match(plan.digest, /^[0-9a-f]{64}$/);
});

test("sync skips equal size and mtime within 2 s", () => {
  const t = 1_700_000_000_000;
  const plan = planTransfer({
    source: [entry("same", 1, t), entry("near", 1, t + 2000), entry("far", 1, t + 2001)],
    target: [entry("same", 1, t), entry("near", 1, t), entry("far", 1, t)],
    sync: true,
  });
  assert.deepEqual(
    plan.update.map((e) => e.path),
    ["far"],
  );
  assert.equal(plan.unchanged, 2);
  const sized = planTransfer({
    source: [entry("a", 2, t)],
    target: [entry("a", 1, t)],
    sync: true,
  });
  assert.equal(sized.overwrites, 1);
});

test("sync with hashes ignores mtime", () => {
  const plan = planTransfer({
    source: [entry("same", 1, 0), entry("changed", 1, 0), entry("unhashed", 1, 0)],
    target: [entry("same", 1, 99_999), entry("changed", 1, 0), entry("unhashed", 1, 0)],
    sync: true,
    hashes: {
      source: new Map([
        ["same", "h1"],
        ["changed", "h2"],
      ]),
      target: new Map([
        ["same", "h1"],
        ["changed", "h3"],
      ]),
    },
  });
  assert.deepEqual(
    plan.update.map((e) => e.path),
    ["changed", "unhashed"],
  );
  assert.equal(plan.unchanged, 1);
});

test("delete empty without deleteExtra", () => {
  const options = { source: [entry("a")], target: [entry("a"), entry("extra")] };
  assert.deepEqual(planTransfer({ ...options, sync: true }).delete, []);
  assert.deepEqual(planTransfer({ ...options, deleteExtra: true }).delete, []);
  const plan = planTransfer({ ...options, sync: true, deleteExtra: true });
  assert.deepEqual(
    plan.delete.map((e) => e.path),
    ["extra"],
  );
  assert.equal(plan.deletes, 1);
});

test("capPlan rejects 10,001 files and 2 GiB + 1 byte", () => {
  const many = planTransfer({
    source: Array.from({ length: 10001 }, (_, i) => entry(`f${i}`, 1)),
    target: [],
  });
  assert.throws(
    () => capPlan(many),
    (error) => {
      assert.equal(error.code, "SFTP_LIMIT");
      assert.equal(error.status, 413);
      assert.deepEqual(error.details, { files: 10001, bytes: 10001 });
      return true;
    },
  );
  const exact = planTransfer({ source: [entry("big", 2 * 1024 ** 3)], target: [] });
  assert.equal(capPlan(exact), exact);
  const big = planTransfer({ source: [entry("big", 2 * 1024 ** 3 + 1)], target: [] });
  assert.throws(() => capPlan(big), { code: "SFTP_LIMIT" });
  assert.doesNotThrow(() => capPlan(many, { ...sftpLimits, maxFiles: 20000 }));
});

test("planSummary caps lists at 500 with more counts", () => {
  const plan = planTransfer({
    source: Array.from({ length: 600 }, (_, i) =>
      entry(`n${String(i).padStart(3, "0")}`),
    ),
    target: [entry("n000"), ...Array.from({ length: 3 }, (_, i) => entry(`x${i}`))],
    sync: true,
    deleteExtra: true,
  });
  const summary = planSummary(plan, 500);
  assert.equal(summary.create.length, 500);
  assert.equal(summary.create[0], "n001");
  assert.deepEqual(summary.update, []);
  assert.deepEqual(summary.delete, ["x0", "x1", "x2"]);
  assert.deepEqual(summary.more, { create: 99, update: 0, delete: 0 });
  assert.equal(summary.files, 599);
  assert.equal(summary.bytes, 5990);
  assert.equal(summary.overwrites, 0);
  assert.equal(summary.deletes, 3);
  assert.equal(planSummary(plan).create.length, 500);
});
