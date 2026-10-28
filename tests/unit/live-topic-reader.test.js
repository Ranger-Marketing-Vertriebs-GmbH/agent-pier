import test from "node:test";
import assert from "node:assert/strict";
import { followSignal, startLiveTopic } from "../../web/lib/live/live-topic-reader.js";
import { apiCopy } from "../../web/lib/i18n/messages/components.js";
import { fakeEnv, settle } from "../helpers/fake-browser.js";

// The state machine behind useLiveTopic, against a fake LiveClient: pushed data,
// one GET after stale/changed, and the visible-only poll during a fallback.
function fakeClient({ connected = false, fallback = false } = {}) {
  const subscriptions = [];
  let status = { connected, fallback };
  return {
    subscriptions,
    subscribe(topicId, listener, options) {
      const entry = { topicId, listener, options, active: true };
      subscriptions.push(entry);
      return () => (entry.active = false);
    },
    status: () => status,
    emit(event) {
      if (event.type === "status") status = { ...event, type: undefined };
      for (const entry of subscriptions) if (entry.active) entry.listener(event);
    },
  };
}
function setup(
  topicId,
  { client = fakeClient(), responses = [], hidden = false, path } = {},
) {
  const fake = fakeEnv({ hidden });
  let clock = 0;
  const reads = [];
  const reports = [];
  const reader = startLiveTopic({
    topicId,
    path,
    client,
    env: { ...fake.env, now: () => clock },
    read: (path, signal) => {
      reads.push(path);
      const next = responses[Math.min(reads.length - 1, responses.length - 1)];
      return next ? next(signal) : Promise.resolve({ path });
    },
    report: (state) => reports.push(state),
  });
  return {
    fake,
    client,
    reader,
    reads,
    reports,
    last: () => reports.at(-1),
    tick: (ms) => (clock += ms),
  };
}
const ok = (data) => async () => data;
const hang = (signal) =>
  new Promise((_resolve, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason)),
  );

test("pushed data is reported without a request", async (t) => {
  const s = setup("session.models:a");
  t.after(s.reader.stop);
  assert.deepEqual(s.client.subscriptions[0].options, { sampled: true });
  assert.deepEqual(s.last(), { data: null, error: "", loading: true, connected: false });
  s.client.emit({ type: "status", connected: true, fallback: false });
  s.client.emit({ type: "data", data: ["m"], revision: 1 });
  await s.fake.advance(60000);
  assert.deepEqual(s.reads, []);
  assert.deepEqual(s.last(), { data: ["m"], error: "", loading: false, connected: true });
});

test("stale and changed cause one GET of the topic's path", async (t) => {
  const s = setup("inbox", { responses: [ok({ n: 1 }), ok({ n: 2 })] });
  t.after(s.reader.stop);
  s.client.emit({ type: "stale" });
  await settle();
  assert.deepEqual(s.reads, ["/inbox"]);
  assert.deepEqual(s.last().data, { n: 1 });
  s.client.emit({ type: "changed" });
  await settle();
  assert.deepEqual(s.reads, ["/inbox", "/inbox"]);
  assert.deepEqual(s.last().data, { n: 2 });
  await s.fake.advance(60000);
  assert.equal(s.reads.length, 2);
});

test("a stale frame while hidden is read once the tab is visible", async (t) => {
  const s = setup("inbox", { hidden: true });
  t.after(s.reader.stop);
  s.client.emit({ type: "stale" });
  s.client.emit({ type: "stale" });
  await s.fake.advance(60000);
  assert.deepEqual(s.reads, []);
  s.fake.setHidden(false);
  await settle();
  assert.deepEqual(s.reads, ["/inbox"]);
});

test("hiding aborts a one-time read silently and repeats it on visible", async (t) => {
  const s = setup("inbox", { responses: [hang, ok({ n: 3 })] });
  t.after(s.reader.stop);
  s.client.emit({ type: "stale" });
  await settle();
  s.fake.setHidden(true);
  await settle();
  assert.equal(s.last().error, "");
  s.fake.setHidden(false);
  await settle();
  assert.equal(s.reads.length, 2);
  assert.deepEqual(s.last().data, { n: 3 });
});

test("a read past its deadline shows the timeout error and keeps the data", async (t) => {
  const s = setup("inbox", { responses: [hang] });
  t.after(s.reader.stop);
  s.client.emit({ type: "data", data: { n: 1 }, revision: 1 });
  s.client.emit({ type: "stale" });
  await s.fake.advance(15000);
  assert.deepEqual(s.last(), {
    data: { n: 1 },
    error: apiCopy.timedOut,
    loading: false,
    connected: false,
  });
});

test("an older read does not replace newer pushed data", async (t) => {
  let release;
  const slow = () => new Promise((resolve) => (release = resolve));
  const s = setup("inbox", { responses: [slow] });
  t.after(s.reader.stop);
  s.client.emit({ type: "stale" });
  await settle();
  s.client.emit({ type: "data", data: { n: 9 }, revision: 9 });
  release({ n: 1 });
  await settle();
  assert.deepEqual(s.last().data, { n: 9 });
});

test("the fallback polls the path while visible; hello ends it", async (t) => {
  const s = setup("state", { responses: [ok({ sessions: [] })] });
  t.after(s.reader.stop);
  s.client.emit({ type: "status", connected: false, fallback: true });
  await settle();
  assert.deepEqual(s.reads, ["/state"]);
  await s.fake.advance(3000);
  assert.equal(s.reads.length, 2);
  s.fake.setHidden(true);
  await s.fake.advance(30000);
  assert.equal(s.reads.length, 2);
  s.fake.setHidden(false);
  await settle();
  assert.equal(s.reads.length, 3);
  s.client.emit({ type: "status", connected: true, fallback: false });
  await s.fake.advance(30000);
  assert.equal(s.reads.length, 3);
  assert.equal(s.last().connected, true);
});

test("a client already in fallback polls from the start", async (t) => {
  const client = fakeClient({ fallback: true });
  const s = setup("session.requests:x", { client });
  t.after(s.reader.stop);
  await settle();
  assert.deepEqual(s.reads, ["/sessions/x/requests"]);
  await s.fake.advance(1500);
  assert.equal(s.reads.length, 2);
});

test("the fallback skips its first poll right after a read", async (t) => {
  const s = setup("inbox");
  t.after(s.reader.stop);
  assert.deepEqual(await s.reader.refresh(), { path: "/inbox" });
  s.tick(1000);
  s.client.emit({ type: "status", connected: false, fallback: true });
  await settle();
  assert.equal(s.reads.length, 1);
  await s.fake.advance(5000);
  assert.equal(s.reads.length, 2);
});

test("an unknown or revoked topic falls back to polling", async (t) => {
  for (const event of [{ type: "error", code: "unknown-topic" }, { type: "revoked" }]) {
    const s = setup("inbox");
    t.after(s.reader.stop);
    s.client.emit({ type: "status", connected: true, fallback: false });
    s.client.emit(event);
    await settle();
    assert.equal(s.reads.length, 1);
    await s.fake.advance(5000);
    assert.equal(s.reads.length, 2);
  }
});

test("a failed first read on the server gets one GET", async (t) => {
  const s = setup("inbox");
  t.after(s.reader.stop);
  s.client.emit({ type: "error" });
  await settle();
  assert.equal(s.reads.length, 1);
  s.client.emit({ type: "error" });
  await settle();
  assert.equal(s.reads.length, 1);
});

test("refresh resolves with the data, or null when the read failed", async (t) => {
  const fail = async () => {
    throw new Error("boom");
  };
  const s = setup("inbox", { responses: [ok({ n: 1 }), fail] });
  t.after(s.reader.stop);
  assert.deepEqual(await s.reader.refresh(), { n: 1 });
  assert.equal(await s.reader.refresh(), null);
  assert.deepEqual(s.last(), {
    data: { n: 1 },
    error: "boom",
    loading: false,
    connected: false,
  });
});

test("stop unsubscribes and ends polling", async () => {
  const s = setup("inbox");
  s.client.emit({ type: "status", connected: false, fallback: true });
  await settle();
  s.reader.stop();
  assert.equal(s.client.subscriptions[0].active, false);
  await s.fake.advance(60000);
  assert.equal(s.reads.length, 1);
});

test("a refused topic stops polling once data or a connection comes back", async (t) => {
  for (const back of [
    { type: "data", data: { n: 1 }, revision: 1 },
    { type: "status", connected: true, fallback: false },
  ]) {
    const s = setup("inbox");
    t.after(s.reader.stop);
    s.client.emit({ type: "status", connected: true, fallback: false });
    s.client.emit({ type: "error", code: "unknown-topic" });
    await settle();
    assert.equal(s.reads.length, 1);
    s.client.emit({ type: "status", connected: false, fallback: false });
    s.client.emit(back);
    await s.fake.advance(30000);
    assert.equal(s.reads.length, 1);
  }
});

test("a topic without a REST route stops loading when it is refused or fails", async (t) => {
  for (const event of [
    { type: "error", code: "unknown-topic" },
    { type: "revoked" },
    { type: "error" },
    { type: "stale" },
  ]) {
    const s = setup("custom.topic");
    t.after(s.reader.stop);
    s.client.emit(event);
    await settle();
    assert.deepEqual(s.reads, []);
    assert.equal(s.last().loading, false);
  }
});

test("followSignal counts changed frames only", (t) => {
  const client = fakeClient();
  let count = 0;
  const stop = followSignal(client, "pipeline.counts", () => (count += 1));
  t.after(stop);
  client.emit({ type: "changed" });
  client.emit({ type: "data", data: 1, revision: 1 });
  client.emit({ type: "status", connected: true, fallback: false });
  client.emit({ type: "changed" });
  assert.equal(count, 2);
  stop();
  client.emit({ type: "changed" });
  assert.equal(count, 2);
});

test("set replaces the data at once and drops a read already under way", async (t) => {
  let resolve;
  const late = () => new Promise((done) => (resolve = done));
  const s = setup("session.requests:a", { responses: [late] });
  t.after(s.reader.stop);
  s.client.emit({ type: "stale" });
  await settle();
  s.reader.set({ requests: [{ id: "answered" }] });
  assert.deepEqual(s.last().data, { requests: [{ id: "answered" }] });
  resolve({ requests: [{ id: "older" }] });
  await settle();
  assert.deepEqual(s.last().data, { requests: [{ id: "answered" }] });
  s.client.emit({ type: "data", data: { requests: [] }, revision: 2 });
  assert.deepEqual(s.last().data, { requests: [] });
});

test("a signal topic reads the caller's route at the start and once per changed", async (t) => {
  const path = "/pipeline-runs?page=2";
  const s = setup("pipeline.runs.changed:p1", {
    path,
    responses: [ok({ page: 2, n: 1 }), ok({ page: 2, n: 2 })],
  });
  t.after(s.reader.stop);
  await settle();
  assert.deepEqual(s.reads, [path]);
  assert.deepEqual(s.last().data, { page: 2, n: 1 });
  s.client.emit({ type: "status", connected: true, fallback: false });
  await s.fake.advance(60000);
  assert.deepEqual(s.reads, [path]);
  s.client.emit({ type: "changed" });
  await settle();
  assert.deepEqual(s.reads, [path, path]);
  assert.deepEqual(s.last().data, { page: 2, n: 2 });
});

test("a signal topic opened hidden reads once it is visible", async (t) => {
  const s = setup("pipeline.runs.changed", {
    path: "/pipeline-runs?page=3",
    hidden: true,
  });
  t.after(s.reader.stop);
  await settle();
  s.client.emit({ type: "changed" });
  await s.fake.advance(10000);
  assert.deepEqual(s.reads, []);
  s.fake.setHidden(false);
  await settle();
  assert.deepEqual(s.reads, ["/pipeline-runs?page=3"]);
});

test("a signal topic in fallback polls the caller's route, visible only", async (t) => {
  const path = "/pipeline-runs?page=2";
  const s = setup("pipeline.runs.changed", {
    path,
    client: fakeClient({ fallback: true }),
  });
  t.after(s.reader.stop);
  await settle();
  assert.deepEqual(s.reads, [path]);
  await s.fake.advance(5000);
  assert.deepEqual(s.reads, [path, path]);
  s.fake.setHidden(true);
  await s.fake.advance(20000);
  assert.equal(s.reads.length, 2);
});

test("changes during a read read once more after it, never cutting it short", async (t) => {
  const pending = [];
  const slow = (signal) =>
    new Promise((resolve, reject) => {
      pending.push(resolve);
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  const s = setup("pipeline.runs.changed", { path: "/p", responses: [slow] });
  t.after(s.reader.stop);
  await settle();
  s.client.emit({ type: "changed" });
  s.client.emit({ type: "changed" });
  await settle();
  assert.equal(s.reads.length, 1);
  pending[0]({ n: 1 });
  await settle();
  assert.deepEqual(s.last().data, { n: 1 });
  assert.equal(s.reads.length, 2);
  pending[1]({ n: 2 });
  await settle();
  assert.deepEqual(s.last().data, { n: 2 });
  assert.equal(s.reads.length, 2);
});

test("a topic with sections reads each section's route into its value", async (t) => {
  const s = setup("agent.list");
  t.after(s.reader.stop);
  s.client.emit({ type: "stale" });
  await settle();
  assert.deepEqual(s.reads, ["/assistants", "/assistant-runtime"]);
  assert.deepEqual(s.last().data, {
    path: "/assistants",
    runtime: { path: "/assistant-runtime" },
  });
  assert.deepEqual(await s.reader.refresh(), s.last().data);
  assert.equal(s.reads.length, 4);
});
