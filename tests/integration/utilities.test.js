import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AccountStore,
  detectTools,
  detectUtilities,
} from "../../server/features/accounts/account-store.js";
import { toolBinDirectories } from "../../server/features/tools/tool-paths.js";
import { GithubCredentials } from "../../server/features/repositories/github-credentials.js";

test("GitHub CLI is detected as a utility, never a coding account or session tool", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-utilities-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "gh");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const env = { PATH: root, HOME: root };
  assert.deepEqual(detectUtilities(env, false), [
    { id: "gh", name: "GitHub CLI", utility: true, installed: true, path: binary },
  ]);
  assert.equal(
    detectTools(env, false).some((tool) => tool.id === "gh"),
    false,
  );
  const accounts = new AccountStore({ dataDir: path.join(root, "data"), home: root });
  assert.equal(
    accounts.list().some((account) => account.tool === "gh"),
    false,
  );
  assert.throws(() => accounts.create({ name: "No account", tool: "gh" }), {
    status: 400,
  });
  fs.chmodSync(binary, 0o600);
  assert.equal(detectUtilities(env, false)[0].installed, false);
});
test("managed gh is available to coding agents while existing PATH binaries have precedence", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-utilities-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managed = path.join(root, "clis/gh/bin");
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(managed, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const dirs = toolBinDirectories(root);
  assert.ok(dirs.includes(managed));
  assert.equal(
    detectUtilities({ PATH: "", HOME: root }, false, dirs)[0].path,
    path.join(managed, "gh"),
  );
  fs.writeFileSync(path.join(root, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.equal(
    detectUtilities({ PATH: root, HOME: root }, false, dirs)[0].path,
    path.join(root, "gh"),
  );
  const accounts = new AccountStore({ dataDir: root, home: root });
  assert.ok(
    accounts.environment("local-codex").PATH.split(path.delimiter).includes(managed),
  );
  const github = new GithubCredentials({
    dataDir: root,
    repositories: { listCredentials: () => [], listProjects: () => [] },
  });
  const launch = await github.prepare({
    id: "utility-fixture",
    account: { tool: "codex" },
    cwd: root,
    launch: { env: { HOME: root, PATH: [root, managed].join(path.delimiter) } },
  });
  assert.equal(launch.env.PATH.split(path.delimiter)[0], root);
});
