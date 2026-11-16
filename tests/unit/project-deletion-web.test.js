import test from "node:test";
import assert from "node:assert/strict";
import { withLanguage } from "../../web/lib/i18n/index.js";
import { mergeProjects } from "../../web/features/projects/useProjectHub.js";
import { projectMenuItems } from "../../web/features/projects/project-menu.js";
import {
  canDelete,
  canRetry,
  confirmReady,
  deleteLabel,
  endableProcesses,
  failureText,
  gitWarnings,
  projectState,
  refusalText,
} from "../../web/features/projects/project-deletion.js";

const en = (read) => withLanguage("en", read);

test("merged projects carry folder state and deletion by path", () => {
  const [p] = mergeProjects({
    memoryProjects: [{ id: "m1", name: "a", cwd: "/w/a", folder: "missing" }],
    repositories: [],
    busProjects: [],
    deletions: [{ path: "/w/a/", state: "failed", error: "EACCES" }],
  });
  assert.equal(p.folder, "missing");
  assert.deepEqual(p.deletion, { state: "failed", error: "EACCES" });
});

test("a row's own deletion wins; folder defaults to present; stale deletions drop", () => {
  const projects = mergeProjects({
    memoryProjects: [
      {
        id: "m1",
        name: "a",
        cwd: "/w/a",
        folder: "present",
        deletion: { state: "deleting", error: null },
      },
    ],
    repositories: [
      { id: "r1", name: "b", path: "/w/b", folder: "unavailable", deletion: null },
    ],
    busProjects: [{ id: "b1", cwd: "/w/c", sessions: [] }],
    deletions: [{ path: "/w/gone", state: "failed", error: "EACCES" }],
  });
  assert.deepEqual(
    projects.map((p) => [p.name, p.folder, p.deletion]),
    [
      ["a", "present", { state: "deleting", error: null }],
      ["b", "unavailable", null],
      ["c", "present", null],
    ],
  );
});

test("a repository fills the folder state a memory row lacks", () => {
  const [p] = mergeProjects({
    memoryProjects: [{ id: "m1", name: "a", cwd: "/w/a" }],
    repositories: [{ id: "r1", name: "a", path: "/w/a/", folder: "missing" }],
    busProjects: [],
  });
  assert.equal(p.folder, "missing");
  assert.equal(p.deletion, null);
});

test("project states: deletion first, then the folder", () => {
  assert.equal(projectState({ folder: "present", deletion: null }), null);
  assert.equal(projectState({ folder: "missing", deletion: null }), "missing");
  assert.equal(projectState({ folder: "unavailable" }), "unavailable");
  assert.equal(
    projectState({ folder: "missing", deletion: { state: "deleting" } }),
    "deleting",
  );
  assert.equal(
    projectState({ folder: "present", deletion: { state: "failed" } }),
    "failed",
  );
});

test("the menu offers Delete project … or Remove from AgentPier … as a danger item", () => {
  en(() => {
    assert.equal(deleteLabel({ folder: "present" }), "Delete project …");
    assert.equal(deleteLabel({ folder: "missing" }), "Remove from AgentPier …");
    assert.equal(deleteLabel({ folder: "unavailable" }), "Delete project …");
  });
  const run = () => {};
  const items = projectMenuItems({
    groups: [],
    current: null,
    onMove() {},
    onNewGroup() {},
    onRemove() {},
    onDelete: run,
    deleteLabel: "Delete project …",
  });
  const last = items.at(-1);
  assert.deepEqual(last, {
    id: "delete",
    label: "Delete project …",
    danger: true,
    restoreFocus: false,
    run,
  });
  assert.equal(items.at(-2).kind, "separator");
  assert.equal(items.filter((item) => item.kind === "separator").length, 1);
  const grouped = projectMenuItems({
    groups: [{ id: "g", name: "G" }],
    current: { id: "g", name: "G" },
    onMove() {},
    onNewGroup() {},
    onRemove() {},
    onDelete: run,
    deleteLabel: "x",
  });
  assert.deepEqual(
    grouped.map((item) => item.id),
    ["move", "separator", "remove", "delete-separator", "delete"],
  );
  const none = projectMenuItems({
    groups: [],
    current: null,
    onMove() {},
    onNewGroup() {},
    onRemove() {},
  });
  assert.equal(
    none.some((item) => item.id === "delete"),
    false,
  );
});

test("the delete action is absent while deleting or failed, retry only when failed", () => {
  assert.equal(canDelete({ deletion: null }), true);
  assert.equal(canDelete({ deletion: { state: "deleting" } }), false);
  assert.equal(canDelete({ deletion: { state: "failed", error: "EACCES" } }), false);
  // A missing folder that came back: a new delete replaces the record.
  const back = { deletion: { state: "failed", error: "PROJECT_FOLDER_REAPPEARED" } };
  assert.equal(canDelete(back), true);
  assert.equal(canRetry(back), false);
  assert.equal(canRetry({ deletion: { state: "failed", error: "EACCES" } }), true);
  assert.equal(canRetry({ deletion: { state: "deleting" } }), false);
  assert.equal(canRetry({ deletion: null }), false);
});

test("the name must match exactly unless the folder is missing", () => {
  const report = { ready: true, folderState: "present", name: "a" };
  assert.equal(confirmReady(report, "A"), false);
  assert.equal(confirmReady(report, "a "), false);
  assert.equal(confirmReady(report, "a"), true);
  assert.equal(confirmReady({ ...report, ready: false }, "a"), false);
  assert.equal(confirmReady({ ...report, folderState: "missing" }, ""), true);
  assert.equal(confirmReady(null, "a"), false);
});

test("only endable processes can be ticked", () => {
  const report = {
    processes: {
      status: "ok",
      list: [
        { pid: 10, startTime: "s", endable: true, owner: "self", protected: false },
        { pid: 11, startTime: "t", endable: false, owner: "other", protected: false },
        { pid: 12, startTime: "u", endable: false, owner: "self", protected: true },
      ],
    },
  };
  assert.deepEqual(
    endableProcesses(report).map((item) => item.pid),
    [10],
  );
  assert.deepEqual(endableProcesses({}), []);
});

test("Git warnings list changes, unpushed commits and what could not be checked", () => {
  const report = {
    git: [
      {
        path: "/w/a",
        report: {
          status: "ok",
          unpushedBranches: 2,
          worktreesChecked: false,
          worktrees: [
            {
              path: "/w/a",
              branch: "main",
              inside: true,
              changes: 3,
              unpushed: 1,
              checked: true,
            },
            {
              path: "/w/a/.worktrees/x",
              branch: "x",
              inside: true,
              changes: 0,
              unpushed: 0,
              checked: true,
            },
            {
              path: "/elsewhere/y",
              branch: "y",
              inside: false,
              changes: 1,
              unpushed: 0,
              checked: true,
            },
            {
              path: "/w/a/.worktrees/z",
              branch: "z",
              inside: true,
              changes: null,
              unpushed: null,
              checked: false,
            },
            {
              path: "/elsewhere/q",
              branch: "q",
              inside: false,
              changes: null,
              unpushed: null,
              checked: false,
            },
          ],
        },
      },
      {
        path: "/w/a/sub",
        report: {
          status: "unchecked",
          worktrees: [],
          unpushedBranches: null,
          worktreesChecked: false,
        },
      },
      {
        path: "/w/a/plain",
        report: {
          status: "none",
          worktrees: [],
          unpushedBranches: null,
          worktreesChecked: true,
        },
      },
    ],
  };
  const lines = en(() => gitWarnings(report).map((item) => [item.path, item.text]));
  assert.deepEqual(lines, [
    ["/w/a", "2 commits that no remote has"],
    ["/w/a", "/w/a could not be checked."],
    ["/w/a", "3 uncommitted changes"],
    ["/elsewhere/y", "1 uncommitted change"],
    [
      "/elsewhere/y",
      "The linked worktree /elsewhere/y lies outside the folder and is kept; remove it by hand afterwards.",
    ],
    ["/w/a/.worktrees/z", "/w/a/.worktrees/z could not be checked."],
    ["/elsewhere/q", "/elsewhere/q could not be checked."],
    [
      "/elsewhere/q",
      "The linked worktree /elsewhere/q lies outside the folder and is kept; remove it by hand afterwards.",
    ],
    ["/w/a/sub", "/w/a/sub could not be checked."],
  ]);
  assert.deepEqual(gitWarnings({ git: [] }), []);
});

test("refusals and failure codes read in English, unknown ones fall back", () => {
  en(() => {
    assert.match(
      refusalText("drive-unavailable"),
      /drive of this folder is not available/,
    );
    assert.match(refusalText("home-child"), /directly in your home folder/);
    assert.match(refusalText("agentpier-process"), /process AgentPier needs/);
    assert.match(refusalText("whatever"), /could not be read/);
    assert.match(failureText("EACCES"), /permissions/);
    assert.match(failureText("EPERM"), /permissions/);
    assert.match(failureText("PROJECT_FOLDER_REAPPEARED"), /exists again/);
    assert.match(failureText("ENOTEMPTY"), /did not finish/);
    assert.match(failureText(null), /did not finish/);
  });
});
