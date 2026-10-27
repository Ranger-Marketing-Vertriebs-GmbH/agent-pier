import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setupFixture } from "../helpers/setup-fixture.js";
import { runInstaller } from "../../scripts/release-install.mjs";
import { installerArguments, resolveSetupOptions } from "../../scripts/setup-options.mjs";
import { provisionRea } from "../../server/features/tools/rea-provisioning.js";
import { reaManifest } from "../../server/features/tools/rea-manifest.js";

function dataDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rea-provision-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const host = { platform: "darwin", arch: "arm64", darwinMajor: 25 };
// Lays out a component the way installReaComponent publishes it.
function lay(root, id, version, home) {
  const name = `${id}-fixture${version}`;
  const directory = path.join(root, ".packages", name);
  fs.mkdirSync(path.join(directory, home), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "agentpier-rea.json"),
    JSON.stringify({ id, version, platform: "darwin", home }),
  );
  fs.rmSync(path.join(root, id), { force: true });
  fs.symlinkSync(path.join(".packages", name), path.join(root, id));
}
const fakeInstall = (calls) => async (options) => {
  calls.push({ id: options.id, version: options.version });
  fs.mkdirSync(options.root, { recursive: true });
  lay(options.root, options.id, options.version, "home");
  return { version: options.version };
};
const request = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, "rea", "settings.json"), "utf8")).requested;

test("without --with-rea and without REA nothing happens", async (t) => {
  const dir = dataDir(t);
  const install = async () => assert.fail("must not install");
  assert.equal(await provisionRea({ dataDir: dir, ...host }, { install }), null);
  assert.equal(fs.existsSync(path.join(dir, "rea")), false);
});

test("--with-rea installs Ghidra and the JDK and leaves a request for the server", async (t) => {
  const dir = dataDir(t);
  const calls = [];
  const result = await provisionRea(
    { dataDir: dir, enable: true, ...host },
    { install: fakeInstall(calls) },
  );
  assert.deepEqual(result, { status: "pending", ghidra: reaManifest.ghidra.version });
  assert.deepEqual(calls, [
    { id: "rea-jdk", version: reaManifest.jdk.version },
    { id: "rea-ghidra", version: reaManifest.ghidra.version },
  ]);
  assert.deepEqual(request(dir), {
    components: { ghidra: true, frida: true },
    settings: { provider: "ghidra" },
  });
  const mode = fs.statSync(path.join(dir, "rea", "settings.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("an installed REA is brought to the pinned Ghidra and JDK on every installer run", async (t) => {
  const dir = dataDir(t);
  const root = path.join(dir, "clis");
  lay(root, "rea-ghidra", "1.0.0", "g");
  lay(root, "rea-jdk", "17.0.1", "j");
  fs.mkdirSync(path.join(dir, "rea"));
  fs.writeFileSync(
    path.join(dir, "rea", "settings.json"),
    JSON.stringify({
      serverId: "abc",
      components: { ghidra: true, frida: false },
      settings: { provider: "ghidra" },
    }),
  );
  const calls = [];
  const options = { dataDir: dir, ...host };
  assert.deepEqual(await provisionRea(options, { install: fakeInstall(calls) }), {
    status: "ready",
    ghidra: reaManifest.ghidra.version,
  });
  assert.equal(calls.length, 2);
  // Current: no download, and no request is left behind.
  assert.deepEqual(
    await provisionRea({ ...options, enable: true }, { install: fakeInstall(calls) }),
    { status: "ready", ghidra: reaManifest.ghidra.version },
  );
  assert.equal(calls.length, 2);
  assert.equal(request(dir), undefined);
});

test("a failed download never fails the installation", async (t) => {
  const dir = dataDir(t);
  const install = async () => {
    throw Error("offline");
  };
  const result = await provisionRea({ dataDir: dir, enable: true, ...host }, { install });
  assert.equal(result.status, "failed");
  assert.equal(result.message, "offline");
  // The request stays, so the server start retries.
  assert.ok(request(dir));
});

test("Intel Macs and linux-arm64 get pending Core with a Ghidra reason", async (t) => {
  for (const unsupported of [
    { platform: "darwin", arch: "x64", darwinMajor: 25 },
    { platform: "linux", arch: "arm64" },
  ]) {
    const dir = dataDir(t);
    const install = async () => assert.fail("no Ghidra on this host");
    const result = await provisionRea(
      { dataDir: dir, enable: true, ...unsupported },
      { install },
    );
    assert.equal(result.status, "pending");
    assert.equal(result.ghidra, null);
    assert.equal(typeof result.message, "string");
    assert.ok(result.message.length > 0);
    assert.ok(request(dir));
  }
  const dir = dataDir(t);
  const result = await provisionRea({
    dataDir: dir,
    enable: true,
    platform: "win32",
    arch: "x64",
  });
  assert.equal(result.status, "unavailable");
  assert.equal(fs.existsSync(path.join(dir, "rea")), false);
});

test("resolveSetupOptions and installerArguments carry --with-rea", () => {
  const options = resolveSetupOptions(["--with-rea"], {
    home: "/Users/test",
    env: {},
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(options.withRea, true);
  assert.ok(installerArguments(options, "1.2.3").includes("--with-rea"));
  const validate = (call) =>
    execFileSync("/bin/sh", ["-c", `. scripts/install-bootstrap.sh && ${call}`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: "/Users/fixture" },
    });
  validate("validate_installer_options --install-root /a --data-dir /b --with-rea");
  validate("validate_setup_options --with-rea");
});

test("runInstaller accepts --with-rea and reports rea in its result", async (t) => {
  const f = await setupFixture(t);
  const seen = [];
  const rea = async (options) => (seen.push(options), { status: "pending", ghidra: "1" });
  const result = await runInstaller(
    [
      "--archive",
      f.options.archive,
      "--install-root",
      f.installRoot,
      "--data-dir",
      f.dataDir,
      "--with-rea",
    ],
    { ...f.dependencies, rea },
  );
  assert.deepEqual(seen, [{ dataDir: f.dataDir, enable: true }]);
  assert.deepEqual(result.rea, { status: "pending", ghidra: "1" });
});
