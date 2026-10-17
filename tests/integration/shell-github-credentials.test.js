import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RepositoryStore } from "../../server/features/repositories/repository-store.js";
import { GithubCredentials } from "../../server/features/repositories/github-credentials.js";

const gitAvailable = !spawnSync("git", ["--version"]).error;

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-sh-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repositories = new RepositoryStore({
    dataDir: path.join(root, "data"),
    home: root,
  });
  const credentials = new GithubCredentials({
    dataDir: repositories.dataDir,
    repositories,
    resolveGh: () => "/fixture/gh",
  });
  const launch = {
    args: [],
    env: { PATH: process.env.PATH, GH_CONFIG_DIR: "/owner/gh", GH_TOKEN: "owner" },
  };
  const prepare = (id) =>
    credentials.prepare({ id, account: { tool: "shell" }, cwd: root, launch });
  return { root, repositories, credentials, launch, prepare };
}

test("a shell without a selected profile keeps the owner's gh and git untouched", async (t) => {
  const { launch, prepare } = setup(t);
  assert.deepEqual(await prepare("plain"), launch);
});

test(
  "a shell's git uses the selected profile while other hosts keep the owner's helpers",
  { skip: !gitAvailable && "git not installed" },
  async (t) => {
    const { root, repositories, prepare } = setup(t);
    repositories.createCredential({
      name: "A",
      host: "github.com",
      token: "shell-token",
    });
    const prepared = await prepare("with-profile");
    assert.equal(prepared.env.GH_CONFIG_DIR, "/owner/gh");
    assert.equal(prepared.env.GH_TOKEN, "owner");
    assert.equal(JSON.stringify(prepared).includes("shell-token"), false);
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    const prompts = path.join(root, "prompts.log");
    const askpass = path.join(root, "askpass.sh");
    fs.writeFileSync(askpass, `#!/bin/sh\necho "$*" >> '${prompts}'\necho prompted\n`, {
      mode: 0o700,
    });
    const fill = (host) =>
      spawnSync("git", ["credential", "fill"], {
        input: `protocol=https\nhost=${host}\n\n`,
        encoding: "utf8",
        cwd: root,
        env: {
          ...prepared.env,
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_ASKPASS: askpass,
        },
        timeout: 10000,
      });
    for (const host of ["github.com", "gist.github.com"]) {
      const result = fill(host);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^password=shell-token$/m);
    }
    assert.equal(fs.existsSync(prompts), false);
    // An unselected host still reaches the owner's own credential flow.
    assert.equal(fill("example.test").status, 0);
    assert.match(fs.readFileSync(prompts, "utf8"), /example\.test/);
  },
);
