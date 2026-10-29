import test from "node:test";
import assert from "node:assert/strict";
import { WRITTEN_WAIT_MS, startLiveTopic } from "../../web/lib/live/live-topic-reader.js";
import { fakeEnv, settle } from "../helpers/fake-browser.js";
import { noteReadStamp } from "../../web/lib/read-stamps.js";
import { fakeClient, ok, setup } from "../helpers/live-topic-reader-fixture.js";

// The read stamps behind useLiveTopic (a push and a REST answer: the later read shows)
// and written(), which follows the caller's own write.

test("of a push and a REST answer, the one read later is shown", async (t) => {
  let release;
  const slow = () => new Promise((resolve) => (release = resolve));
  const s = setup("inbox", { responses: [slow, ok(noteReadStamp({ n: 3 }, 400))] });
  t.after(s.reader.stop);
  // A refresh after a write; a push read before the write arrives during it.
  const answer = s.reader.refresh();
  await settle();
  s.client.emit({ type: "data", data: { n: 1 }, revision: 1, readAt: 100 });
  release(noteReadStamp({ n: 2 }, 200));
  assert.deepEqual(await answer, { n: 2 });
  assert.deepEqual(s.last().data, { n: 2 });
  // A push read before the answer never undoes it; one read after it shows.
  s.client.emit({ type: "data", data: { n: 1 }, revision: 2, readAt: 150 });
  assert.deepEqual(s.last().data, { n: 2 });
  s.client.emit({ type: "data", data: { n: 5 }, revision: 3, readAt: 500 });
  assert.deepEqual(s.last().data, { n: 5 });
  // A REST answer read before the shown push resolves, but is not shown.
  assert.deepEqual(await s.reader.refresh(), { n: 3 });
  assert.deepEqual(s.last().data, { n: 5 });
});

test("read stamps compare only within one server instance", async (t) => {
  const s = setup("inbox", { client: fakeClient({ connected: true }) });
  t.after(s.reader.stop);
  s.client.emit({
    type: "data",
    data: { n: 1 },
    revision: 1,
    readAt: 900,
    instance: "a",
  });
  s.client.emit({
    type: "data",
    data: { n: 0 },
    revision: 2,
    readAt: 800,
    instance: "a",
  });
  assert.deepEqual(s.last().data, { n: 1 });
  // The server restarted on a clock that went back: its values still show.
  s.client.emit({ type: "status", connected: true, fallback: false, instance: "b" });
  s.client.emit({
    type: "data",
    data: { n: 2 },
    revision: 1,
    readAt: 500,
    instance: "b",
  });
  assert.deepEqual(s.last().data, { n: 2 });
  assert.equal(s.last().readAt, 500);
  s.client.emit({
    type: "data",
    data: { n: 3 },
    revision: 2,
    readAt: 400,
    instance: "b",
  });
  assert.deepEqual(s.last().data, { n: 2 });
});

test("written waits for the write's push, or reads the route when none comes", async (t) => {
  const s = setup("inbox", { client: fakeClient({ connected: true }) });
  t.after(s.reader.stop);
  s.client.emit({ type: "data", data: { n: 1 }, revision: 1 });
  // Connected: it resolves with the push that follows the write, and reads nothing.
  let answered = null;
  const pending = s.reader.written().then((data) => (answered = data));
  await settle();
  assert.equal(answered, null);
  s.client.emit({ type: "data", data: { n: 2 }, revision: 2 });
  assert.deepEqual(await pending, { n: 2 });
  assert.deepEqual(s.reads, []);
  // No push (the write left the value as it was): the route answers after the wait.
  const quiet = s.reader.written();
  await s.fake.advance(WRITTEN_WAIT_MS - 1);
  assert.deepEqual(s.reads, []);
  await s.fake.advance(1);
  assert.deepEqual(await quiet, { path: "/inbox" });
  assert.deepEqual(s.reads, ["/inbox"]);
  // Without a connection, it reads the route at once.
  s.client.emit({ type: "status", connected: false, fallback: false });
  assert.deepEqual(await s.reader.written(), { path: "/inbox" });
  assert.deepEqual(s.reads, ["/inbox", "/inbox"]);
  // A refused topic is polled, not pushed; written reads it at once too.
  s.client.emit({ type: "status", connected: true, fallback: false });
  s.client.emit({ type: "error", code: "unknown-topic" });
  assert.deepEqual(await s.reader.written(), { path: "/inbox" });
  assert.deepEqual(s.reads, ["/inbox", "/inbox", "/inbox"]);
});

test("written calls the browser's timers unbound, as window's require", async () => {
  const fake = fakeEnv();
  const strict = (fn) =>
    function (...args) {
      if (this !== undefined && this !== globalThis)
        throw new TypeError("Illegal invocation");
      return fn(...args);
    };
  const client = fakeClient({ connected: true });
  const reader = startLiveTopic({
    topicId: "inbox",
    client,
    env: {
      ...fake.env,
      setTimeout: strict(fake.env.setTimeout),
      clearTimeout: strict(fake.env.clearTimeout),
    },
    read: async (path) => ({ path }),
    report: () => {},
  });
  const pending = reader.written();
  await fake.advance(WRITTEN_WAIT_MS);
  assert.deepEqual(await pending, { path: "/inbox" });
  reader.stop();
});

test("written ignores a push read before the write's answer", async (t) => {
  const s = setup("inbox", { client: fakeClient({ connected: true }) });
  t.after(s.reader.stop);
  s.client.emit({
    type: "data",
    data: { n: 1 },
    revision: 1,
    readAt: 100,
    instance: "a",
  });
  // The write answered at 300 (its X-Read-Started).
  noteReadStamp({}, 300, { instance: "a", write: true });
  let answered = null;
  const pending = s.reader.written().then((data) => (answered = data));
  // A push read at 200, before the write, arrives after it: still the old state.
  s.client.emit({
    type: "data",
    data: { n: 2 },
    revision: 2,
    readAt: 200,
    instance: "a",
  });
  await settle();
  assert.equal(answered, null);
  // The push read after the write shows it.
  s.client.emit({
    type: "data",
    data: { n: 3 },
    revision: 3,
    readAt: 400,
    instance: "a",
  });
  assert.deepEqual(await pending, { n: 3 });
  assert.deepEqual(s.reads, []);
});

test("a poll after a restart in fallback mode shows though its clock went back", async (t) => {
  const s = setup("inbox", {
    client: fakeClient({ connected: true }),
    responses: [ok(noteReadStamp({ n: 2 }, 500, { instance: "new" }))],
  });
  t.after(s.reader.stop);
  s.client.emit({
    type: "data",
    data: { n: 1 },
    revision: 1,
    readAt: 900,
    instance: "old",
  });
  // The server restarted on a clock that went back; the socket is down.
  s.client.emit({ type: "status", connected: false, fallback: true });
  await s.fake.advance(5000);
  assert.deepEqual(s.last().data, { n: 2 });
  assert.equal(s.last().readAt, 500);
});

test("a written() still waiting resolves null when the topic stops", async () => {
  const s = setup("inbox", { client: fakeClient({ connected: true }) });
  const pending = s.reader.written();
  s.reader.stop();
  assert.equal(await pending, null);
});
