import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import {
  NativeSessionBinding,
  recordNativeSession,
} from "../../server/features/sessions/native-session-binding.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { ChatStore } from "../../server/features/chat/chat-store.js";
function setup(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-binding-")),
  );
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const accounts = new AccountStore({ dataDir: path.join(root, "data"), home: root });
  const bindings = new NativeSessionBinding({ dataDir: accounts.dataDir, accounts });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cwd, accounts, bindings };
}
async function launch(ctx, id, tool, options = {}) {
  const account = ctx.accounts.create({ name: id, tool });
  const prepared = await ctx.bindings.prepare({
    id,
    account,
    cwd: ctx.cwd,
    launch: {
      command: process.execPath,
      args: [],
      env: ctx.accounts.environment(account.id),
      ...options,
    },
  });
  return {
    prepared,
    session: {
      id,
      tool,
      accountId: account.id,
      cwd: ctx.cwd,
      status: "running",
      nativeBinding: prepared.nativeBinding,
    },
  };
}
test("binding adapters are session-only, merge existing Codex hooks and remain independent of AgentBus", async (t) => {
  const ctx = setup(t);
  const args = [
    "--yolo",
    "-c",
    'hooks.SessionStart=[{hooks=[{type="command",command="existing hook"}]}]',
  ];
  const { prepared } = await launch(ctx, "codex-one", "codex", { args });
  assert.equal(prepared.nativeBinding.enabled, true);
  assert.equal(prepared.env.AGENTBUS_HOME, undefined);
  assert.equal(prepared.args[0], "--yolo");
  const hook = prepared.args.find((value) => value.startsWith("hooks.SessionStart="));
  assert.equal(parse(hook).hooks.SessionStart.length, 2);
  assert.match(hook, /existing hook/);
  assert.ok(!prepared.args.some((value) => value.includes("bypass-hook-trust")));
  const oc = await launch(ctx, "opencode-one", "opencode");
  assert.ok(oc.prepared.env.OPENCODE_TUI_CONFIG);
  assert.match(
    JSON.parse(fs.readFileSync(oc.prepared.env.OPENCODE_TUI_CONFIG)).plugin[0],
    /^file:/,
  );
});
test("concurrent sessions in the same cwd bind only their exact receipt and survive server restart", async (t) => {
  const ctx = setup(t);
  const first = await launch(ctx, "first", "codex");
  const second = await launch(ctx, "second", "codex");
  recordNativeSession({ session_id: "native-first", cwd: ctx.cwd }, first.prepared.env, {
    pid: process.pid,
  });
  recordNativeSession(
    { session_id: "native-second", cwd: ctx.cwd },
    second.prepared.env,
    { pid: process.pid },
  );
  assert.equal((await ctx.bindings.resolve(first.session)).id, "native-first");
  assert.equal((await ctx.bindings.resolve(second.session)).id, "native-second");
  const restarted = new NativeSessionBinding({
    dataDir: ctx.accounts.dataDir,
    accounts: ctx.accounts,
  });
  assert.equal((await restarted.resolve(first.session)).id, "native-first");
  assert.equal(
    await restarted.resolve({ ...first.session, accountId: second.session.accountId }),
    null,
  );
  assert.equal(await restarted.resolve({ ...first.session, cwd: ctx.root }), null);
});
for (const tool of ["codex", "claude"])
  test(`${tool} reader follows native clear/resume identity without listing candidates`, async (t) => {
    const ctx = setup(t);
    const { prepared, session } = await launch(ctx, "chat-native", tool);
    let reads = 0;
    const history = {
      list: async () => {
        throw Error("must not guess");
      },
      read: async (_session, id) => {
        reads++;
        return { messages: [{ id: "one", role: "assistant", text: id }], tasks: [] };
      },
    };
    const store = new ChatStore({
      dataDir: ctx.accounts.dataDir,
      sessions: { get: async () => session },
      history,
      bindings: ctx.bindings,
    });
    assert.equal((await store.read(session.id)).availability, "waiting");
    recordNativeSession({ session_id: "exact-native", cwd: ctx.cwd }, prepared.env, {
      pid: process.pid,
    });
    assert.equal((await store.read(session.id)).providerSessionId, "exact-native");
    assert.equal(reads, 1);
    recordNativeSession({ session_id: "next-native", cwd: ctx.cwd }, prepared.env, {
      pid: process.pid,
    });
    assert.equal((await store.read(session.id)).providerSessionId, "next-native");
    assert.equal(reads, 2);
  });
test("receipt integrity rejects wrong tokens, cwd, traversal, symlinks and a competing live process", async (t) => {
  const ctx = setup(t);
  const { prepared, session } = await launch(ctx, "safe", "codex");
  assert.throws(() =>
    recordNativeSession({ session_id: "../escape", cwd: ctx.cwd }, prepared.env, {
      pid: process.pid,
    }),
  );
  assert.throws(() =>
    recordNativeSession({ session_id: "native", cwd: ctx.root }, prepared.env, {
      pid: process.pid,
    }),
  );
  assert.throws(() =>
    recordNativeSession(
      { session_id: "native", cwd: ctx.cwd },
      { ...prepared.env, AGENTPIER_NATIVE_BINDING_TOKEN: "wrong" },
      { pid: process.pid },
    ),
  );
  recordNativeSession({ session_id: "native", cwd: ctx.cwd }, prepared.env, {
    pid: process.pid,
  });
  assert.throws(
    () =>
      recordNativeSession({ session_id: "other", cwd: ctx.cwd }, prepared.env, {
        pid: process.ppid,
      }),
    /different|anderer|nested/,
  );
  const receipt = prepared.env.AGENTPIER_NATIVE_BINDING_FILE.replace(
    ".launch.json",
    ".receipt.json",
  );
  fs.unlinkSync(receipt);
  const outside = path.join(ctx.root, "outside");
  fs.writeFileSync(outside, "{}");
  fs.symlinkSync(outside, receipt);
  assert.equal(await ctx.bindings.resolve(session), null);
  assert.throws(() =>
    recordNativeSession({ session_id: "native", cwd: ctx.cwd }, prepared.env, {
      pid: process.pid,
    }),
  );
  assert.equal(fs.readFileSync(outside, "utf8"), "{}");
});

test("runtime Codex binding uses only the exact child with its own writer lock and rollout, including npm launchers", async (t) => {
  const { resolveCodexProcess } =
    await import("../../server/features/sessions/native-session-process.js");
  const { ProviderHistory } =
    await import("../../server/features/chat/provider-history.js");
  const ctx = setup(t);
  const { session, prepared } = await launch(ctx, "runtime", "codex");
  const env = ctx.accounts.environment(session.accountId);
  const root = env.CODEX_HOME;
  fs.mkdirSync(path.join(root, "thread-writer-locks"), { recursive: true });
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const lock = path.join(root, "thread-writer-locks/native-exact.lock");
  fs.writeFileSync(lock, "");
  const rollout = path.join(root, "sessions/rollout.jsonl");
  fs.writeFileSync(
    rollout,
    JSON.stringify({
      type: "session_meta",
      payload: { id: "native-exact", cwd: ctx.cwd },
    }) + "\n",
  );
  const pkg = path.join(ctx.root, "node_modules/@openai/codex");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "@openai/codex" }),
  );
  const executable = path.join(pkg, "bin/codex.js");
  fs.writeFileSync(executable, "// fixture");
  const triple = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
  const native = path.join(pkg, "vendor", triple, "bin/codex");
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(native, "");
  let files = [lock, rollout];
  let stamp = "first";
  const probe = {
    children: async (pid) => (pid === 101 ? [102] : []),
    executable: async (pid) => (pid === 102 ? native : process.execPath),
    files: async () => files,
    start: async () => stamp,
  };
  const history = new ProviderHistory({ accounts: ctx.accounts, home: ctx.root });
  t.after(() => history.close());
  const options = {
    accounts: ctx.accounts,
    history,
    executable,
    probe,
    sessions: { target: (id) => "=" + id, tmux: async () => "101" },
  };
  assert.equal((await resolveCodexProcess(session, options))?.id, "native-exact");
  const childRollout = path.join(root, "sessions/child.jsonl");
  const childLock = path.join(root, "thread-writer-locks/child.lock");
  fs.writeFileSync(childLock, "");
  fs.writeFileSync(
    childRollout,
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: "child",
        cwd: ctx.cwd,
        source: { subagent: { thread_spawn: { parent_thread_id: "native-exact" } } },
      },
    }) + "\n",
  );
  files = [lock, rollout, childLock, childRollout];
  assert.equal((await resolveCodexProcess(session, options))?.id, "native-exact");
  files = [rollout];
  assert.equal(await resolveCodexProcess(session, options), null);
  files = [lock, rollout];
  assert.equal(await resolveCodexProcess({ ...session, cwd: ctx.root }, options), null);
  const bindings = new NativeSessionBinding({
    dataDir: ctx.accounts.dataDir,
    accounts: ctx.accounts,
    sessions: options.sessions,
    history,
    processOptions: { executable, probe },
  });
  const legacy = { ...session, nativeBinding: undefined };
  const fakeHistory = {
    read: async (_session, id) => ({
      messages: [{ id: "one", role: "assistant", text: id }],
      tasks: [],
    }),
  };
  const chat = new ChatStore({
    dataDir: ctx.accounts.dataDir,
    sessions: { get: async () => legacy },
    history: fakeHistory,
    bindings,
  });
  chat.initialize(legacy, "old-manual");
  assert.equal((await chat.read(legacy.id)).providerSessionId, "native-exact");
  assert.equal(await bindings.resolve({ ...legacy, cwd: ctx.root }), null);
  assert.equal(await bindings.resolve({ ...legacy, status: "stopped" }), null);
  recordNativeSession({ session_id: "old-receipt", cwd: ctx.cwd }, prepared.env, {
    pid: process.pid,
  });
  const upgraded = path.join(ctx.root, "new-codex");
  fs.writeFileSync(upgraded, "");
  const afterUpgrade = new NativeSessionBinding({
    dataDir: ctx.accounts.dataDir,
    accounts: ctx.accounts,
    sessions: options.sessions,
    history,
    processOptions: {
      executable: upgraded,
      probe: {
        ...probe,
        children: async (pid) =>
          ({ 101: [103], 103: [104], 104: [105], 105: [process.pid] })[pid] || [],
        executable: async (pid) => (pid === process.pid ? native : process.execPath),
      },
    },
  });
  files = [lock, rollout, childLock, childRollout];
  assert.equal(
    (await afterUpgrade.resolve(session, { forInput: true }))?.id,
    "native-exact",
  );
  files = [];
  // A live receipt can outlast /clear; writes must not use its old thread or a cached result.
  assert.equal(await afterUpgrade.resolve(session, { forInput: true }), null);
  files = [lock, rollout];
  let verifiedChecks = 0;
  assert.equal(
    await resolveCodexProcess(session, {
      ...options,
      verifyRuntime: (pid) => pid === 102 && ++verifiedChecks === 1,
    }),
    null,
  );
  probe.start = async () => {
    const before = stamp;
    stamp = "reused";
    return before;
  };
  assert.equal(await resolveCodexProcess(session, options), null);
});
test("process probes read macOS metadata and Linux proc files without native input", async (t) => {
  const { processProbe } =
    await import("../../server/features/sessions/native-session-process.js");
  const ctx = setup(t);
  const calls = [];
  const mac = processProbe({
    platform: "darwin",
    run: async (command, args) => {
      calls.push([command, args]);
      return {
        stdout: command.endsWith("pgrep")
          ? "102\n"
          : command.endsWith("lsof")
            ? "p102\nn/a/rollout.jsonl\n"
            : "/a/codex\n",
      };
    },
  });
  assert.deepEqual(await mac.children(101), [102]);
  assert.equal(await mac.executable(102), "/a/codex");
  assert.deepEqual(await mac.files(102), ["/a/rollout.jsonl"]);
  assert.ok(calls.every(([cmd]) => path.isAbsolute(cmd)));
  const procRoot = path.join(ctx.root, "proc");
  fs.mkdirSync(path.join(procRoot, "101/task/101"), { recursive: true });
  fs.mkdirSync(path.join(procRoot, "102/fd"), { recursive: true });
  fs.writeFileSync(path.join(procRoot, "101/task/101/children"), "102 ");
  fs.symlinkSync(process.execPath, path.join(procRoot, "102/exe"));
  fs.symlinkSync("/a/rollout.jsonl", path.join(procRoot, "102/fd/3"));
  const linux = processProbe({ platform: "linux", procRoot });
  assert.deepEqual(await linux.children(101), [102]);
  assert.equal(await linux.executable(102), process.execPath);
  assert.deepEqual(await linux.files(102), ["/a/rollout.jsonl"]);
});
test("OpenCode default TUI loader follows the displayed session and stops on disposal; Shell skips reader APIs", async (t) => {
  const ctx = setup(t);
  const { prepared, session } = await launch(ctx, "route", "opencode");
  const config = JSON.parse(fs.readFileSync(prepared.env.OPENCODE_TUI_CONFIG, "utf8"));
  const module = await import(config.plugin[0]);
  const plugin = module.default;
  assert.equal(plugin?.id, "agentpier-reader");
  assert.equal(plugin?.tui, module.tui);
  const saved = { ...process.env };
  Object.assign(process.env, prepared.env);
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  let current = { name: "session", params: { sessionID: "ses_first" } };
  let dispose;
  await plugin.tui({
    route: {
      get current() {
        return current;
      },
    },
    lifecycle: { onDispose: (fn) => (dispose = fn) },
  });
  t.after(() => dispose());
  assert.equal((await ctx.bindings.resolve(session)).id, "ses_first");
  current = { name: "session", params: { sessionID: "ses_second" } };
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await ctx.bindings.resolve(session)).id, "ses_second");
  current = { name: "home" };
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await ctx.bindings.resolve(session)).id, null);
  dispose();
  const shell = { ...session, tool: "shell" };
  const chat = new ChatStore({
    dataDir: ctx.accounts.dataDir,
    sessions: { get: async () => shell },
    history: {
      list: () => {
        throw Error("must not list");
      },
    },
    bindings: ctx.bindings,
  });
  assert.equal((await chat.read(shell.id)).availability, "unsupported");
  await assert.rejects(chat.choices(shell.id), { status: 409 });
  await assert.rejects(chat.bind(shell.id, "native"), { status: 409 });
  assert.equal(
    (await ctx.bindings.prepare({ account: { tool: "shell" }, launch: { args: [] } }))
      .nativeBinding.enabled,
    false,
  );
});
