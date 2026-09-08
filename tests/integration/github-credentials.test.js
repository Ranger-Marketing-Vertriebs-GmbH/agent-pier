import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RepositoryStore } from "../../server/features/repositories/repository-store.js";
import { GithubCredentials } from "../../server/features/repositories/github-credentials.js";
function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-gh-")));
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
  return { root, repositories, credentials };
}
const launch = {
  args: ["native"],
  env: {
    PATH: process.env.PATH,
    GH_TOKEN: "ambient",
    GITHUB_TOKEN: "ambient",
    GH_ENTERPRISE_TOKEN: "ambient",
    GITHUB_ENTERPRISE_TOKEN: "ambient",
    GH_HOST: "wrong",
    GH_REPO: "wrong",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "color.ui",
    GIT_CONFIG_VALUE_0: "false",
  },
};
test("per-host credentials select defaults and nearest cloned project without exposing secrets in environment", async (t) => {
  const { root, repositories, credentials } = setup(t);
  const a = repositories.createCredential({
    name: "A",
    host: "github.com",
    token: "secret-a",
  });
  const b = repositories.createCredential({
    name: "B",
    host: "github.com",
    token: "secret-b",
  });
  repositories.createCredential({
    name: "Enterprise",
    host: "git.example.test",
    token: "secret-e",
  });
  const project = path.join(root, "project");
  const nested = path.join(project, "nested");
  fs.mkdirSync(nested, { recursive: true });
  repositories.projects = [
    { path: project, url: "https://github.com/owner/repo", credentialId: b.id },
  ];
  const result = await credentials.prepare({
    id: "one",
    account: { tool: "codex" },
    cwd: nested,
    launch,
  });
  const hosts = JSON.parse(
    fs.readFileSync(path.join(result.env.GH_CONFIG_DIR, "hosts.yml")),
  );
  assert.equal(hosts["github.com"].oauth_token, "secret-b");
  assert.equal(hosts["git.example.test"].oauth_token, "secret-e");
  assert.equal(JSON.stringify(result).includes("secret-"), false);
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_HOST",
    "GH_REPO",
  ])
    assert.equal(result.env[key], undefined);
  assert.equal(result.env.GIT_CONFIG_VALUE_0, "false");
  assert.equal(result.env.GIT_CONFIG_COUNT, "5");
  assert.match(result.env.GIT_CONFIG_KEY_1, /credential\.https:\/\/github.com\.helper/);
  assert.equal(
    fs.statSync(path.join(result.env.GH_CONFIG_DIR, "hosts.yml")).mode & 0o777,
    0o600,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(result.env.GH_CONFIG_DIR, "config.yml")))
      .version,
    1,
  );
  assert.equal(
    repositories.listCredentials().find((x) => x.id === a.id).agentDefault,
    true,
  );
});
test("rotation, revocation and restart synchronize saved selections without retaining old secrets", async (t) => {
  const { root, repositories, credentials } = setup(t);
  const a = repositories.createCredential({
    name: "A",
    host: "github.com",
    token: "before",
  });
  const prepared = await credentials.prepare({
    id: "rotate",
    account: { tool: "claude" },
    cwd: root,
    launch,
  });
  const file = path.join(prepared.env.GH_CONFIG_DIR, "hosts.yml");
  repositories.updateCredential(a.id, { name: "A", token: "after" });
  await credentials.sync();
  assert.equal(fs.readFileSync(file, "utf8").includes("before"), false);
  assert.equal(JSON.parse(fs.readFileSync(file))["github.com"].oauth_token, "after");
  repositories.removeCredential(a.id);
  await new GithubCredentials({ dataDir: repositories.dataDir, repositories }).sync();
  assert.equal(
    JSON.parse(fs.readFileSync(file))["github.com"].oauth_token,
    "agentpier-disabled-no-token",
  );
  await credentials.discard("rotate");
  assert.equal(fs.existsSync(prepared.env.GH_CONFIG_DIR), false);
});
test("Shell/login skip; unsupported native hosts skipped; symlink directories and secrets fail closed", async (t) => {
  const { root, repositories, credentials } = setup(t);
  repositories.createCredential({
    name: "Port",
    host: "example.test:8443",
    token: "port-secret",
  });
  const a = repositories.createCredential({
    name: "A",
    host: "github.com",
    token: "secret",
  });
  for (const options of [
    { account: { tool: "shell" } },
    { account: { tool: "codex" }, purpose: "login" },
  ])
    assert.deepEqual(
      await credentials.prepare({ id: "skip", cwd: root, launch, ...options }),
      launch,
    );
  const prepared = await credentials.prepare({
    id: "valid",
    account: { tool: "opencode" },
    cwd: root,
    launch,
  });
  assert.deepEqual(
    Object.keys(
      JSON.parse(fs.readFileSync(path.join(prepared.env.GH_CONFIG_DIR, "hosts.yml"))),
    ),
    ["github.com"],
  );
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(path.dirname(prepared.env.GH_CONFIG_DIR), "escape"));
  await assert.rejects(
    credentials.prepare({ id: "escape", account: { tool: "codex" }, cwd: root, launch }),
  );
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(repositories.secretFile(a.id));
  fs.writeFileSync(
    path.join(outside, "secret.json"),
    JSON.stringify({ token: "outside" }),
  );
  fs.symlinkSync(path.join(outside, "secret.json"), repositories.secretFile(a.id));
  await credentials.sync();
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(prepared.env.GH_CONFIG_DIR, "hosts.yml")))[
      "github.com"
    ].oauth_token,
    "agentpier-disabled-no-token",
  );
});
test("session helper cannot release tokens to unknown hosts, protocols, operations or revoked credentials", async (t) => {
  const { gitCredential } =
    await import("../../server/features/repositories/github-credentials.js");
  const { root, repositories, credentials } = setup(t);
  const a = repositories.createCredential({
    name: "A",
    host: "github.com",
    token: "fixture-a",
  });
  const prepared = await credentials.prepare({
    id: "helper",
    account: { tool: "codex" },
    cwd: root,
    launch,
  });
  assert.match(prepared.env.PATH, /\/fixture/);
  assert.ok(prepared.env.PATH.includes(path.join(repositories.dataDir, "clis/gh/bin")));
  assert.equal(
    gitCredential("protocol=https\nhost=github.com\n\n", prepared.env),
    "username=x-access-token\npassword=fixture-a\n\n",
  );
  for (const input of [
    "protocol=https\nhost=unknown.test\n\n",
    "protocol=http\nhost=github.com\n\n",
    "protocol=https\nhost=api.github.com\n\n",
    "protocol=https\nhost=github.com\nhost=evil.test\n\n",
  ])
    assert.equal(gitCredential(input, prepared.env), "");
  assert.equal(
    gitCredential("protocol=https\nhost=github.com\n\n", prepared.env, "store"),
    "",
  );
  repositories.removeCredential(a.id);
  await credentials.sync();
  assert.equal(gitCredential("protocol=https\nhost=github.com\n\n", prepared.env), "");
});
test("installed gh reads generated multi-host config offline without a user name migration", async (t) => {
  const available = spawnSync("gh", ["--version"], { encoding: "utf8" });
  if (available.error?.code === "ENOENT") {
    t.skip("gh not installed");
    return;
  }
  const { root, repositories, credentials } = setup(t);
  repositories.createCredential({
    name: "Public",
    host: "github.com",
    token: "fixture-public",
  });
  repositories.createCredential({
    name: "Tenant",
    host: "tenant.ghe.com",
    token: "fixture-tenant",
  });
  repositories.createCredential({
    name: "Enterprise",
    host: "git.example.test",
    token: "fixture-enterprise",
  });
  const prepared = await credentials.prepare({
    id: "offline",
    account: { tool: "claude" },
    cwd: root,
    launch,
  });
  const env = {
    ...prepared.env,
    HOME: root,
    GH_NO_UPDATE_NOTIFIER: "1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    HTTP_PROXY: "http://127.0.0.1:1",
  };
  for (const [host, token] of [
    ["github.com", "fixture-public"],
    ["tenant.ghe.com", "fixture-tenant"],
    ["git.example.test", "fixture-enterprise"],
  ]) {
    const result = spawnSync("gh", ["auth", "token", "--hostname", host], {
      env,
      cwd: root,
      encoding: "utf8",
      timeout: 3000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), token);
  }
  const result = spawnSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    cwd: root,
    env: {
      ...env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    timeout: 3000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /password=fixture-public/);
  assert.equal(fs.existsSync(path.join(root, ".gitconfig")), false);
  repositories.removeCredential(
    repositories.listCredentials().find((item) => item.host === "https://github.com").id,
  );
  await credentials.sync();
  const revoked = spawnSync("gh", ["auth", "token", "--hostname", "github.com"], {
    env,
    cwd: root,
    encoding: "utf8",
    timeout: 3000,
  });
  assert.equal(revoked.status, 0);
  assert.equal(revoked.stdout.trim(), "agentpier-disabled-no-token");
});
test("nearest project wins and moved credentials cannot override a different repository host", async (t) => {
  const { root, repositories, credentials } = setup(t);
  const a = repositories.createCredential({
    name: "A",
    host: "github.com",
    token: "default",
  });
  const b = repositories.createCredential({
    name: "B",
    host: "github.com",
    token: "outer",
  });
  const c = repositories.createCredential({
    name: "C",
    host: "github.com",
    token: "inner",
  });
  const outer = path.join(root, "outer"),
    inner = path.join(outer, "inner");
  fs.mkdirSync(inner, { recursive: true });
  repositories.projects = [
    { path: outer, url: "https://github.com/org/outer", credentialId: b.id },
    { path: inner, url: "https://github.com/org/inner", credentialId: c.id },
  ];
  const first = await credentials.prepare({
    id: "nested",
    account: { tool: "codex" },
    cwd: inner,
    launch,
  });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(first.env.GH_CONFIG_DIR, "hosts.yml")))[
      "github.com"
    ].oauth_token,
    "inner",
  );
  repositories.updateCredential(c.id, { name: "C", host: "different.test" });
  await credentials.sync();
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(first.env.GH_CONFIG_DIR, "hosts.yml")))[
      "github.com"
    ].oauth_token,
    "agentpier-disabled-no-token",
  );
  const second = await credentials.prepare({
    id: "changed",
    account: { tool: "codex" },
    cwd: inner,
    launch,
  });
  const hosts = JSON.parse(
    fs.readFileSync(path.join(second.env.GH_CONFIG_DIR, "hosts.yml")),
  );
  assert.equal(hosts["github.com"].oauth_token, "default");
  assert.equal(hosts["different.test"].oauth_token, "inner");
  assert.equal(
    repositories.listCredentials().find((item) => item.id === a.id).agentDefault,
    true,
  );
});
test("corrupt or missing selection metadata disables existing session copies instead of retaining revoked tokens", async (t) => {
  const { gitCredential } =
    await import("../../server/features/repositories/github-credentials.js");
  const { root, repositories, credentials } = setup(t);
  const a = repositories.createCredential({
    name: "A",
    host: "github.com",
    token: "to-revoke",
  });
  const first = await credentials.prepare({
    id: "corrupt",
    account: { tool: "codex" },
    cwd: root,
    launch,
  });
  const second = await credentials.prepare({
    id: "missing",
    account: { tool: "codex" },
    cwd: root,
    launch,
  });
  const third = await credentials.prepare({
    id: "invalid",
    account: { tool: "codex" },
    cwd: root,
    launch,
  });
  fs.writeFileSync(path.join(first.env.GH_CONFIG_DIR, "selection.json"), "{broken");
  fs.unlinkSync(path.join(second.env.GH_CONFIG_DIR, "selection.json"));
  fs.writeFileSync(
    path.join(third.env.GH_CONFIG_DIR, "selection.json"),
    JSON.stringify({ id: "other", selections: [] }),
  );
  repositories.removeCredential(a.id);
  await credentials.sync();
  for (const prepared of [first, second, third]) {
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(prepared.env.GH_CONFIG_DIR, "config.yml")))
        .version,
      "agentpier-disabled",
    );
    const text = fs.readFileSync(
      path.join(prepared.env.GH_CONFIG_DIR, "hosts.yml"),
      "utf8",
    );
    assert.equal(text.includes("to-revoke"), false);
    assert.equal(
      JSON.parse(text)["github.com"].oauth_token,
      "agentpier-disabled-no-token",
    );
    assert.equal(gitCredential("protocol=https\nhost=github.com\n\n", prepared.env), "");
  }
  const gh = spawnSync("gh", ["auth", "token", "--hostname", "github.com"], {
    env: {
      ...first.env,
      HOME: root,
      HTTPS_PROXY: "http://127.0.0.1:1",
      HTTP_PROXY: "http://127.0.0.1:1",
    },
    cwd: root,
    encoding: "utf8",
    timeout: 3000,
  });
  if (!gh.error) {
    assert.notEqual(gh.status, 0);
    assert.equal(gh.stdout, "");
    assert.match(gh.stderr, /migrat|version/i);
  }
});
