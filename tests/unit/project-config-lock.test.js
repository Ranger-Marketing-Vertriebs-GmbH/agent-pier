import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectTarget } from "../../server/features/assistants/project-paths.js";

const locked = { status: 403, key: "projectToolConfigLocked" };
const user = { lockToolConfig: true, write: true };

// A real repository with one commit, isolated from the host's Git configuration.
function repo(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "config-lock-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, stdio: "pipe" });
  const project = path.join(base, "app");
  fs.mkdirSync(project);
  git(project, "init", "-q");
  git(project, "commit", "-q", "--allow-empty", "-m", "init");
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
    fs.writeFileSync(path.join(project, name), text);
  };
  return { project, git, write };
}

const refusedFor = (project, paths) => {
  for (const raw of paths) {
    assert.throws(() => projectTarget(project, raw, user), locked, raw);
    projectTarget(project, raw, { write: true });
  }
};

test("a linked worktree's relative hooks path and lefthook folders are locked", (t) => {
  const r = repo(t);
  r.git(r.project, "config", "core.hooksPath", "scripts/hooks");
  r.git(r.project, "worktree", "add", "-q", ".worktrees/feat");
  assert.equal(
    r
      .git(path.join(r.project, ".worktrees", "feat"), "rev-parse", "--git-path", "hooks")
      .toString()
      .trim(),
    "scripts/hooks",
  );
  r.write(".worktrees/feat/lefthook.yml", "source_dir: tools/hooks\n");
  refusedFor(r.project, [
    "scripts/hooks/pre-commit",
    ".worktrees/feat/scripts/hooks/pre-commit",
    ".worktrees/feat/.lefthook/pre-commit/x.sh",
    ".worktrees/feat/tools/hooks/pre-commit/x.sh",
    ".worktrees/feat/scripts",
  ]);
  assert.equal(
    projectTarget(r.project, ".worktrees/feat/src/a.js", user).relative,
    ".worktrees/feat/src/a.js",
  );
});

test("a nested repository's own hooks path and lefthook folders are locked", (t) => {
  const r = repo(t);
  const vendored = path.join(r.project, "vendor", "lib");
  fs.mkdirSync(vendored, { recursive: true });
  r.git(vendored, "init", "-q");
  r.git(vendored, "config", "core.hooksPath", "githooks");
  refusedFor(r.project, [
    "vendor/lib/githooks/pre-commit",
    "vendor/lib/.lefthook/pre-commit/x.sh",
  ]);
  assert.equal(
    projectTarget(r.project, "vendor/lib/index.js", user).relative,
    "vendor/lib/index.js",
  );
});

test("Git config files included from the working tree are locked with their settings", (t) => {
  const r = repo(t);
  r.git(r.project, "config", "include.path", "../.gitconfig");
  r.git(r.project, "config", "includeIf.onbranch:main.path", "../config/git/extra");
  r.write(".gitconfig", "[include]\n\tpath = config/git/more\n");
  r.write("config/git/more", '[core]\n\thooksPath = "planted-hooks"\n');
  refusedFor(r.project, [
    ".gitconfig",
    "config/git/more",
    "config/git/extra",
    "config/git",
    "planted-hooks/pre-commit",
  ]);
  assert.equal(
    projectTarget(r.project, "config/app.json", user).relative,
    "config/app.json",
  );
});

test("a folder too large to search completely locks every write", (t) => {
  const r = repo(t);
  for (let i = 0; i < 10001; i++)
    fs.mkdirSync(path.join(r.project, "d", String(i)), {
      recursive: true,
    });
  assert.throws(() => projectTarget(r.project, "src/a.js", user), locked);
  assert.equal(
    projectTarget(r.project, "src/a.js", { write: true }).relative,
    "src/a.js",
  );
});
