import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellSegments } from "../../server/features/requests/shell-command.js";
import { defaultSegments } from "../../server/features/requests/cli-approval-defaults.js";

const allowed = (command, place) => {
  const segments = shellSegments(command);
  return Boolean(segments && defaultSegments(segments, place).every(Boolean));
};

// A project with a repository of its own, a linked work tree, and repositories
// inside it that are not its own: a nested one, a submodule and a bare one.
function project(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-place-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const make = (...parts) => fs.mkdirSync(path.join(root, ...parts), { recursive: true });
  const file = (name, text) => fs.writeFileSync(path.join(root, name), text);
  make("proj/.git");
  make("proj/src/deep");
  make("proj/nested/.git");
  make("proj/nested/src");
  make("proj/module");
  file("proj/module/.git", "gitdir: ../.git/modules/module\n");
  make("proj/.worktrees/x/web");
  file("proj/.worktrees/x/.git", "gitdir: ../../.git/worktrees/x\n");
  make("proj/bare.git/objects");
  make("proj/bare.git/refs");
  file("proj/bare.git/HEAD", "ref: refs/heads/main\n");
  make("proj/origin");
  make("plain/sub");
  const proj = path.join(root, "proj");
  return {
    root,
    proj,
    place: { cwd: proj, roots: [proj, path.join(proj, ".worktrees/x")] },
  };
}

test("git is covered only in a repository of the project", (t) => {
  const { root, proj, place } = project(t);
  for (const command of [
    "git status",
    "cd src/deep && git log -3",
    "git -C .worktrees/x status",
    "cd .worktrees/x/web && git diff --stat",
    "git fetch upstream",
  ])
    assert.equal(allowed(command, place), true, command);
  assert.equal(
    allowed("git status", { ...place, cwd: path.join(proj, ".worktrees/x") }),
    true,
  );
  for (const command of [
    "git -C nested status",
    "cd nested/src && git log -3",
    "git -C module diff",
    "git -C bare.git log",
    "cd bare.git && git fetch",
    "cd bare.git/refs && git status",
    // A remote's name that is a folder here is a path to git.
    "git fetch origin",
  ])
    assert.equal(allowed(command, place), false, command);
  // Nothing but git depends on the repository.
  assert.equal(allowed("cd nested && npm test && ls", place), true);
  // A folder without a repository: git only reports that.
  const plain = path.join(root, "plain");
  assert.equal(allowed("cd sub && git status", { cwd: plain, roots: [plain] }), true);
  // A project folder inside someone else's repository.
  const inner = path.join(proj, "src");
  assert.equal(allowed("git status", { cwd: inner, roots: [inner] }), false);
});

test("long chains and deep paths ask without being resolved", (t) => {
  const { place } = project(t);
  const timed = (command, expected) => {
    const started = performance.now();
    assert.equal(allowed(command, place), expected, command.slice(0, 30));
    assert.ok(performance.now() - started < 300, `slow for ${command.slice(0, 30)}…`);
  };
  timed(`${"cd src && cd .. && ".repeat(9)}git status`, true);
  timed(`${"cd src && cd .. && ".repeat(400)}git status`, false);
  timed(`cd ${"src/../".repeat(30)}src && git status`, false);
  timed(`git -C ${"a/".repeat(500)} status`, false);
  timed(`${"cd missing/a/b/c && ".repeat(19)}ls`, true);
});
