// Pins the launch additions of the session hooks (AgentBus, native session binding,
// session secrets) and the native binding results per CLI, for shell and for login
// sessions. The expected literals were captured from the code before the hooks moved
// into the CLI drivers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { AgentBus } from "../../server/features/agentbus/agent-bus.js";
import {
  NativeSessionBinding,
  recordNativeSession,
  runNativeSessionHook,
} from "../../server/features/sessions/native-session-binding.js";
import { recordNativeActivity } from "../../server/features/sessions/native-session-activity.js";
import { SecretStore } from "../../server/features/secrets/secret-store.js";
import { SessionSecrets } from "../../server/features/secrets/session-secrets.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { cliDriver } from "../../server/features/clis/drivers.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = ["codex", "claude", "opencode"];
const owner = { kind: "owner" };

function tempRoot(t, prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Replaces the run-specific paths and values so the snapshot is stable.
function normalise(value, replacements) {
  let text = JSON.stringify(value);
  for (const [from, to] of replacements) text = text.split(from).join(to);
  return JSON.parse(text);
}

// DUMP=<file> writes the actual values instead of comparing (capture only).
const captured = {};
function pin(table, name, key, actual) {
  if (!process.env.DUMP) return assert.deepEqual(actual, table[key], key);
  captured[name] = { ...captured[name], [key]: actual };
  fs.writeFileSync(process.env.DUMP, JSON.stringify(captured, null, 2));
}

// Every JSON file below `folder`, relative path → parsed content.
function files(folder) {
  const out = {};
  const walk = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith(".json"))
        out[path.relative(folder, file)] = JSON.parse(fs.readFileSync(file, "utf8"));
    }
  };
  if (fs.existsSync(folder)) walk(folder);
  return out;
}

async function agentBusFixture(t) {
  const root = tempRoot(t, "cli-session-hooks-bus-");
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const dataDir = path.join(root, "data");
  const accounts = new AccountStore({ dataDir, home });
  const sessions = { list: async () => [], get: async () => null };
  const bus = new AgentBus({
    dataDir,
    home,
    accounts,
    sessions,
    classifyFolder: (folder) => ({ kind: "project", cwd: folder }),
  });
  await bus.ready;
  t.after(() => bus.close());
  return { root, cwd, accounts, bus };
}

async function agentBusLaunch(ctx, tool, launch = {}) {
  const account = ctx.accounts.create({ name: `bus-${tool}`, tool });
  const prepared = await ctx.bus.prepare({
    id: `bus-${tool}`,
    account,
    cwd: ctx.cwd,
    launch: { command: "cli", args: ["--existing"], env: { KEEP: "1" }, ...launch },
  });
  const projectHome = path.join(
    ctx.bus.root,
    "projects",
    prepared.agentbus.projectId || "none",
  );
  return normalise(
    {
      args: prepared.args,
      env: prepared.env,
      agentbus: { ...prepared.agentbus, projectId: Boolean(prepared.agentbus.projectId) },
      files: files(path.join(projectHome, "adapters", `bus-${tool}`)),
    },
    [
      [projectHome, "<project>"],
      [ctx.bus.broker.transport.socketPath, "<socket>"],
      [ctx.root, "<root>"],
      [REPO, "<repo>"],
      [process.execPath, "<node>"],
      [prepared.agentbus.version, "<version>"],
    ],
  );
}

// prettier-ignore
const AGENTBUS = {
  "codex": {
    args: ["--existing","-c","mcp_servers.agentpier_agentbus={\"command\"=\"<node>\",\"args\"=[\"<repo>/server/features/agentbus/agentbus-mcp.js\"],\"env\"={\"AGENTPIER_AGENTBUS_NODE\"=\"<node>\",\"AGENTPIER_AGENTBUS_SOCKET\"=\"<socket>\",\"AGENTPIER_AGENTBUS_CAPABILITY_FILE\"=\"<root>/data/agentbus/sessions/bus-codex/capability.json\"}}","-c","hooks.SessionStart=[{\"hooks\"=[{\"type\"=\"command\",\"command\"=\"\\\"${AGENTPIER_HOOK_NODE:?}\\\" \\\"${AGENTPIER_AGENTBUS_HOOK:?}\\\" 'SessionStart'\",\"timeout\"=10}]}]","-c","hooks.UserPromptSubmit=[{\"hooks\"=[{\"type\"=\"command\",\"command\"=\"\\\"${AGENTPIER_HOOK_NODE:?}\\\" \\\"${AGENTPIER_AGENTBUS_HOOK:?}\\\" 'UserPromptSubmit'\",\"timeout\"=10}]}]","-c","hooks.SessionEnd=[{\"hooks\"=[{\"type\"=\"command\",\"command\"=\"\\\"${AGENTPIER_HOOK_NODE:?}\\\" \\\"${AGENTPIER_AGENTBUS_HOOK:?}\\\" 'SessionEnd'\",\"timeout\"=3}]}]"],
    env: {"KEEP":"1","AGENTPIER_AGENTBUS_NODE":"<node>","AGENTPIER_AGENTBUS_SOCKET":"<socket>","AGENTPIER_AGENTBUS_CAPABILITY_FILE":"<root>/data/agentbus/sessions/bus-codex/capability.json","AGENTPIER_HOOK_NODE":"<node>","AGENTPIER_AGENTBUS_HOOK":"<repo>/server/features/agentbus/agentbus-hook.js"},
    agentbus: {"enabled":true,"projectId":true,"version":"<version>"},
    files: {},
  },
  "claude": {
    args: ["--existing","--plugin-dir","<project>/adapters/bus-claude"],
    env: {"KEEP":"1","AGENTPIER_AGENTBUS_NODE":"<node>","AGENTPIER_AGENTBUS_SOCKET":"<socket>","AGENTPIER_AGENTBUS_CAPABILITY_FILE":"<root>/data/agentbus/sessions/bus-claude/capability.json"},
    agentbus: {"enabled":true,"projectId":true,"version":"<version>"},
    files: {
      ".claude-plugin/plugin.json": {"name":"agentpier-agentbus","version":"1.0.0","description":"AgentBus for this AgentPier session","license":"MIT"},
      ".mcp.json": {"mcpServers":{"agentpier_agentbus":{"command":"<node>","args":["<repo>/server/features/agentbus/agentbus-mcp.js"],"env":{"AGENTPIER_AGENTBUS_NODE":"<node>","AGENTPIER_AGENTBUS_SOCKET":"<socket>","AGENTPIER_AGENTBUS_CAPABILITY_FILE":"<root>/data/agentbus/sessions/bus-claude/capability.json"}}}},
      "hooks/hooks.json": {"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/agentbus/agentbus-hook.js' 'SessionStart'","timeout":10}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/agentbus/agentbus-hook.js' 'UserPromptSubmit'","timeout":10}]}],"SessionEnd":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/agentbus/agentbus-hook.js' 'SessionEnd'","timeout":3}]}]}},
    },
  },
  "opencode": {
    args: ["--existing"],
    env: {"KEEP":"1","AGENTPIER_AGENTBUS_NODE":"<node>","AGENTPIER_AGENTBUS_SOCKET":"<socket>","AGENTPIER_AGENTBUS_CAPABILITY_FILE":"<root>/data/agentbus/sessions/bus-opencode/capability.json","OPENCODE_CONFIG_CONTENT":"{\"plugin\":[\"file://<repo>/server/features/agentbus/agentbus-opencode.js\"]}"},
    agentbus: {"enabled":true,"projectId":true,"version":"<version>"},
    files: {},
  },
};

test("AgentBus adds each CLI's session hooks, MCP server and plugin files", async (t) => {
  const ctx = await agentBusFixture(t);
  for (const tool of TOOLS)
    pin(AGENTBUS, "AGENTBUS", tool, await agentBusLaunch(ctx, tool));
});

test("AgentBus keeps its OpenCode error and skips login launches", async (t) => {
  const ctx = await agentBusFixture(t);
  for (const content of ["[]", "{", '{"plugin":"x"}'])
    await assert.rejects(
      agentBusLaunch(ctx, "opencode", { env: { OPENCODE_CONFIG_CONTENT: content } }),
      { status: 409, message: serverMessages.common.invalidTemporaryOpenCodeConfig },
    );
  // AgentBus appends its plugin without dropping duplicates or checking entries.
  const merged = await agentBusLaunch(ctx, "opencode", {
    env: { OPENCODE_CONFIG_CONTENT: '{"plugin":["a",1],"mcp":{}}' },
  });
  assert.deepEqual(JSON.parse(merged.env.OPENCODE_CONFIG_CONTENT), {
    plugin: ["a", 1, "file://<repo>/server/features/agentbus/agentbus-opencode.js"],
    mcp: {},
  });
  const login = await ctx.bus.prepare({
    id: "login",
    account: { id: "x", tool: "claude" },
    cwd: ctx.cwd,
    launch: { args: [] },
    purpose: "login",
  });
  assert.deepEqual(login, { args: [], agentbus: { enabled: false } });
});

function bindingFixture(t, options = {}) {
  const root = tempRoot(t, "cli-session-hooks-binding-");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const accounts = new AccountStore({ dataDir: path.join(root, "data"), home: root });
  const bindings = new NativeSessionBinding({
    dataDir: accounts.dataDir,
    accounts,
    ...options,
  });
  return { root, cwd, accounts, bindings };
}

async function bindingLaunch(ctx, tool, id, launch = {}) {
  const account = ctx.accounts.create({ name: id, tool });
  const prepared = await ctx.bindings.prepare({
    id,
    account,
    cwd: ctx.cwd,
    launch: { command: "cli", args: [], env: { KEEP: "1" }, ...launch },
  });
  const session = {
    id,
    tool,
    accountId: account.id,
    cwd: ctx.cwd,
    status: "running",
    nativeBinding: prepared.nativeBinding,
  };
  const snapshot = normalise(
    {
      args: prepared.args,
      env: prepared.env,
      nativeBinding: prepared.nativeBinding,
      sandboxGrants: prepared.sandboxGrants,
      files: Object.fromEntries(
        Object.entries(files(path.join(ctx.bindings.directory, id))).filter(
          ([name]) => name.startsWith(`${id}.`) && !name.endsWith("launch.json"),
        ),
      ),
    },
    [
      [prepared.env.AGENTPIER_NATIVE_BINDING_TOKEN, "<token>"],
      [ctx.root, "<root>"],
      [REPO, "<repo>"],
      [process.execPath, "<node>"],
    ],
  );
  return { prepared, session, snapshot };
}

// prettier-ignore
const BINDING = {
  "codex": {
    args: ["-c","hooks.SessionStart=[{\"hooks\"=[{\"type\"=\"command\",\"command\"=\"\\\"${AGENTPIER_HOOK_NODE:?}\\\" \\\"${AGENTPIER_BINDING_HOOK:?}\\\" '--record'\",\"timeout\"=5}]}]","-c","hooks.UserPromptSubmit=[{\"hooks\"=[{\"type\"=\"command\",\"command\"=\"\\\"${AGENTPIER_HOOK_NODE:?}\\\" \\\"${AGENTPIER_BINDING_HOOK:?}\\\" '--record'\",\"timeout\"=5}]}]"],
    env: {"KEEP":"1","AGENTPIER_NATIVE_BINDING_FILE":"<root>/data/native-sessions/codex/codex.launch.json","AGENTPIER_NATIVE_BINDING_TOKEN":"<token>","AGENTPIER_HOOK_NODE":"<node>","AGENTPIER_BINDING_HOOK":"<repo>/server/features/sessions/native-session-binding.js"},
    nativeBinding: {"enabled":true,"version":1},
    sandboxGrants: [{"access":"allow","path":"<root>/data/native-sessions/codex"},{"access":"read","path":"<node>"},{"access":"read","path":"<repo>/server/features/sessions/native-session-binding.js"}],
    files: {},
  },
  "codex-merged": {
    args: ["--yolo","-c","hooks.UserPromptSubmit=[{\"hooks\"=[{\"type\"=\"command\",\"command\"=\"existing\"}]},{\"hooks\"=[{\"type\"=\"command\",\"command\"=\"\\\"${AGENTPIER_HOOK_NODE:?}\\\" \\\"${AGENTPIER_BINDING_HOOK:?}\\\" '--record'\",\"timeout\"=5}]}]","-c","hooks.SessionStart=[{\"hooks\"=[{\"type\"=\"command\",\"command\"=\"\\\"${AGENTPIER_HOOK_NODE:?}\\\" \\\"${AGENTPIER_BINDING_HOOK:?}\\\" '--record'\",\"timeout\"=5}]}]"],
    env: {"KEEP":"1","AGENTPIER_NATIVE_BINDING_FILE":"<root>/data/native-sessions/codex-merged/codex-merged.launch.json","AGENTPIER_NATIVE_BINDING_TOKEN":"<token>","AGENTPIER_HOOK_NODE":"<node>","AGENTPIER_BINDING_HOOK":"<repo>/server/features/sessions/native-session-binding.js"},
    nativeBinding: {"enabled":true,"version":1},
    sandboxGrants: [{"access":"allow","path":"<root>/data/native-sessions/codex-merged"},{"access":"read","path":"<node>"},{"access":"read","path":"<repo>/server/features/sessions/native-session-binding.js"}],
    files: {},
  },
  "claude-old": {
    args: ["--session-id","claude-old","--plugin-dir","<root>/data/native-sessions/claude-old/claude-old.claude","--plugin-dir","<root>/data/native-sessions/claude-old/claude-old.claude-activity"],
    env: {"KEEP":"1","AGENTPIER_NATIVE_BINDING_FILE":"<root>/data/native-sessions/claude-old/claude-old.launch.json","AGENTPIER_NATIVE_BINDING_TOKEN":"<token>"},
    nativeBinding: {"enabled":true,"version":1},
    sandboxGrants: [{"access":"allow","path":"<root>/data/native-sessions/claude-old"},{"access":"read","path":"<node>"},{"access":"read","path":"<repo>/server/features/sessions/native-session-binding.js"}],
    files: {
      "claude-old.claude/.claude-plugin/plugin.json": {"name":"agentpier-reader","version":"1.0.0","description":"Native session identity for the AgentPier reader"},
      "claude-old.claude/hooks/hooks.json": {"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5}]}]}},
      "claude-old.claude-activity/.claude-plugin/plugin.json": {"name":"agentpier-activity","version":"1.0.0","description":"Native session activity for AgentPier"},
      "claude-old.claude-activity/hooks/hooks.json": {"hooks":{"Stop":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5,"async":true}]}],"StopFailure":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5,"async":true}]}],"PermissionRequest":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5,"async":true}]}],"PreToolUse":[{"matcher":"AskUserQuestion","hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5,"async":true}]}],"Elicitation":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5,"async":true}]}],"SessionEnd":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5,"async":true}]}]}},
    },
  },
  "claude-stream": {
    args: ["--resume","x","--plugin-dir","<root>/data/native-sessions/claude-stream/claude-stream.claude","--plugin-dir","<root>/data/native-sessions/claude-stream/claude-stream.claude-activity","--plugin-dir","<root>/data/native-sessions/claude-stream/claude-stream.claude-stream"],
    env: {"KEEP":"1","AGENTPIER_NATIVE_BINDING_FILE":"<root>/data/native-sessions/claude-stream/claude-stream.launch.json","AGENTPIER_NATIVE_BINDING_TOKEN":"<token>"},
    nativeBinding: {"enabled":true,"version":1},
    sandboxGrants: [{"access":"allow","path":"<root>/data/native-sessions/claude-stream"},{"access":"read","path":"<node>"},{"access":"read","path":"<repo>/server/features/sessions/native-session-binding.js"}],
    files: {
      "claude-stream.claude/.claude-plugin/plugin.json": {"name":"agentpier-reader","version":"1.0.0","description":"Native session identity for the AgentPier reader"},
      "claude-stream.claude/hooks/hooks.json": {"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5}]}]}},
      "claude-stream.claude-activity/.claude-plugin/plugin.json": {"name":"agentpier-activity","version":"1.0.0","description":"Native session activity for AgentPier"},
      "claude-stream.claude-activity/hooks/hooks.json": {"hooks":{"Stop":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5,"async":true}]}],"StopFailure":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5,"async":true}]}],"PermissionRequest":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5,"async":true}]}],"PreToolUse":[{"matcher":"AskUserQuestion","hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5,"async":true}]}],"Elicitation":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5,"async":true}]}],"SessionEnd":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5,"async":true}]}]}},
      "claude-stream.claude-stream/.claude-plugin/plugin.json": {"name":"agentpier-stream","version":"1.0.0","description":"Live reply text for the AgentPier chat"},
      "claude-stream.claude-stream/hooks/hooks.json": {"hooks":{"MessageDisplay":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/sessions/native-session-binding.js' '--record'","timeout":5,"async":true}]}]}},
    },
  },
  "opencode": {
    args: [],
    env: {"KEEP":"1","AGENTPIER_NATIVE_BINDING_FILE":"<root>/data/native-sessions/opencode/opencode.launch.json","AGENTPIER_NATIVE_BINDING_TOKEN":"<token>","OPENCODE_TUI_CONFIG":"<root>/data/native-sessions/opencode/opencode.tui.json"},
    nativeBinding: {"enabled":true,"version":1},
    sandboxGrants: [{"access":"allow","path":"<root>/data/native-sessions/opencode"},{"access":"read","path":"<node>"},{"access":"read","path":"<repo>/server/features/sessions/native-session-binding.js"}],
    files: {
      "opencode.tui.json": {"plugin":["file://<repo>/server/features/sessions/native-session-opencode.js"]},
    },
  },
};

test("the native binding adds each CLI's hooks, plugins and TUI configuration", async (t) => {
  const ctx = bindingFixture(t);
  const cases = {
    codex: ["codex", {}],
    "codex-merged": [
      "codex",
      {
        args: [
          "--yolo",
          "-c",
          'hooks.UserPromptSubmit=[{hooks=[{type="command",command="existing"}]}]',
        ],
      },
    ],
    "claude-old": ["claude", { cliVersion: "2.1.151" }],
    "claude-stream": ["claude", { cliVersion: "2.1.152", args: ["--resume", "x"] }],
    opencode: ["opencode", {}],
  };
  for (const [name, [tool, launch]] of Object.entries(cases))
    pin(
      BINDING,
      "BINDING",
      name,
      (await bindingLaunch(ctx, tool, name, launch)).snapshot,
    );
});

test("the native binding keeps its errors and the shell and login exits", async (t) => {
  const ctx = bindingFixture(t);
  const { sessions } = serverMessages;
  for (const [id, args, message] of [
    ["bad-toml", ["-c", "hooks.SessionStart=[{"], sessions.codexHooksCannotBeMerged],
    ["bad-list", ["--config", 'hooks.SessionStart="x"'], sessions.unknownCodexHookFormat],
  ])
    await assert.rejects(bindingLaunch(ctx, "codex", id, { args }), {
      status: 409,
      message,
    });
  await assert.rejects(
    bindingLaunch(ctx, "opencode", "tui", { env: { OPENCODE_TUI_CONFIG: "x" } }),
    { status: 409, message: sessions.temporaryTuiConfigConflict },
  );
  for (const input of [
    { account: { id: "x", tool: "shell" } },
    { account: { id: "x", tool: "codex" }, purpose: "login" },
  ])
    assert.deepEqual(
      await ctx.bindings.prepare({
        id: "off",
        cwd: ctx.cwd,
        launch: { args: [] },
        ...input,
      }),
      { args: [], nativeBinding: { enabled: false, version: 1 } },
    );
  const shell = { id: "off", tool: "shell", cwd: ctx.cwd, accountId: "x" };
  assert.equal(await ctx.bindings.resolve(shell), null);
  assert.equal(
    await ctx.bindings.resolve({ ...shell, tool: "codex", purpose: "login" }),
    null,
  );
});

test("binding results per CLI: ids, process lookup, hook activity and interrupts", async (t) => {
  const tmux = [];
  const claudeFiles = [];
  const ctx = bindingFixture(t, {
    sessions: { tmux: async (args) => (tmux.push(args), ""), target: (id) => id },
    history: {
      codexRolloutIdentity: () => null,
      claudeFile: async (session, id) => (claudeFiles.push([session.id, id]), "/none"),
    },
  });
  const results = {};
  for (const tool of TOOLS) {
    const { prepared, session } = await bindingLaunch(ctx, tool, `r-${tool}`);
    const env = prepared.env;
    let missing = false;
    try {
      recordNativeSession({ cwd: ctx.cwd }, env, { pid: process.pid });
    } catch (error) {
      missing = error.message === serverMessages.sessions.nativeSessionIdMissing;
    }
    recordNativeSession({ session_id: `native-${tool}`, cwd: ctx.cwd }, env, {
      pid: process.pid,
    });
    const before = tmux.length;
    const resolved = (await ctx.bindings.resolve(session))?.id;
    const cached = (await ctx.bindings.resolve(session))?.id;
    const forInput = await ctx.bindings.resolve(session, { forInput: true });
    await runNativeSessionHook({
      env,
      input: Readable.from([JSON.stringify({ hook_event_name: "Stop" })]),
      at: 1000,
    });
    const hooked = ctx.bindings.activity(session)?.state ?? null;
    recordNativeActivity({ state: "working", event: "UserPromptSubmit", at: 2000 }, env);
    const filesBefore = claudeFiles.length;
    const reported = (await ctx.bindings.reportedActivity(session))?.state ?? null;
    results[tool] = {
      missing,
      resolved,
      cached,
      forInput,
      processLookups: tmux.length - before,
      hooked,
      reported,
      transcriptReads: claudeFiles.length - filesBefore,
    };
  }
  assert.deepEqual(results, {
    codex: {
      missing: true,
      resolved: "native-codex",
      cached: "native-codex",
      forInput: null,
      processLookups: 2,
      hooked: null,
      reported: "working",
      transcriptReads: 0,
    },
    claude: {
      missing: true,
      resolved: "native-claude",
      cached: "native-claude",
      forInput: null,
      processLookups: 0,
      hooked: "idle",
      reported: "working",
      transcriptReads: 1,
    },
    opencode: {
      missing: false,
      resolved: "native-opencode",
      cached: "native-opencode",
      forInput: null,
      processLookups: 0,
      hooked: null,
      reported: "working",
      transcriptReads: 0,
    },
  });
  assert.equal(await ctx.bindings.reportedActivity({ id: "nope", tool: "shell" }), null);
});

// prettier-ignore
const SECRETS = {
  "codex": {
    args: ["-c","hooks.SessionStart=[{\"hooks\"=[{\"type\"=\"command\",\"command\"=\"\\\"${AGENTPIER_HOOK_NODE:?}\\\" \\\"${AGENTPIER_SSH_HOOK:?}\\\"\",\"timeout\"=5}]}]"],
    env: {"KEEP":"1","AGENTPIER_SECRETS_FILE":"<data>/secrets/sessions/s-codex/secrets.env","AGENTPIER_SSH_HINT":"0","AGENTPIER_HOOK_NODE":"<node>","AGENTPIER_SSH_HOOK":"<repo>/server/features/ssh/ssh-hook.js"},
    sandboxGrants: [{"access":"read","path":"<data>/secrets/sessions/s-codex"},{"access":"read","path":"<node>"},{"access":"read","path":"<repo>/server/features/ssh/ssh-hook.js"}],
    files: {},
  },
  "claude": {
    args: ["--plugin-dir","<data>/secrets/sessions/s-claude/plugin"],
    env: {"KEEP":"1","AGENTPIER_SECRETS_FILE":"<data>/secrets/sessions/s-claude/secrets.env","AGENTPIER_SSH_HINT":"0"},
    sandboxGrants: [{"access":"read","path":"<data>/secrets/sessions/s-claude"},{"access":"read","path":"<node>"},{"access":"read","path":"<repo>/server/features/ssh/ssh-hook.js"}],
    files: {
      "plugin/.claude-plugin/plugin.json": {"name":"agentpier-secrets","version":"1.0.0","description":"The start hint naming this session's secrets file."},
      "plugin/hooks/hooks.json": {"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"'<node>' '<repo>/server/features/ssh/ssh-hook.js'","timeout":5}]}]}},
    },
  },
  "opencode": {
    args: [],
    env: {"KEEP":"1","AGENTPIER_SECRETS_FILE":"<data>/secrets/sessions/s-opencode/secrets.env","AGENTPIER_SSH_HINT":"0","OPENCODE_CONFIG_CONTENT":"{\"plugin\":[\"file://<repo>/server/features/ssh/ssh-opencode.js\"]}"},
    sandboxGrants: [{"access":"read","path":"<data>/secrets/sessions/s-opencode"},{"access":"read","path":"<node>"},{"access":"read","path":"<repo>/server/features/ssh/ssh-hook.js"}],
    files: {},
  },
  "shell": {
    args: [],
    env: {"KEEP":"1","AGENTPIER_SECRETS_FILE":"<data>/secrets/sessions/s-shell/secrets.env"},
    sandboxGrants: [{"access":"read","path":"<data>/secrets/sessions/s-shell"}],
    files: {},
  },
};

test("session secrets add the start hint hook per CLI", async (t) => {
  const dataDir = tempRoot(t, "cli-session-hooks-secrets-");
  const store = new SecretStore({ dataDir });
  t.after(() => store.close());
  store.create({ name: "TOKEN", projectId: "P", value: "v" }, owner);
  const secrets = new SessionSecrets({
    dataDir,
    store,
    sessions: { list: async () => [] },
  });
  for (const tool of [...TOOLS, "shell"]) {
    const id = `s-${tool}`;
    const launch = await secrets.prepare({
      id,
      account: { id: "a", tool },
      cwd: dataDir,
      launch: {
        command: "cli",
        args: [],
        env: { KEEP: "1" },
        sshTools: { enabled: false, project: { projectId: "P" } },
      },
    });
    const folder = secrets.folder(id);
    pin(
      SECRETS,
      "SECRETS",
      tool,
      normalise(
        {
          args: launch.args,
          env: launch.env,
          sandboxGrants: launch.sandboxGrants,
          files: files(folder),
        },
        [
          [dataDir, "<data>"],
          [REPO, "<repo>"],
          [process.execPath, "<node>"],
        ],
      ),
    );
  }
});

test("session hook and binding members per CLI", () => {
  const shape = (driver) => ({
    addSessionHooks: typeof driver.addSessionHooks,
    addPluginFolder: typeof driver.addPluginFolder,
    binding: Object.fromEntries(
      Object.entries(driver.binding).map(([key, value]) => [
        key,
        typeof value === "function" ? "function" : value,
      ]),
    ),
  });
  const binding = (idOptional, members) => ({
    idOptional,
    addHooks: "function",
    resolve: undefined,
    reportedActivity: undefined,
    hookActivity: undefined,
    ...members,
  });
  assert.deepEqual(Object.fromEntries(TOOLS.map((id) => [id, shape(cliDriver(id))])), {
    codex: {
      addSessionHooks: "function",
      addPluginFolder: "undefined",
      binding: binding(false, { resolve: "function" }),
    },
    claude: {
      addSessionHooks: "function",
      addPluginFolder: "function",
      binding: binding(false, { reportedActivity: "function", hookActivity: "function" }),
    },
    opencode: {
      addSessionHooks: "function",
      addPluginFolder: "undefined",
      binding: binding(true, {}),
    },
  });
  assert.ok(Object.isFrozen(cliDriver("claude").binding));
  assert.throws(() => cliDriver("shell"), TypeError);
});
