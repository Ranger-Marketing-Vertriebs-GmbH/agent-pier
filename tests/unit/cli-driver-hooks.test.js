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
import { hookScreen } from "../fixtures/requests/codex-hook-trust.js";
import { themeScreen } from "../fixtures/requests/claude-startup-prompts.js";

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

// Cycles that predate the guard and are safe (function declarations used at call time).
// The list may only shrink.
const KNOWN_CYCLES = new Set([
  "server/features/providers/endpoint-config.js server/features/providers/provider-definitions.js",
  "server/features/providers/endpoint-config.js server/features/providers/endpoint-routing.js server/features/providers/provider-definitions.js",
]);

test("the driver import graph has no new cycle", () => {
  const graph = importGraph(DRIVERS);
  const state = new Map();
  const stack = [];
  const cycles = [];
  const visit = (file) => {
    if (state.get(file) === 2) return;
    if (state.get(file) === 1) {
      const loop = [...stack.slice(stack.indexOf(file)), file];
      const members = [...new Set(loop.map((item) => path.relative(ROOT, item)))];
      cycles.push(members.sort().join(" "));
      return;
    }
    state.set(file, 1);
    stack.push(file);
    for (const next of graph.get(file) || []) visit(next);
    stack.pop();
    state.set(file, 2);
  };
  visit(DRIVERS);
  assert.deepEqual(
    cycles.filter((cycle) => !KNOWN_CYCLES.has(cycle)),
    [],
  );
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

test("every driver member of every CLI is frozen all the way down", () => {
  for (const id of CODING_CLI_IDS) {
    const driver = cliDriver(id);
    assertFrozenDeep(driver, id);
    assert.equal(driver.definition, cliDefinition(id));
    for (const step of driver.tui.modelPicker.openKeys)
      if (step.keys) assert.ok(Object.isFrozen(step.keys), `${id} openKeys keys`);
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

test("provider member shape", () => {
  for (const id of CODING_CLI_IDS) {
    const { provider } = cliDriver(id);
    assert.equal(typeof provider.environment, "function");
    assert.ok(Object.isFrozen(provider));
    if (id === "claude") {
      assert.equal(typeof provider.launch, "function");
      assert.equal(provider.endpointLaunch, undefined);
    } else {
      assert.equal(provider.launch, undefined);
      assert.equal(typeof provider.endpointLaunch, "function");
      assert.equal(typeof provider.catalogLaunch, "function");
    }
  }
  assert.deepEqual(
    CODING_CLI_IDS.map((id) => cliDefinition(id).capabilities.endpointSdkRouting),
    [false, false, true],
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

test("account transfer refuses a CLI without a transfer driver", async () => {
  const { prepareAccountTransfer } =
    await import("../../server/application/session-account-transfer.js");
  const { serverMessages } = await import("../../server/lib/i18n/de.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-driver-"));
  try {
    const environment = (id) => ({
      HOME: root,
      XDG_DATA_HOME: path.join(root, id, "data"),
      XDG_CONFIG_HOME: path.join(root, id, "config"),
    });
    const id = "11111111-1111-4111-8111-111111111111";
    await assert.rejects(
      prepareAccountTransfer(
        { accounts: { environment }, history: {} },
        { tool: "opencode", accountId: "a", cwd: root },
        { id: "b", tool: "opencode" },
        id,
      ),
      (error) => error.message === serverMessages.sessionTransfer.notTransferable,
    );
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("transfer member shape", () => {
  assert.equal(cliDriver("opencode").transfer, null);
  for (const id of ["codex", "claude"]) {
    const { transfer } = cliDriver(id);
    for (const name of ["locate", "safePath", "destination", "companions", "validator"])
      assert.equal(typeof transfer[name], "function", `${id}.${name}`);
    assert.ok(Object.isFrozen(transfer));
  }
  const codex = cliDriver("codex").transfer;
  assert.equal(codex.destination("archived_sessions/a.jsonl"), "sessions/a.jsonl");
  assert.deepEqual(codex.companions("sessions/a.jsonl", "x"), []);
  const claude = cliDriver("claude").transfer;
  assert.equal(claude.destination("projects/p/a.jsonl"), "projects/p/a.jsonl");
  assert.deepEqual(claude.companions("projects/p/x.jsonl", "x"), [
    "projects/p/x",
    path.join("file-history", "x"),
  ]);
});

test("Claude messages pass image decoration unchanged", async () => {
  const { UploadedImageInput } =
    await import("../../server/features/chat/uploaded-image-input.js");
  const messages = [{ role: "user", text: "hi" }];
  const out = await new UploadedImageInput().decorate(
    { tool: "claude" },
    messages,
    os.tmpdir(),
  );
  assert.equal(out, messages);
});

test("inlineMcpNames per CLI", () => {
  const env = { OPENCODE_CONFIG_CONTENT: '{"mcp":{"a":{}}}' };
  assert.deepEqual(cliDriver("opencode").inlineMcpNames(env), ["a"]);
  assert.deepEqual(cliDriver("opencode").inlineMcpNames({}), []);
  assert.throws(() =>
    cliDriver("opencode").inlineMcpNames({ OPENCODE_CONFIG_CONTENT: "{" }),
  );
  for (const id of ["codex", "claude"])
    assert.deepEqual(cliDriver(id).inlineMcpNames(env), []);
});

test("request launch records and handoff capability per CLI", () => {
  const abs = { CLAUDE_CONFIG_DIR: "/tmp/cfg" };
  const record = cliDriver("claude").requests.launchRecord;
  assert.equal(record({}).claudeHookVersion, 2);
  assert.equal("claudeTrustFile" in record({ CLAUDE_CONFIG_DIR: "rel" }), false);
  assert.equal(record(abs).claudeTrustFile, "/tmp/cfg/.claude.json");
  for (const id of ["codex", "opencode"])
    assert.equal(cliDriver(id).requests.launchRecord, undefined);
  assert.deepEqual(
    CODING_CLI_IDS.filter((id) => cliDefinition(id).capabilities.requestHandoff),
    ["claude"],
  );
  assert.ok(Object.isFrozen(cliDriver("claude").requests));
});

test("every CLI with transcript cleanup walks its transcript layout", () => {
  for (const id of CODING_CLI_IDS) {
    const { history } = cliDriver(id);
    if (!cliDefinition(id).capabilities.transcriptCleanup) continue;
    const steps = history.transcriptFiles(path.join(os.tmpdir(), "home"));
    assert.ok(steps.length > 0, id);
    for (const step of steps) {
      assert.equal(typeof step.folder, "string");
      assert.ok(step.pattern instanceof RegExp);
    }
  }
  const [claude] = cliDriver("claude").history.transcriptFiles("/h");
  assert.deepEqual(
    [claude.folder, claude.perFolder, claude.depth, claude.companion],
    ["/h/projects", true, 0, true],
  );
  assert.deepEqual(
    cliDriver("codex")
      .history.transcriptFiles("/h")
      .map((step) => [step.folder, step.depth, step.companion]),
    [
      ["/h/sessions", 4, false],
      ["/h/archived_sessions", 4, false],
    ],
  );
});

test("runtimeInterpreter resolves a Node shebang for Claude Code only", () => {
  assert.equal(typeof cliDriver("claude").runtimeInterpreter, "function");
  assert.equal(cliDriver("claude").runtimeInterpreter("/nonexistent/claude", {}), null);
  assert.equal(cliDriver("codex").runtimeInterpreter, undefined);
  assert.equal(cliDriver("opencode").runtimeInterpreter, undefined);
});

const SANDBOX = ["-c", 'sandbox_mode="workspace-write"'];

test("grantDirectory adds each CLI's attachment grant like the launch did", () => {
  const grant = (
    id,
    { reload = false, launchMode = "default", args = [], ok = true },
  ) => {
    const launch = { args: [...args], launchMode };
    let ensured = 0;
    const granted = cliDriver(id).grantDirectory(launch, "/att/s1", {
      reload,
      ensure: () => (ensured++, ok),
      profile: () => null,
      accountDirectory: "/att",
    });
    return { granted, args: launch.args, ensured };
  };
  const add = ["--add-dir", "/att/s1"];
  for (const reload of [false, true]) {
    const ensured = reload ? 0 : 1;
    assert.deepEqual(grant("claude", { reload }), { granted: true, args: add, ensured });
    assert.deepEqual(grant("claude", { reload, launchMode: "bypass" }), {
      granted: true,
      args: add,
      ensured,
    });
    assert.deepEqual(grant("codex", { reload }), {
      granted: true,
      args: [...add, ...SANDBOX],
      ensured,
    });
    assert.deepEqual(grant("codex", { reload, launchMode: "yolo" }), {
      granted: true,
      args: add,
      ensured,
    });
  }
  // A first launch always pins the sandbox; a reload only when it is missing.
  assert.deepEqual(grant("codex", { args: SANDBOX }).args, [
    ...SANDBOX,
    ...add,
    ...SANDBOX,
  ]);
  assert.deepEqual(grant("codex", { reload: true, args: SANDBOX }).args, [
    ...SANDBOX,
    ...add,
  ]);
  for (const id of ["claude", "codex"])
    assert.deepEqual(grant(id, { ok: false }), { granted: false, args: [], ensured: 1 });
  // OpenCode: no profile, no grant and no directory; a reload changes nothing.
  assert.deepEqual(grant("opencode", {}), { granted: false, args: [], ensured: 0 });
  assert.deepEqual(grant("opencode", { reload: true }), {
    granted: true,
    args: [],
    ensured: 0,
  });
});

test("OpenCode grants attachments through its profile, read lazily", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-grant-"));
  const launch = { args: [], env: {}, launchMode: "default" };
  let reads = 0;
  const granted = cliDriver("opencode").grantDirectory(launch, "/att/s1", {
    reload: false,
    ensure: () => true,
    profile: () => (reads++, { root, boundary: root }),
    accountDirectory: "/att",
  });
  assert.equal(granted, true);
  assert.equal(reads, 1);
  assert.deepEqual(launch.args, []);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, "opencode.json"), "utf8")).references,
    { "agentpier-attachments": { path: "/att" } },
  );
  let lazy = 0;
  for (const id of ["claude", "codex"])
    cliDriver(id).grantDirectory({ args: [] }, "/att/s1", {
      reload: false,
      ensure: () => true,
      profile: () => lazy++,
    });
  assert.equal(lazy, 0);
});

test("session id, reload model and credential members per CLI", () => {
  assert.deepEqual(cliDefinition("claude").sessionIdArgs("s1"), ["--session-id", "s1"]);
  assert.equal(cliDefinition("codex").sessionIdArgs, null);
  assert.equal(cliDefinition("opencode").sessionIdArgs, null);
  const history = { readCodexModels: async (session) => [session.id] };
  return cliDriver("codex")
    .history.models(history, { id: "s1" })
    .then((models) => {
      assert.deepEqual(models, ["s1"]);
      assert.equal(cliDriver("claude").history.models, undefined);
      assert.equal(cliDriver("opencode").history.models, undefined);
      for (const id of ["codex", "claude"])
        assert.equal(typeof cliDriver(id).tui.modelPicker.resolveDisplayed, "function");
      assert.equal(cliDriver("opencode").tui.modelPicker.resolveDisplayed, undefined);
      const { credentials } = cliDriver("codex");
      assertFrozenDeep(credentials, "codex.credentials");
      assert.deepEqual(credentials.args(), [
        "-c",
        'cli_auth_credentials_store="file"',
        "-c",
        'mcp_oauth_credentials_store="file"',
      ]);
      assert.equal(cliDriver("claude").credentials, null);
      assert.equal(cliDriver("opencode").credentials, null);
    });
});

test("terminal input members per CLI", () => {
  const file = "/tmp/a b.png";
  for (const id of CODING_CLI_IDS) {
    const { tui } = cliDriver(id);
    assert.ok(Object.isFrozen(tui));
    assertFrozenDeep(tui.images, `${id}.tui.images`);
    assert.equal(typeof tui.queuedInputs, "function");
    assert.equal(tui.images.pathText(file), id === "codex" ? '"/tmp/a b.png"' : file);
    assert.equal(cliDefinition(id).capabilities.imagePaste, id === "claude");
  }
  const { codex, claude, opencode } = Object.fromEntries(
    CODING_CLI_IDS.map((id) => [id, cliDriver(id).tui]),
  );
  for (const tui of [codex, opencode]) {
    assert.equal(typeof tui.promptState, "function");
    assert.equal(tui.images.wait, undefined);
    assert.equal(tui.images.draft, undefined);
    assert.equal(tui.images.chipsOnly, undefined);
  }
  assert.equal(claude.promptState, undefined);
  for (const key of ["wait", "draft", "chipsOnly"])
    assert.equal(typeof claude.images[key], "function");
  assert.equal(codex.promptProof(["a", "b"], "a\nb"), true);
  assert.equal(codex.promptProof(["a", "c"], "a\nb"), false);
  assert.equal(claude.promptProof, undefined);
  assert.equal(opencode.promptProof, undefined);
  assert.equal(typeof codex.blockingScreen, "function");
  assert.equal(typeof claude.blockingScreen, "function");
  assert.equal(opencode.blockingScreen, undefined);
  // An empty or unrelated screen blocks nothing.
  assert.ok(!codex.blockingScreen("", { cwd: "/tmp", started: true }));
  assert.ok(!claude.blockingScreen("", { cwd: "/tmp", started: true }));
  // A real hook review and a real startup dialog block the chat input.
  assert.ok(codex.blockingScreen(hookScreen(), { cwd: "/tmp", started: true }));
  assert.ok(
    claude.blockingScreen(themeScreen(), { cwd: "/fixture/project", started: false }),
  );
  assert.equal(
    codex.promptState({ raw: "", pane: { cursorY: 0, height: 1 } }),
    undefined,
  );
  // Without a recognisable queue every CLI reads none.
  const pane = { cursorX: 0, cursorY: 2, width: 80, height: 4 };
  for (const tui of [codex, claude, opencode])
    assert.deepEqual(
      tui.queuedInputs({
        raw: "\n\n\n",
        styled: ["", "", "", ""],
        lines: ["", "", "", ""],
        row: 2,
        pane,
        hashes: (values) => values,
      }),
      [],
    );
});
