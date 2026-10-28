import test from "node:test";
import assert from "node:assert/strict";
import { LiveInstance } from "../../server/features/live/live-instance.js";
import { ChatSync } from "../../server/features/chat/chat-sync.js";
import { manualTimers } from "../helpers/manual-timers.js";

const HUB = "hub-1";

/** One instance over `source.value`, counting reads; `extra` overrides the definition. */
function setup(t, extra = {}, options = {}) {
  const clock = manualTimers();
  const source = { value: { count: 0 }, reads: 0, hold: null };
  const hooks = {};
  const definition = {
    name: "demo",
    mode: "state",
    authorize: () => true,
    scopeKey: () => "owner",
    read: async () => {
      source.reads++;
      if (source.hold) await source.hold;
      return structuredClone(source.value);
    },
    watch: ({ invalidate, nudge }) => {
      Object.assign(hooks, { invalidate, nudge, watching: true });
      return () => (hooks.watching = false);
    },
    ...extra,
  };
  const instance = new LiveInstance({
    definition,
    topicId: "demo",
    scopeKey: "owner",
    instance: HUB,
    sync: new ChatSync({}),
    timers: clock.timers,
    debounceMs: 150,
    maxWaitMs: 1000,
    ...options,
  });
  t.after(() => instance.stop());
  return { clock, source, hooks, instance };
}

function listen(instance, have) {
  const frames = [];
  const subscriber = { principal: { role: "owner" }, have, send: (f) => frames.push(f) };
  instance.add(subscriber);
  return { frames, subscriber, remove: () => instance.remove(subscriber) };
}

test("N invalidations within the debounce cause one read", async (t) => {
  const { clock, source, hooks, instance } = setup(t);
  const { frames } = listen(instance);
  await clock.advance(0);
  assert.equal(source.reads, 1);
  assert.equal(frames[0].type, "snapshot");
  for (let i = 0; i < 10; i++) {
    source.value = { count: i + 1 };
    hooks.invalidate();
    await clock.advance(10);
  }
  await clock.advance(149);
  assert.equal(source.reads, 2);
  assert.deepEqual(frames.at(-1), {
    type: "state",
    topic: "demo",
    revision: 2,
    data: { count: 10 },
  });
});

test("maxWait forces a read under continuous invalidation", async (t) => {
  const { clock, source, hooks, instance } = setup(t);
  listen(instance);
  await clock.advance(0);
  const start = clock.now();
  const readsAt = [];
  while (clock.now() - start < 1100) {
    const before = source.reads;
    hooks.invalidate();
    await clock.advance(100);
    if (source.reads > before) readsAt.push(clock.now() - start);
  }
  assert.deepEqual(readsAt, [1000]);
});

test("an invalidation during a read causes exactly one more read", async (t) => {
  const { clock, source, hooks, instance } = setup(t);
  const { frames } = listen(instance);
  await clock.advance(0);
  let release;
  source.hold = new Promise((resolve) => (release = resolve));
  hooks.invalidate();
  await clock.advance(150);
  assert.equal(source.reads, 2);
  // Changes while the read runs: the last one must still be read once.
  for (let i = 0; i < 5; i++) {
    source.value = { count: 100 + i };
    hooks.invalidate();
  }
  source.hold = null;
  release();
  await clock.advance(2000);
  assert.equal(source.reads, 3);
  assert.deepEqual(frames.at(-1).data, { count: 104 });
});

test("an unchanged digest sends no frame and keeps the revision", async (t) => {
  const { clock, hooks, instance } = setup(t);
  const { frames } = listen(instance);
  await clock.advance(0);
  const revision = instance.revision;
  hooks.invalidate();
  await clock.advance(200);
  assert.equal(frames.length, 1);
  assert.equal(instance.revision, revision);
});

test("a custom digest ignores fields that do not count as a change", async (t) => {
  const { clock, source, hooks, instance } = setup(t, {
    digest: ({ age: _age, ...rest }) => rest,
  });
  const { frames } = listen(instance);
  await clock.advance(0);
  source.value = { count: 0, age: 5 };
  hooks.invalidate();
  await clock.advance(200);
  assert.equal(frames.length, 1);
});

test("a changed digest raises the revision by one", async (t) => {
  const { clock, source, hooks, instance } = setup(t);
  const { frames } = listen(instance);
  await clock.advance(0);
  const revision = instance.revision;
  source.value = { count: 1 };
  hooks.invalidate();
  await clock.advance(200);
  assert.equal(instance.revision, revision + 1);
  assert.equal(frames.at(-1).revision, revision + 1);
});

test("a frame over maxBytes sends stale instead", async (t) => {
  const { clock, source, hooks, instance } = setup(t, { maxBytes: 200 });
  const { frames } = listen(instance);
  await clock.advance(0);
  source.value = { text: "x".repeat(500) };
  hooks.invalidate();
  await clock.advance(200);
  assert.deepEqual(frames.at(-1), {
    type: "stale",
    topic: "demo",
    revision: instance.revision,
  });
});

test("the sampler starts with the first subscriber and stops with the last", async (t) => {
  const { clock, source, hooks, instance } = setup(t, { sampleMs: 3000 });
  assert.equal(clock.pending(), 0);
  const first = listen(instance);
  const second = listen(instance);
  assert.equal(hooks.watching, true);
  await clock.advance(0);
  assert.equal(source.reads, 1);
  await clock.advance(9000);
  assert.equal(source.reads, 4);
  first.remove();
  await clock.advance(3000);
  assert.equal(source.reads, 5);
  second.remove();
  assert.equal(hooks.watching, false);
  assert.equal(clock.pending(), 0);
  await clock.advance(9000);
  assert.equal(source.reads, 5);
});

test("sampling() false skips the read", async (t) => {
  let sampling = true;
  const { clock, source, instance } = setup(t, {
    sampleMs: 1000,
    sampling: () => sampling,
  });
  listen(instance);
  await clock.advance(0);
  await clock.advance(1000);
  assert.equal(source.reads, 2);
  sampling = false;
  await clock.advance(5000);
  assert.equal(source.reads, 2);
  sampling = true;
  await clock.advance(1000);
  assert.equal(source.reads, 3);
});

test("nudge reads before the next sample", async (t) => {
  const { clock, source, hooks, instance } = setup(t, { sampleMs: 3000 });
  const { frames } = listen(instance);
  await clock.advance(0);
  await clock.advance(500);
  source.value = { count: 7 };
  hooks.nudge();
  await clock.advance(150);
  assert.equal(source.reads, 2);
  assert.deepEqual(frames.at(-1).data, { count: 7 });
  // The next sample counts from the nudged read.
  await clock.advance(2999);
  assert.equal(source.reads, 2);
  await clock.advance(1);
  assert.equal(source.reads, 3);
});

test("a nudge while sampling() is false reads nothing", async (t) => {
  const { clock, source, hooks, instance } = setup(t, {
    sampleMs: 3000,
    sampling: () => false,
  });
  listen(instance);
  await clock.advance(0);
  hooks.nudge();
  await clock.advance(500);
  assert.equal(source.reads, 1);
});

test("a subscriber joining a settled instance is answered without a read", async (t) => {
  const { clock, source, instance } = setup(t);
  listen(instance);
  await clock.advance(0);
  const late = listen(instance);
  assert.equal(late.frames[0].type, "snapshot");
  assert.equal(source.reads, 1);
});

test("signal mode answers same and then changed on each change", async (t) => {
  const { clock, source, hooks, instance } = setup(t, {
    mode: "signal",
    read: undefined,
  });
  const { frames } = listen(instance);
  assert.deepEqual(frames, [{ type: "same", topic: "demo", revision: 0 }]);
  hooks.invalidate();
  hooks.invalidate();
  await clock.advance(200);
  assert.deepEqual(frames.at(-1), { type: "changed", topic: "demo", revision: 1 });
  assert.equal(frames.length, 2);
  assert.equal(source.reads, 0);
});

test("a failed read reports the error and keeps the last value", async (t) => {
  const errors = [];
  let fail = false;
  const { clock, source, hooks, instance } = setup(
    t,
    {
      read: async () => {
        source.reads++;
        if (fail) throw new Error("gone");
        return { ok: true };
      },
    },
    { onError: (error) => errors.push(error.message) },
  );
  const { frames } = listen(instance);
  await clock.advance(0);
  fail = true;
  hooks.invalidate();
  await clock.advance(200);
  assert.deepEqual(errors, ["gone"]);
  assert.equal(frames.length, 1);
  const late = listen(instance);
  assert.deepEqual(late.frames[0].data, { ok: true });
});

test("a subscriber leaving during sampling() stops the cycle before a read", async (t) => {
  let release;
  const { clock, source, instance } = setup(t, {
    sampleMs: 1000,
    sampling: () => new Promise((resolve) => (release = resolve)),
  });
  const { remove } = listen(instance);
  await clock.advance(1000);
  remove();
  release(true);
  await clock.advance(0);
  assert.equal(source.reads, 1);
});
