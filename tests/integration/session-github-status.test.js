import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RepositoryStore } from "../../server/features/repositories/repository-store.js";
import { GithubCredentials } from "../../server/features/repositories/github-credentials.js";
import { remoteTransport } from "../../server/features/repositories/git-remote.js";

test("remote transports tell SSH from HTTPS remotes", () => {
  for (const [remote, expected] of [
    ["https://github.com/acme/app.git", { protocol: "https", host: "github.com" }],
    ["git@github.com:acme/app.git", { protocol: "ssh", host: "github.com" }],
    ["ssh://git@GHE.example:2222/acme/app", { protocol: "ssh", host: "ghe.example" }],
    ["git+ssh://git@github.com/acme/app", { protocol: "ssh", host: "github.com" }],
    ["/srv/git/app.git", { protocol: "other", host: null }],
    ["", null],
  ])
    assert.deepEqual(remoteTransport(remote), expected, remote);
});

test("a session's GitHub status names its profiles and token checks without tokens", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-sgs-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repositories = new RepositoryStore({
    dataDir: path.join(root, "data"),
    home: root,
  });
  const credentials = new GithubCredentials({
    dataDir: repositories.dataDir,
    repositories,
    resolveGh: () => null,
  });
  const work = repositories.createCredential({
    name: "Work",
    host: "github.com",
    token: "status-secret",
  });
  repositories.credential(work.id).tokenCheck = { state: "expired" };
  await credentials.prepare({
    id: "status",
    account: { tool: "shell" },
    cwd: root,
    launch: { args: [], env: {} },
  });
  const status = credentials.status("status");
  assert.deepEqual(status, {
    configured: true,
    hosts: [
      { host: "github.com", credentialId: work.id, name: "Work", tokenState: "expired" },
    ],
  });
  repositories.removeCredential(work.id);
  assert.deepEqual(credentials.status("status").hosts, [
    { host: "github.com", tokenState: "removed" },
  ]);
  assert.deepEqual(credentials.status("unknown"), { configured: false, hosts: [] });
  assert.equal(JSON.stringify(status).includes("status-secret"), false);
});
