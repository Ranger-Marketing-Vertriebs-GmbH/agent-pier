import test from "node:test";
import assert from "node:assert/strict";
import { describeDuplicates } from "../../server/features/memory/project-duplicates.js";
import { listedProjects, listedProjectsPath } from "../../web/lib/project-list.js";
import { savedProjectIds } from "../../web/features/assistants/settings/agent-settings-fields.js";

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

test("an older row with pipeline work its current row lacks stays listed", () => {
  const described = describeDuplicates(rows, onDisk).map((project) =>
    project.id === "lab-dir" || project.id === "ops-dir"
      ? { ...project, pipelineWork: true }
      : project.id === "ops-git"
        ? { ...project, pipelineWork: true }
        : project,
  );
  // electronic-lab: only the older row has steps or runs, so both rows are listed;
  // spoolops: the current row has work of its own, so the older row stays hidden.
  assert.deepEqual(
    listedProjects(described).map((project) => project.id),
    ["lab-dir", "lab-git", "pier", "ops-git"],
  );
});

test("the Work tab keeps an older row the saved access holds, even when unticked", () => {
  const projects = [
    { id: "current", name: "lab", path: "/p/lab" },
    { id: "older", name: "lab", path: "/p/lab", duplicateOf: "current" },
    { id: "oldest", name: "lab", path: "/p/lab", duplicateOf: "current" },
  ];
  const saved = { projectIds: ["older"], projectFiles: {} };
  // The draft no longer names "older" after unticking it; the saved access still does.
  const listed = listedProjects(projects, savedProjectIds(saved)).map((row) => row.id);
  assert.deepEqual(listed, ["current", "older"]);
  assert.deepEqual(
    savedProjectIds({ projectIds: [], projectFiles: { oldest: "read" } }),
    ["oldest"],
  );
  assert.deepEqual(savedProjectIds(null), []);
});
