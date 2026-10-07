import test from "node:test";
import assert from "node:assert/strict";
import { describeDuplicates } from "../../server/features/memory/project-duplicates.js";
import { mergeProjects } from "../../web/features/projects/useProjectHub.js";

const row = (id, cwd, createdAt, entryCount = 0, extra = {}) => ({
  id,
  name: cwd.split("/").pop(),
  cwd,
  kind: "git",
  createdAt,
  entryCount,
  ...extra,
});

test("the row matching the folder on disk is current; the others are older duplicates", () => {
  const projects = describeDuplicates(
    [
      row("old", "/w/lab", "2026-01-01T00:00:00Z", 3, { identity: "secret-free" }),
      row("cur", "/w/lab", "2025-01-01T00:00:00Z", 1),
      row("solo", "/w/solo", "2026-01-01T00:00:00Z"),
    ],
    new Map([["/w/lab", "cur"]]),
  );
  const byId = Object.fromEntries(projects.map((project) => [project.id, project]));
  assert.deepEqual(byId.cur.olderDuplicates, [
    { id: "old", name: "lab", entries: 3, createdAt: "2026-01-01T00:00:00Z" },
  ]);
  assert.equal(byId.old.duplicateOf, "cur");
  assert.equal(byId.old.olderDuplicates, undefined);
  assert.deepEqual(byId.solo, row("solo", "/w/solo", "2026-01-01T00:00:00Z"));
});

test("without a row matching the folder the most recently registered one is current", () => {
  const projects = describeDuplicates(
    [
      row("a", "/w/x", "2026-01-01T00:00:00Z", 1),
      row("c", "/w/x", "2026-03-01T00:00:00Z", 0),
      row("b", "/w/x", "2026-02-01T00:00:00Z", 2),
    ],
    new Map([["/w/x", null]]),
  );
  const current = projects.find((project) => !project.duplicateOf);
  assert.equal(current.id, "c");
  assert.deepEqual(
    current.olderDuplicates.map((item) => item.id),
    ["b", "a"],
  );
  assert.deepEqual(
    projects
      .filter((project) => project.duplicateOf)
      .map((project) => project.duplicateOf),
    ["c", "c"],
  );
});

test("the hub lists only the current project of a folder and carries its older rows", () => {
  const projects = mergeProjects({
    repositories: [],
    memoryProjects: [
      {
        id: "cur",
        name: "lab",
        cwd: "/w/lab",
        entryCount: 1,
        olderDuplicates: [{ id: "old", name: "lab", entries: 3, createdAt: "x" }],
      },
      { id: "old", name: "lab", cwd: "/w/lab", entryCount: 3, duplicateOf: "cur" },
    ],
    busProjects: [],
  });
  assert.deepEqual(
    projects.map((project) => [project.id, project.memoryId, project.entryCount]),
    [["cur", "cur", 1]],
  );
  assert.deepEqual(projects[0].olderDuplicates, [
    { id: "old", name: "lab", entries: 3, createdAt: "x" },
  ]);
});
