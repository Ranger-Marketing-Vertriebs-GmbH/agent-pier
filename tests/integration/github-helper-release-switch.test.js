import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RepositoryStore } from "../../server/features/repositories/repository-store.js";
import { GithubCredentials } from "../../server/features/repositories/github-credentials.js";
import { githubHelperLocation } from "../../server/features/repositories/github-helper-location.js";

const source = fileURLToPath(new URL("../../", import.meta.url));
const gitAvailable = !spawnSync("git", ["--version"]).error;
// The helper's whole import graph; the test asserts it stays this small.
const helperFiles = [
  "server/github-credentials.js",
  "server/lib/is-main-module.js",
  "server/features/repositories/session-git-credential.js",
  "server/features/repositories/git-credential-request.js",
  "vendor/agentbus/core/fsx.js",
  "vendor/agentbus/package.json",
  "package.json",
];

function release(root, version) {
  const directory = path.join(root, "releases", version);
  for (const file of helperFiles) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join(directory, file));
  }
  fs.mkdirSync(path.join(directory, "bin"));
  fs.symlinkSync(process.execPath, path.join(directory, "bin", "node"));
  return directory;
}

test(
  "a session keeps its git credentials after an update switches releases and cleanup removes the old one",
  { skip: !gitAvailable && "git not installed" },
  async (t) => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-ghr-")),
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const install = path.join(root, "app");
    const first = release(install, "1.0.0");
    fs.symlinkSync("releases/1.0.0", path.join(install, "current"));
    const repositories = new RepositoryStore({
      dataDir: path.join(root, "data"),
      home: root,
    });
    repositories.createCredential({ name: "A", host: "github.com", token: "fixture-a" });
    const session = (id, helperLocation) =>
      new GithubCredentials({
        dataDir: repositories.dataDir,
        repositories,
        resolveGh: () => null,
        helperLocation,
      }).prepare({
        id,
        account: { tool: "codex" },
        cwd: root,
        launch: { args: [], env: { PATH: process.env.PATH } },
      });
    const prepared = await session("switch", () =>
      githubHelperLocation({ installRoot: install, applicationRoot: first }),
    );
    // How sessions were configured before: node and helper inside the release.
    const pinned = await session("pinned", () => ({
      node: path.join(first, "bin", "node"),
      script: path.join(first, "server", "github-credentials.js"),
      reads: [],
    }));
    assert.equal(JSON.stringify(prepared.env).includes("1.0.0"), false);
    // The update: a new release becomes current, cleanup deletes the old one.
    release(install, "1.1.0");
    fs.rmSync(path.join(install, "current"));
    fs.symlinkSync("releases/1.1.0", path.join(install, "current"));
    fs.rmSync(first, { recursive: true });
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    const fill = (env, host = "github.com") =>
      spawnSync("git", ["credential", "fill"], {
        input: `protocol=https\nhost=${host}\n\n`,
        encoding: "utf8",
        cwd: root,
        env: {
          ...env,
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
        timeout: 10000,
      });
    assert.notEqual(fill(pinned.env).status, 0);
    for (const host of ["github.com", "gist.github.com"]) {
      const result = fill(prepared.env, host);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^password=fixture-a$/m);
    }
  },
);
