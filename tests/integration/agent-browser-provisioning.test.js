import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setupFixture } from "../helpers/setup-fixture.js";
import { runInstaller } from "../../scripts/release-install.mjs";
import { installerArguments, resolveSetupOptions } from "../../scripts/setup-options.mjs";
import { provisionAgentBrowser } from "../../server/features/tools/chromium-provisioning.js";
import { ToolInstaller } from "../../server/features/tools/tool-installer.js";

const manifest = (version) => ({
  version,
  platforms: {
    linux64: {
      url: "https://storage.googleapis.com/x/chrome-linux64.zip",
      sha256: "0".repeat(64),
      size: 1,
      executable: "chrome-linux64/chrome",
    },
  },
});
// Lays out an installed managed browser the way installChromium publishes it.
function installed(root, version) {
  const name = `chromium-${version}`;
  const directory = path.join(root, ".packages", name);
  fs.mkdirSync(path.join(directory, "chrome-linux64"), { recursive: true });
  fs.writeFileSync(path.join(directory, "chrome-linux64/chrome"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(directory, "agentpier-chromium.json"),
    JSON.stringify({ version, platform: "linux64", executable: "chrome-linux64/chrome" }),
  );
  fs.rmSync(path.join(root, "chromium"), { force: true });
  fs.symlinkSync(path.join(".packages", name), path.join(root, "chromium"));
}
function dataDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("--with-agent-browser installs the managed browser; an installed one stays current", async (t) => {
  const dir = dataDir(t);
  const root = path.join(dir, "clis");
  const calls = [];
  const install = async (options) => {
    calls.push(options.manifest.version);
    fs.mkdirSync(options.root, { recursive: true });
    installed(options.root, options.manifest.version);
    return { version: options.manifest.version };
  };
  const options = { dataDir: dir, platform: "linux", arch: "x64" };
  // Not asked for and not installed: nothing happens.
  assert.equal(
    await provisionAgentBrowser({ ...options, manifest: manifest("1") }, { install }),
    null,
  );
  assert.deepEqual(
    await provisionAgentBrowser(
      { ...options, enable: true, manifest: manifest("1") },
      { install },
    ),
    { status: "ready", version: "1" },
  );
  // Already current: no download.
  assert.deepEqual(
    await provisionAgentBrowser({ ...options, manifest: manifest("1") }, { install }),
    { status: "ready", version: "1" },
  );
  // An update of AgentPier that pins a newer build updates it, even unasked.
  assert.deepEqual(
    await provisionAgentBrowser({ ...options, manifest: manifest("2") }, { install }),
    { status: "ready", version: "2" },
  );
  assert.deepEqual(calls, ["1", "2"]);
  assert.ok(fs.existsSync(path.join(root, "chromium")));
  // A failure never fails the AgentPier installation.
  assert.deepEqual(
    await provisionAgentBrowser(
      { ...options, manifest: manifest("3") },
      {
        install: async () => {
          throw Error("offline");
        },
      },
    ),
    { status: "failed", message: "offline" },
  );
  assert.equal(
    (
      await provisionAgentBrowser({
        dataDir: dir,
        enable: true,
        platform: "win32",
        arch: "x64",
        manifest: manifest("3"),
      })
    ).status,
    "unavailable",
  );
});

test("the installers forward --with-agent-browser", async (t) => {
  const f = await setupFixture(t);
  const seen = [];
  const agentBrowser = async (options) => (seen.push(options), { status: "ready" });
  const result = await runInstaller(
    [
      "--archive",
      f.options.archive,
      "--install-root",
      f.installRoot,
      "--data-dir",
      f.dataDir,
      "--with-agent-browser",
    ],
    { ...f.dependencies, agentBrowser },
  );
  assert.deepEqual(seen, [{ dataDir: f.dataDir, enable: true }]);
  assert.deepEqual(result.agentBrowser, { status: "ready" });
  const options = resolveSetupOptions(["--with-agent-browser"], {
    home: "/Users/test",
    env: {},
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(options.withAgentBrowser, true);
  assert.ok(installerArguments(options, "1.2.3").includes("--with-agent-browser"));
  const validate = (call) =>
    execFileSync("/bin/sh", ["-c", `. scripts/install-bootstrap.sh && ${call}`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: "/Users/fixture" },
    });
  validate(
    "validate_installer_options --install-root /a --data-dir /b --with-agent-browser",
  );
  validate("validate_setup_options --with-agent-browser");
});

test("a server start updates an installed managed browser to the pinned version", async (t) => {
  const dir = dataDir(t);
  const root = path.join(dir, "clis");
  fs.mkdirSync(root, { recursive: true });
  installed(root, "1");
  const tools = new ToolInstaller({
    dataDir: dir,
    home: dir,
    npmCli: "/bin/false",
    detect: () => [],
    platform: "linux",
    arch: "x64",
    manifest: manifest("2"),
    // The download fails here; that the update was started is what counts.
    chromiumFetch: async () => {
      throw Error("offline");
    },
  });
  const job = tools.keepChromiumCurrent();
  assert.equal(job.operation, "update");
  await tools.active?.done;
  const current = new ToolInstaller({
    dataDir: dir,
    home: dir,
    npmCli: "/bin/false",
    detect: () => [],
    platform: "linux",
    arch: "x64",
    manifest: manifest("1"),
  });
  assert.equal(current.keepChromiumCurrent(), null);
});
