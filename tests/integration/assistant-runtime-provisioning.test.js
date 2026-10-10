import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assistantInstallFixture } from "../helpers/assistant-install-fixture.js";
import { setupFixture } from "../helpers/setup-fixture.js";
import {
  stageRuntimeInBackground,
  provisionInstallerRuntime,
} from "../../server/features/assistants/runtime-provisioning.js";
import { ensureAssistantRuntime } from "../../server/features/assistants/runtime-install.js";
import {
  proxyVariables,
  runtimeEnvironment,
} from "../../server/features/assistants/runtime-config.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { writeAssistantFeature } from "../../server/features/assistants/assistant-feature.js";
import { startAssistantServices } from "../../server/application/assistants.js";
import { runInstaller } from "../../scripts/release-install.mjs";
import { installerArguments, resolveSetupOptions } from "../../scripts/setup-options.mjs";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const previous = { version: "2026.9.7", nodeVersion: "26.6.0", nodePath: "/old" };

function selectPrevious(dataDir) {
  fs.mkdirSync(path.join(dataDir, "assistants"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "assistants/runtime.json"),
    JSON.stringify(previous),
  );
}
function gatedDownload(f) {
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const calls = [];
  const download = async (url) => {
    calls.push(url);
    await gate;
    return f.options.download(url);
  };
  return { download, calls, open };
}

test("after an update an enabled installation stages the new runtime in the background", async (t) => {
  const f = assistantInstallFixture(t);
  selectPrevious(f.dataDir);
  writeAssistantFeature(f.dataDir, { enabled: true });
  const gated = gatedDownload(f);
  const job = stageRuntimeInBackground({ ...f.options, download: gated.download });
  assert.ok(job instanceof Promise);
  // Nothing has been downloaded synchronously: AgentPier's start is never blocked.
  assert.equal(gated.calls.length, 0);
  const candidate = path.join(f.dataDir, "assistants/candidate.json");
  assert.equal(fs.existsSync(candidate), false);
  gated.open();
  const staged = await job;
  assert.equal(staged.version, f.manifest.version);
  assert.equal(read(candidate).version, f.manifest.version);
  // The selection is unchanged; activation stays an explicit owner action.
  assert.deepEqual(read(path.join(f.dataDir, "assistants/runtime.json")), previous);
});

test("a disabled installation downloads nothing after an update", async (t) => {
  const f = assistantInstallFixture(t);
  const download = () => assert.fail("unexpected download");
  assert.equal(stageRuntimeInBackground({ ...f.options, download }), null);
  assert.equal(fs.existsSync(path.join(f.dataDir, "assistants")), false);
  selectPrevious(f.dataDir);
  writeAssistantFeature(f.dataDir, { enabled: false });
  assert.equal(stageRuntimeInBackground({ ...f.options, download }), null);
});

test("background staging is skipped when the selection or candidate is current", async (t) => {
  const f = assistantInstallFixture(t);
  writeAssistantFeature(f.dataDir, { enabled: true });
  const download = () => assert.fail("unexpected download");
  // No selection yet: the first start installs, there is nothing to update.
  assert.equal(stageRuntimeInBackground({ ...f.options, download }), null);
  await ensureAssistantRuntime(f.options);
  assert.equal(stageRuntimeInBackground({ ...f.options, download }), null);
  const selection = path.join(f.dataDir, "assistants/runtime.json");
  const current = read(selection);
  fs.writeFileSync(selection, JSON.stringify(previous));
  fs.writeFileSync(
    path.join(f.dataDir, "assistants/candidate.json"),
    JSON.stringify(current),
  );
  assert.equal(stageRuntimeInBackground({ ...f.options, download }), null);
});

test("a failed background staging is reported by code and keeps the selection", async (t) => {
  const f = assistantInstallFixture(t);
  selectPrevious(f.dataDir);
  writeAssistantFeature(f.dataDir, { enabled: true });
  const logged = [];
  t.mock.method(console, "error", (line) => logged.push(line));
  const result = await stageRuntimeInBackground({
    ...f.options,
    download: async () => {
      throw Object.assign(Error(`secret ${f.dataDir}`), { code: "ECONNRESET" });
    },
  });
  assert.equal(result, null);
  assert.deepEqual(logged, [
    "AgentPier could not prepare the assistant runtime: ECONNRESET",
  ]);
  assert.deepEqual(read(path.join(f.dataDir, "assistants/runtime.json")), previous);
});

test("starting assistant services schedules runtime staging without waiting for it", () => {
  const calls = [];
  const services = {
    config: { dataDir: "/data" },
    assistants: {},
    assistantChannels: { start: () => calls.push("channels") },
    assistantRuntime: { paths: { root: "/nonexistent" }, start: async () => {} },
  };
  startAssistantServices(services, {
    stageInBackground: (options) => calls.push(options),
  });
  assert.deepEqual(calls, ["channels", { dataDir: "/data" }]);
});

test("proxy settings reach npm ci and the Gateway; nothing else leaks", async (t) => {
  const f = assistantInstallFixture(t);
  const proxies = {
    HTTPS_PROXY: "http://proxy:3128",
    https_proxy: "http://proxy:3128",
    HTTP_PROXY: "http://proxy:3128",
    http_proxy: "http://proxy:3128",
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost",
    NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
  };
  assert.deepEqual(new Set(proxyVariables), new Set(Object.keys(proxies)));
  // Node is told to use the proxy, and loopback is merged into both exclusion lists.
  const expected = {
    ...proxies,
    NO_PROXY: "localhost,127.0.0.1,::1,[::1]",
    no_proxy: "localhost,127.0.0.1,::1,[::1]",
    NODE_USE_ENV_PROXY: "1",
  };
  const environment = {
    ...proxies,
    node_extra_ca_certs: "/etc/ignored.pem",
    PATH: "/attacker/bin",
    HOME: "/home/user",
    GITHUB_TOKEN: "secret",
    NPM_CONFIG_REGISTRY: "https://evil.invalid",
    NODE_OPTIONS: "--require /evil.js",
  };
  await ensureAssistantRuntime({ ...f.options, environment });
  const npm = f.commands.find((command) => command.args.includes("ci"));
  const fixed = [
    "HOME",
    "TMPDIR",
    "PATH",
    "npm_config_cache",
    "npm_config_userconfig",
    "npm_config_globalconfig",
    "npm_config_update_notifier",
  ];
  assert.deepEqual(
    Object.keys(npm.opts.env).sort(),
    [...fixed, ...Object.keys(expected)].sort(),
  );
  for (const [key, value] of Object.entries(expected))
    assert.equal(npm.opts.env[key], value);
  assert.notEqual(npm.opts.env.PATH, environment.PATH);
  const paths = runtimePaths(f.dataDir);
  const gateway = runtimeEnvironment(
    paths,
    "/runtime/node/bin/node",
    "token",
    environment,
  );
  const base = runtimeEnvironment(paths, "/runtime/node/bin/node", "token", {});
  assert.deepEqual(gateway, { ...base, ...expected });
  assert.equal(gateway.PATH, base.PATH);
  for (const key of [
    "GITHUB_TOKEN",
    "NPM_CONFIG_REGISTRY",
    "NODE_OPTIONS",
    "node_extra_ca_certs",
  ])
    assert.equal(gateway[key], undefined);
  // Without proxy variables nothing is added.
  assert.equal(base.NODE_USE_ENV_PROXY, undefined);
  assert.equal(base.NO_PROXY, undefined);
});

test("the installer enables and pre-provisions assistants with --with-assistants", async (t) => {
  const f = await setupFixture(t);
  const provisioned = [];
  const assistantRuntime = async (options) => {
    provisioned.push(options.dataDir);
    return { version: "2026.9.8" };
  };
  const result = await runInstaller(
    [
      "--archive",
      f.options.archive,
      "--install-root",
      f.installRoot,
      "--data-dir",
      f.dataDir,
      "--with-assistants",
    ],
    { ...f.dependencies, assistantRuntime },
  );
  assert.deepEqual(provisioned, [f.dataDir]);
  assert.deepEqual(read(path.join(f.dataDir, "assistant-feature.json")), {
    enabled: true,
  });
  assert.deepEqual(result.assistantRuntime, { status: "ready", version: "2026.9.8" });
});

test("the interactive installer provisions the runtime when assistants are enabled", async (t) => {
  const f = await setupFixture(t);
  const provisioned = [];
  const assistantRuntime = async ({ dataDir }) => (provisioned.push(dataDir), {});
  const off = await f.install({}, { assistantRuntime });
  assert.equal(off.assistantRuntime, undefined);
  assert.deepEqual(provisioned, []);
  writeAssistantFeature(f.dataDir, { enabled: true });
  await f.install({}, { assistantRuntime });
  assert.deepEqual(provisioned, [f.dataDir]);
});

test("a failed runtime download never fails the AgentPier installation", async (t) => {
  const f = await setupFixture(t);
  const result = await f.install(
    { withAssistants: true },
    {
      assistantRuntime: async () => {
        throw Object.assign(Error("offline"), { code: "ENOTFOUND" });
      },
    },
  );
  assert.equal(result.version, "1.0.0");
  assert.deepEqual(result.assistantRuntime, { status: "failed", code: "ENOTFOUND" });
});

test("installer provisioning uses the shared provisioner and enabled flag", async (t) => {
  const f = assistantInstallFixture(t);
  assert.equal(await provisionInstallerRuntime({ dataDir: f.dataDir }), null);
  const result = await provisionInstallerRuntime(
    { dataDir: f.dataDir, enable: true },
    {
      assistantRuntime: (options) => ensureAssistantRuntime({ ...f.options, ...options }),
    },
  );
  assert.equal(result.status, "ready");
  assert.equal(read(path.join(f.dataDir, "assistants/runtime.json")).version, "2026.9.8");
});

test("setup forwards --with-assistants to the release installer", () => {
  const options = resolveSetupOptions(["--with-assistants"], {
    home: "/Users/test",
    env: {},
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(options.withAssistants, true);
  assert.ok(installerArguments(options, "1.2.3").includes("--with-assistants"));
});

test("both shell entrypoints accept --with-assistants", () => {
  const validate = (call) =>
    execFileSync("/bin/sh", ["-c", `. scripts/install-bootstrap.sh && ${call}`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: "/Users/fixture" },
    });
  validate(
    "validate_installer_options --install-root /a --data-dir /b --with-assistants",
  );
  validate("validate_setup_options --with-assistants");
  assert.throws(() =>
    validate("validate_setup_options --with-assistants --dependencies-only"),
  );
});

test("unsafe storage never aborts the AgentPier installation", async (t) => {
  const f = await setupFixture(t);
  await f.install();
  const outside = path.join(f.temporary, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.dataDir, "assistants"));
  const result = await f.install({ withAssistants: true });
  assert.equal(result.version, "1.0.0");
  assert.deepEqual(result.assistantRuntime, {
    status: "failed",
    code: "ASSISTANT_STORAGE_UNSAFE",
  });
  assert.deepEqual(fs.readdirSync(outside), []);
  const blocked = assistantInstallFixture(t);
  fs.mkdirSync(path.join(blocked.dataDir, "assistant-feature.json"));
  assert.deepEqual(
    await provisionInstallerRuntime({ dataDir: blocked.dataDir, enable: true }),
    { status: "failed", code: "EISDIR" },
  );
});

test("an installer rerun next to an older selection reports the staged runtime", async (t) => {
  const f = assistantInstallFixture(t);
  selectPrevious(f.dataDir);
  const result = await provisionInstallerRuntime(
    { dataDir: f.dataDir, enable: true },
    {
      assistantRuntime: (options) => ensureAssistantRuntime({ ...f.options, ...options }),
    },
  );
  assert.deepEqual(result, {
    status: "staged",
    version: "2026.9.8",
    selected: "2026.9.7",
  });
  assert.deepEqual(read(path.join(f.dataDir, "assistants/runtime.json")), previous);
});
