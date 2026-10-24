import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RepositoryStore } from "../../server/features/repositories/repository-store.js";
import {
  GithubCredentials,
  readOnlyPushMessage,
} from "../../server/features/repositories/github-credentials.js";
import { execShellScript } from "../../server/features/assistants/exec-shell.js";

// AGENTPIER-211: real git in an agent's shell, through the exec wrapper as OpenClaw
// runs it (OPENCLAW_PREPEND_PATH, fact d). github.com is served by a local bare
// repository: a global config of the test's own rewrites https://github.com/ and
// git@github.com: to it, so fetches need no network and no credential.
function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-gh-ro-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, "data");
  const home = path.join(dir, "home");
  for (const folder of [dataDir, home]) fs.mkdirSync(folder);
  const repositories = new RepositoryStore({ dataDir });
  const work = repositories.createCredential({
    name: "Work",
    host: "https://github.com",
    token: "ghp_read_only_test_token",
  });
  const github = new GithubCredentials({ dataDir, repositories });
  const remotes = path.join(dir, "remotes");
  const globalConfig = path.join(dir, "gitconfig");
  fs.writeFileSync(
    globalConfig,
    `[url "file://${remotes}/"]\n\tinsteadOf = https://github.com/\n\tinsteadOf = git@github.com:\n` +
      "[init]\n\tdefaultBranch = main\n",
  );
  const env = {
    HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Owner",
    GIT_AUTHOR_EMAIL: "owner@example.com",
    GIT_COMMITTER_NAME: "Owner",
    GIT_COMMITTER_EMAIL: "owner@example.com",
  };
  const git = (args, cwd = dir) => {
    const result = spawnSync("git", args, {
      cwd,
      env: { ...env, PATH: process.env.PATH },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  // The remote with one commit, seeded outside the agent's shell.
  git(["init", "-q", "--bare", path.join(remotes, "o", "r.git")]);
  git(["clone", "-q", "https://github.com/o/r.git", "seed"]);
  git(["commit", "-q", "--allow-empty", "-m", "first"], path.join(dir, "seed"));
  git(["push", "-q", "origin", "HEAD:main"], path.join(dir, "seed"));
  const wrapper = path.join(dir, "sh");
  fs.writeFileSync(wrapper, execShellScript(home), { mode: 0o700 });
  let marker;
  // A command in the agent's shell, as OpenClaw 2026.10.3 hands it to the wrapper.
  const shell = (command) =>
    spawnSync(
      wrapper,
      [
        "-c",
        'export PATH="${OPENCLAW_PREPEND_PATH}${PATH:+:$PATH}"; ' +
          `unset OPENCLAW_PREPEND_PATH; cd '${dir}' && ${command}`,
      ],
      {
        env: { ...env, PATH: process.env.PATH, OPENCLAW_PREPEND_PATH: marker },
        encoding: "utf8",
      },
    );
  return {
    dir,
    git,
    shell,
    remoteHead: () =>
      git([
        "--git-dir",
        path.join(remotes, "o", "r.git"),
        "log",
        "-1",
        "--format=%s",
        "main",
      ]),
    level: (level) => {
      marker = github.prepareAgent("a1", work.id, level);
    },
  };
}

test("with Read, git push to the profile's host fails and fetch keeps working", (t) => {
  const f = setup(t);
  f.level("read");
  const clone = f.shell("git clone -q https://github.com/o/r.git agent");
  assert.equal(clone.status, 0, clone.stderr);
  const commit = f.shell("cd agent && git commit -q --allow-empty -m second");
  assert.equal(commit.status, 0, commit.stderr);
  const push = f.shell("cd agent && git push origin HEAD:main");
  assert.notEqual(push.status, 0);
  assert.ok(push.stderr.includes(readOnlyPushMessage), push.stderr);
  assert.equal(f.remoteHead(), "first");
  // Fetch and pull use the unchanged URL.
  f.git(["commit", "-q", "--allow-empty", "-m", "upstream"], path.join(f.dir, "seed"));
  f.git(["push", "-q", "origin", "HEAD:main"], path.join(f.dir, "seed"));
  const fetch = f.shell(
    "cd agent && git fetch -q origin && git log -1 --format=%s origin/main",
  );
  assert.equal(fetch.status, 0, fetch.stderr);
  assert.equal(fetch.stdout.trim(), "upstream");
  const pull = f.shell("cd agent && git pull -q --rebase origin main");
  assert.equal(pull.status, 0, pull.stderr);
  // The SSH form of the same host is refused as well.
  const ssh = f.shell(
    "cd agent && git remote set-url origin git@github.com:o/r.git && " +
      "git fetch -q origin && git push origin HEAD:main",
  );
  assert.notEqual(ssh.status, 0);
  assert.ok(ssh.stderr.includes(readOnlyPushMessage), ssh.stderr);
  assert.equal(f.remoteHead(), "upstream");
});

test("with Read and write, git push from the agent's shell works", (t) => {
  const f = setup(t);
  f.level("read");
  assert.equal(f.shell("git clone -q https://github.com/o/r.git agent").status, 0);
  // The level changed in Work -> GitHub: the folder is prepared again.
  f.level("write");
  const push = f.shell(
    "cd agent && git commit -q --allow-empty -m second && git push -q origin HEAD:main",
  );
  assert.equal(push.status, 0, push.stderr);
  assert.equal(f.remoteHead(), "second");
});
