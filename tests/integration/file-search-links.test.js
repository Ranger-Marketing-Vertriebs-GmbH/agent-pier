import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { FileNative } from "../../server/features/files/file-native.js";
import { searchFiles, measureFiles } from "../../server/features/files/file-search.js";
import { readFileLimits } from "../../server/features/files/file-limits.js";
import { fileFixture } from "../helpers/file-explorer.js";

for (const kind of ["search", "size"])
  for (const position of ["leaf", "ancestor"]) {
    test(`${kind} never enumerates a directory replaced through its ${position} by an outside link`, async (t) => {
      const f = await fileFixture(t);
      const selected = path.join(f.project, "parent", "scan");
      const outside = path.join(f.home, "outside");
      await fs.mkdir(selected, { recursive: true });
      await fs.mkdir(path.join(outside, "scan"), { recursive: true });
      const target = position === "leaf" ? path.join(outside, "scan") : outside;
      await fs.writeFile(path.join(outside, "scan", "outside-sentinel.txt"), "outside");
      let swapped = false,
        outsideRead = false;
      const reports = [];
      async function swap() {
        if (swapped) return;
        swapped = true;
        const replacement = position === "leaf" ? selected : path.dirname(selected);
        await fs.rename(replacement, `${replacement}-kept`);
        await fs.symlink(target, replacement);
      }
      const realOpen = fs.opendir;
      t.mock.method(fs, "opendir", async (input, ...args) => {
        if (input === selected) await swap();
        const directory = await realOpen(input, ...args);
        const read = directory.read.bind(directory);
        directory.read = async () => {
          const entry = await read();
          if (entry?.name === "outside-sentinel.txt") outsideRead = true;
          return entry;
        };
        return directory;
      });
      const realRun = FileNative.prototype.run;
      t.mock.method(FileNative.prototype, "run", async function (operation, args) {
        if (operation === "openDirectory" && args.path === "parent/scan") await swap();
        const value = await realRun.call(this, operation, args);
        if (operation === "readDirectory" && value?.name === "outside-sentinel.txt")
          outsideRead = true;
        return value;
      });
      await (kind === "search" ? searchFiles : measureFiles)({
        scope: f.projectScope,
        operation: {
          sources: ["parent/scan"],
          options: { query: ".txt", recursive: true, hidden: true, caseSensitive: false },
        },
        signal: new AbortController().signal,
        report: async (patch) => reports.push(patch),
        store: { putEntry: () => assert.fail("An outside result must never be stored") },
        jobId: "fixture",
        limits: readFileLimits({ searchEntries: 10 }),
      });
      assert.equal(swapped, true, "replacement ran at the production opening boundary");
      assert.equal(
        outsideRead,
        false,
        "no native/Node directory read observed the outside sentinel",
      );
      assert.equal(reports.at(-1).issue.args.reason, "changed");
      assert.equal(reports.at(-1).completedEntries, 0);
    });
  }

test("a deadline reached while opening the native directory stops before enumeration", async (t) => {
  const f = await fileFixture(t);
  await fs.writeFile(path.join(f.project, "found.txt"), "fixture");
  const run = FileNative.prototype.run;
  let clock = 0,
    reads = 0;
  const reports = [];
  t.mock.method(FileNative.prototype, "run", async function (operation, args) {
    const value = await run.call(this, operation, args);
    if (operation === "openDirectory") clock = 30000;
    if (operation === "readDirectory") reads++;
    return value;
  });
  await searchFiles({
    scope: f.projectScope,
    operation: {
      sources: [""],
      options: { query: ".txt", recursive: true, hidden: true, caseSensitive: false },
    },
    signal: new AbortController().signal,
    report: async (patch) => reports.push(patch),
    store: { putEntry: () => assert.fail("No result after the deadline") },
    jobId: "fixture",
    limits: readFileLimits(),
    now: () => clock,
  });
  assert.equal(reads, 0);
  assert.equal(reports.at(-1).issue.args.reason, "time");
  assert.equal(reports.at(-1).completedEntries, 0);
});
