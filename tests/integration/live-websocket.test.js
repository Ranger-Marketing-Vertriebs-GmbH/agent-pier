import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { upgradeStatus } from "../helpers/users.js";

const owner = (principal) => principal?.role === "owner";

/** An owner topic whose value the test sets; `set` invalidates it. */
function fixtureTopic(f, { name = "fixture.value", ...options } = {}) {
  let value = { n: 0 };
  f.application.live.define({
    name,
    mode: "state",
    authorize: owner,
    scopeKey: () => "owner",
    read: () => value,
    ...options,
  });
  return {
    name,
    set(next) {
      value = next;
      f.application.live.invalidate(name);
    },
  };
}

const ofType = (type, topic) => (frame) =>
  frame.type === type && (topic === undefined || frame.topic === topic);

async function subscribed(f, topic, have) {
  const live = openLive(f);
  const hello = await live.next(ofType("hello"));
  live.send({ op: "sub", topic, ...(have ? { have } : {}) });
  const first = await live.next((frame) => frame.topic === topic);
  return { live, hello, first };
}

test("an owner gets hello, then a snapshot for a defined topic", async (t) => {
  const f = await applicationFixture(t);
  const topic = fixtureTopic(f);
  const { live, hello, first } = await subscribed(f, topic.name);
  assert.deepEqual(hello, { type: "hello", instance: f.application.live.instance });
  assert.equal(first.type, "snapshot");
  assert.deepEqual(first.data, { n: 0 });
  live.send({ op: "ping" });
  assert.deepEqual(await live.next(ofType("pong")), { type: "pong" });
  live.ws.close();
});

test("a frame follows a change within 1 s", async (t) => {
  const f = await applicationFixture(t);
  const topic = fixtureTopic(f);
  const { live, first } = await subscribed(f, topic.name);
  const started = Date.now();
  topic.set({ n: 1 });
  const frame = await live.next(ofType("state", topic.name), 1000);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(frame.data, { n: 1 });
  assert.ok(frame.revision > first.revision);
  live.ws.close();
});

test("an unknown op closes with 1008 and a 5 kB message closes the socket", async (t) => {
  const f = await applicationFixture(t);
  const malformed = [
    { op: "subscribe", topic: "x" },
    "not json",
    "[1]",
    JSON.stringify({ op: "sub", topic: 7 }),
    JSON.stringify({ op: "sub", topic: "x", have: "old" }),
    JSON.stringify({ op: "unsub" }),
  ];
  for (const frame of malformed) {
    const live = openLive(f);
    await live.next(ofType("hello"));
    live.send(frame);
    assert.equal((await live.closed).code, 1008, JSON.stringify(frame));
  }
  const binary = openLive(f);
  await binary.next(ofType("hello"));
  binary.ws.send(Buffer.from("{}"));
  assert.equal((await binary.closed).code, 1008);
  const large = openLive(f);
  await large.next(ofType("hello"));
  large.send({ op: "sub", topic: "x".repeat(5000) });
  assert.equal((await large.closed).code, 1009);
  assert.equal(large.frames.length, 1);
});

test("the 65th subscription answers limit", async (t) => {
  const f = await applicationFixture(t);
  fixtureTopic(f, { name: "fixture.item", param: /\d+/, read: () => 1 });
  const live = openLive(f);
  await live.next(ofType("hello"));
  for (let index = 0; index < 64; index++)
    live.send({ op: "sub", topic: `fixture.item:${index}` });
  for (let index = 0; index < 64; index++)
    await live.next(ofType("snapshot", `fixture.item:${index}`));
  // Resubscribing a held topic takes no new slot.
  live.send({ op: "sub", topic: "fixture.item:3" });
  await live.next(ofType("snapshot", "fixture.item:3"));
  live.send({ op: "sub", topic: "fixture.item:64" });
  assert.deepEqual(await live.next((frame) => frame.topic === "fixture.item:64"), {
    type: "error",
    topic: "fixture.item:64",
    code: "limit",
  });
  live.send({ op: "unsub", topic: "fixture.item:0" });
  live.send({ op: "sub", topic: "fixture.item:64" });
  await live.next(ofType("snapshot", "fixture.item:64"));
  live.ws.close();
});

test("a 17th socket of one principal is refused", async (t) => {
  const f = await applicationFixture(t);
  const sockets = Array.from({ length: 16 }, () => openLive(f));
  await Promise.all(sockets.map((live) => live.opened));
  assert.equal(await upgradeStatus(f, "/api/live", f.cookie), 429);
  sockets[0].ws.close();
  await sockets[0].closed;
  const another = openLive(f);
  await another.opened;
  for (const live of [...sockets, another]) live.ws.close();
});

test("the origin check and the login guard the upgrade", async (t) => {
  const f = await applicationFixture(t);
  assert.equal(await upgradeStatus(f, "/api/live", ""), 401);
  const foreign = openLive(f, f.cookie, { origin: "http://evil.example" });
  await assert.rejects(foreign.opened, (error) => error.statusCode === 403);
});

test("logout closes the socket with 1008", async (t) => {
  const f = await applicationFixture(t);
  const live = openLive(f);
  await live.next(ofType("hello"));
  const response = await f.request("/auth/logout", { method: "POST" });
  assert.equal(response.status, 204);
  assert.equal((await live.closed).code, 1008);
});

test("an owner-privacy change revokes a subscription that lost access", async (t) => {
  const f = await applicationFixture(t);
  let allowed = true;
  const topic = fixtureTopic(f, { authorize: () => allowed });
  const { live } = await subscribed(f, topic.name);
  allowed = false;
  f.application.ownerPrivacy.emit("changed");
  assert.deepEqual(await live.next(ofType("revoked")), {
    type: "revoked",
    topic: topic.name,
  });
  live.ws.close();
});

test("a slow reader gets the newest frame per topic and 1013 above 2 MiB", async (t) => {
  const f = await applicationFixture(t);
  const big = (n, bytes) => ({ n, pad: "x".repeat(bytes) });
  const topic = fixtureTopic(f, { maxBytes: 64 * 1024 * 1024 });
  const { live } = await subscribed(f, topic.name);
  // The reader stops reading: the kernel buffers fill, then the server queues.
  live.ws._socket.pause();
  for (let n = 1; n <= 24; n++) {
    topic.set(big(n, 1024 * 1024));
    await delay(180);
  }
  live.ws._socket.resume();
  const last = await live.next((frame) => frame.data?.n === 24, 5000);
  assert.equal(last.type, "state");
  // How many frames the kernel buffers absorb differs by platform; what holds
  // everywhere is that frames never repeat or go back and the newest one arrives.
  // Which frames a full buffer drops is covered in tests/unit/live-connection.test.js.
  const seen = live.frames.filter(ofType("state")).map((frame) => frame.data.n);
  assert.deepEqual(
    seen,
    [...new Set(seen)].sort((a, b) => a - b),
  );
  assert.equal(seen.at(-1), 24);
  // One frame far larger than any kernel socket buffers (Linux autotunes to a few
  // MiB) leaves more than 2 MiB buffered, whatever the platform.
  live.ws._socket.pause();
  topic.set(big(25, 32 * 1024 * 1024));
  await delay(400);
  topic.set(big(26, 16));
  await delay(400);
  live.ws._socket.resume();
  assert.equal((await live.closed).code, 1013);
});

test("shutdown closes with 1012 and a restart answers a snapshot with a new instance", async (t) => {
  const f = await applicationFixture(t);
  const topic = fixtureTopic(f);
  const { live, hello, first } = await subscribed(f, topic.name);
  const restarted = f.restart();
  assert.equal((await live.closed).code, 1012);
  await restarted;
  fixtureTopic(f);
  const again = await subscribed(f, topic.name, {
    instance: hello.instance,
    revision: first.revision,
  });
  assert.notEqual(again.hello.instance, hello.instance);
  assert.equal(again.first.type, "snapshot");
  assert.deepEqual(again.first.data, { n: 0 });
  again.live.ws.close();
});

test("agents switched on later, off and on again still re-check subscriptions", async (t) => {
  const f = await applicationFixture(t);
  assert.equal(f.application.assistants, null);
  let allowed = true;
  const topic = fixtureTopic(f, { authorize: () => allowed });
  const feature = (enabled) =>
    f.request("/api/assistant-feature", { method: "PUT", body: { enabled } });
  const revokedAfter = async (change) => {
    const { live } = await subscribed(f, topic.name);
    allowed = false;
    await change();
    await live.next(ofType("revoked", topic.name));
    allowed = true;
    live.ws.close();
  };
  assert.equal((await feature(true)).status, 200);
  assert.ok(f.application.assistants);
  // An agent event of the services created after boot re-checks access.
  await revokedAfter(() => f.application.assistants.events.publish({ type: "probe" }));
  // Switching off is a change too.
  await revokedAfter(() => feature(false));
  assert.equal(f.application.assistants, null);
  await revokedAfter(() => feature(true));
  await revokedAfter(() => f.application.assistants.events.publish({ type: "probe" }));
});
