import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostNode, npmRegistryFixture } from "../helpers/npm-registry-fixture.js";
import { checkNpmLock } from "../../server/features/mcp-packages/lock-check.js";
import {
  installNpm,
  npmManifestText,
  resolveNpm,
} from "../../server/features/mcp-packages/npm-package-install.js";

const work = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-npm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const server = {
  name: "server-x",
  version: "1.0.0",
  bin: { "server-x": "index.js" },
  files: { "index.js": "#!/usr/bin/env node\nconsole.log('ok')\n" },
  dependencies: { helper: "2.0.0" },
};
const helper = { name: "helper", version: "2.0.0", files: { "index.js": "" } };
const scripted = {
  name: "scripted",
  version: "1.0.0",
  bin: "index.js",
  files: { "index.js": "" },
  scripts: { postinstall: "node -e \"require('fs').writeFileSync('ran','1')\"" },
};

test("resolve freezes a registry-only lock; ci installs it without scripts", async (t) => {
  const registry = await npmRegistryFixture(t, [server, helper]);
  const dir = work(t);
  const ref = { registry: "npm", name: "server-x", version: "1.0.0" };
  const options = {
    ref,
    node: hostNode(),
    registry: registry.url,
    cacheDir: path.join(dir, "cache"),
  };
  const { manifestText, lockText } = await resolveNpm({
    stage: path.join(dir, "resolve"),
    ...options,
  });
  const checked = checkNpmLock(lockText, {
    ref,
    integrity: registry.integrity("server-x", "1.0.0"),
    registry: registry.url,
  });
  assert.deepEqual(
    checked.dependencies.map((d) => d.name),
    ["helper", "server-x"],
  );
  const target = path.join(dir, "install");
  await installNpm({
    directory: target,
    manifestText,
    lockText,
    allowScripts: false,
    ...options,
  });
  assert.ok(fs.existsSync(path.join(target, "node_modules/server-x/index.js")));
  assert.ok(fs.existsSync(path.join(target, "node_modules/helper/index.js")));
});

test("install scripts run only when allowed", async (t) => {
  const registry = await npmRegistryFixture(t, [scripted]);
  const dir = work(t);
  const ref = { registry: "npm", name: "scripted", version: "1.0.0" };
  const options = {
    ref,
    node: hostNode(),
    registry: registry.url,
    cacheDir: path.join(dir, "cache"),
  };
  const resolved = await resolveNpm({ stage: path.join(dir, "resolve"), ...options });
  assert.equal(
    checkNpmLock(resolved.lockText, {
      ref,
      integrity: registry.integrity("scripted", "1.0.0"),
      registry: registry.url,
    }).needsScripts,
    true,
  );
  const quiet = path.join(dir, "quiet");
  await installNpm({ directory: quiet, ...resolved, allowScripts: false, ...options });
  assert.equal(fs.existsSync(path.join(quiet, "node_modules/scripted/ran")), false);
  const loud = path.join(dir, "loud");
  await installNpm({ directory: loud, ...resolved, allowScripts: true, ...options });
  assert.equal(fs.existsSync(path.join(loud, "node_modules/scripted/ran")), true);
});

test("the owner's npm configuration never applies", async (t) => {
  const registry = await npmRegistryFixture(t, [helper]);
  const dir = work(t);
  const home = path.join(dir, "owner-home");
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(home, ".npmrc"),
    "registry=http://127.0.0.1:9/\nlockfile-version=2\n",
  );
  const ref = { registry: "npm", name: "helper", version: "2.0.0" };
  const { lockText } = await resolveNpm({
    stage: path.join(dir, "resolve"),
    ref,
    node: hostNode(),
    registry: registry.url,
    cacheDir: path.join(dir, "cache"),
    environment: {
      ...process.env,
      HOME: home,
      npm_config_registry: "http://127.0.0.1:9/",
      npm_config_lockfile_version: "2",
    },
  });
  assert.equal(JSON.parse(lockText).lockfileVersion, 3);
  assert.match(
    lockText,
    new RegExp(registry.url.replace(/[.*+?^${}()|[\]\\/:]/g, "\\$&")),
  );
});

test("npm failures never leak output or paths", async (t) => {
  const dir = work(t);
  const ref = { registry: "npm", name: "helper", version: "2.0.0" };
  const logged = [];
  const execute = async () => {
    throw Object.assign(Error(`npm failed in ${dir}`), {
      stdout: "",
      stderr: `npm ERR! ${dir}/secret`,
    });
  };
  const options = {
    ref,
    node: hostNode(),
    registry: "http://127.0.0.1:9",
    cacheDir: path.join(dir, "cache"),
    execute,
    log: (text) => logged.push(text),
  };
  for (const run of [
    () => resolveNpm({ stage: path.join(dir, "resolve"), ...options }),
    () =>
      installNpm({
        directory: path.join(dir, "install"),
        manifestText: npmManifestText(ref),
        lockText: "{}",
        allowScripts: false,
        ...options,
      }),
  ]) {
    await assert.rejects(run, (error) => {
      assert.equal(error.code, "MCP_PACKAGE_INSTALL_FAILED");
      assert.equal(error.message.includes(dir), false);
      return true;
    });
  }
  assert.ok(logged.some((text) => text.includes("npm ERR!")));
  assert.equal(fs.existsSync(path.join(dir, "resolve", "resolve")), false);
  assert.equal(fs.existsSync(path.join(dir, "install", ".npm-work")), false);
});

test("a dependency version that does not exist is unsatisfiable, only in the resolve", async (t) => {
  const broken = { ...server, dependencies: { helper: "9.0.0" } };
  const registry = await npmRegistryFixture(t, [broken, helper]);
  const dir = work(t);
  const ref = { registry: "npm", name: "server-x", version: "1.0.0" };
  const logged = [];
  const options = {
    ref,
    node: hostNode(),
    registry: registry.url,
    cacheDir: path.join(dir, "cache"),
    log: (text) => logged.push(text),
  };
  // Real npm: "npm error code ETARGET" for helper@9.0.0.
  await assert.rejects(
    resolveNpm({ stage: path.join(dir, "resolve"), ...options }),
    (error) => {
      assert.equal(error.code, "MCP_PACKAGE_UNSATISFIABLE");
      assert.equal(error.status, 400);
      assert.doesNotMatch(error.message, /helper|ETARGET|127\.0\.0\.1/);
      return true;
    },
  );
  assert.match(logged.join("\n"), /ETARGET/);
  // npm ci installs a checked lock: the same words there are an install failure (R3).
  const execute = async () => {
    throw Object.assign(Error("npm"), { stdout: "", stderr: "npm error code ETARGET" });
  };
  await assert.rejects(
    installNpm({
      directory: path.join(dir, "install"),
      manifestText: npmManifestText(ref),
      lockText: "{}",
      allowScripts: false,
      ...options,
      execute,
    }),
    { code: "MCP_PACKAGE_INSTALL_FAILED" },
  );
});

test("an install whose package version differs fails", async (t) => {
  const dir = work(t);
  const ref = { registry: "npm", name: "@scope/tool", version: "1.0.0" };
  const directory = path.join(dir, "install");
  const execute = async (file, args, { cwd, env }) => {
    assert.equal(file, process.execPath);
    assert.ok(args.includes("--ignore-scripts"));
    assert.ok(args.includes("--registry=http://127.0.0.1:9"));
    assert.equal(env.npm_config_userconfig.startsWith(directory), true);
    assert.equal(fs.readFileSync(env.npm_config_userconfig, "utf8"), "");
    const target = path.join(cwd, "node_modules", "@scope", "tool");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "package.json"), '{"version":"1.0.1"}');
    return { stdout: "", stderr: "" };
  };
  await assert.rejects(
    installNpm({
      directory,
      manifestText: npmManifestText(ref),
      lockText: "{}",
      ref,
      node: hostNode(),
      registry: "http://127.0.0.1:9",
      cacheDir: path.join(dir, "cache"),
      allowScripts: false,
      execute,
    }),
    { code: "MCP_PACKAGE_INSTALL_FAILED" },
  );
});

test("a scoped install must name its scope and version in its own manifest", async (t) => {
  const ref = { registry: "npm", name: "@scope/tool", version: "1.0.0" };
  const install = (manifest) => {
    const dir = work(t);
    return installNpm({
      directory: path.join(dir, "install"),
      manifestText: npmManifestText(ref),
      lockText: "{}",
      ref,
      node: hostNode(),
      registry: "http://127.0.0.1:9",
      cacheDir: path.join(dir, "cache"),
      allowScripts: false,
      execute: async (_file, _args, { cwd }) => {
        const target = path.join(cwd, "node_modules", "@scope", "tool");
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, "package.json"), JSON.stringify(manifest));
        return { stdout: "", stderr: "" };
      },
    });
  };
  await install({ name: "@scope/tool", version: "1.0.0" });
  for (const name of ["tool", "@other/tool", "scope/tool"])
    await assert.rejects(install({ name, version: "1.0.0" }), {
      code: "MCP_PACKAGE_INSTALL_FAILED",
    });
});

test("the manifest is deterministic", () => {
  assert.equal(
    npmManifestText({ registry: "npm", name: "@a/b", version: "1.2.3" }),
    '{"name":"agentpier-mcp-package","private":true,"dependencies":{"@a/b":"1.2.3"}}\n',
  );
});
