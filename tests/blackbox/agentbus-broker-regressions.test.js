import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { busFixture, requestBus } from "../helpers/agentbus-broker.js";
import {
  registerPeer,
  register,
} from "../../server/features/agentbus/agentbus-runtime.js";

function hostRegister(f, session, native, name) {
  const ctx = f.bus.broker.access.record(session.id);
  const peer = registerPeer(ctx, native, { pid: session.native.pid });
  if (name) peer.name = name;
  register(ctx.h, { ...peer, brokerGeneration: ctx.record.generation });
  return peer;
}
function send(session, to, text = "Durable message", extra = {}) {
  return requestBus(session.launch.env, "tools/call", {
    name: "peer_send",
    arguments: { __agentpierSession: "sender-native", to, text, ...extra },
  });
}

test(
  "durable sends return before blocked advisory wakes, cap work and drain on close",
  { timeout: 30000 },
  async (t) => {
    const f = await busFixture(t);
    const sender = await f.prepare("durable-sender");
    const target = await f.prepare("durable-target");
    hostRegister(f, sender, "sender-native");
    const peer = hostRegister(f, target, "target-native");
    const ctx = f.bus.broker.access.record(target.id);
    const queue = f.bus.queue(ctx.h);
    let release, enter;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    let calls = 0;
    let completed = 0;
    t.mock.method(f.bus.broker, "wake", async () => {
      calls++;
      enter(queue.summary(peer.key).count);
      await gate;
      completed++;
    });
    // The watchdog bounds a broken implementation and releases fixture cleanup.
    // Success depends on ordering against this gate, not HTTP response latency.
    t.signal.addEventListener("abort", release, { once: true });
    try {
      const pending = send(sender, peer.key);
      const [response, queuedAtWake] = await Promise.all([pending, entered]);
      assert.equal(queuedAtWake, 1, "Delivery must be durable before advisory wake");
      assert.equal(completed, 0, "Sending must not await the advisory wake");
      assert.notEqual(response.result.isError, true);
      assert.match(response.result.content[0].text, /id /);
      for (let i = 0; i < 35; i++)
        assert.notEqual((await send(sender, peer.key)).result.isError, true);
      assert.equal(calls, 32, "Advisory wake concurrency must be bounded");
      assert.equal(completed, 0, "Advisory wakes remain blocked until released");
      assert.equal(queue.summary(peer.key).count, 36);
      let closed = false;
      const closing = f.bus.broker.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(closed, false, "Close drains tracked advisory work");
      release();
      await closing;
      assert.equal(completed, calls, "Close waits for every tracked advisory wake");
    } finally {
      t.signal.removeEventListener("abort", release);
      release();
    }
  },
);

test("tool validation returns distinct safe errors and bounded scoped peer hints", async (t) => {
  const f = await busFixture(t);
  const sender = await f.prepare("errors-sender");
  const target = await f.prepare("errors-target");
  const second = await f.prepare("errors-second");
  const self = hostRegister(f, sender, "sender-native");
  const peer = hostRegister(f, target, "target-native", "shared");
  hostRegister(f, second, "second-native", "shared");
  const cases = [
    ["missing-private-marker", "ok", {}, "UNKNOWN_PEER"],
    ["shared", "ok", {}, "AMBIGUOUS_PEER"],
    [self.key, "ok", {}, "SELF_SEND"],
    [peer.key, "", {}, "EMPTY_TEXT"],
    [peer.key, "x".repeat(16385), {}, "TEXT_TOO_LARGE"],
    [peer.key, "ok", { replyTo: "../private-marker" }, "INVALID_REPLY_TO"],
    [peer.key, "ok", { __agentpierSession: "absent" }, "NOT_REGISTERED"],
  ];
  for (const [to, text, extra, code] of cases) {
    const response = await send(sender, to, text, extra);
    assert.equal(response.result.isError, true);
    const error = JSON.parse(response.result.content[0].text);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 20);
    assert.doesNotMatch(
      JSON.stringify(error),
      /private-marker|pidStart|token|socket|cwd/,
    );
    if (error.peers) {
      assert.ok(error.peers.length <= 10);
      for (const hint of error.peers)
        assert.deepEqual(Object.keys(hint).sort(), ["key", "name", "runtime"]);
    }
  }
  const ctx = f.bus.broker.access.record(target.id);
  t.mock.method(f.bus.queue(ctx.h), "enqueue", () => {
    throw Error("secret-internal-marker");
  });
  const failure = await send(sender, peer.key);
  const error = JSON.parse(failure.result.content[0].text);
  assert.equal(error.code, "OPERATION_FAILED");
  assert.doesNotMatch(JSON.stringify(error), /secret-internal-marker/);
});

test("summary reads only the authorized native peer queue without registration or session listing", async (t) => {
  const f = await busFixture(t);
  const session = await f.prepare("summary-reader");
  const peer = hostRegister(f, session, "reader-native");
  const other = hostRegister(f, session, "other-native");
  const ctx = f.bus.broker.access.record(session.id);
  const queue = f.bus.queue(ctx.h);
  const summary = (nativeSessionId) =>
    requestBus(session.launch.env, "agentbus/summary", { nativeSessionId });
  queue.enqueue({
    id: "queued",
    ts: Date.now(),
    from: { name: "source" },
    to: other.key,
    text: "private-body",
  });
  t.mock.method(f.sessions, "list", () => {
    throw Error("No all-session scans");
  });
  t.mock.method(f.bus.broker, "register", () => {
    throw Error("No registration");
  });
  assert.deepEqual((await summary("reader-native")).result, { context: null });
  const before = queue.summary(other.key);
  t.mock.method(queue, "claim", () => {
    throw Error("Summary must not claim messages");
  });
  t.mock.method(queue, "ack", () => {
    throw Error("Summary must not acknowledge messages");
  });
  assert.match((await summary("other-native")).result.context, /1.*inbox_read/);
  assert.deepEqual(queue.summary(other.key), before);
  assert.equal(queue.summary(peer.key).count, 0);
  assert.equal((await summary("missing")).error.code, -32004);
  register(ctx.h, { ...other, brokerGeneration: "obsolete-generation" });
  assert.equal((await summary("other-native")).error.code, -32004);
  assert.deepEqual(queue.summary(other.key), before);
  const credential = JSON.parse(
    fs.readFileSync(session.launch.env.AGENTPIER_AGENTBUS_CAPABILITY_FILE),
  );
  f.bus.broker.revoke(session.id);
  assert.equal(
    (
      await requestBus(
        session.launch.env,
        "agentbus/summary",
        { nativeSessionId: "reader-native" },
        credential,
      )
    ).error.code,
    -32000,
  );
});

test("close aborts a deferred binding proof without a late wake", async (t) => {
  const f = await busFixture(t);
  const sender = await f.prepare("close-sender");
  const target = await f.prepare("close-target", "codex");
  hostRegister(f, sender, "sender-native");
  const peer = hostRegister(f, target, "target-native");
  let release, enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.bus.bindings = {
    async resolve() {
      enter();
      await gate;
      return { id: "target-native" };
    },
  };
  let timer;
  try {
    const pending = send(sender, peer.key);
    await entered;
    const closing = f.bus.broker.close();
    assert.equal(
      await Promise.race([
        closing.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]),
      true,
      "Closing must abort outstanding native proof waits",
    );
    let lateReads = 0;
    t.mock.method(f.bus.broker.access, "record", () => {
      lateReads++;
      throw Error("Closed storage");
    });
    release();
    await pending.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lateReads, 0, "Late proof completion must not touch closed storage");
  } finally {
    release();
    clearTimeout(timer);
  }
});

test("summary without registration opens no queue and creates no native registration", async (t) => {
  const f = await busFixture(t);
  const session = await f.prepare("summary-unregistered");
  t.mock.method(f.bus, "queue", () => {
    throw Error("Must not open or write a queue");
  });
  t.mock.method(f.bus.broker, "register", () => {
    throw Error("Must not register");
  });
  t.mock.method(f.sessions, "list", () => {
    throw Error("Must not scan other sessions");
  });
  const response = await requestBus(session.launch.env, "agentbus/summary", {
    nativeSessionId: "unregistered-native",
  });
  assert.equal(response.error.code, -32004);
});

test("invalid inbox references are actionable and leave unread messages untouched", async (t) => {
  const f = await busFixture(t);
  const session = await f.prepare("invalid-inbox-reference");
  const self = hostRegister(f, session, "reader-native");
  const ctx = f.bus.broker.access.record(session.id);
  const queue = f.bus.queue(ctx.h);
  queue.enqueue({
    id: "valid-message-id",
    ts: Date.now(),
    from: { name: "source" },
    to: self.key,
    text: "unread-fixture",
  });
  for (const messageId of [null, 42, {}, "", "../private-marker", "x".repeat(241)]) {
    const response = await requestBus(session.launch.env, "tools/call", {
      name: "inbox_read",
      arguments: { __agentpierSession: "reader-native", messageId },
    });
    assert.equal(response.result.isError, true);
    const error = JSON.parse(response.result.content[0].text);
    assert.equal(error.code, "INVALID_MESSAGE_ID");
    assert.match(error.message, /messageId/);
    assert.doesNotMatch(error.message, /private-marker/);
    assert.equal(queue.summary(self.key).count, 1);
  }
});
