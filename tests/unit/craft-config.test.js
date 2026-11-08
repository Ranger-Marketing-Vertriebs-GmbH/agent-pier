import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "smol-toml";
import {
  craftEnvironment,
  craftHome,
  craftManagedKeys,
  ensureGhidraStub,
  sessionsConfigDir,
  writeCraftConfig,
} from "../../server/features/tools/craft-config.js";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "craft-config-"));
const ghidra = { version: "1", directory: "/g", home: "/g/ghidra" };
const jdk = { version: "1", directory: "/j", home: "/j/home" };
const read = (dir) => parse(fs.readFileSync(path.join(dir, "config.toml"), "utf8"));

test("paths and environment", () => {
  assert.equal(craftHome("/d"), "/d/craft-anything");
  assert.equal(sessionsConfigDir("/d"), "/d/craft-anything/sessions");
  assert.deepEqual(craftEnvironment("/d"), {
    CRAFT_ANYTHING_CONFIG_DIR: "/d/craft-anything/sessions",
    CRAFT_ANYTHING_NO_KEYCHAIN: "1",
  });
  assert.deepEqual(craftManagedKeys, [
    "CRAFT_ANYTHING_CONFIG_DIR",
    "CRAFT_ANYTHING_NO_KEYCHAIN",
  ]);
});

test("writes auto_mode and deep_mode off and the Ghidra paths", () => {
  const dir = path.join(temp(), "sessions");
  writeCraftConfig(dir, { ghidra, jdk, stub: "/stub" });
  const config = read(dir);
  assert.equal(config.auto_mode, false);
  assert.equal(config.deep_mode, false);
  assert.equal(config.engines.ghidra.install_dir, "/g/ghidra");
  assert.equal(config.engines.ghidra.java_home, "/j/home");
  assert.equal(fs.statSync(path.join(dir, "config.toml")).mode & 0o777, 0o600);
});

test("without Ghidra points at the stub and drops java_home", () => {
  const data = temp();
  const dir = sessionsConfigDir(data);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    '[engines.ghidra]\njava_home = "/old"\n',
  );
  const stub = ensureGhidraStub(data);
  assert.equal(stub, path.join(data, "craft-anything", "no-ghidra"));
  assert.equal(fs.statSync(stub).mode & 0o777, 0o700);
  writeCraftConfig(dir, { ghidra: null, jdk: null, stub });
  const config = read(dir);
  assert.equal(config.engines.ghidra.install_dir, stub);
  assert.equal("java_home" in config.engines.ghidra, false);
  const run = spawnSync(stub, { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.equal(
    run.stderr.trim(),
    "Ghidra is not installed. Install it in AgentPier: CLIs and extensions › Installation › Craft Anything.",
  );
});

test("rewrite keeps foreign keys and resets ours", () => {
  const dir = temp();
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    'theme = "studio"\ndeep_mode = true\nask_before_running = false\n',
  );
  writeCraftConfig(dir, { ghidra, jdk, stub: "/stub" });
  const config = read(dir);
  assert.equal(config.theme, "studio");
  assert.equal(config.deep_mode, false);
  assert.equal(config.ask_before_running, false);
});

test("an unreadable config is replaced, never thrown", () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, "config.toml"), "= not [ toml");
  writeCraftConfig(dir, { ghidra, jdk, stub: "/stub" });
  assert.deepEqual(JSON.parse(JSON.stringify(read(dir))), {
    auto_mode: false,
    deep_mode: false,
    engines: { ghidra: { install_dir: "/g/ghidra", java_home: "/j/home" } },
  });
});

test("refuses a config dir that is a link", () => {
  const root = temp();
  const target = path.join(root, "elsewhere");
  fs.mkdirSync(target);
  const link = path.join(root, "link");
  fs.symlinkSync(target, link);
  assert.throws(() => writeCraftConfig(link, { ghidra, jdk, stub: "/stub" }));
  assert.equal(fs.existsSync(path.join(target, "config.toml")), false);
});

test("the rebuilds' config names Claude Code as the builder and switches an existing entry on", () => {
  const dir = temp();
  writeCraftConfig(dir, { ghidra, jdk, stub: "/stub", builder: true });
  assert.deepEqual(JSON.parse(JSON.stringify(read(dir).ai.backends)), [
    { enabled: true, kind: "agent_cli", model: "claude-code", name: "Claude Code" },
  ]);
  const mine = { enabled: false, kind: "agent_cli", model: "claude-code", name: "Mine" };
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    '[[ai.backends]]\nenabled = false\nkind = "agent_cli"\nmodel = "claude-code"\nname = "Mine"\n',
  );
  writeCraftConfig(dir, { ghidra, jdk, stub: "/stub", builder: true });
  assert.deepEqual(JSON.parse(JSON.stringify(read(dir).ai.backends)), [
    { ...mine, enabled: true },
  ]);
  const plain = temp();
  writeCraftConfig(plain, { ghidra, jdk, stub: "/stub" });
  assert.equal("ai" in read(plain), false);
});
