import test from "node:test";
import assert from "node:assert/strict";
import { describeDuplicates } from "../../server/features/memory/project-duplicates.js";
import {
  listedProjects,
  listedProjectsPath,
} from "../../web/features/pipelines/project-list.js";

const row = (id, cwd, kind, createdAt) => ({
  id,
  name: cwd.split("/").pop(),
  cwd,
  kind,
  createdAt,
  entryCount: 0,
});

// The owner's state: a folder registered as a plain directory and again after
// `git init`, so two rows share one name and one path.
const rows = [
  row("lab-dir", "/w/electronic-lab", "directory", "2026-10-03T11:30:00Z"),
  row("lab-git", "/w/electronic-lab", "git", "2026-10-03T15:47:00Z"),
  row("pier", "/w/agent-pier", "git", "2026-09-01T00:00:00Z"),
  row("ops-dir", "/w/spoolops", "directory", "2026-09-11T19:31:00Z"),
  row("ops-git", "/w/spoolops", "git", "2026-09-12T08:39:00Z"),
];
const onDisk = new Map([
  ["/w/electronic-lab", "lab-git"],
  ["/w/spoolops", "ops-git"],
]);

test("pipeline project lists show each folder once, as its current row", () => {
  const listed = listedProjects(describeDuplicates(rows, onDisk));
  assert.deepEqual(
    listed.map((project) => project.id),
    ["lab-git", "pier", "ops-git"],
  );
  assert.equal(new Set(listed.map((project) => project.cwd)).size, listed.length);
  assert.match(listedProjectsPath, /[?&]duplicates=1(&|$)/);
});

test("an older row stays listed while it is the open one", () => {
  const listed = listedProjects(describeDuplicates(rows, onDisk), "lab-dir");
  assert.deepEqual(
    listed.map((project) => project.id),
    ["lab-dir", "lab-git", "pier", "ops-git"],
  );
  assert.deepEqual(listedProjects(undefined), []);
});
