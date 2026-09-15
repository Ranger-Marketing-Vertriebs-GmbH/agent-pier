import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { busFixture, requestBus } from "../helpers/agentbus-broker.js";

async function registered(f, id, tool = "opencode", cwd = f.cwd) {
  const result = await f.prepare(id, tool, cwd);
  assert.ok(result.launch.env.AGENTPIER_AGENTBUS_CAPABILITY_FILE);
  const response = await requestBus(result.launch.env, "agentbus/register", {
    nativeSessionId: `native-${id}`,
    pid: result.native.pid,
  });
  assert.equal(response.error, undefined, JSON.stringify(response));
  return result;
}
const call = (session, name, args = {}) =>
  requestBus(session.launch.env, "tools/call", {
    name,
    arguments: { ...args, __agentpierSession: `native-${session.id}` },
  });
const text = (response) => {
  assert.equal(response.error, undefined);
  assert.notEqual(response.result.isError, true, JSON.stringify(response));
  return response.result.content[0].text;
};

test("broker owns project messages, explicit reads, and scoped OpenCode notices", async (t) => {
  const f = await busFixture(t);
  const a = await registered(f, "sender"),
    b = await registered(f, "receiver");
  assert.equal(a.launch.env.AGENTBUS_HOME, undefined);
  assert.equal(a.launch.env.AGENTBUS_SOCKET_DIR, undefined);
  const listing = text(await call(a, "peers_list"));
  const key = listing.match(/\(key ([^)]+)\)/)[1];
  const notice = requestBus(b.launch.env, "agentbus/wait");
  assert.match(
    text(await call(a, "peer_send", { to: key, text: "Synthetic message" })),
    /Gesendet/,
  );
  const notification = await notice;
  assert.equal(notification.result.notifications[0].nativeSessionId, "native-receiver");
  assert.doesNotMatch(JSON.stringify(notification), /Synthetic message/);
  assert.match(text(await call(b, "inbox_read")), /Synthetic message/);
  assert.match(text(await call(b, "inbox_read")), /Keine neuen/);
  const other = path.join(f.root, "other");
  fs.mkdirSync(other);
  const foreign = await registered(f, "foreign", "opencode", other);
  assert.doesNotMatch(text(await call(foreign, "peers_list")), /receiver/);
  assert.equal(
    (await call(foreign, "peer_send", { to: key, text: "Forbidden" })).result.isError,
    true,
  );
});

test("forged credentials and foreign process registration fail closed", async (t) => {
  const f = await busFixture(t);
  const a = await f.prepare("one"),
    b = await f.prepare("two");
  assert.ok(a.launch.env.AGENTPIER_AGENTBUS_CAPABILITY_FILE);
  const response = await requestBus(a.launch.env, "agentbus/register", {
    nativeSessionId: "fake",
    pid: b.native.pid,
  });
  assert.ok(response.error);
  const credential = JSON.parse(
    fs.readFileSync(a.launch.env.AGENTPIER_AGENTBUS_CAPABILITY_FILE),
  );
  assert.ok(
    (
      await requestBus(
        a.launch.env,
        "tools/list",
        {},
        { ...credential, token: "0".repeat(64) },
      )
    ).error,
  );
  assert.ok(
    (
      await requestBus(
        a.launch.env,
        "tools/list",
        {},
        { ...credential, sessionId: "two" },
      )
    ).error,
  );
});

test("broker restart preserves credentials, registrations and unread messages", async (t) => {
  const f = await busFixture(t),
    a = await registered(f, "restart-a"),
    b = await registered(f, "restart-b");
  const key = text(await call(a, "peers_list")).match(/\(key ([^)]+)\)/)[1];
  text(await call(a, "peer_send", { to: key, text: "Before restart" }));
  const socket = a.launch.env.AGENTPIER_AGENTBUS_SOCKET;
  await f.bus.close();
  const { AgentBus } = await import("../../server/features/agentbus/agent-bus.js");
  f.bus = new AgentBus(f);
  await f.bus.ready;
  assert.equal(f.bus.broker.transport.socketPath, socket);
  assert.match(text(await call(b, "inbox_read")), /Before restart/);
  const hint = await requestBus(b.launch.env, "agentbus/hook", {
    event: "UserPromptSubmit",
    nativeSessionId: "native-restart-b",
    pid: b.native.pid,
  });
  assert.equal(hint.error, undefined);
  assert.equal(hint.result.context, null);
});

test("revocation releases waiters, rejects old credentials and retains history", async (t) => {
  const f = await busFixture(t),
    a = await registered(f, "revoke-a"),
    b = await registered(f, "revoke-b");
  const key = text(await call(a, "peers_list")).match(/\(key ([^)]+)\)/)[1];
  text(await call(a, "peer_send", { to: key, text: "Keep history" }));
  await requestBus(b.launch.env, "agentbus/wait");
  const credential = JSON.parse(
    fs.readFileSync(b.launch.env.AGENTPIER_AGENTBUS_CAPABILITY_FILE),
  );
  const wait = requestBus(b.launch.env, "agentbus/wait", {}, credential);
  await new Promise((resolve) => setTimeout(resolve, 20));
  f.bus.revoke(b.id);
  f.rows.get(b.id).status = "stopped";
  assert.ok((await wait).error);
  assert.ok((await requestBus(b.launch.env, "tools/list", {}, credential)).error);
  assert.doesNotMatch(text(await call(a, "peers_list")), /revoke-b/);
  assert.equal(
    (await f.bus.messages(a.launch.agentbus.projectId)).items[0].text,
    "Keep history",
  );
});

test("inbox batching does not acknowledge messages beyond the response budget", async (t) => {
  const f = await busFixture(t),
    a = await registered(f, "batch-a"),
    b = await registered(f, "batch-b");
  const key = text(await call(a, "peers_list")).match(/\(key ([^)]+)\)/)[1];
  for (let i = 0; i < 11; i++) {
    text(
      await (
        await import("../../server/features/agentbus/agentbus-client.js")
      ).agentbusClient(a.launch.env)({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "peer_send",
          arguments: {
            __agentpierSession: "native-batch-a",
            to: key,
            text: `message-${i}:` + "x".repeat(15000),
          },
        },
      }),
    );
  }
  const first = text(await call(b, "inbox_read"));
  assert.equal((first.match(/<agentbus-message /g) || []).length, 8);
  assert.match(first, /Weitere Nachrichten/);
  const second = text(await call(b, "inbox_read"));
  assert.equal((second.match(/<agentbus-message /g) || []).length, 3);
  assert.doesNotMatch(second, /message-0:/);
  assert.match(text(await call(b, "inbox_read")), /Keine neuen/);
});

test("replacement rotates capability and stale async registration cannot restore access", async (t) => {
  const f = await busFixture(t),
    a = await registered(f, "rotate");
  const old = JSON.parse(
    fs.readFileSync(a.launch.env.AGENTPIER_AGENTBUS_CAPABILITY_FILE),
  );
  const row = f.rows.get(a.id),
    account = f.accounts.get(row.accountId);
  const launch = await f.bus.prepare({
    id: a.id,
    account,
    cwd: f.cwd,
    replace: true,
    launch: { command: process.execPath, env: { HOME: f.home } },
  });
  assert.ok((await requestBus(launch.env, "tools/list", {}, old)).error);
  assert.equal((await requestBus(launch.env, "tools/list")).error, undefined);
  let unblock, entered;
  const ready = new Promise((resolve) => (entered = resolve)),
    gate = new Promise((resolve) => (unblock = resolve));
  const tmux = f.sessions.tmux;
  f.sessions.tmux = async (args) => {
    entered();
    await gate;
    return tmux(args);
  };
  const registration = requestBus(launch.env, "agentbus/register", {
    nativeSessionId: "native-rotate",
    pid: a.native.pid,
  });
  await ready;
  f.bus.revoke(a.id);
  unblock();
  assert.ok((await registration).error);
});

test("cancelled reads and concurrent unregister do not acknowledge unread messages", async (t) => {
  const f = await busFixture(t),
    a = await registered(f, "race-a"),
    b = await registered(f, "race-b");
  const key = text(await call(a, "peers_list")).match(/\(key ([^)]+)\)/)[1];
  text(await call(a, "peer_send", { to: key, text: "Still unread" }));
  const credential = JSON.parse(
    fs.readFileSync(b.launch.env.AGENTPIER_AGENTBUS_CAPABILITY_FILE),
  );
  const original = f.sessions.get;
  let entered,
    unblock,
    calls = 0;
  let ready = new Promise((resolve) => (entered = resolve)),
    gate = new Promise((resolve) => (unblock = resolve));
  f.sessions.get = async (id) => {
    if (++calls === 2) {
      entered();
      await gate;
    }
    return original(id);
  };
  const controller = new AbortController();
  const read = f.bus.broker.call(
    credential,
    "inbox_read",
    { __agentpierSession: "native-race-b" },
    controller.signal,
  );
  await ready;
  controller.abort();
  unblock();
  await assert.rejects(read, /cancelled/);
  calls = 0;
  ready = new Promise((resolve) => (entered = resolve));
  gate = new Promise((resolve) => (unblock = resolve));
  const stale = f.bus.broker.call(credential, "inbox_read", {
    __agentpierSession: "native-race-b",
  });
  await ready;
  const { unregister } = await import("../../vendor/agentbus/core/peers.js");
  unregister(f.bus.broker.access.record(b.id).h, key);
  unblock();
  await assert.rejects(stale, /not registered/);
  f.sessions.get = original;
  assert.equal(
    (
      await requestBus(b.launch.env, "agentbus/register", {
        nativeSessionId: "native-race-b",
        pid: b.native.pid,
      })
    ).error,
    undefined,
  );
  assert.match(text(await call(b, "inbox_read")), /Still unread/);
});
