import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { NativeRequestChannel } from "../../server/features/requests/native-channel.js";
import { pushNative } from "../../server/features/requests/native-push.js";
import { messages, send } from "../../server/features/requests/wire.js";
import { ChatStore } from "../../server/features/chat/chat-store.js";
import { ChatStreams } from "../../server/features/chat/chat-streams.js";
import { ChatEvents } from "../../server/features/chat/chat-events.js";
import { runNativeSessionHook } from "../../server/features/sessions/native-session-binding.js";
import { readerTui } from "../../server/features/sessions/native-session-opencode.js";
import { until } from "../helpers/adapter-process.js";

const NATIVE = "11111111-1111-1111-1111-111111111111";

/**
 * A broker wired like services.js to a chat whose file watcher never fires: only a
 * push can make the chat read its source again before the 30 s recovery.
 */
async function fixture(t, { tool = "claude", sessions: ids = ["s1"] } = {}) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-push-")));
  const all = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        id,
        accountId: `account-${id}`,
        tool,
        cwd: "/x",
        status: "running",
        nativeRequests: { enabled: true },
      },
    ]),
  );
  const source = { version: 1 };
  const events = new ChatEvents();
  const chat = new ChatStore({
    dataDir,
    sessions: { get: async (id) => ({ ...all[id] }) },
    history: {
      list: async () => [],
      readPage: async () => ({
        messages: [{ id: `m${source.version}`, role: "assistant", text: "x" }],
        tasks: [],
      }),
    },
    events,
  });
  for (const session of Object.values(all)) chat.initialize(session, NATIVE, "manual");
  const streams = new ChatStreams({
    sessions: { get: async (id) => ({ ...all[id] }) },
    chat,
    chatImages: { read: (id) => chat.read(id) },
    chatEvents: events,
    accounts: {},
    config: {},
    watch: () => () => {},
    watchInput: () => () => {},
    probe: () => () => {},
  });
  const pushes = [];
  const broker = new RequestBroker({
    dataDir,
    sessions: { get: async (id) => ({ ...all[id] }) },
    onNative: (sessionId, push) => {
      pushes.push({ sessionId, ...push });
      if (push.type === "activity") events.publish(sessionId, "native-activity");
    },
  });
  await broker.ready;
  const launches = {};
  for (const id of ids)
    launches[id] = await broker.prepare({
      id,
      account: { id: `account-${id}`, tool },
      cwd: dataDir,
      launch: { command: "/fixture/cli", args: [], env: {} },
    });
  t.after(async () => {
    streams.close();
    await broker.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const values = [];
  streams.subscribe("s1", (value) => values.push(value));
  await until(() => values.at(-1)?.snapshot?.messages[0]?.id === "m1", 10_000);
  // The silent watcher reports nothing; the source changes now.
  source.version = 2;
  const fresh = () => values.at(-1)?.snapshot?.messages[0]?.id === "m2";
  return { broker, launches, pushes, values, fresh, all, dataDir };
}

async function within(ms, check) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return Date.now() - start;
    await delay(5);
  }
  assert.fail(`not within ${ms} ms`);
}

test("a Claude hook push makes the chat read again within a second", async (t) => {
  const f = await fixture(t);
  const env = { ...f.launches.s1.env };
  await runNativeSessionHook({
    env,
    input: Readable.from([JSON.stringify({ hook_event_name: "Stop" })]),
    at: Date.now(),
  });
  await within(1000, f.fresh);
  assert.deepEqual(
    f.pushes.map((push) => [push.sessionId, push.type, push.event]),
    [["s1", "activity", "Stop"]],
  );
});

test("a Codex proxy or OpenCode plugin channel push reaches the chat at once", async (t) => {
  const f = await fixture(t, { tool: "opencode" });
  const channel = new NativeRequestChannel({ env: f.launches.s1.env });
  t.after(() => channel.close());
  await channel.ready;
  channel.activity("turn/completed");
  await within(1000, f.fresh);
  assert.equal(f.pushes[0].event, "turn/completed");
});

test("the OpenCode reader plugin pushes its activity change", async (t) => {
  const f = await fixture(t, { tool: "opencode" });
  // A real binding file is not needed: recording fails, the push still names it.
  const pushed = [];
  const fake = { activity: (event) => pushed.push(event), close() {} };
  const disposers = [];
  let busy = false;
  const api = {
    route: { current: { name: "session", params: { sessionID: "ses_1" } } },
    state: { session: { status: () => ({ type: busy ? "busy" : "idle" }) } },
    lifecycle: { onDispose: (fn) => disposers.push(fn) },
  };
  const env = {
    AGENTPIER_NATIVE_BINDING_FILE: path.join(f.dataDir, "native-sessions/s1.launch.json"),
    AGENTPIER_NATIVE_BINDING_TOKEN: "x",
  };
  fs.mkdirSync(path.dirname(env.AGENTPIER_NATIVE_BINDING_FILE), { recursive: true });
  fs.writeFileSync(
    env.AGENTPIER_NATIVE_BINDING_FILE,
    JSON.stringify({ id: "s1", accountId: "account-s1", tool: "opencode", token: "x" }),
  );
  const stderr = process.stderr.write;
  process.stderr.write = () => true;
  t.after(() => (process.stderr.write = stderr));
  await readerTui({ channel: () => fake, env })(api);
  busy = true;
  await until(() => pushed.includes("session.status"), 2000);
  disposers.forEach((dispose) => dispose());
});

test("a push for a foreign session is refused and never reaches its chat", async (t) => {
  const f = await fixture(t, { sessions: ["s1", "s2"] });
  const foreign = JSON.parse(fs.readFileSync(f.launches.s2.env.AGENTPIER_REQUEST_FILE));
  // s2's channel credentials naming s1: the broker closes the connection.
  const socket = net.createConnection(foreign.socketPath);
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.on("error", () => {});
  const replies = [];
  messages(socket, (reply) => replies.push(reply));
  socket.on("connect", () => {
    send(socket, { type: "hello", sessionId: "s1", token: foreign.token, epoch: "e" });
    send(socket, { type: "activity" });
  });
  await closed;
  assert.deepEqual(replies, []);
  // A push without a hello is refused as well.
  const bare = net.createConnection(foreign.socketPath);
  bare.on("error", () => {});
  bare.on("connect", () => send(bare, { type: "activity" }));
  await new Promise((resolve) => bare.once("close", resolve));
  // A stopped session's owner cannot push either.
  f.all.s2.status = "stopped";
  assert.equal(
    await pushNative({ type: "activity" }, { env: f.launches.s2.env }),
    true,
    "sent, then refused by the broker",
  );
  await delay(100);
  assert.deepEqual(f.pushes, []);
  assert.equal(f.fresh(), false);
});

test("a hook push never waits long for a server that is down", async (t) => {
  const f = await fixture(t);
  await f.broker.close();
  const start = Date.now();
  assert.equal(await pushNative({ type: "activity" }, { env: f.launches.s1.env }), false);
  assert.ok(Date.now() - start < 1600);
  // A server that accepts but never answers is cut off by the timeout.
  const file = JSON.parse(fs.readFileSync(f.launches.s1.env.AGENTPIER_REQUEST_FILE));
  const silent = net.createServer(() => {});
  await new Promise((resolve) => silent.listen(file.socketPath, resolve));
  t.after(() => silent.close());
  const waited = Date.now();
  assert.equal(
    await pushNative({ type: "activity" }, { env: f.launches.s1.env, timeout: 200 }),
    false,
  );
  assert.ok(Date.now() - waited < 1000);
});

test("a reconnected channel sends its streaming runs whole again", async (t) => {
  const f = await fixture(t, { tool: "codex" });
  const channel = new NativeRequestChannel({ env: f.launches.s1.env });
  t.after(() => channel.close());
  await channel.ready;
  channel.streamDelta("item", "Hel", { turn: "t" });
  channel.streamDelta("item", "lo", { turn: "t" });
  await until(() => f.pushes.length === 2, 2000);
  assert.deepEqual(
    f.pushes.map(({ from, text, turn }) => [from, text, turn]),
    [
      [0, "Hel", "t"],
      [3, "lo", "t"],
    ],
  );
  channel.socket.destroy();
  // The broker ends the lost owner's run; the reconnect starts it again whole.
  await until(() => f.pushes.some((push) => push.type === "stream-end"), 2000);
  await until(() => f.pushes.at(-1).type === "stream", 4000);
  assert.deepEqual([f.pushes.at(-1).from, f.pushes.at(-1).text], [0, "Hello"]);
  channel.streamEnd(undefined, { turn: "t" });
  await until(() => f.pushes.at(-1).type === "stream-end", 2000);
});
