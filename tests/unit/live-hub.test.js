import test from "node:test";
import assert from "node:assert/strict";
import {
  LiveHub,
  MAX_TOPIC_ID,
  unknownTopic,
} from "../../server/features/live/live-hub.js";
import { applyListSync } from "../../web/features/assistants/agent-list-sync.js";
import { manualTimers } from "../helpers/manual-timers.js";

const owner = { role: "owner" };
const user = (id) => ({ role: "user", id });
const scope = (principal) =>
  principal.role === "owner" ? "owner" : `user:${principal.id}`;

function setup(t) {
  const clock = manualTimers();
  const hub = new LiveHub({ timers: clock.timers });
  t.after(() => hub.close());
  return { clock, hub };
}

function listen(hub, principal, topic, have) {
  const frames = [];
  const unsubscribe = hub.subscribe(principal, topic, have, (frame) =>
    frames.push(frame),
  );
  return { frames, unsubscribe };
}

test("define rejects a duplicate name and an invalid definition", (t) => {
  const { hub } = setup(t);
  const base = { mode: "state", authorize: () => true, scopeKey: () => "owner" };
  hub.define({ name: "pipeline.counts", ...base, read: () => 1, param: /p\d+/ });
  assert.throws(() => hub.define({ name: "pipeline.counts", ...base, read: () => 2 }));
  assert.throws(() => hub.define({ name: "bad:name", ...base, read: () => 2 }));
  assert.throws(() => hub.define({ name: "x", ...base, mode: "other", read: () => 2 }));
  assert.throws(() => hub.define({ name: "y", ...base }));
});

test("unknown, unauthorized, overlong and malformed topic ids all resolve to null", async (t) => {
  const { hub, clock } = setup(t);
  hub.define({
    name: "session.models",
    param: /[a-z0-9-]{1,40}/,
    mode: "state",
    authorize: (principal) => principal.role === "owner",
    scopeKey: scope,
    read: () => ({ models: [] }),
  });
  hub.define({
    name: "pipeline.counts",
    param: /[a-z0-9]{1,20}/,
    paramOptional: true,
    mode: "state",
    authorize: () => true,
    scopeKey: scope,
    read: () => 1,
  });
  assert.equal(hub.resolve(owner, "session.models:s1").param, "s1");
  assert.equal(hub.resolve(owner, "pipeline.counts").param, undefined);
  assert.equal(hub.resolve(owner, "pipeline.counts:p1").param, "p1");
  for (const id of [
    "nothing",
    "session.models",
    "session.models:",
    "session.models:S1!",
    "session.models:s1\n",
    "session.models:s1:extra",
    `session.models:${"a".repeat(MAX_TOPIC_ID)}`,
    "pipeline.counts:",
    "x".repeat(MAX_TOPIC_ID + 1),
    "",
    42,
    null,
  ])
    assert.equal(hub.resolve(owner, id), null, String(id));
  assert.equal(hub.resolve(user("u1"), "session.models:s1"), null);

  // A denied topic answers exactly like an unknown one.
  const denied = listen(hub, user("u1"), "session.models:s1");
  const unknown = listen(hub, user("u1"), "session.nothing:s1");
  await clock.advance(200);
  assert.equal(denied.frames.length, 1);
  assert.equal(
    JSON.stringify(denied.frames[0]).replace("session.models", "X"),
    JSON.stringify(unknown.frames[0]).replace("session.nothing", "X"),
  );
});

test("equal scope keys share one read; different scope keys never share a payload", async (t) => {
  const { hub, clock } = setup(t);
  const reads = [];
  hub.define({
    name: "me.reminders",
    mode: "state",
    authorize: () => true,
    scopeKey: scope,
    read: (principal) => {
      reads.push(scope(principal));
      return { for: scope(principal) };
    },
  });
  const a = listen(hub, user("u1"), "me.reminders");
  const b = listen(hub, user("u1"), "me.reminders");
  const c = listen(hub, user("u2"), "me.reminders");
  await clock.advance(0);
  assert.deepEqual(reads.sort(), ["user:u1", "user:u2"]);
  assert.deepEqual(a.frames[0].data, { for: "user:u1" });
  assert.deepEqual(b.frames[0].data, { for: "user:u1" });
  assert.deepEqual(c.frames[0].data, { for: "user:u2" });
});

function counter(hub) {
  const source = { value: { n: 1 }, reads: 0 };
  hub.define({
    name: "state",
    mode: "state",
    authorize: () => true,
    scopeKey: () => "owner",
    read: () => {
      source.reads++;
      return structuredClone(source.value);
    },
  });
  return source;
}

test("have with the current instance and revision answers same", async (t) => {
  const { hub, clock } = setup(t);
  counter(hub);
  const first = listen(hub, owner, "state");
  await clock.advance(0);
  const { revision } = first.frames[0];
  first.unsubscribe();
  // The instance is gone; its revision survives for the resubscribe.
  const again = listen(hub, owner, "state", { instance: hub.instance, revision });
  await clock.advance(0);
  assert.deepEqual(again.frames, [{ type: "same", topic: "state", revision }]);
});

test("have from another instance answers snapshot", async (t) => {
  const { hub, clock } = setup(t);
  counter(hub);
  const first = listen(hub, owner, "state");
  await clock.advance(0);
  const { revision } = first.frames[0];
  const other = listen(hub, owner, "state", { instance: "restarted", revision });
  assert.equal(other.frames[0].type, "snapshot");
  assert.deepEqual(other.frames[0].data, { n: 1 });
});

test("revisions of a recreated instance never repeat an earlier one", async (t) => {
  const { hub, clock } = setup(t);
  const source = counter(hub);
  const first = listen(hub, owner, "state");
  await clock.advance(0);
  const old = first.frames[0].revision;
  first.unsubscribe();
  source.value = { n: 2 };
  const next = listen(hub, owner, "state", { instance: hub.instance, revision: old });
  await clock.advance(0);
  assert.equal(next.frames[0].type, "snapshot");
  assert.ok(next.frames[0].revision > old);
});

test("a rows cursor in the baseline answers delta; an unknown cursor snapshot", async (t) => {
  const { hub, clock } = setup(t);
  const source = { value: { items: [{ id: "a", v: 1 }], total: 1 } };
  hub.define({
    name: "rows",
    mode: "rows",
    authorize: () => true,
    scopeKey: () => "owner",
    read: () => structuredClone(source.value),
  });
  const first = listen(hub, owner, "rows");
  await clock.advance(0);
  assert.equal(first.frames[0].type, "snapshot");
  let list = applyListSync(null, first.frames[0].data);
  const cursor = list.state.sync.cursor;
  first.unsubscribe();

  const same = listen(hub, owner, "rows", { instance: hub.instance, cursor });
  await clock.advance(0);
  assert.equal(same.frames[0].type, "same");
  same.unsubscribe();

  source.value = {
    items: [
      { id: "a", v: 1 },
      { id: "b", v: 2 },
    ],
    total: 2,
  };
  const delta = listen(hub, owner, "rows", { instance: hub.instance, cursor });
  await clock.advance(0);
  assert.equal(delta.frames[0].type, "delta");
  list = applyListSync(list, delta.frames[0].data);
  assert.deepEqual(list.list, source.value);

  const unknown = listen(hub, owner, "rows", { instance: hub.instance, cursor: "nope" });
  assert.equal(unknown.frames[0].type, "snapshot");
  const foreign = listen(hub, owner, "rows", { instance: "restarted", cursor });
  assert.equal(foreign.frames[0].type, "snapshot");

  // A change reaches a subscriber as a delta against its cursor.
  source.value = { items: [{ id: "b", v: 3 }], total: 1 };
  hub.invalidate("rows");
  await clock.advance(200);
  assert.equal(delta.frames.at(-1).type, "delta");
  list = applyListSync(list, delta.frames.at(-1).data);
  assert.deepEqual(list.list, source.value);
});

test("invalidate recomputes only subscribed instances of the name and param", async (t) => {
  const { hub, clock } = setup(t);
  const reads = [];
  let total = 0;
  hub.define({
    name: "job.install",
    param: /[a-z0-9]+/,
    mode: "state",
    authorize: () => true,
    scopeKey: () => "owner",
    read: (_principal, param) => {
      reads.push(param);
      return { param, at: ++total };
    },
  });
  hub.invalidate("job.install", "a");
  assert.deepEqual(reads, []);
  const a = listen(hub, owner, "job.install:a");
  listen(hub, owner, "job.install:b");
  await clock.advance(0);
  reads.length = 0;
  hub.invalidate("job.install", "a");
  await clock.advance(200);
  assert.deepEqual(reads, ["a"]);
  assert.equal(a.frames.at(-1).type, "state");
  hub.invalidate("job.install");
  await clock.advance(200);
  assert.deepEqual(reads.sort(), ["a", "a", "b"]);
});

test("reauthorize sends revoked and stops reads for that subscriber", async (t) => {
  const { hub, clock } = setup(t);
  const allowed = new Set(["u1", "u2"]);
  let reads = 0;
  hub.define({
    name: "me.inbox",
    mode: "state",
    authorize: (principal) => allowed.has(principal.id),
    scopeKey: scope,
    read: () => ({ reads: ++reads }),
  });
  const u1 = listen(hub, user("u1"), "me.inbox");
  const u2 = listen(hub, user("u2"), "me.inbox");
  await clock.advance(0);
  allowed.delete("u1");
  hub.reauthorize();
  assert.deepEqual(u1.frames.at(-1), { type: "revoked", topic: "me.inbox" });
  const count = u1.frames.length;
  const before = reads;
  hub.invalidate("me.inbox");
  await clock.advance(200);
  assert.equal(u1.frames.length, count);
  assert.equal(reads, before + 1);
  assert.equal(u2.frames.at(-1).type, "state");
  u1.unsubscribe();
});

test("a signal change while nobody subscribes answers changed on resubscribe", async (t) => {
  const { hub, clock } = setup(t);
  hub.define({
    name: "artifacts",
    mode: "signal",
    authorize: () => true,
    scopeKey: () => "owner",
  });
  const first = listen(hub, owner, "artifacts");
  const { revision } = first.frames[0];
  first.unsubscribe();
  hub.invalidate("artifacts");
  await clock.advance(200);
  const again = listen(hub, owner, "artifacts", { instance: hub.instance, revision });
  assert.equal(again.frames[0].type, "changed");
  assert.ok(again.frames[0].revision > revision);
  // Its new revision is known afterwards.
  const third = listen(hub, owner, "artifacts", {
    instance: hub.instance,
    revision: again.frames[0].revision,
  });
  assert.equal(third.frames[0].type, "same");
});

test("state and rows topics recompute on resubscribe after an unseen change", async (t) => {
  const { hub, clock } = setup(t);
  const source = counter(hub);
  const rows = { value: { items: [{ id: "a", v: 1 }] } };
  hub.define({
    name: "rows",
    mode: "rows",
    authorize: () => true,
    scopeKey: () => "owner",
    read: () => structuredClone(rows.value),
  });
  const state = listen(hub, owner, "state");
  const list = listen(hub, owner, "rows");
  await clock.advance(0);
  const { revision } = state.frames[0];
  const held = applyListSync(null, list.frames[0].data);
  state.unsubscribe();
  list.unsubscribe();
  source.value = { n: 9 };
  rows.value = { items: [{ id: "a", v: 2 }] };
  hub.invalidate("state");
  hub.invalidate("rows");
  await clock.advance(200);
  const stateAgain = listen(hub, owner, "state", { instance: hub.instance, revision });
  const listAgain = listen(hub, owner, "rows", {
    instance: hub.instance,
    cursor: held.state.sync.cursor,
  });
  await clock.advance(0);
  assert.equal(stateAgain.frames[0].type, "snapshot");
  assert.deepEqual(stateAgain.frames[0].data, { n: 9 });
  assert.equal(listAgain.frames[0].type, "delta");
  assert.deepEqual(applyListSync(held, listAgain.frames[0].data).list, rows.value);
});

test("define drops stateful and multiline flags from param patterns", (t) => {
  const { hub } = setup(t);
  hub.define({
    name: "session.models",
    param: /[a-z]+/gmy,
    mode: "state",
    authorize: () => true,
    scopeKey: () => "owner",
    read: () => 1,
  });
  assert.equal(hub.resolve(owner, "session.models:ab\ncd"), null);
  assert.equal(hub.resolve(owner, "session.models:ab").param, "ab");
  assert.equal(hub.resolve(owner, "session.models:ab").param, "ab");
});

test("the unknown-topic frame echoes a bounded string topic", (t) => {
  const { hub } = setup(t);
  assert.deepEqual(listen(hub, owner, 42).frames[0], unknownTopic(""));
  const long = listen(hub, owner, "x".repeat(5000)).frames[0];
  assert.equal(long.topic.length, MAX_TOPIC_ID);
});

test("close drops kept revisions and row baselines", async (t) => {
  const { hub, clock } = setup(t);
  counter(hub);
  const first = listen(hub, owner, "state");
  await clock.advance(0);
  first.unsubscribe();
  const sync = hub.sync;
  hub.close();
  assert.equal(hub.records.size, 0);
  assert.notEqual(hub.sync, sync);
});
