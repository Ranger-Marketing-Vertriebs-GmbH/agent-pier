import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { AgentBus } from "../../server/features/agentbus/agent-bus.js";
import {
  context,
  registerPeer,
  trustedPeers,
  toolsFor,
  trustedNudge,
} from "../../vendor/agentbus/agentpier/runtime.js";
import { enqueue } from "../../vendor/agentbus/core/inbox.js";
import { createMessage } from "../../vendor/agentbus/core/message.js";
import { openQueue } from "../../vendor/agentbus/core/queue.js";
import { writeJsonAtomic } from "../../vendor/agentbus/core/fsx.js";

import { unregister } from "../../vendor/agentbus/core/peers.js";
import OpenCodePlugin from "../../vendor/agentbus/agentpier/opencode.js";
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-bus-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const dataDir = path.join(root, "data");
  const accounts = new AccountStore({ dataDir, home });
  const rows = [];
  const sessions = { list: async () => rows };
  const bus = new AgentBus({ dataDir, home, accounts, sessions });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, cwd, dataDir, accounts, rows, bus };
}
async function prepare(ctx, id, tool, extra = {}) {
  const account = ctx.accounts.create({ name: id, tool, apiKey: "private-api-key" });
  const launch = {
    command: process.execPath,
    args: ["--existing"],
    env: ctx.accounts.environment(account.id),
  };
  const result = await ctx.bus.prepare({ id, account, cwd: ctx.cwd, launch, ...extra });
  ctx.rows.push({
    id,
    name: id,
    tool,
    cwd: ctx.cwd,
    accountId: account.id,
    status: "running",
    agentbus: result.agentbus,
  });
  return result;
}
test("session-only launch adapters preserve options, profile files and project scope across accounts", async (t) => {
  const ctx = setup(t);
  const codex = await prepare(ctx, "one", "codex");
  const claude = await prepare(ctx, "two", "claude");
  const opencode = await prepare(ctx, "three", "opencode");
  assert.equal(codex.env.AGENTBUS_HOME, claude.env.AGENTBUS_HOME);
  assert.equal(claude.env.AGENTBUS_HOME, opencode.env.AGENTBUS_HOME);
  assert.notEqual(
    codex.env.AGENTPIER_AGENTBUS_SESSION,
    claude.env.AGENTPIER_AGENTBUS_SESSION,
  );
  assert.ok(codex.args.includes("--existing"));
  assert.ok(codex.args.some((arg) => arg.startsWith("mcp_servers.agentpier_agentbus=")));
  assert.ok(codex.args.some((arg) => arg.startsWith("hooks.SessionStart=")));
  assert.ok(!codex.args.some((arg) => arg.includes("bypass-hook-trust")));
  assert.ok(claude.args.includes("--plugin-dir"));
  assert.equal(opencode.args[0], "--existing");
  assert.match(JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT).plugin[0], /^file:/);
  assert.equal(
    fs.readFileSync(path.join(codex.env.CODEX_HOME, "config.toml"), "utf8"),
    'cli_auth_credentials_store = "file"\n',
  );
  assert.equal(
    fs.existsSync(path.join(claude.env.CLAUDE_CONFIG_DIR, "settings.json")),
    false,
  );
  const catalog = await ctx.bus.list();
  assert.equal(catalog.projects.length, 1);
  assert.equal(catalog.projects[0].sessions.length, 3);
  assert.equal(JSON.stringify(catalog).includes("private-api-key"), false);
});

test("pending overview is read-only; explicit inbox claims each message once and excludes foreign peers", async (t) => {
  const ctx = setup(t);
  const a = context((await prepare(ctx, "sender", "claude")).env);
  const b = context((await prepare(ctx, "receiver", "codex")).env);
  const sender = registerPeer(a, "claude-native", { pid: process.pid });
  const receiver = registerPeer(b, "codex-native", { pid: process.pid });
  writeJsonAtomic(path.join(a.h, "peers", "foreign.json"), {
    ...sender,
    key: "claude-foreign",
    sessionId: "foreign",
    agentpierSessionId: "missing",
  });
  const listing = await toolsFor(a)
    .find((tool) => tool.name === "peers_list")
    .run({});
  assert.match(listing, /codex/);
  assert.doesNotMatch(listing, /foreign/);
  const message = createMessage({
    from: sender,
    to: receiver.key,
    toName: receiver.name,
    text: "Fixture private message",
  });
  enqueue(a.h, receiver.key, message);
  const first = await ctx.bus.list();
  const second = await ctx.bus.list();
  assert.equal(
    first.projects[0].sessions.find((row) => row.id === "receiver").pending,
    1,
  );
  assert.equal(
    second.projects[0].sessions.find((row) => row.id === "receiver").pending,
    1,
  );
  assert.equal(JSON.stringify(first).includes("Fixture private message"), false);
  const reader = toolsFor(b).find((tool) => tool.name === "inbox_read");
  const read = await Promise.all([reader.run({}), reader.run({})]);
  assert.equal(read.filter((text) => text.includes("Fixture private message")).length, 1);
  const queue = openQueue(a.h);
  assert.equal(queue.rows({ status: "acked" }).length, 1);
  queue.close();
});
test("Codex wake uses the registered target binary and profile, and a failed wake keeps queued data", async (t) => {
  const ctx = setup(t);
  const a = context((await prepare(ctx, "sender", "claude")).env);
  const b = context((await prepare(ctx, "target", "codex")).env);
  registerPeer(a, "sender-native", { pid: process.pid });
  const target = registerPeer(b, "target-native", { pid: process.pid });
  let call;
  assert.equal(
    await trustedNudge(
      a.h,
      { ...target, nudge: { command: "/evil", codexHome: "/wrong" } },
      "fixture wake",
      "sender",
      {
        exec: async (...args) => {
          call = args;
        },
      },
    ),
    true,
  );
  assert.equal(call[0], process.execPath);
  assert.equal(call[2].env.CODEX_HOME, b.launch.codexHome);
  assert.deepEqual(call[1], [
    "queue",
    "--thread",
    "target-native",
    "--message",
    "fixture wake",
  ]);
  const sent = await toolsFor(a, {
    exec: async () => {
      throw new Error("fake wake unavailable");
    },
  })
    .find((tool) => tool.name === "peer_send")
    .run({ to: target.key, text: "Keep this queued" });
  assert.match(sent, /Anstoß nicht möglich/);
  const queue = openQueue(a.h);
  assert.equal(queue.summary(target.key).count, 1);
  queue.close();
});
test("OpenCode resolves every concurrent tool call by exact native session without a shared active slot", async (t) => {
  const ctx = setup(t);
  const c = context((await prepare(ctx, "oc", "opencode")).env);
  const first = registerPeer(c, "ses_first", { pid: process.pid });
  const tools = toolsFor(c);
  const inbox = tools.find((tool) => tool.name === "inbox_read");
  assert.match(await inbox.run({ __agentpierSession: "ses_first" }), /Keine neuen/);
  const second = registerPeer(c, "ses_second", { pid: process.pid });
  enqueue(
    c.h,
    first.key,
    createMessage({
      from: second,
      to: first.key,
      toName: first.name,
      text: "Only first",
    }),
  );
  enqueue(
    c.h,
    second.key,
    createMessage({
      from: first,
      to: second.key,
      toName: second.name,
      text: "Only second",
    }),
  );
  const [one, two] = await Promise.all([
    inbox.run({ __agentpierSession: "ses_first" }),
    inbox.run({ __agentpierSession: "ses_second" }),
  ]);
  assert.match(one, /Only first/);
  assert.doesNotMatch(one, /Only second/);
  assert.match(two, /Only second/);
  assert.doesNotMatch(two, /Only first/);
  await assert.rejects(inbox.run({}), /exact OpenCode/);
  await assert.rejects(inbox.run({ __agentpierSession: "../escape" }), /not registered/);
});
test("MCP stdin transport exposes tools and uses registered launch identity without model calls", async (t) => {
  const ctx = setup(t);
  const launch = await prepare(ctx, "stdio", "claude");
  const c = context(launch.env);
  registerPeer(c, "native-stdio", { pid: process.pid });
  const child = spawn(
    process.execPath,
    [path.resolve("vendor/agentbus/agentpier/mcp.js")],
    { env: launch.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => child.kill());
  let output = "",
    error = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    error += chunk;
  });
  const ended = new Promise((resolve) => child.on("close", resolve));
  child.stdin.end(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "inbox_read", arguments: {} },
      },
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  assert.equal(await ended, 0, error);
  const replies = output.trim().split("\n").map(JSON.parse);
  assert.equal(replies.find((row) => row.id === 2).result.tools.length, 3);
  assert.match(replies.find((row) => row.id === 3).result.content[0].text, /Keine neuen/);
});
test("launch registry and bus storage refuse traversal and symlinks; stale PIDs do not register as live", async (t) => {
  const ctx = setup(t);
  const c = context((await prepare(ctx, "safe", "codex")).env);
  const peer = registerPeer(c, "native", { pid: process.pid });
  writeJsonAtomic(path.join(c.h, "peers", `${peer.key}.json`), {
    ...peer,
    pidStart: "stale-start",
  });
  assert.equal(trustedPeers(c.h)[0].alive, false);
  const inbox = path.join(c.h, "inbox");
  const outside = path.join(ctx.root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, inbox);
  assert.throws(
    () =>
      enqueue(
        c.h,
        peer.key,
        createMessage({ from: peer, to: peer.key, toName: peer.name, text: "no write" }),
      ),
    /symlinked/,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});
test("message history paginates pending and read messages without claiming, even after a peer stops", async (t) => {
  const ctx = setup(t);
  const a = context((await prepare(ctx, "history-a", "claude")).env);
  const b = context((await prepare(ctx, "history-b", "codex")).env);
  const sender = registerPeer(a, "native-a", { pid: process.pid });
  const recipient = registerPeer(b, "native-b", { pid: process.pid });
  for (let index = 0; index < 25; index++)
    enqueue(
      a.h,
      recipient.key,
      createMessage(
        {
          from: sender,
          to: recipient.key,
          toName: recipient.name,
          text: `history ${index}`,
        },
        Date.now() + index,
      ),
    );
  const queue = openQueue(a.h);
  const before = queue.rows({ recipient: recipient.key, status: "pending" }).length;
  const first = await ctx.bus.messages(a.launch.projectId, { page: 1 });
  assert.equal(first.total, 25);
  assert.equal(first.items.length, 20);
  assert.equal(first.items[0].text, "history 24");
  assert.equal(first.items[0].status, "pending");
  const second = await ctx.bus.messages(a.launch.projectId, { page: 2 });
  assert.equal(second.items.length, 5);
  assert.equal(
    queue.rows({ recipient: recipient.key, status: "pending" }).length,
    before,
  );
  await toolsFor(b)
    .find((tool) => tool.name === "inbox_read")
    .run({});
  ctx.rows.find((row) => row.id === "history-b").status = "stopped";
  const read = await ctx.bus.messages(a.launch.projectId, {});
  assert.equal(read.items[0].status, "read");
  assert.equal(read.items[0].from.tool, "claude");
  assert.equal(read.items[0].to.tool, "codex");
  unregister(a.h, sender.key);
  unregister(a.h, recipient.key);
  const ended = await ctx.bus.messages(a.launch.projectId, {});
  assert.equal(ended.total, 25);
  assert.equal(ended.items[0].status, "read");
  queue.close();
  await assert.rejects(ctx.bus.messages("../escape", {}));
  await assert.rejects(ctx.bus.messages(a.launch.projectId, { page: 0 }));
  await assert.rejects(ctx.bus.messages(a.launch.projectId, { page: 1.5 }));
});
test("Claude wake uses the target profile registry socket and keeps its authentication token private", async (t) => {
  const ctx = setup(t);
  const c = context((await prepare(ctx, "claude-wake", "claude")).env);
  const peer = registerPeer(c, "native-claude", { pid: process.pid });
  const socketDir = fs.mkdtempSync("/tmp/agentpier-bus-wake-");
  const socketPath = path.join(socketDir, "wake.sock");
  fs.mkdirSync(c.launch.claudeSessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(c.launch.claudeSessionsDir, "fixture.json"),
    JSON.stringify({
      sessionId: "native-claude",
      pid: process.pid,
      messagingSocketPath: socketPath,
    }),
  );
  fs.writeFileSync(
    path.join(c.launch.claudeSessionsDir, `${process.pid}.fixture.key`),
    JSON.stringify({ peerToken: "private-fixture-token" }),
  );
  let text = "";
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      text += chunk;
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(socketDir, { recursive: true, force: true });
  });
  assert.equal(await trustedNudge(c.h, peer, "fixture notice", "fixture"), true);
  assert.match(text, /private-fixture-token/);
  assert.match(text, /fixture notice/);
  assert.equal(
    JSON.stringify(await ctx.bus.list()).includes("private-fixture-token"),
    false,
  );
});
test("OpenCode hook attaches exact per-call identity and never redirects a deleted socket target", async (t) => {
  const ctx = setup(t);
  const launch = await prepare(ctx, "plugin", "opencode");
  context(launch.env);
  const old = {};
  for (const key of [
    "AGENTBUS_HOME",
    "AGENTPIER_AGENTBUS_SESSION",
    "AGENTBUS_SOCKET_DIR",
  ]) {
    old[key] = process.env[key];
    process.env[key] = launch.env[key];
  }
  const prompts = [];
  let hooks;
  try {
    hooks = await OpenCodePlugin({
      directory: ctx.cwd,
      client: {
        session: {
          promptAsync: async (value) => {
            prompts.push(value);
          },
          get: async () => ({ data: null }),
        },
      },
    });
  } finally {
    for (const [key, value] of Object.entries(old))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
  t.after(async () => {
    await hooks.dispose();
    fs.rmSync(launch.env.AGENTBUS_SOCKET_DIR, { recursive: true, force: true });
  });
  await hooks.event({
    event: { type: "session.created", properties: { info: { id: "ses_one" } } },
  });
  await hooks.event({
    event: { type: "session.created", properties: { info: { id: "ses_two" } } },
  });
  const output = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_one" }, output);
  assert.match(output.system.join("\n"), /nur nach einem Nachrichtenhinweis/);
  assert.match(output.system.join("\n"), /nicht periodisch/);
  assert.doesNotMatch(output.system.join("\n"), /neue Nachricht\(en\)/);
  const one = { args: { __agentpierSession: "ses_two" } },
    two = { args: {} };
  const nativeArgs = one.args;
  await Promise.all([
    hooks["tool.execute.before"](
      { tool: "agentpier_agentbus_inbox_read", sessionID: "ses_one" },
      one,
    ),
    hooks["tool.execute.before"](
      { tool: "agentpier_agentbus_inbox_read", sessionID: "ses_two" },
      two,
    ),
  ]);
  assert.equal(nativeArgs.__agentpierSession, "ses_one");
  assert.equal(one.args, nativeArgs);
  assert.equal(two.args.__agentpierSession, "ses_two");
  await hooks.event({
    event: { type: "session.deleted", properties: { sessionID: "ses_one" } },
  });
  const sock = net.createConnection(
    path.join(launch.env.AGENTBUS_SOCKET_DIR, `${process.pid}.sock`),
  );
  await new Promise((resolve, reject) => {
    sock.on("error", reject);
    sock.on("connect", () => {
      sock.end(JSON.stringify({ v: 1, session: "ses_one", text: "fake wake" }) + "\n");
    });
    sock.on("close", resolve);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(prompts, []);
});

for (const tool of ["codex", "claude"]) {
  test(`${tool} hooks request inbox reads only for pending messages or explicit requests`, async (t) => {
    const ctx = setup(t);
    const launch = await prepare(ctx, `guidance-${tool}`, tool);
    const busContext = context(launch.env);
    const runHook = (event) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["vendor/agentbus/agentpier/hook.js", event],
          {
            env: { PATH: process.env.PATH, ...launch.env },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (part) => {
          stdout += part;
        });
        child.stderr.on("data", (part) => {
          stderr += part;
        });
        child.on("error", reject);
        child.on("close", (code) => {
          // Node 22 reports an experimental SQLite warning even on success.
          // The hook catches its own errors and reports them with this prefix.
          if (code !== 0 || /^agentbus:/m.test(stderr))
            reject(new Error(`Hook failed: ${code} ${stderr}`));
          else resolve(stdout);
        });
        child.stdin.end(JSON.stringify({ session_id: "guidance-native" }));
      });
    const intro = JSON.parse(await runHook("SessionStart")).hookSpecificOutput
      .additionalContext;
    assert.match(intro, /nur nach einem Nachrichtenhinweis/);
    assert.match(intro, /nicht periodisch/);
    assert.doesNotMatch(intro, /Prüfe inbox_read vor/);
    assert.equal(await runHook("UserPromptSubmit"), "");
    const peer = trustedPeers(busContext.h)[0];
    enqueue(
      busContext.h,
      peer.key,
      createMessage({
        from: peer,
        to: peer.key,
        toName: peer.name,
        text: "Synthetic pending message",
      }),
    );
    assert.match(await runHook("UserPromptSubmit"), /1 neue Nachricht/);
    const reader = toolsFor(busContext).find((item) => item.name === "inbox_read");
    assert.match(reader.description, /nicht periodisch/);
    assert.match(await reader.run({}), /Synthetic pending message/);
    assert.equal(await runHook("UserPromptSubmit"), "");
    fs.unlinkSync(path.join(busContext.h, "launches", `guidance-${tool}.json`));
    await assert.rejects(runHook("UserPromptSubmit"), /Hook failed: 0.*agentbus:/s);
  });
}
test("disabled and login launches do not create bus state; canonical project directories isolate buses", async (t) => {
  const ctx = setup(t);
  const disabled = await prepare(ctx, "off", "codex", { enabled: false });
  assert.equal(disabled.agentbus.enabled, false);
  assert.equal(disabled.env.AGENTBUS_HOME, undefined);
  assert.equal(fs.existsSync(path.join(ctx.dataDir, "agentbus")), false);
  const login = await prepare(ctx, "login", "claude", { purpose: "login" });
  assert.equal(login.env.AGENTBUS_HOME, undefined);
  const one = await prepare(ctx, "first", "codex");
  const alias = path.join(ctx.root, "alias");
  fs.symlinkSync(ctx.cwd, alias);
  const account = ctx.accounts.get(ctx.rows.at(-1).accountId);
  const same = await ctx.bus.prepare({
    id: "alias",
    account,
    cwd: alias,
    launch: {
      command: process.execPath,
      args: [],
      env: ctx.accounts.environment(account.id),
    },
  });
  assert.equal(one.agentbus.projectId, same.agentbus.projectId);
  fs.mkdirSync(path.join(ctx.root, "other"));
  const different = await ctx.bus.prepare({
    id: "other",
    account,
    cwd: path.join(ctx.root, "other"),
    launch: {
      command: process.execPath,
      args: [],
      env: ctx.accounts.environment(account.id),
    },
  });
  assert.notEqual(one.agentbus.projectId, different.agentbus.projectId);
  await assert.rejects(
    ctx.bus.prepare({ id: "../escape", account, cwd: ctx.cwd, launch: {} }),
  );
});
