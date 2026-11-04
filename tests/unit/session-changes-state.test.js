import test from "node:test";
import assert from "node:assert/strict";
import {
  baseLine,
  changedCount,
  diffKey,
  shownWorkspace,
  workspaceLabel,
} from "../../web/features/sessions/session-changes-state.js";

const base = { kind: "start-commit", sha: "a".repeat(40) };
const root = { id: "", branch: "main", base, files: 2, added: 5, removed: 1 };
const tree = {
  id: ".worktrees/feat/x",
  branch: "feat/x",
  base: { kind: "merge-base", sha: "b".repeat(40), ref: "refs/remotes/origin/main" },
  files: 0,
  added: 0,
  removed: 0,
};
const summary = { repository: true, workspaces: [root, tree], changedFiles: 2 };
const copy = {
  sessionDirectory: "Session directory",
  baseMergeBase: (name) => `Since the branch point with ${name}`,
  baseStart: "Since the session started",
  baseFirstOpen: "Since this session was first viewed after the update",
  baseHead: "Uncommitted changes only",
};

test("the tab shows the picked workspace while it is listed, else the first", () => {
  assert.equal(shownWorkspace(summary, null), "");
  assert.equal(shownWorkspace(summary, tree.id), tree.id);
  assert.equal(shownWorkspace(summary, ".worktrees/gone"), "");
  assert.equal(shownWorkspace({ ...summary, workspaces: [tree] }, ""), tree.id);
  assert.equal(shownWorkspace({ repository: false, workspaces: [] }, null), null);
  assert.equal(shownWorkspace(null, "x"), null);
});

test("the diff is read again only when its workspace entry changes", () => {
  assert.equal(diffKey(root), diffKey({ ...root }));
  for (const change of [
    { base: { ...base, sha: "c".repeat(40) } },
    { files: 3 },
    { added: 6 },
    { removed: 2 },
  ])
    assert.notEqual(diffKey({ ...root, ...change }), diffKey(root));
  assert.equal(diffKey({ ...root, branch: "other" }), diffKey(root));
  assert.equal(diffKey(undefined), null);
});

test("a workspace reads as its id or the session directory, branch and lines", () => {
  assert.equal(workspaceLabel(root, copy), "Session directory · main · +5 −1");
  assert.equal(workspaceLabel(tree, copy), ".worktrees/feat/x · feat/x · +0 −0");
  assert.equal(
    workspaceLabel({ ...tree, branch: null }, copy),
    ".worktrees/feat/x · +0 −0",
  );
});

test("the base line names the branch point, the session start or uncommitted work", () => {
  assert.equal(baseLine(tree.base, null, copy), "Since the branch point with main");
  assert.equal(
    baseLine({ kind: "merge-base", ref: "refs/heads/master" }, null, copy),
    "Since the branch point with master",
  );
  assert.equal(baseLine(base, { sha: base.sha, source: "start" }, copy), copy.baseStart);
  assert.equal(
    baseLine(base, { sha: base.sha, source: "first-open" }, copy),
    copy.baseFirstOpen,
  );
  assert.equal(
    baseLine({ kind: "head", sha: "d".repeat(40) }, null, copy),
    copy.baseHead,
  );
});

test("the badge counts changed files and hides at zero or without a summary", () => {
  assert.equal(changedCount(summary), 2);
  assert.equal(changedCount({ changedFiles: 0 }), 0);
  assert.equal(changedCount(null), 0);
  assert.equal(changedCount({ changedFiles: "3" }), 0);
});
