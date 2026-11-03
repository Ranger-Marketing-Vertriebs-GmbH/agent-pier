import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODING_CLI_IDS } from "../../server/features/clis/catalog.js";
import { cliDriver } from "../../server/features/clis/drivers.js";
import {
  normalizeClaude,
  normalizeCodex,
  normalizeOpenCode,
} from "../../server/features/chat/history-parsers.js";
import {
  observeClaude,
  observeCodex,
  observeOpenCode,
} from "../../server/features/chat/chat-observability.js";

test("every coding CLI has a driver with profileEnv, configRoot, parseAuthStatus", () => {
  for (const id of CODING_CLI_IDS) {
    const driver = cliDriver(id);
    assert.equal(driver.definition.id, id);
    for (const method of ["profileEnv", "configRoot", "dataRoot", "parseAuthStatus"])
      assert.equal(typeof driver[method], "function", `${id}.${method}`);
  }
  assert.throws(() => cliDriver("shell"), TypeError);
  assert.throws(() => cliDriver("nope"), TypeError);
});

test("configRoot honours the override variable and falls back to the home default", () => {
  const home = "/home/u";
  const cases = {
    codex: [{ CODEX_HOME: "/x/codex" }, "/x/codex", "/home/u/.codex"],
    claude: [{ CLAUDE_CONFIG_DIR: "/x/claude" }, "/x/claude", "/home/u/.claude"],
    opencode: [
      { XDG_CONFIG_HOME: "/x/cfg" },
      "/x/cfg/opencode",
      "/home/u/.config/opencode",
    ],
  };
  for (const [id, [env, override, fallback]] of Object.entries(cases)) {
    assert.equal(cliDriver(id).configRoot(env, home), override);
    assert.equal(cliDriver(id).configRoot({}, home), fallback);
  }
  assert.equal(cliDriver("codex").configRoot({ HOME: "/h2" }, home), "/h2/.codex");
  assert.equal(cliDriver("claude").configRoot({ HOME: "/h2" }, home), "/h2/.claude");
  assert.equal(
    cliDriver("opencode").configRoot({ HOME: "/h2" }, home),
    "/h2/.config/opencode",
  );
});

test("dataRoot honours the data override and falls back to the home default", () => {
  const home = "/home/u";
  assert.equal(cliDriver("codex").dataRoot({ CODEX_HOME: "/x" }, home), "/x");
  assert.equal(cliDriver("codex").dataRoot({ HOME: "/h2" }, home), "/h2/.codex");
  assert.equal(cliDriver("claude").dataRoot({ CLAUDE_CONFIG_DIR: "/x" }, home), "/x");
  assert.equal(cliDriver("claude").dataRoot({}, home), "/home/u/.claude");
  assert.equal(
    cliDriver("opencode").dataRoot({ XDG_DATA_HOME: "/x/data" }, home),
    "/x/data/opencode",
  );
  assert.equal(
    cliDriver("opencode").dataRoot({ XDG_CONFIG_HOME: "/x/cfg" }, home),
    "/home/u/.local/share/opencode",
  );
  assert.equal(
    cliDriver("opencode").dataRoot({ HOME: "/h2" }, home),
    "/h2/.local/share/opencode",
  );
});

test("profileEnv isolates each CLI under the account root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drivers-"));
  try {
    assert.deepEqual(cliDriver("codex").profileEnv(root), {
      CODEX_HOME: path.join(root, "codex"),
    });
    const claude = path.join(root, "claude");
    assert.deepEqual(cliDriver("claude").profileEnv(root), {
      CLAUDE_CONFIG_DIR: claude,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: claude,
    });
    assert.deepEqual(cliDriver("opencode").profileEnv(root), {
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
    });
    for (const dir of ["codex", "claude", "config", "data", "state", "cache"]) {
      const stat = fs.statSync(path.join(root, dir));
      assert.ok(stat.isDirectory(), dir);
      assert.equal(stat.mode & 0o777, 0o700, dir);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parseAuthStatus reads each CLI's status output", () => {
  const parse = (id, ...args) => cliDriver(id).parseAuthStatus(...args);
  assert.equal(parse("claude", '{"loggedIn":true}', 0).signedIn, true);
  assert.equal(parse("claude", '{"loggedIn":false}', 1).state, "unauthenticated");
  assert.equal(parse("codex", "Logged in using ChatGPT\n", 0).signedIn, true);
  assert.equal(parse("codex", "Not logged in\n", 1).state, "unauthenticated");
  assert.equal(parse("codex", "Not logged in\n", 0).state, "unknown");
  assert.equal(parse("opencode", "└  2 credentials\n", 0).signedIn, true);
  assert.equal(parse("opencode", "└  0 credentials\n", 0).state, "unauthenticated");
  assert.equal(parse("opencode", "└  1 credential\n", 1).state, "unknown");
});

test("every driver provides prepareRequests, shellToolName and startupDialogs", () => {
  const shells = {
    codex: "item/commandExecution/requestApproval",
    claude: "Bash",
    opencode: "bash",
  };
  const dialogs = {
    codex: ["codexHookTrust"],
    claude: ["claudeFolderTrust", "claudeStartupPrompt"],
    opencode: [],
  };
  for (const id of CODING_CLI_IDS) {
    const driver = cliDriver(id);
    assert.equal(typeof driver.prepareRequests, "function", `${id}.prepareRequests`);
    assert.equal(driver.shellToolName, shells[id]);
    assert.deepEqual(Object.keys(driver.startupDialogs), dialogs[id]);
    for (const handler of Object.values(driver.startupDialogs))
      assert.equal(typeof handler, "function");
  }
  const ids = CODING_CLI_IDS.flatMap((id) => Object.keys(cliDriver(id).startupDialogs));
  assert.equal(new Set(ids).size, ids.length, "startupDialogs ids are unique");
});

test("every driver provides the history methods", () => {
  const methods = [
    "list",
    "read",
    "readPage",
    "readReloadContext",
    "normalize",
    "observe",
    "watchRoots",
    "slashCommands",
  ];
  for (const id of CODING_CLI_IDS) {
    const { history } = cliDriver(id);
    assert.ok(Object.isFrozen(history), `${id}.history is frozen`);
    for (const method of methods)
      assert.equal(typeof history[method], "function", `${id}.history.${method}`);
  }
  const normalize = {
    codex: normalizeCodex,
    claude: normalizeClaude,
    opencode: normalizeOpenCode,
  };
  const observe = {
    codex: observeCodex,
    claude: observeClaude,
    opencode: observeOpenCode,
  };
  for (const id of CODING_CLI_IDS) {
    assert.equal(cliDriver(id).history.normalize, normalize[id]);
    assert.equal(cliDriver(id).history.observe, observe[id]);
  }
});

test("history watchRoots name the folders a chat without sources discovers", () => {
  const env = { CODEX_HOME: "/p/codex", CLAUDE_CONFIG_DIR: "/p/claude" };
  assert.deepEqual(cliDriver("codex").history.watchRoots(env, "/h", "/w/a"), [
    "/p/codex/sessions",
    "/p/codex/archived_sessions",
  ]);
  assert.deepEqual(cliDriver("claude").history.watchRoots(env, "/h", "/w/a.b"), [
    "/p/claude/projects/-w-a-b",
  ]);
  assert.deepEqual(cliDriver("claude").history.watchRoots(env, "/h", undefined), [
    "/p/claude/projects",
  ]);
  assert.deepEqual(
    cliDriver("opencode").history.watchRoots({ XDG_DATA_HOME: "/p/data" }, "/h", "/w"),
    ["/p/data/opencode"],
  );
});

test("every driver provides the tui functions", () => {
  const openKeys = {
    codex: [{ type: "/model" }, { pauseMs: 250 }, { keys: ["Enter"] }],
    claude: [{ keys: ["M-p"] }],
    opencode: [{ keys: ["C-x", "m"] }],
  };
  for (const id of CODING_CLI_IDS) {
    const { tui } = cliDriver(id);
    assert.ok(Object.isFrozen(tui), `${id}.tui is frozen`);
    for (const method of ["activity", "composer", "limitWarning"])
      assert.equal(typeof tui[method], "function", `${id}.tui.${method}`);
    for (const method of ["parse", "current", "promptReady", "unsupported"])
      assert.equal(
        typeof tui.modelPicker[method],
        "function",
        `${id}.tui.modelPicker.${method}`,
      );
    assert.deepEqual(tui.modelPicker.openKeys, openKeys[id]);
  }
});

test("every driver provides pipeline, plugins and profileFiles", () => {
  for (const id of CODING_CLI_IDS) {
    const { pipeline, plugins, profileFiles } = cliDriver(id);
    for (const part of [pipeline, pipeline.events, plugins, profileFiles])
      assert.ok(Object.isFrozen(part), `${id} driver part is frozen`);
    for (const method of ["command", "sessionArgs", "promptArgs"])
      assert.equal(typeof pipeline[method], "function", `${id}.pipeline.${method}`);
    for (const method of ["nativeId", "failed", "progress", "completed"])
      assert.equal(typeof pipeline.events[method], "function", `${id}.events.${method}`);
    for (const method of ["inventory", "selection", "actionArgs"])
      assert.equal(typeof plugins[method], "function", `${id}.plugins.${method}`);
    for (const list of ["roots", "credentials", "configFiles"])
      assert.ok(Array.isArray(profileFiles[list]), `${id}.profileFiles.${list}`);
    assert.deepEqual(Object.keys(profileFiles.backupAllowlist), profileFiles.roots);
  }
  const files = (id) => cliDriver(id).profileFiles;
  assert.deepEqual(files("codex").credentials, ["codex/auth.json"]);
  assert.deepEqual(files("claude").credentials, ["claude/.credentials.json"]);
  assert.deepEqual(files("opencode").credentials, ["data/opencode/auth.json"]);
  assert.deepEqual(files("opencode").roots, ["config/opencode", "data/opencode"]);
  assert.deepEqual(files("codex").configFiles, ["config.toml"]);
  assert.deepEqual(files("claude").configFiles, ["settings.json"]);
  assert.deepEqual(files("opencode").configFiles, [
    "config.json",
    "opencode.json",
    "opencode.jsonc",
    "tui.json",
    "tui.jsonc",
  ]);
  const args = (id, ...rest) => cliDriver(id).plugins.actionArgs(...rest);
  assert.deepEqual(args("codex", "install", { pluginId: "p@m" }), [
    "plugin",
    "add",
    "p@m",
    "--json",
  ]);
  assert.deepEqual(args("claude", "remove", { pluginId: "p@m" }), [
    "plugin",
    "uninstall",
    "p@m",
    "--scope",
    "user",
    "--keep-data",
  ]);
  assert.deepEqual(args("codex", "marketplace-update", { marketplace: "m" }), [
    "plugin",
    "marketplace",
    "upgrade",
    "m",
    "--json",
  ]);
  assert.deepEqual(args("opencode", "install", { source: "pkg@1" }), [
    "plugin",
    "pkg@1",
    "--global",
  ]);
  const prompt = (id) => cliDriver(id).pipeline.promptArgs("hi");
  assert.deepEqual(prompt("opencode"), ["--prompt", "hi"]);
  assert.deepEqual(prompt("codex"), ["--", "hi"]);
  assert.deepEqual(cliDriver("claude").pipeline.sessionArgs("s1"), [
    "--session-id",
    "s1",
  ]);
  assert.deepEqual(cliDriver("codex").pipeline.sessionArgs("s1"), []);
  const nativeId = (id, event) => cliDriver(id).pipeline.events.nativeId(event);
  assert.equal(nativeId("codex", { thread_id: "t" }), "t");
  assert.equal(nativeId("claude", { session_id: "s" }), "s");
  assert.equal(nativeId("opencode", { sessionID: "o" }), "o");
});
