import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  GitRemotes,
  publicRemote,
} from "../../server/features/repositories/git-remote.js";

function folder(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-remote-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function repository(root, name, remote) {
  const cwd = path.join(root, name);
  fs.mkdirSync(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  if (remote) execFileSync("git", ["-C", cwd, "remote", "add", "origin", remote]);
  return cwd;
}
function fakeGit(root, body) {
  const file = path.join(root, "fake-git.cjs");
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return file;
}

test("a folder that became a repository reports its origin remote", async (t) => {
  const root = folder(t);
  const cwd = repository(root, "lab", "git@github.com:acme/lab.git");
  const remotes = new GitRemotes();
  assert.equal(await remotes.read(cwd), "git@github.com:acme/lab.git");
});

test("credentials embedded in a remote never reach the caller", async (t) => {
  const root = folder(t);
  const cwd = repository(root, "secret", "https://user:token@github.com/acme/app.git");
  assert.equal(await new GitRemotes().read(cwd), "https://github.com/acme/app.git");
  assert.equal(
    publicRemote("https://ghp_abc@github.com/acme/app.git?x=1#y"),
    "https://github.com/acme/app.git",
  );
  assert.equal(
    publicRemote("ssh://git:pw@host.example/acme/app"),
    "ssh://host.example/acme/app",
  );
  assert.equal(
    publicRemote("git@github.com:acme/app.git"),
    "git@github.com:acme/app.git",
  );
  assert.equal(publicRemote("/srv/git/app.git"), "/srv/git/app.git");
  assert.equal(publicRemote("https://github.com/a\nb"), "");
});

test("plain folders, repositories without origin and missing folders report nothing", async (t) => {
  const root = folder(t);
  const plain = path.join(root, "plain");
  fs.mkdirSync(plain);
  const bare = repository(root, "no-origin");
  const remotes = new GitRemotes();
  assert.equal(await remotes.read(plain), "");
  assert.equal(await remotes.read(bare), "");
  assert.equal(await remotes.read(path.join(root, "gone")), "");
  assert.equal(await remotes.read("relative/path"), "");
});

test("a missing or hanging git reports nothing within the time bound", async (t) => {
  const root = folder(t);
  const cwd = repository(root, "app", "https://github.com/acme/app.git");
  const missing = new GitRemotes({ git: path.join(root, "no-such-git") });
  assert.equal(await missing.read(cwd), "");
  const hanging = new GitRemotes({
    git: fakeGit(root, "setTimeout(() => {}, 60000);"),
    timeoutMs: 200,
  });
  const started = Date.now();
  assert.equal(await hanging.read(cwd), "");
  assert.ok(Date.now() - started < 5000);
});

test("remotes are cached briefly per folder", async (t) => {
  const root = folder(t);
  const cwd = path.join(root, "app");
  fs.mkdirSync(cwd);
  const count = path.join(root, "calls");
  const git = fakeGit(
    root,
    `require("node:fs").appendFileSync(${JSON.stringify(count)}, "x");
process.stdout.write("https://github.com/acme/app.git\\n");`,
  );
  let now = 1000;
  const remotes = new GitRemotes({ git, ttlMs: 5000, now: () => now });
  assert.equal(await remotes.read(cwd), "https://github.com/acme/app.git");
  assert.equal(await remotes.read(cwd), "https://github.com/acme/app.git");
  assert.equal(fs.readFileSync(count, "utf8"), "x");
  now += 6000;
  await remotes.read(cwd);
  assert.equal(fs.readFileSync(count, "utf8"), "xx");
  const listed = await remotes.annotate([{ cwd }, { cwd: "" }], "cwd");
  assert.deepEqual(
    listed.map((item) => item.remote),
    ["https://github.com/acme/app.git", ""],
  );
});
