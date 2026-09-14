import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RepositoryStore } from "../../server/features/repositories/repository-store.js";
import { GithubCredentials } from "../../server/features/repositories/github-credentials.js";

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-identity-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repositories = new RepositoryStore({
    dataDir: path.join(root, "data"),
    home: root,
  });
  const github = new GithubCredentials({
    dataDir: repositories.dataDir,
    repositories,
    resolveGh: () => null,
  });
  const launch = {
    args: [],
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  };
  return { root, repositories, github, launch };
}

test("commit identities persist, survive token rotation, clear explicitly and reject partial updates atomically", (t) => {
  const { repositories, root } = setup(t);
  const identity = { name: "Work Author", email: "work@example.test" };
  const entry = repositories.createCredential({
    name: "Work",
    host: "github.com",
    token: "original-token",
    commitIdentity: identity,
  });
  repositories.updateCredential(entry.id, { name: "Work", token: "rotated-token" });
  const reopened = new RepositoryStore({ dataDir: repositories.dataDir, home: root });
  assert.deepEqual(reopened.credential(entry.id).commitIdentity, identity);
  for (const invalid of [
    { name: "Name" },
    { name: "Name", email: "bad" },
    { name: "bad\nname", email: "a@b" },
    { name: "Name", email: "a\x01@b" },
  ]) {
    assert.throws(
      () =>
        reopened.updateCredential(entry.id, {
          name: "Changed",
          token: "must-not-save",
          commitIdentity: invalid,
        }),
      /INVALID_COMMIT_IDENTITY/,
    );
    assert.equal(reopened.credential(entry.id).name, "Work");
    assert.equal(
      JSON.parse(fs.readFileSync(reopened.secretFile(entry.id))).token,
      "rotated-token",
    );
  }
  reopened.updateCredential(entry.id, { name: "Work", commitIdentity: null });
  assert.equal(reopened.credential(entry.id).commitIdentity, undefined);
  assert.equal(
    JSON.stringify(reopened.listCredentials()).includes("rotated-token"),
    false,
  );
});

test("real commits use the selected project token identity for author and committer without global Git changes", async (t) => {
  const { root, repositories, github, launch } = setup(t);
  for (const [index, name] of ["Work Author", "Personal Author"].entries()) {
    const identity = { name, email: `author${index}@example.test` };
    const entry = repositories.createCredential({
      name,
      host: "github.com",
      token: `token-${index}`,
      commitIdentity: identity,
    });
    const cwd = path.join(root, `project${index}`);
    fs.mkdirSync(cwd);
    repositories.projects.push({
      path: cwd,
      url: `https://github.com/owner/project${index}`,
      credentialId: entry.id,
    });
    const result = await github.prepare({
      id: `session${index}`,
      account: { tool: "codex" },
      cwd,
      launch,
    });
    const git = (...args) => {
      const child = spawnSync("git", args, { cwd, env: result.env, encoding: "utf8" });
      assert.equal(child.status, 0, child.stderr);
      return child.stdout.trim();
    };
    git("init", "-q");
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture commit");
    assert.equal(
      git("log", "-1", "--format=%an|%ae|%cn|%ce"),
      `${name}|${identity.email}|${name}|${identity.email}`,
    );
    assert.equal(git("config", "user.name"), name);
  }
  assert.equal(fs.existsSync(path.join(root, ".gitconfig")), false);
});

test("a single default applies without a project while ambiguous hosts preserve existing Git identity", async (t) => {
  const { root, repositories, github, launch } = setup(t);
  repositories.createCredential({
    name: "One",
    host: "github.com",
    token: "one",
    commitIdentity: { name: "One", email: "one@example.test" },
  });
  const prepare = (id) =>
    github.prepare({ id, account: { tool: "claude" }, cwd: root, launch });
  assert.equal((await prepare("one")).env.GIT_AUTHOR_NAME, "One");
  repositories.createCredential({
    name: "Two",
    host: "git.example.test",
    token: "two",
    commitIdentity: { name: "Two", email: "two@example.test" },
  });
  assert.equal((await prepare("two")).env.GIT_AUTHOR_NAME, undefined);
});
