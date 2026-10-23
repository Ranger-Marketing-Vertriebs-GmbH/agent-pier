import test from "node:test";
import assert from "node:assert/strict";
import {
  transferSummary,
  withinBudget,
} from "../../server/features/sftp/sftp-session-tools.js";

const long = (prefix, i) => `${prefix}/${"ä".repeat(2000)}/${i}.txt`;
const entries = (prefix, count) =>
  Array.from({ length: count }, (_, i) => ({
    path: long(prefix, i),
    size: 1,
    mtimeMs: 0,
  }));

test("transfer summaries stay inside the MCP output budget with long paths", () => {
  const plan = {
    create: entries("c", 300),
    update: entries("u", 300),
    delete: entries("d", 300),
    deleteDirs: Array.from({ length: 300 }, (_, i) => long("dir", i)),
    files: 600,
    bytes: 600,
    overwrites: 300,
    deletes: 300,
  };
  const summary = transferSummary(
    {
      plan,
      summary: { operation: "sync", direction: "up", kind: "folder", remotePath: "/www" },
    },
    { relative: "site" },
  );
  const bytes = Buffer.byteLength(JSON.stringify(summary));
  assert.ok(bytes < 300 * 1024, `${bytes} bytes`);
  // Every path is either listed or counted.
  assert.equal(summary.create.length + summary.more.create, 300);
  assert.equal(summary.update.length + summary.more.update, 300);
  assert.equal(summary.delete.length + summary.more.delete, 300);
  assert.equal(summary.deleteDirs.length + summary.moreDeleteDirs, 300);
  assert.ok(summary.create.length > 0);
  assert.ok(summary.more.delete > 100);
});

test("short lists are kept whole", () => {
  const { kept, cut } = withinBudget({ a: ["x", "y"], b: ["z"] }, 1024);
  assert.deepEqual(kept, { a: ["x", "y"], b: ["z"] });
  assert.deepEqual(cut, { a: 0, b: 0 });
});
