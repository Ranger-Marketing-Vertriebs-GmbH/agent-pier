import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { NativeRequestChannel } from "../../server/features/requests/native-channel.js";
import { openCodeCommands } from "../../server/features/requests/opencode-plugin.js";
import { send } from "../../server/features/requests/wire.js";
import { openCodeTaskDriver } from "../../server/features/chat/opencode-task-driver.js";
import { TaskControl } from "../../server/features/chat/task-control.js";

// Server-originated commands on the native request channel (OpenCode now, Codex next).
async function fixture(t, ids = ["fixture"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-commands-"));
  const sessions = new Map(
    ids.map((id) => [
      id,
      {
        id,
        tool: "opencode",
        accountId: "account",
        status: "running",
        nativeRequests: { enabled: true },
      },
    ]),
  );
  const broker = new RequestBroker({
    dataDir: root,
    sessions: { get: async (id) => sessions.get(id) },
  });
  const changes = [];
  broker.commands.onChange = (id) => changes.push(id);
  const launches = {};
  for (const id of ids)
    launches[id] = await broker.prepare({
      id,
      account: { id: "account", tool: "opencode" },
      cwd: root,
      launch: { command: "/fixture/cli", args: [], env: {} },
    });
  const channels = [];
  const open = async (id = ids[0], options = { commands: true }) => {
    const channel = new NativeRequestChannel({ env: launches[id].env, ...options });
    channels.push(channel);
    await channel.ready;
    await until(() => !options.commands || broker.commands.connected(id));
    return channel;
  };
  t.after(async () => {
    for (const channel of channels) channel.close();
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { broker, open, sessions, changes };
}
async function until(predicate) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) throw Error("Timed out");
    await delay(5);
  }
}
/** The command lines the server wrote to `channel`. */
function sniff(channel) {
  const seen = [];
  channel.socket.on("data", (chunk) => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      const value = JSON.parse(line);
      if (value.type === "command") seen.push(value);
    }
  });
  return seen;
}

test("a command reaches the session's channel and its result comes back", async (t) => {
  const { broker, open, changes } = await fixture(t);
  const channel = await open();
  assert.deepEqual(changes, ["fixture"]);
  channel.onCommand = async (name, params) => ({ name, params });
  assert.deepEqual(
    await broker.commands.send("fixture", { name: "x", params: { a: 1 } }),
    { ok: true, data: { name: "x", params: { a: 1 } } },
  );
  channel.onCommand = async () => {
    throw Error("nope");
  };
  assert.deepEqual(await broker.commands.send("fixture", { name: "x", params: {} }), {
    ok: false,
    reason: "nope",
  });
  channel.onCommand = () => new Promise(() => {});
  const pending = broker.commands.send("fixture", { name: "x", params: {} });
  await delay(20);
  channel.socket.destroy(); // CLI restarted mid-stop
  await assert.rejects(pending, { code: "TASK_STOP_CHANNEL_DOWN" });
  await until(() => changes.length === 2);
});

test("a channel without commands is not connected and a send is refused", async (t) => {
  const { broker, open } = await fixture(t);
  await open("fixture", {});
  assert.equal(broker.commands.connected("fixture"), false);
  await assert.rejects(broker.commands.send("fixture", { name: "x", params: {} }), {
    code: "TASK_STOP_CHANNEL_DOWN",
  });
  assert.equal(broker.commands.connected("unknown"), false);
});

test("a repeated command id runs once and answers from the result cache", async (t) => {
  const { broker, open } = await fixture(t);
  const channel = await open();
  let calls = 0;
  channel.onCommand = async () => ({ calls: ++calls });
  const server = [...broker.clients].find((socket) => socket.owner?.id === "fixture");
  const results = [];
  server.on("data", (chunk) => {
    for (const line of String(chunk).split("\n").filter(Boolean))
      if (JSON.parse(line).type === "command-result") results.push(JSON.parse(line));
  });
  const command = { type: "command", id: "c-1", name: "x", params: {} };
  send(server, command);
  send(server, command);
  await until(() => results.length === 2);
  assert.equal(calls, 1);
  assert.deepEqual(results, [
    { type: "command-result", id: "c-1", ok: true, data: { calls: 1 } },
    { type: "command-result", id: "c-1", ok: true, data: { calls: 1 } },
  ]);
});

test("only a result for the id the server generated settles a command", async (t) => {
  const { broker, open } = await fixture(t);
  const channel = await open();
  const seen = sniff(channel);
  let release;
  const received = [];
  channel.onCommand = (name, params) => {
    received.push([name, params]);
    return new Promise((resolve) => (release = resolve));
  };
  let settled = false;
  const pending = broker.commands
    .send("fixture", { id: "chosen", name: "x", params: { a: 1 } })
    .finally(() => (settled = true));
  await until(() => seen.length === 1);
  assert.notEqual(seen[0].id, "chosen");
  assert.deepEqual(Object.keys(seen[0]).sort(), ["id", "name", "params", "type"]);
  assert.deepEqual(received, [["x", { a: 1 }]]);
  send(channel.socket, { type: "command-result", id: "chosen", ok: true });
  send(channel.socket, { type: "command-result", id: "guess", ok: true });
  await delay(30);
  assert.equal(settled, false);
  release("done");
  assert.deepEqual(await pending, { ok: true, data: "done" });
});

test("another session's channel neither receives nor answers a command", async (t) => {
  const { broker, open } = await fixture(t, ["fixture", "other"]);
  const mine = await open("fixture");
  const other = await open("other");
  const seenMine = sniff(mine);
  const seenOther = sniff(other);
  let otherCalls = 0;
  other.onCommand = async () => otherCalls++;
  let release;
  mine.onCommand = () => new Promise((resolve) => (release = resolve));
  let settled = false;
  const pending = broker.commands
    .send("fixture", { name: "x", params: {} })
    .finally(() => (settled = true));
  await until(() => seenMine.length === 1);
  // The other session's plugin learns the id somehow and answers it.
  send(other.socket, { type: "command-result", id: seenMine[0].id, ok: true });
  await delay(30);
  assert.equal(settled, false);
  assert.deepEqual(seenOther, []);
  assert.equal(otherCalls, 0);
  release();
  assert.deepEqual(await pending, { ok: true });
});

test("a command times out, and its late result is ignored", async (t) => {
  const { broker, open } = await fixture(t);
  const channel = await open();
  let release;
  channel.onCommand = () => new Promise((resolve) => (release = resolve));
  await assert.rejects(
    broker.commands.send("fixture", { name: "x", params: {} }, { timeoutMs: 40 }),
    { code: "TASK_STOP_TIMEOUT" },
  );
  release();
  await delay(30);
  // The channel is still up and the next command works.
  channel.onCommand = async () => "next";
  assert.deepEqual(await broker.commands.send("fixture", { name: "y", params: {} }), {
    ok: true,
    data: "next",
  });
});

test("the newest commands channel of a session takes the commands", async (t) => {
  const { broker, open } = await fixture(t);
  const first = await open();
  first.onCommand = async () => "first";
  const second = await open();
  second.onCommand = async () => "second";
  await until(() => [...broker.clients].filter((s) => s.owner).length === 2);
  assert.deepEqual(await broker.commands.send("fixture", { name: "x", params: {} }), {
    ok: true,
    data: "second",
  });
  second.close();
  await until(() => [...broker.clients].filter((s) => s.owner).length === 1);
  assert.equal(broker.commands.connected("fixture"), true);
  assert.deepEqual(await broker.commands.send("fixture", { name: "x", params: {} }), {
    ok: true,
    data: "first",
  });
});

test("the OpenCode driver stops a child session through the plugin", async (t) => {
  const { broker, open, sessions } = await fixture(t);
  const channel = await open();
  const aborted = [];
  const api = {
    route: { current: { name: "session", params: { sessionID: "ses_parent" } } },
    client: {
      session: {
        get: async ({ sessionID }) => ({
          data: {
            id: sessionID,
            parentID: sessionID === "ses_child" ? "ses_parent" : "",
          },
        }),
        abort: async (input) => {
          aborted.push(input);
          return { data: true };
        },
      },
    },
  };
  channel.onCommand = openCodeCommands(api);
  const subagents = [
    { id: "ses_child", name: "general", status: "running" },
    { id: "ses_foreign", name: "general", status: "running" },
  ];
  const control = new TaskControl({
    sessions: { get: async (id) => sessions.get(id) },
    chat: { read: async () => ({ observability: { subagents, shells: [] } }) },
    reads: { flags: () => ({}) },
    stops: { has: () => false, record: () => {}, forget: () => {} },
    onChange: () => {},
  });
  control.register("opencode", openCodeTaskDriver({ commands: broker.commands }));
  const snapshot = control.overlay(sessions.get("fixture"), {
    observability: { subagents, shells: [] },
  });
  assert.deepEqual(
    snapshot.observability.subagents.map((entry) => entry.canStop),
    [true, true],
  );
  assert.deepEqual(await control.stop("fixture", "ses_child"), { stopped: true });
  assert.deepEqual(aborted, [{ sessionID: "ses_child" }]);
  await assert.rejects(control.stop("fixture", "ses_foreign"), {
    code: "TASK_STOP_REFUSED",
    reason: "not a child",
  });
  assert.deepEqual(aborted, [{ sessionID: "ses_child" }]);
});
