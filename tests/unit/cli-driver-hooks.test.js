// Driver members beyond the base set of cli-drivers.test.js, plus the guard that keeps
// drivers.js out of its own import graph. Later tasks append their members here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODING_CLI_IDS, cliDefinition } from "../../server/features/clis/catalog.js";
import { cliDriver } from "../../server/features/clis/drivers.js";
import { documents } from "../../server/features/cli-profiles/configuration.js";
import { assetDirectories } from "../../server/features/cli-profiles/assets.js";
import {
  centralFromNative,
  cliEntry,
} from "../../server/features/mcp-servers/cli-native.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DRIVERS = path.join(ROOT, "server/features/clis/drivers.js");
const SPECIFIER =
  /(?:^|\n)\s*(?:import|export)\s+(?:[^"';]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g;

function importGraph(entry) {
  const seen = new Map();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    const imports = [];
    seen.set(file, imports);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(SPECIFIER)) {
      const target = path.resolve(path.dirname(file), match[1]);
      if (!target.endsWith(".js") || !fs.existsSync(target)) continue;
      imports.push(target);
      queue.push(target);
    }
  }
  return seen;
}

test("drivers.js is not reachable from its own imports", () => {
  const graph = importGraph(DRIVERS);
  assert.ok(graph.size > 20, "the walk found the driver import graph");
  const cyclic = [...graph]
    .filter(([, imports]) => imports.includes(DRIVERS))
    .map(([file]) => path.relative(ROOT, file));
  assert.deepEqual(cyclic, [], "a module on the driver import graph imports drivers.js");
});

// Plain objects and arrays must be frozen all the way down; regular expressions and
// functions stay as they are.
function assertFrozenDeep(value, label) {
  if (Array.isArray(value) || Object.getPrototypeOf(value ?? 0) === Object.prototype) {
    assert.ok(Object.isFrozen(value), `${label} is frozen`);
    for (const [key, child] of Object.entries(value))
      if (child && typeof child === "object") assertFrozenDeep(child, `${label}.${key}`);
  }
}

test("every new driver member is frozen", () => {
  for (const id of CODING_CLI_IDS) {
    const driver = cliDriver(id);
    assertFrozenDeep(driver.profileFiles, `${id}.profileFiles`);
    assert.ok(Object.isFrozen(driver.profileFiles.assetDirectories));
  }
});

function location(tool, root, env) {
  return { account: { tool }, root, env, boundary: root };
}

test("shared documents per CLI", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-docs-"));
  const strip = (docs) => docs.map(({ file, keys }) => ({ file, keys }));
  assert.deepEqual(strip(documents(location("codex", root, {}))), [
    {
      file: path.join(root, "config.toml"),
      keys: ["mcp_servers", "plugins", "marketplaces", "skills", "agents"],
    },
  ]);
  const settings = {
    file: path.join(root, "settings.json"),
    keys: ["enabledPlugins", "extraKnownMarketplaces"],
  };
  assert.deepEqual(
    strip(documents(location("claude", root, { CLAUDE_CONFIG_DIR: root }))),
    [{ file: path.join(root, ".claude.json"), keys: ["mcpServers"] }, settings],
  );
  assert.deepEqual(strip(documents(location("claude", root, {}))), [
    { file: path.join(path.dirname(root), ".claude.json"), keys: ["mcpServers"] },
    settings,
  ]);
  const opencode = documents(location("opencode", root, {}));
  assert.deepEqual(
    strip(opencode),
    ["config.json", "opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"].map(
      (name) => ({
        file: path.join(root, name),
        keys: name.startsWith("tui.") ? ["plugin"] : ["mcp", "plugin", "agent"],
      }),
    ),
  );
  assert.deepEqual(
    opencode.filter((doc) => doc.createIfMissing).map((doc) => path.basename(doc.file)),
    ["opencode.jsonc", "tui.jsonc"],
  );
  for (const tool of ["codex", "claude"])
    assert.ok(documents(location(tool, root, {})).every((doc) => doc.createIfMissing));
});

test("documents throw for an unknown CLI", () => {
  assert.throws(() => documents(location("gemini", "/tmp/none", {})), TypeError);
  assert.throws(() => documents(location("shell", "/tmp/none", {})), TypeError);
});

test("asset directories per CLI", () => {
  const base = ["skills", "agents", "commands", "plugins"];
  assert.deepEqual(assetDirectories("codex"), [...base, ".tmp/marketplaces"]);
  assert.deepEqual(assetDirectories("claude"), base);
  assert.deepEqual(assetDirectories("opencode"), [...base, "plugin"]);
});

test("native folders and config formats per CLI", () => {
  assert.deepEqual(
    CODING_CLI_IDS.map((id) => cliDriver(id).profileFiles.nativeFolder),
    ["codex", "claude", "config/opencode"],
  );
  assert.deepEqual(
    CODING_CLI_IDS.map((id) => cliDefinition(id).configFormat),
    ["toml", "json", "jsonc"],
  );
});

test("mcp codec member shape", () => {
  const timeouts = {
    codex: {
      startup_timeout_sec: { field: "startupTimeoutSec", scale: 1 },
      tool_timeout_sec: { field: "toolTimeoutSec", scale: 1 },
    },
    claude: { timeout: { field: "toolTimeoutSec", scale: 1000 } },
    opencode: { timeout: { field: "toolTimeoutSec", scale: 1000 } },
  };
  for (const id of CODING_CLI_IDS) {
    const { mcp } = cliDriver(id);
    assert.equal(typeof mcp.toNative, "function");
    assert.equal(typeof mcp.fromNative, "function");
    assert.deepEqual(mcp.timeouts, timeouts[id]);
    assert.deepEqual(Object.keys(mcp.timeouts), Object.keys(timeouts[id]));
    assert.equal(mcp.remoteSseAsHttp, id === "opencode");
    assert.equal(mcp.keepsOAuthScope, id === "claude");
    assert.ok(Object.isFrozen(mcp));
    assertFrozenDeep(mcp, `${id}.mcp`);
  }
});

test("an unknown CLI has no MCP codec", () => {
  assert.deepEqual(centralFromNative("gemini", { type: "remote", url: "https://x" }), {
    ok: false,
    reason: "invalid",
  });
  assert.throws(
    () =>
      cliEntry(
        "gemini",
        { transport: "http", url: "https://x/mcp" },
        { headers: {}, env: {} },
      ),
    TypeError,
  );
});

test("native agent files per CLI", async () => {
  const { nativeAgent } = await import("../../server/features/agency/source.js");
  const agent = { name: "A", description: "D", body: "B" };
  const tail = "B\n\nSource: src\nLicense: MIT (see AGENCY-LICENSE.txt).\n";
  assert.equal(
    nativeAgent("codex", agent, "src"),
    `name = "A"\ndescription = "D"\ndeveloper_instructions = "B\\n\\nSource: src\\nLicense: MIT (see AGENCY-LICENSE.txt).\\n"\n`,
  );
  assert.equal(
    nativeAgent("claude", agent, "src"),
    `---\nname: A\ndescription: D\nmodel: inherit\n---\n\n${tail}`,
  );
  assert.equal(
    nativeAgent("opencode", agent, "src"),
    `---\nname: A\ndescription: D\nmode: subagent\n---\n\n${tail}`,
  );
  assert.deepEqual(cliDriver("codex").profileFiles.agents, {
    format: "toml",
    frontmatter: {},
  });
  assert.throws(() => nativeAgent("gemini", agent, "src"), TypeError);
});
