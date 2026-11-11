import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NativeSessionBinding,
  recordNativeSession,
} from "../../server/features/sessions/native-session-binding.js";
import { recordNativeActivity } from "../../server/features/sessions/native-session-activity.js";
import {
  isLaunchFile,
  sessionFolder,
} from "../../server/features/sessions/session-own-folder.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { AgentBus } from "../../server/features/agentbus/agent-bus.js";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { refreshClaudeRuntime } from "../../server/features/requests/claude-runtime.js";

// What a sandboxed session is granted of the folders all sessions share: its own
// part, and nothing of the other sessions beside it.
const covers = (grants, target) =>
  grants.some(
    (grant) =>
      ["read", "write", "allow"].includes(grant.access) &&
      (grant.path === target || target.startsWith(grant.path + path.sep)),
  );
const writable = (grants, target) =>
  covers(
    grants.filter((grant) => grant.access !== "read"),
    target,
  );

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ap-own-folder-")));
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const accounts = new AccountStore({ dataDir: path.join(root, "data"), home: root });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cwd, accounts, dataDir: accounts.dataDir };
}

test("a native binding lives in the session's own folder, the only one it is granted", async (t) => {
  const ctx = setup(t);
  const bindings = new NativeSessionBinding({
    dataDir: ctx.dataDir,
    accounts: ctx.accounts,
  });
  const shared = path.join(ctx.dataDir, "native-sessions");
  const prepare = (id, tool) => {
    const account = ctx.accounts.create({ name: id, tool });
    return bindings
      .prepare({
        id,
        account,
        cwd: ctx.cwd,
        launch: { command: process.execPath, args: [], env: {}, cliVersion: "2.1.300" },
      })
      .then((prepared) => ({ prepared, account }));
  };
  const other = await prepare("other", "claude");
  const { prepared, account } = await prepare("mine", "claude");
  const own = path.join(shared, "mine");
  assert.equal(
    prepared.env.AGENTPIER_NATIVE_BINDING_FILE,
    path.join(own, "mine.launch.json"),
  );
  assert.equal(bindings.file("mine"), path.join(own, "mine.launch.json"));
  for (const plugin of ["mine.claude", "mine.claude-activity", "mine.claude-stream"]) {
    assert.ok(fs.existsSync(path.join(own, plugin, "hooks/hooks.json")), plugin);
    assert.ok(prepared.args.includes(path.join(own, plugin)), plugin);
  }
  // Nothing of the launch is left directly in the shared folder.
  assert.deepEqual(fs.readdirSync(shared).sort(), ["mine", "other"]);
  assert.ok(writable(prepared.sandboxGrants, path.join(own, "mine.receipt.json")));
  for (const denied of [
    shared,
    path.join(shared, "other"),
    other.prepared.env.AGENTPIER_NATIVE_BINDING_FILE,
    path.join(shared, "other", "other.claude", "hooks/hooks.json"),
  ])
    assert.equal(covers(prepared.sandboxGrants, denied), false, denied);
  // The hooks write their receipt and activity through a temporary file beside them.
  recordNativeSession({ session_id: "native-mine", cwd: ctx.cwd }, prepared.env, {
    pid: process.pid,
  });
  recordNativeActivity({ state: "working", event: "UserPromptSubmit" }, prepared.env);
  assert.deepEqual(
    fs
      .readdirSync(own)
      .filter((name) => name.endsWith(".json"))
      .sort(),
    ["mine.activity.json", "mine.launch.json", "mine.receipt.json"],
  );
  const session = {
    id: "mine",
    tool: "claude",
    accountId: account.id,
    cwd: ctx.cwd,
    status: "running",
    nativeBinding: prepared.nativeBinding,
  };
  assert.equal(bindings.verifiedReceipt(session).providerSessionId, "native-mine");
  assert.equal(bindings.activity(session).state, "working");
  await bindings.discard("mine");
  assert.deepEqual(fs.readdirSync(shared), ["other"]);
});

test("a binding from before the own folder is read where it is and moves on reload", async (t) => {
  const ctx = setup(t);
  const bindings = new NativeSessionBinding({
    dataDir: ctx.dataDir,
    accounts: ctx.accounts,
  });
  const shared = path.join(ctx.dataDir, "native-sessions");
  const account = ctx.accounts.create({ name: "old", tool: "codex" });
  // What a release before this one wrote for a session that is still running.
  fs.mkdirSync(shared, { recursive: true });
  const flat = path.join(shared, "old.launch.json");
  fs.writeFileSync(
    flat,
    JSON.stringify({
      id: "old",
      accountId: account.id,
      tool: "codex",
      cwd: ctx.cwd,
      token: "t".repeat(48),
    }),
  );
  fs.mkdirSync(path.join(shared, "old.claude"));
  fs.writeFileSync(path.join(shared, "old.tui.json"), "{}");
  const env = {
    AGENTPIER_NATIVE_BINDING_FILE: flat,
    AGENTPIER_NATIVE_BINDING_TOKEN: "t".repeat(48),
  };
  const session = {
    id: "old",
    tool: "codex",
    accountId: account.id,
    cwd: ctx.cwd,
    status: "running",
    nativeBinding: { enabled: true, version: 1 },
  };
  assert.equal(bindings.file("old"), flat);
  assert.equal(sessionFolder(shared, "old"), shared);
  // Its hooks keep writing beside the launch file they were started with.
  recordNativeSession({ session_id: "native-old", cwd: ctx.cwd }, env, {
    pid: process.pid,
  });
  recordNativeActivity({ state: "idle", event: "turn/completed" }, env);
  assert.equal(bindings.verifiedReceipt(session).providerSessionId, "native-old");
  assert.equal(bindings.activity(session).state, "idle");
  await assert.rejects(
    bindings.prepare({
      id: "old",
      account,
      cwd: ctx.cwd,
      launch: { command: process.execPath, args: [], env: {} },
    }),
    { status: 409 },
  );
  // A reload starts the session again with a folder of its own and clears the old files.
  const prepared = await bindings.prepare({
    id: "old",
    account,
    cwd: ctx.cwd,
    replace: true,
    launch: { command: process.execPath, args: [], env: {} },
  });
  assert.equal(
    prepared.env.AGENTPIER_NATIVE_BINDING_FILE,
    path.join(shared, "old", "old.launch.json"),
  );
  assert.deepEqual(fs.readdirSync(shared), ["old"]);
  assert.equal(bindings.verifiedReceipt(session), null);
  assert.equal(covers(prepared.sandboxGrants, shared), false);
});

test("a launch file counts in the shared folder or in the session's own, nowhere else", () => {
  for (const file of [
    "/d/native-sessions/a.launch.json",
    "/d/native-sessions/a/a.launch.json",
  ])
    assert.equal(isLaunchFile(file, "native-sessions"), true, file);
  for (const file of [
    "/d/native-sessions/b/a.launch.json",
    "/d/other/a.launch.json",
    "/d/native-sessions/a/x/a.launch.json",
    "/d/native-sessions/a/a.receipt.json",
    "native-sessions/a.launch.json",
    null,
  ])
    assert.equal(isLaunchFile(file, "native-sessions"), false, String(file));
});

test("a request launch reads its own folder and no other session's token", async (t) => {
  const ctx = setup(t);
  const broker = new RequestBroker({
    dataDir: ctx.dataDir,
    sessions: { get: async () => null },
  });
  t.after(() => broker.close());
  const prepare = (id, tool) =>
    broker.prepare({
      id,
      account: { id: "account", tool },
      cwd: ctx.cwd,
      launch: { command: tool, args: [], env: {}, cliVersion: "2.1.300" },
    });
  await prepare("other", "claude");
  const prepared = await prepare("mine", "claude");
  const shared = broker.directory;
  const own = path.join(shared, "mine");
  assert.equal(prepared.env.AGENTPIER_REQUEST_FILE, path.join(own, "mine.launch.json"));
  assert.equal(broker.file("mine"), path.join(own, "mine.launch.json"));
  assert.equal(broker.sessionPath("mine", ".claude"), path.join(own, "mine.claude"));
  assert.ok(covers(prepared.sandboxGrants, prepared.env.AGENTPIER_REQUEST_FILE));
  assert.equal(
    writable(prepared.sandboxGrants, prepared.env.AGENTPIER_REQUEST_FILE),
    false,
  );
  for (const plugin of ["mine.claude", "mine.claude-bridge"]) {
    assert.ok(prepared.args.includes(path.join(own, plugin)), plugin);
    assert.ok(writable(prepared.sandboxGrants, path.join(own, plugin, "x")), plugin);
  }
  for (const denied of [
    shared,
    path.join(shared, "created.json"),
    path.join(shared, "other", "other.launch.json"),
    path.join(shared, "other", "other.claude", "hooks/hooks.json"),
  ])
    assert.equal(covers(prepared.sandboxGrants, denied), false, denied);
  const tui = await prepare("tui", "opencode");
  assert.equal(tui.env.OPENCODE_TUI_CONFIG, path.join(shared, "tui", "tui.tui.json"));
  assert.ok(writable(tui.sandboxGrants, tui.env.OPENCODE_TUI_CONFIG));
  await broker.discard("mine");
  assert.equal(fs.existsSync(own), false);
  assert.ok(fs.existsSync(path.join(shared, "other", "other.launch.json")));
});

test("a request launch from before the own folder keeps working and is replaced on reload", async (t) => {
  const ctx = setup(t);
  const shared = path.join(ctx.dataDir, "requests");
  // What a release before this one left for a running Claude Code session.
  fs.mkdirSync(path.join(shared, "old.claude", "hooks"), { recursive: true });
  const flat = path.join(shared, "old.launch.json");
  fs.writeFileSync(
    flat,
    JSON.stringify({
      id: "old",
      accountId: "account",
      tool: "claude",
      token: "t",
      cwd: ctx.cwd,
    }),
  );
  const broker = new RequestBroker({
    dataDir: ctx.dataDir,
    sessions: { get: async () => null },
  });
  t.after(() => broker.close());
  await broker.ready;
  assert.equal(broker.file("old"), flat);
  assert.equal(broker.sessionPath("old", ".claude"), path.join(shared, "old.claude"));
  // The start rewrote its hooks in place, with the dispatcher it was started with.
  const hooks = JSON.parse(
    fs.readFileSync(path.join(shared, "old.claude", "hooks/hooks.json"), "utf8"),
  );
  assert.match(
    hooks.hooks.PermissionRequest[0].hooks[0].command,
    new RegExp(`${path.join(shared, "claude-hook.sh")}'$`),
  );
  assert.ok(broker.claudeReloadRequired.has("old"));
  const launch = { command: "claude", args: [], env: {}, cliVersion: "2.1.300" };
  const input = {
    id: "old",
    account: { id: "account", tool: "claude" },
    cwd: ctx.cwd,
    launch,
  };
  await assert.rejects(broker.prepare(input), { code: "EEXIST" });
  await broker.discard("old");
  const prepared = await broker.prepare(input);
  assert.equal(
    prepared.env.AGENTPIER_REQUEST_FILE,
    path.join(shared, "old", "old.launch.json"),
  );
  assert.equal(fs.existsSync(flat), false);
  assert.equal(fs.existsSync(path.join(shared, "old.claude")), false);
  // A later start finds the launch in its own folder and leaves current hooks alone.
  assert.deepEqual(
    [...(await refreshClaudeRuntime(shared, broker.runtimeDirectory))],
    [],
  );
});

test("an AgentBus session is granted its own plugin folder, not the project's bus", async (t) => {
  const ctx = setup(t);
  const bus = new AgentBus({
    dataDir: ctx.dataDir,
    home: ctx.root,
    accounts: ctx.accounts,
    sessions: { list: async () => [], get: async () => null },
    classifyFolder: (folder) => ({ kind: "project", cwd: folder }),
  });
  await bus.ready;
  t.after(() => bus.close());
  const prepare = async (id, tool) => {
    const account = ctx.accounts.create({ name: id, tool });
    return bus.prepare({
      id,
      account,
      cwd: ctx.cwd,
      launch: { command: "cli", args: [], env: {} },
    });
  };
  const other = await prepare("other", "claude");
  const claude = await prepare("mine", "claude");
  const codex = await prepare("codex", "codex");
  const home = path.join(bus.root, "projects", claude.agentbus.projectId);
  const plugin = path.join(home, "adapters", "mine");
  assert.ok(claude.args.includes(plugin));
  assert.ok(covers(claude.sandboxGrants, path.join(plugin, "hooks/hooks.json")));
  for (const grants of [claude.sandboxGrants, codex.sandboxGrants, other.sandboxGrants])
    for (const denied of [
      home,
      path.join(home, "launches", "mine.json"),
      path.join(home, "launches", "other.json"),
      path.join(home, "peers"),
      path.join(home, "inbox"),
      path.join(home, "queue.sqlite"),
    ])
      assert.equal(covers(grants, denied), false, denied);
  assert.equal(covers(claude.sandboxGrants, path.join(home, "adapters", "other")), false);
  // Codex and OpenCode load no plugin folder: nothing of the bus folder is granted.
  assert.equal(covers(codex.sandboxGrants, path.join(home, "adapters", "codex")), false);
  // What the session's own bus programs need stays granted.
  for (const grants of [claude.sandboxGrants, codex.sandboxGrants]) {
    assert.ok(grants.some((grant) => grant.access === "socket"));
    assert.ok(grants.some((grant) => /capability\.json$/.test(grant.path)));
  }
});
