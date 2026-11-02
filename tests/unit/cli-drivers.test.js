import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODING_CLI_IDS } from "../../server/features/clis/catalog.js";
import { cliDriver } from "../../server/features/clis/drivers.js";

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
