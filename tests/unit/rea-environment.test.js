import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverMessages } from "../../server/lib/i18n/de.js";
import {
  cleanReaSettings,
  prepareReaHome,
  reaEnvPatch,
  reaEnvironment,
  reaHome,
  reaManagedKeys,
} from "../../server/features/tools/rea-environment.js";

const home = "/data/rea/home";
const plain = cleanReaSettings({});

test("Core alone: controlled home, compact schema, provider ghidra, no Ghidra or JDK keys", () => {
  assert.deepEqual(reaEnvironment({ home, ghidra: null, jdk: null, settings: plain }), {
    HOME: home,
    TMPDIR: `${home}/tmp`,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_CACHE_HOME: `${home}/.cache`,
    XDG_DATA_HOME: `${home}/.local/share`,
    CLAUDE_CONFIG_DIR: `${home}/.claude`,
    CODEX_HOME: `${home}/.codex`,
    REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
    REA_ANALYSIS_PROVIDER: "ghidra",
  });
  // One component alone is not enough to run Ghidra.
  const ghidraOnly = reaEnvironment({
    home,
    ghidra: { home: "/g" },
    jdk: null,
    settings: plain,
  });
  assert.equal(Object.hasOwn(ghidraOnly, "GHIDRA_INSTALL_DIR"), false);
  assert.equal(Object.hasOwn(ghidraOnly, "JAVA_HOME"), false);
  const jdkOnly = reaEnvironment({
    home,
    ghidra: null,
    jdk: { home: "/j" },
    settings: plain,
  });
  assert.equal(Object.hasOwn(jdkOnly, "JAVA_HOME"), false);
  for (const key of Object.keys(jdkOnly)) assert.ok(reaManagedKeys.includes(key));
});

test("Ghidra and JDK installed: GHIDRA_INSTALL_DIR and JAVA_HOME are their real homes", () => {
  const env = reaEnvironment({
    home,
    ghidra: { home: "/data/clis/.packages/rea-ghidra-1/ghidra/12.1.4/libexec" },
    jdk: { home: "/data/clis/.packages/rea-jdk-1/jdk/Contents/Home" },
    settings: plain,
  });
  assert.equal(
    env.GHIDRA_INSTALL_DIR,
    "/data/clis/.packages/rea-ghidra-1/ghidra/12.1.4/libexec",
  );
  assert.equal(env.JAVA_HOME, "/data/clis/.packages/rea-jdk-1/jdk/Contents/Home");
  assert.equal(env.REA_ANALYSIS_PROVIDER, "ghidra");
});

test("bring-your-own settings map to HOPPER_LAUNCHER_PATH, REA_IDA_MCP_CONFIG, REA_JEB_MCP_URL", () => {
  const settings = cleanReaSettings({
    provider: "ida",
    hopperPath: "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
    idaConfig: "/Users/me/ida-mcp.json",
    jebUrl: "http://127.0.0.1:8851/mcp",
  });
  assert.deepEqual(settings, {
    provider: "ida",
    hopperPath: "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
    idaConfig: "/Users/me/ida-mcp.json",
    jebUrl: "http://127.0.0.1:8851/mcp",
  });
  const env = reaEnvironment({ home, ghidra: null, jdk: null, settings });
  assert.equal(
    env.HOPPER_LAUNCHER_PATH,
    "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
  );
  assert.equal(env.REA_IDA_MCP_CONFIG, "/Users/me/ida-mcp.json");
  assert.equal(env.REA_JEB_MCP_URL, "http://127.0.0.1:8851/mcp");
  assert.equal(env.REA_ANALYSIS_PROVIDER, "ida");
  // Empty values clear a setting and leave its key out.
  const cleared = cleanReaSettings({ hopperPath: "", idaConfig: "", jebUrl: "" });
  assert.deepEqual(cleared, {
    provider: "ghidra",
    hopperPath: null,
    idaConfig: null,
    jebUrl: null,
  });
  const none = reaEnvironment({ home, ghidra: null, jdk: null, settings: cleared });
  for (const key of ["HOPPER_LAUNCHER_PATH", "REA_IDA_MCP_CONFIG", "REA_JEB_MCP_URL"])
    assert.equal(Object.hasOwn(none, key), false);
  // Settings never carry extra keys into the environment.
  assert.deepEqual(
    Object.keys(cleanReaSettings({ HOME: "/x", JAVA_HOME: "/y" })).sort(),
    ["hopperPath", "idaConfig", "jebUrl", "provider"],
  );
});

test("CLAUDE_CONFIG_DIR and CODEX_HOME point into REA's own home, never the CLI's", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-rea-env-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  assert.equal(reaHome(dataDir), path.join(dataDir, "rea", "home"));
  const created = prepareReaHome(dataDir);
  assert.equal(created, reaHome(dataDir));
  for (const sub of [
    "",
    "tmp",
    ".config",
    ".cache",
    ".local/share",
    ".claude",
    ".codex",
  ]) {
    const stat = fs.statSync(path.join(created, sub));
    assert.ok(stat.isDirectory(), sub);
    assert.equal(stat.mode & 0o777, 0o700, sub);
  }
  assert.equal(prepareReaHome(dataDir), created);
  const env = reaEnvironment({ home: created, ghidra: null, jdk: null, settings: plain });
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(created, ".claude"));
  assert.equal(env.CODEX_HOME, path.join(created, ".codex"));
  for (const key of [
    "HOME",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
  ])
    assert.ok(env[key].startsWith(created), key);
  assert.notEqual(env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), ".claude"));
  assert.notEqual(env.CODEX_HOME, path.join(os.homedir(), ".codex"));
});

test("prepareReaHome refuses a link in place of any home directory, .local included", (t) => {
  for (const sub of ["tmp", ".config", ".cache", ".local", ".local/share", ".claude"]) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-rea-link-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-rea-outside-"));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const target = path.join(reaHome(dataDir), sub);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(outside, target);
    assert.throws(
      () => prepareReaHome(dataDir),
      (error) =>
        error.status === 409 &&
        error.message === serverMessages.tools.installationDirectoryInvalid,
      sub,
    );
    assert.deepEqual(fs.readdirSync(outside), [], sub);
  }
});

test("cleanReaSettings refuses relative paths, control characters, credential URLs and ida without config", () => {
  const refuses = (input, message) =>
    assert.throws(
      () => cleanReaSettings(input),
      (error) => error.message === message && error.status === 400,
    );
  const messages = serverMessages.rea;
  refuses({ hopperPath: "hopper" }, messages.invalidPath);
  refuses({ hopperPath: "./bin/hopper" }, messages.invalidPath);
  refuses({ idaConfig: "~/ida.json" }, messages.invalidPath);
  refuses({ hopperPath: "/bin/hop\nper" }, messages.invalidPath);
  refuses({ idaConfig: "/tmp/ida\u0000.json" }, messages.invalidPath);
  refuses({ idaConfig: "/tmp/ida\u007f.json" }, messages.invalidPath);
  refuses({ hopperPath: `/${"a".repeat(4096)}` }, messages.invalidPath);
  refuses({ hopperPath: 42 }, messages.invalidPath);
  refuses({ jebUrl: "http://user:secret@127.0.0.1:8851/mcp" }, messages.invalidJebUrl);
  refuses({ jebUrl: "http://127.0.0.1:8851/mcp#x" }, messages.invalidJebUrl);
  refuses({ jebUrl: "file:///etc/passwd" }, messages.invalidJebUrl);
  refuses({ jebUrl: "not a url" }, messages.invalidJebUrl);
  refuses({ jebUrl: 7 }, messages.invalidJebUrl);
  refuses({ provider: "ida" }, messages.idaConfigRequired);
  refuses({ provider: "ida", idaConfig: "" }, messages.idaConfigRequired);
  refuses({ provider: "hopper" }, messages.invalidProvider);
  refuses({ provider: 1 }, messages.invalidProvider);
  assert.equal(cleanReaSettings(undefined).provider, "ghidra");
  assert.equal(cleanReaSettings({ provider: "" }).provider, "ghidra");
  assert.equal(cleanReaSettings({ provider: null }).provider, "ghidra");
});

test("reaEnvPatch drops removed managed keys and never touches an owner key", () => {
  assert.deepEqual(reaEnvPatch({ JAVA_HOME: "/a", MY_TOKEN: "x" }, {}), {
    JAVA_HOME: null,
  });
  assert.deepEqual(
    reaEnvPatch(
      { HOME: "/h", JAVA_HOME: "/old", MY_TOKEN: "x" },
      { HOME: "/h", JAVA_HOME: "/new", GHIDRA_INSTALL_DIR: "/g", MY_TOKEN: "y" },
    ),
    { JAVA_HOME: "/new", GHIDRA_INSTALL_DIR: "/g" },
  );
  assert.deepEqual(reaEnvPatch({ HOME: "/h" }, { HOME: "/h" }), {});
  assert.deepEqual(reaEnvPatch(undefined, { HOME: "/h" }), { HOME: "/h" });
});

test("reaManagedKeys lists every key REA's environment can set", () => {
  assert.deepEqual(reaManagedKeys, [
    "HOME",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "REA_MCP_INPUT_SCHEMA_PROFILE",
    "REA_ANALYSIS_PROVIDER",
    "GHIDRA_INSTALL_DIR",
    "JAVA_HOME",
    "HOPPER_LAUNCHER_PATH",
    "REA_IDA_MCP_CONFIG",
    "REA_JEB_MCP_URL",
  ]);
  assert.ok(Object.isFrozen(reaManagedKeys));
});
