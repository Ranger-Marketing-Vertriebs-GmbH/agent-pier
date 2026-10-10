import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { renderLaunchAgent, runService } from "../../scripts/service.mjs";
import { inspectSetupService } from "../../scripts/setup-service.mjs";
import { proxyEnvironment } from "../../server/lib/proxy-environment.js";
import { runtimeEnvironment } from "../../server/features/assistants/runtime-config.js";
import { setupFixture } from "../helpers/setup-fixture.js";

const proxies = {
  HTTPS_PROXY: "http://proxy.example:3128",
  NO_PROXY: "intranet.example",
  NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
};
const persisted = {
  HTTPS_PROXY: "http://proxy.example:3128",
  NO_PROXY: "intranet.example,localhost,127.0.0.1,::1,[::1]",
  no_proxy: "intranet.example,localhost,127.0.0.1,::1,[::1]",
  NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
  NODE_USE_ENV_PROXY: "1",
};

function serviceFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-service-proxy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, "dist"), { recursive: true });
  fs.writeFileSync(path.join(project, "dist/index.html"), "fixture");
  return {
    root,
    file: path.join(root, "home/.config/systemd/user/dev.agentpier.server.service"),
    options: {
      action: "install",
      platform: "linux",
      projectDir: project,
      home: path.join(root, "home"),
      config: { dataDir: path.join(root, "data"), port: 4380 },
      node: "/opt/node",
      run: () => "",
      log: () => {},
    },
  };
}

test("the systemd unit persists proxy settings present at install time and nothing else", async (t) => {
  const f = serviceFixture(t);
  await runService({
    ...f.options,
    env: {
      PATH: "/usr/bin",
      GITHUB_TOKEN: "secret",
      node_extra_ca_certs: "/x",
      ...proxies,
    },
  });
  const lines = fs
    .readFileSync(f.file, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("Environment="))
    .map((line) => JSON.parse(line.slice("Environment=".length)));
  assert.deepEqual(
    lines.filter((line) => !/^(PATH|AGENTPIER_DATA_DIR)=/.test(line)).sort(),
    Object.entries(persisted)
      .map(([key, value]) => `${key}=${value}`)
      .sort(),
  );
  await runService({ ...f.options, env: { PATH: "/usr/bin" } });
  assert.doesNotMatch(fs.readFileSync(f.file, "utf8"), /PROXY|EXTRA_CA/);
});

test("the launch agent persists proxy settings as environment variables", () => {
  const plist = renderLaunchAgent({
    projectDir: "/app",
    node: "/app/bin/node",
    dataDir: "/data",
    envPath: "/usr/bin",
    proxy: proxyEnvironment({ ...proxies, GITHUB_TOKEN: "secret" }),
  });
  for (const [key, value] of Object.entries(persisted))
    assert.ok(plist.includes(`<key>${key}</key><string>${value}</string>`), key);
  assert.doesNotMatch(plist, /GITHUB_TOKEN/);
  assert.doesNotMatch(
    renderLaunchAgent({ projectDir: "/a", node: "/n", dataDir: "/d", envPath: "/p" }),
    /PROXY/,
  );
});

async function linuxService(t, env) {
  const f = await setupFixture(t);
  const procRoot = path.join(f.temporary, "proc");
  fs.mkdirSync(path.join(procRoot, "net"), { recursive: true });
  fs.writeFileSync(path.join(procRoot, "net/tcp"), "header\n");
  fs.writeFileSync(path.join(procRoot, "net/tcp6"), "header\n");
  const launcher = path.join(f.installRoot, "bin/agentpier");
  fs.mkdirSync(path.join(f.installRoot, "current/dist"), { recursive: true });
  fs.writeFileSync(path.join(f.installRoot, "current/dist/index.html"), "fixture");
  await runService({
    action: "install",
    platform: "linux",
    home: f.temporary,
    config: { dataDir: f.dataDir, port: 4380 },
    env: {
      PATH: "/usr/bin",
      AGENTPIER_INSTALL_ROOT: f.installRoot,
      AGENTPIER_DATA_DIR: f.dataDir,
      ...env,
    },
    run: () => "",
    log: () => {},
  });
  const run = async () => ({
    stdout: `MainPID=0\nExecStart={ path=${launcher} ; argv[]=${launcher} ; }\nEnvironment=AGENTPIER_INSTALL_ROOT=${f.installRoot} AGENTPIER_DATA_DIR=${f.dataDir}\n`,
  });
  return inspectSetupService({
    installRoot: f.installRoot,
    dataDir: f.dataDir,
    home: f.temporary,
    env: {},
    platform: "linux",
    procRoot,
    run,
  });
}

test("services with or without proxy keys stay matching and report their settings", async (t) => {
  const plain = await linuxService(t, {});
  assert.equal(plain.state, "matching");
  assert.deepEqual(plain.proxy, {});
  const proxied = await linuxService(t, proxies);
  assert.equal(proxied.state, "matching");
  assert.deepEqual(proxied.proxy, persisted);
});

test("a setup rerun with proxies updates a healthy service; without, it keeps them", async (t) => {
  const f = await setupFixture(t);
  await f.install();
  f.restartCalls.length = 0;
  f.state.proxy = {};
  const inspectService = async () => ({
    state: f.state.service,
    listener: f.state.listener,
    proxy: f.state.proxy,
  });
  const run = async () => ({ stdout: "fixture" });
  await f.install({}, { inspectService, env: { ...process.env, ...proxies }, run });
  assert.equal(f.restartCalls.length, 1);
  assert.deepEqual(proxyEnvironment(f.restartCalls[0].env), persisted);
  // The healthy service now has the settings: a rerun changes nothing.
  f.state.proxy = persisted;
  await f.install({}, { inspectService, env: { ...process.env, ...proxies }, run });
  await f.install({}, { inspectService, env: withoutProxies(process.env), run });
  assert.equal(f.restartCalls.length, 1);
  // A repair without proxy variables in the shell keeps the service's settings.
  f.state.listener = false;
  await f.install({}, { inspectService, env: withoutProxies(process.env), run });
  assert.equal(f.restartCalls.length, 2);
  assert.deepEqual(proxyEnvironment(f.restartCalls[1].env), persisted);
});
function withoutProxies(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !/_proxy$|^NODE_EXTRA_CA_CERTS$/i.test(key)),
  );
}

test("loopback calls bypass an unreachable proxy for AgentPier and the Gateway", async (t) => {
  const server = http.createServer((_req, res) => res.end("healthy"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const dead = http.createServer();
  await new Promise((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const deadPort = dead.address().port;
  await new Promise((resolve) => dead.close(resolve));
  const proxy = `http://127.0.0.1:${deadPort}`;
  const parent = { HTTP_PROXY: proxy, HTTPS_PROXY: proxy };
  const { port } = server.address();
  const probe = `
    const results = [];
    for (const url of process.argv.slice(1))
      results.push(await fetch(url).then((r) => r.text(), (e) => "failed:" + (e.cause?.code || e.message)));
    console.log(JSON.stringify(results));`;
  const urls = [
    `http://127.0.0.1:${port}/api/health`,
    `http://localhost:${port}/api/health`,
    "http://outside.invalid/",
  ];
  const gateway = runtimeEnvironment(
    { home: "/tmp", tmp: os.tmpdir(), state: "/s", config: "/c" },
    process.execPath,
    "t",
    parent,
  );
  const fetchAll = async (env) =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          ["--input-type=module", "-e", probe, ...urls],
          { env: { ...env, PATH: process.env.PATH }, timeout: 20000 },
        )
      ).stdout,
    );
  // Control: without the loopback exclusion, the health check would hit the proxy.
  const [unprotected] = await fetchAll({ ...parent, NODE_USE_ENV_PROXY: "1" });
  assert.equal(unprotected, "failed:ECONNREFUSED");
  for (const env of [proxyEnvironment(parent), gateway]) {
    const [ip, name, outside] = await fetchAll(env);
    assert.equal(ip, "healthy");
    assert.equal(name, "healthy");
    // The proxy really is in use: external hosts are sent to the dead proxy.
    assert.equal(outside, "failed:ECONNREFUSED");
  }
});

test("the installer tells Node to use the proxy and never proxies loopback", async (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-install-proxy-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  // The version probe runs on the real Node; the installer itself only reports env.
  fs.writeFileSync(
    path.join(bin, "node"),
    `#!/bin/sh\nif [ "$1" = -e ]; then exec "${process.execPath}" "$@"; fi\nprintf '%s|%s|%s' "\${NODE_USE_ENV_PROXY:-}" "\${NO_PROXY:-}" "\${no_proxy:-}"\n`,
    { mode: 0o755 },
  );
  const run = (env) =>
    promisify(execFile)("/bin/sh", ["scripts/install.sh", "--dependencies-only"], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, ...env },
      encoding: "utf8",
    });
  const proxied = await run({ https_proxy: "http://proxy:3128", NO_PROXY: "corp" });
  assert.equal(
    proxied.stdout,
    "1|corp,localhost,127.0.0.1,::1,[::1]|corp,localhost,127.0.0.1,::1,[::1]",
  );
  assert.equal((await run({})).stdout, "||");
});
