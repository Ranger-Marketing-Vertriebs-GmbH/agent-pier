import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RepositoryStore } from "../../server/features/repositories/repository-store.js";
import { GithubCredentials } from "../../server/features/repositories/github-credentials.js";

const helperEntry = fileURLToPath(
  new URL("../../server/github-credentials.js", import.meta.url),
);
const gitAvailable = !spawnSync("git", ["--version"]).error;

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-sgc-")));
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
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  // Records every prompt git would show; a prompt in an agent pane is the hang.
  const prompts = path.join(root, "prompts.log");
  const askpass = path.join(root, "askpass.sh");
  fs.writeFileSync(askpass, `#!/bin/sh\necho "$*" >> '${prompts}'\necho prompted\n`, {
    mode: 0o700,
  });
  const prepare = (id) =>
    credentials.prepare({
      id,
      account: { tool: "claude" },
      cwd: root,
      launch: { args: [], env: { PATH: process.env.PATH } },
    });
  // The injected GIT_CONFIG_* environment against the installed git, offline and
  // without the user's global or system git configuration.
  const fill = (env, host = "github.com") =>
    spawnSync("git", ["credential", "fill"], {
      input:
        "capability[]=authtype\ncapability[]=state\nprotocol=https\n" +
        `host=${host}\nwwwauth[]=Basic realm="GitHub"\n\n`,
      encoding: "utf8",
      cwd: root,
      env: {
        ...env,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ASKPASS: askpass,
        HTTPS_PROXY: "http://127.0.0.1:1",
      },
      timeout: 10000,
    });
  const prompted = () => (fs.existsSync(prompts) ? fs.readFileSync(prompts, "utf8") : "");
  return { root, repositories, credentials, prepare, fill, prompted };
}

test(
  "git credential fill with git 2.46+ capability lines receives the session token",
  { skip: !gitAvailable && "git not installed" },
  async (t) => {
    const { repositories, prepare, fill, prompted } = setup(t);
    repositories.createCredential({ name: "A", host: "github.com", token: "fixture-a" });
    const prepared = await prepare("capabilities");
    const result = fill(prepared.env);
    assert.equal(result.error, undefined, "git credential fill must not hang");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^username=x-access-token$/m);
    assert.match(result.stdout, /^password=fixture-a$/m);
    assert.equal(prompted(), "");
  },
);

test(
  "a selected host without a usable token fails at once instead of prompting",
  { skip: !gitAvailable && "git not installed" },
  async (t) => {
    const { repositories, credentials, prepare, fill, prompted } = setup(t);
    const a = repositories.createCredential({
      name: "A",
      host: "github.com",
      token: "fixture-a",
    });
    const prepared = await prepare("revoked");
    repositories.removeCredential(a.id);
    await credentials.sync();
    const result = fill(prepared.env);
    assert.equal(result.error, undefined, "git credential fill must not hang");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no usable GitHub access/);
    assert.doesNotMatch(result.stdout, /password=/);
    assert.equal(prompted(), "");
    // Hosts without a selection keep git's own behaviour, prompts included.
    const other = fill(prepared.env, "example.test");
    assert.equal(other.status, 0, other.stderr);
    assert.match(prompted(), /Username for 'https:\/\/example\.test'/);
  },
);

test(
  "a helper that cannot start still fails at once for its host",
  {
    skip: !gitAvailable && "git not installed",
  },
  async (t) => {
    const { repositories, prepare, fill, prompted } = setup(t);
    repositories.createCredential({ name: "A", host: "github.com", token: "fixture-a" });
    const prepared = await prepare("missing-runtime");
    const env = { ...prepared.env };
    for (const key of Object.keys(env))
      if (key.startsWith("GIT_CONFIG_VALUE_") && env[key].includes("--git-credential"))
        env[key] = "!'/nonexistent/agentpier/bin/node' --git-credential";
    const result = fill(env);
    assert.equal(result.error, undefined, "git credential fill must not hang");
    assert.notEqual(result.status, 0);
    assert.equal(prompted(), "");
  },
);

test("sessions without a selected connection keep the user's own gh configuration", async (t) => {
  const { prepare } = setup(t);
  const prepared = await prepare("unselected");
  assert.equal(prepared.env.GH_CONFIG_DIR, undefined);
  assert.equal(prepared.env.GIT_CONFIG_COUNT, "0");
});

test("the session helper runs without loading any npm package", async (t) => {
  const { root, repositories, prepare } = setup(t);
  repositories.createCredential({ name: "A", host: "github.com", token: "fixture-a" });
  const prepared = await prepare("import-graph");
  // Resolving any bare, non-builtin specifier fails, as it would for a release
  // runtime that cannot reach node_modules.
  const hooks = path.join(root, "hooks.mjs");
  const register = path.join(root, "register.mjs");
  fs.writeFileSync(
    hooks,
    `import { isBuiltin } from "node:module";
export async function resolve(specifier, context, next) {
  if (!isBuiltin(specifier) && !/^(\\.|\\/|file:|data:)/.test(specifier))
    throw new Error("npm import " + specifier);
  return next(specifier, context);
}
`,
  );
  fs.writeFileSync(
    register,
    `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(register).href, helperEntry, "--git-credential", "get"],
    {
      input:
        "capability[]=authtype\ncapability[]=state\nprotocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      env: { PATH: process.env.PATH, GH_CONFIG_DIR: prepared.env.GH_CONFIG_DIR },
      timeout: 10000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "username=x-access-token\npassword=fixture-a\n\n");
});
