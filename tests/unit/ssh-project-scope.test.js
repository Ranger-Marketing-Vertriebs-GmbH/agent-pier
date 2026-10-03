import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createSshProjectBinding,
  validateSshProjectBinding,
} from "../../server/features/ssh/ssh-project-scope.js";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test("ordinary directory binding detects replacement and keeps its project after git init", async (t) => {
  const root = fixture(t),
    cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const binding = await createSshProjectBinding(cwd);
  assert.equal((await validateSshProjectBinding(binding)).projectId, binding.projectId);
  fs.renameSync(cwd, cwd + "-old");
  fs.mkdirSync(cwd);
  await assert.rejects(validateSshProjectBinding(binding), {
    code: "SSH_PROJECT_CHANGED",
  });
  const next = await createSshProjectBinding(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  const initialized = await validateSshProjectBinding(next);
  const repository = await createSshProjectBinding(cwd);
  assert.equal(initialized.projectId, next.projectId, "No access is added");
  assert.equal(initialized.kind, "directory");
  assert.deepEqual(initialized.rebind, {
    fromId: next.projectId,
    toId: repository.projectId,
  });
  assert.equal((await validateSshProjectBinding(repository)).rebind, undefined);
  fs.rmSync(path.join(cwd, ".git"), { recursive: true });
  await assert.rejects(validateSshProjectBinding(repository), {
    code: "SSH_PROJECT_CHANGED",
  });
  fs.rmSync(cwd, { recursive: true });
  await assert.rejects(validateSshProjectBinding(next), {
    code: "SSH_PROJECT_UNAVAILABLE",
  });
});
test("git worktrees share project but replacing launch directory invalidates binding", async (t) => {
  const root = fixture(t),
    repo = path.join(root, "repo"),
    worktree = path.join(root, "worktree");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  execFileSync("git", ["-C", repo, "worktree", "add", "--detach", worktree], {
    stdio: "ignore",
  });
  const main = await createSshProjectBinding(repo),
    linked = await createSshProjectBinding(worktree);
  assert.equal(main.projectId, linked.projectId);
  fs.renameSync(worktree, worktree + "-old");
  fs.mkdirSync(worktree);
  fs.copyFileSync(path.join(worktree + "-old", ".git"), path.join(worktree, ".git"));
  assert.equal((await createSshProjectBinding(worktree)).projectId, main.projectId);
  await assert.rejects(validateSshProjectBinding(linked), {
    code: "SSH_PROJECT_CHANGED",
  });
});

test("nested directories and separate clones retain separate identities", async (t) => {
  const root = fixture(t),
    nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  const parent = await createSshProjectBinding(root);
  assert.notEqual((await createSshProjectBinding(nested)).projectId, parent.projectId);
  const first = path.join(root, "first"),
    second = path.join(root, "second");
  for (const repo of [first, second]) execFileSync("git", ["init", "-q", repo]);
  assert.notEqual(
    (await createSshProjectBinding(first)).projectId,
    (await createSshProjectBinding(second)).projectId,
  );
  await assert.rejects(validateSshProjectBinding(null), {
    code: "SSH_PROJECT_UNAVAILABLE",
  });
});

test("only a folder that became the root of its own repository keeps its binding", async (t) => {
  const root = fixture(t);
  const changed = { code: "SSH_PROJECT_CHANGED" };
  const child = path.join(root, "parent", "child");
  fs.mkdirSync(child, { recursive: true });
  const nested = await createSshProjectBinding(child);
  execFileSync("git", ["init", "-q", path.dirname(child)]);
  await assert.rejects(validateSshProjectBinding(nested), changed);

  const separate = path.join(root, "separate");
  fs.mkdirSync(separate);
  const plain = await createSshProjectBinding(separate);
  const outside = `--separate-git-dir=${path.join(root, "separate.git")}`;
  execFileSync("git", ["init", "-q", outside, separate]);
  await assert.rejects(validateSshProjectBinding(plain), changed);

  const linked = path.join(root, "linked"),
    elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(linked);
  const unlinked = await createSshProjectBinding(linked);
  execFileSync("git", ["init", "-q", elsewhere]);
  fs.symlinkSync(path.join(elsewhere, ".git"), path.join(linked, ".git"));
  await assert.rejects(validateSshProjectBinding(unlinked), changed);
});
