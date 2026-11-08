import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setupFixture } from "../helpers/setup-fixture.js";
import { runInstaller } from "../../scripts/release-install.mjs";
import { installerArguments, resolveSetupOptions } from "../../scripts/setup-options.mjs";
import { provisionCraftAnything } from "../../server/features/tools/craft-provisioning.js";

function dataDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "craft-provision-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const file = (dir) => path.join(dir, "craft-anything", "settings.json");
const saved = (dir) => JSON.parse(fs.readFileSync(file(dir), "utf8"));

test("--with-craft-anything flows from setup options to the installer arguments", () => {
  const options = resolveSetupOptions(["--with-craft-anything"], {
    home: "/Users/test",
    env: {},
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(options.withCraftAnything, true);
  assert.ok(installerArguments(options, "1.2.3").includes("--with-craft-anything"));
  const validate = (call) =>
    execFileSync("/bin/sh", ["-c", `. scripts/install-bootstrap.sh && ${call}`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: "/Users/fixture" },
    });
  validate(
    "validate_installer_options --install-root /a --data-dir /b --with-craft-anything",
  );
  validate("validate_setup_options --with-craft-anything");
});

test("without the flag and without Craft Anything nothing happens", async (t) => {
  const dir = dataDir(t);
  assert.deepEqual(await provisionCraftAnything({ dataDir: dir }), {
    requested: false,
    installed: false,
  });
  assert.equal(fs.existsSync(path.join(dir, "craft-anything")), false);
});

test("writes the request once and keeps other settings", async (t) => {
  const dir = dataDir(t);
  fs.mkdirSync(path.join(dir, "craft-anything"));
  fs.writeFileSync(file(dir), JSON.stringify({ settings: { mode: "deep" } }));
  const first = await provisionCraftAnything({ dataDir: dir, enable: true });
  assert.deepEqual(first, { requested: true, installed: false });
  assert.deepEqual(saved(dir), {
    settings: { mode: "deep" },
    requested: { components: { ghidra: true }, settings: { mode: "clean-room" } },
  });
  assert.equal(fs.statSync(file(dir)).mode & 0o777, 0o600);
  const before = fs.readFileSync(file(dir), "utf8");
  assert.deepEqual(await provisionCraftAnything({ dataDir: dir, enable: true }), first);
  assert.equal(fs.readFileSync(file(dir), "utf8"), before);
});

test("ghidra false is passed on", async (t) => {
  const dir = dataDir(t);
  await provisionCraftAnything({ dataDir: dir, enable: true, ghidra: false });
  assert.deepEqual(saved(dir).requested.components, { ghidra: false });
});

test("an installed Craft Anything is left alone", async (t) => {
  const dir = dataDir(t);
  fs.mkdirSync(path.join(dir, "craft-anything"));
  const body = JSON.stringify({ serverId: "srv-1", components: { ghidra: false } });
  fs.writeFileSync(file(dir), body);
  const result = await provisionCraftAnything({ dataDir: dir, enable: true });
  assert.deepEqual(result, { requested: false, installed: true });
  assert.equal(fs.readFileSync(file(dir), "utf8"), body);
});

test("a link in place of the folder is refused", async (t) => {
  const dir = dataDir(t);
  const elsewhere = dataDir(t);
  fs.symlinkSync(elsewhere, path.join(dir, "craft-anything"));
  const result = await provisionCraftAnything({ dataDir: dir, enable: true });
  assert.equal(result.requested, false);
  assert.ok(result.message);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("release install calls it with enable", async (t) => {
  const f = await setupFixture(t);
  const seen = [];
  const craftAnything = async (options) => (
    seen.push(options),
    { requested: true, installed: false }
  );
  const result = await runInstaller(
    [
      "--archive",
      f.options.archive,
      "--install-root",
      f.installRoot,
      "--data-dir",
      f.dataDir,
      "--with-craft-anything",
    ],
    { ...f.dependencies, craftAnything },
  );
  assert.deepEqual(seen, [{ dataDir: f.dataDir, enable: true }]);
  assert.deepEqual(result.craftAnything, { requested: true, installed: false });
});
