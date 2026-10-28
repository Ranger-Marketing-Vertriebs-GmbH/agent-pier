import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { FileJobClient } from "../../web/features/files/file-job-client.js";

// The explorer's job envelopes come from the live topic `files.jobs:<scope>`: a
// pushed envelope needs no read of /jobs or /jobs/<id>, and a job's result pages are
// read again only when its version (`updatedAt`) changes. Without the channel, or for
// a job the pushed page does not carry, the explorer polls as before.

const copy = (status, updatedAt, extra = {}) => ({
  id: "copy",
  scopeId: "scope",
  kind: "copy",
  status,
  completedEntries: 0,
  conflict: null,
  issue: null,
  updatedAt,
  ...extra,
});
const page = (...jobs) => ({ jobs, nextCursor: null });

function fakeLive({ connected = true } = {}) {
  const listeners = new Set();
  const topics = [];
  let status = { connected, fallback: false };
  return {
    topics,
    subscribe(topic, listener) {
      topics.push(topic);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: () => status,
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    push(data) {
      this.emit({ type: "data", data, revision: 1 });
    },
    setStatus(next) {
      status = { ...status, ...next };
      this.emit({ type: "status", ...status });
    },
    listening: () => listeners.size,
  };
}

function fixture({ get, mutate, live = fakeLive(), hidden: startHidden = false }) {
  let hidden = startHidden,
    wake;
  const reads = [];
  const timers = new Map();
  let sequence = 0;
  const client = {
    jobsTopic: "files.jobs:global",
    async get(suffix, query, signal) {
      reads.push(suffix);
      return get(suffix, query, signal);
    },
    mutate,
  };
  const session = new FileJobClient(
    client,
    {
      hidden: () => hidden,
      listen: (callback) => {
        wake = callback;
        return () => (wake = null);
      },
      timer: (callback, delay) => {
        timers.set(++sequence, { callback, delay });
        return sequence;
      },
      clear: (id) => timers.delete(id),
    },
    live,
  );
  const unsubscribe = session.subscribe(() => {});
  return {
    session,
    live,
    reads,
    timers,
    unsubscribe,
    wake: (value = hidden) => {
      hidden = value;
      wake?.();
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

test("a pushed copy job's progress needs no job reads; pages are read per version", async () => {
  let rows = [];
  const f = fixture({
    get: async (suffix) => {
      assert.equal(suffix, "/jobs/copy/entries");
      return { entries: rows, nextCursor: null };
    },
  });
  await settle();
  assert.deepEqual(f.live.topics, ["files.jobs:global"]);
  assert.deepEqual(f.reads, []);
  f.live.push(page(copy("running", 1)));
  await settle();
  assert.equal(f.session.state.jobs[0].status, "running");
  assert.deepEqual(f.reads, ["/jobs/copy/entries"]);
  // The same version again (a resubscribe's snapshot): nothing is read.
  f.live.push(page(copy("running", 1)));
  await settle();
  assert.equal(f.reads.length, 1);
  rows = [{ id: "a", status: "completed" }];
  f.live.push(page(copy("running", 2, { completedEntries: 1 })));
  await settle();
  assert.equal(f.reads.length, 2);
  assert.equal(f.session.state.jobs[0].completedEntries, 1);
  assert.equal(f.timers.size, 0);
  f.live.push(page(copy("completed", 3, { completedEntries: 1 })));
  await settle();
  assert.equal(f.reads.length, 3);
  assert.equal(f.session.tracked.size, 0);
  assert.equal(f.session.state.entries.copy.complete, true);
  assert.equal(f.timers.size, 0);
  f.unsubscribe();
  assert.equal(f.live.listening(), 0);
});

test("a pushed explorer reads nothing on focus; a hidden one waits until shown", async () => {
  const f = fixture({
    get: async () => ({ entries: [], nextCursor: null }),
  });
  f.live.push(page());
  await settle();
  f.wake(false);
  await settle();
  assert.deepEqual(f.reads, []);
  f.wake(true);
  f.live.push(page(copy("running", 1)));
  await settle();
  assert.deepEqual(f.reads, []);
  assert.equal(f.session.state.jobs[0].status, "running");
  f.wake(false);
  await settle();
  assert.deepEqual(f.reads, ["/jobs/copy/entries"]);
  f.unsubscribe();
});

test("without the channel the explorer reads /jobs and polls a running job", async () => {
  const live = fakeLive({ connected: false });
  const f = fixture({
    live,
    get: async (suffix) =>
      suffix === "/jobs"
        ? page(copy("running", 1))
        : suffix === "/jobs/copy"
          ? copy("running", 1)
          : { entries: [], nextCursor: null },
  });
  await settle();
  assert.deepEqual(f.reads, ["/jobs", "/jobs/copy", "/jobs/copy/entries"]);
  assert.equal([...f.timers.values()][0]?.delay, 1500);
  // Connected and pushed, the timer goes; a refused topic brings it back.
  f.live.setStatus({ connected: true });
  f.live.push(page(copy("running", 1)));
  await settle();
  assert.equal(f.timers.size, 0);
  f.live.emit({ type: "error", code: "unknown-topic" });
  await settle();
  assert.equal(f.reads.at(-3), "/jobs");
  assert.equal(f.timers.size, 1);
  f.unsubscribe();
});

test("a tracked job the pushed page does not carry is read and polled", async () => {
  const f = fixture({
    get: async (suffix) =>
      suffix === "/jobs/copy" ? copy("running", 2) : { entries: [], nextCursor: null },
    mutate: async () => copy("queued", 1),
  });
  f.live.push(page());
  await settle();
  await f.session.start("scope", { kind: "copy" });
  const [timer] = [...f.timers.values()];
  f.timers.clear();
  timer.callback();
  await settle();
  assert.deepEqual(f.reads, ["/jobs/copy", "/jobs/copy/entries"]);
  assert.equal(f.timers.size, 1);
  // Once the page carries it, the push alone follows it.
  f.live.push(page(copy("running", 3)));
  await settle();
  assert.equal(f.timers.size, 0);
  f.unsubscribe();
});

test("an older answer never replaces a newer pushed envelope", async () => {
  const f = fixture({
    get: async (suffix) =>
      suffix === "/jobs"
        ? page(copy("cancelling", 5))
        : { entries: [], nextCursor: null },
    mutate: async () => copy("running", 4),
  });
  f.live.push(page(copy("cancelling", 5)));
  await settle();
  await f.session.cancel("scope", "copy");
  assert.equal(f.session.state.jobs[0].status, "cancelling");
  assert.equal(f.session.state.jobs[0].updatedAt, 5);
  // A stale frame reads /jobs once over REST.
  f.live.emit({ type: "stale" });
  await settle();
  assert.equal(f.reads.filter((suffix) => suffix === "/jobs").length, 1);
  f.unsubscribe();
});

test("a channel lost before its first page reads the list over REST", async () => {
  const f = fixture({ get: async () => page() });
  await settle();
  assert.deepEqual(f.reads, []);
  f.live.setStatus({ connected: false });
  await settle();
  assert.deepEqual(f.reads, ["/jobs"]);
  // Once a list is held, losing the channel reads nothing until it is needed.
  f.live.setStatus({ connected: true });
  f.live.setStatus({ connected: false });
  await settle();
  assert.deepEqual(f.reads, ["/jobs"]);
  f.unsubscribe();
});

test("a push during a read is read after it, or once a hidden tab is shown", async () => {
  const gate = Promise.withResolvers();
  let first = true;
  const f = fixture({
    get: async () => {
      if (first) {
        first = false;
        await gate.promise;
      }
      return { entries: [], nextCursor: null };
    },
  });
  f.live.push(page(copy("running", 1)));
  await settle();
  f.live.push(page(copy("running", 2)));
  f.wake(true);
  gate.resolve();
  await settle();
  assert.equal(f.reads.length, 1);
  f.wake(false);
  await settle();
  assert.equal(f.reads.length, 2);
  f.unsubscribe();
});
