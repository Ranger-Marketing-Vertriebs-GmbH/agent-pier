import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";

const waitingRun = {
  id: "run-waiting",
  status: "awaiting-human",
  revision: 2,
  pipelineName: "Release",
  cwd: "/fixture/app",
  currentNodeId: "gate",
  nodes: [{ id: "gate", status: "awaiting-gate", kind: "gate" }],
  executionLog: [],
  createdAt: "2026-10-17T10:00:00.000Z",
};

/** Reads server-sent events from a streamed response until `count` arrived. */
async function readEvents(response, count) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("");
      if (data) events.push(JSON.parse(data));
    }
  }
  return { events, reader };
}

test("the inbox lists, streams revisions and resolves stable item addresses", async (t) => {
  const f = await applicationFixture(t);
  const empty = await (await f.request("/api/inbox")).json();
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.counts, {
    all: 0,
    questions: 0,
    approvals: 0,
    gates: 0,
    agents: 0,
  });
  const state = await (await f.request("/api/state")).json();
  assert.deepEqual(state.inbox, { revision: empty.revision, counts: empty.counts });

  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await f.request("/api/inbox/events", { signal: controller.signal });
  assert.match(stream.headers.get("content-type"), /^text\/event-stream/);
  const first = await readEvents(stream, 1);
  assert.equal(first.events[0].type, "connected");
  assert.equal(first.events[0].revision, empty.revision);

  // A run that starts waiting reaches the open stream as counts and a new revision.
  const store = f.application.pipelines.store;
  const original = store.withStatus.bind(store);
  store.withStatus = (status) =>
    status === "awaiting-human" ? [waitingRun] : original(status);
  f.application.inbox.changed();
  const next = await readEvents({ body: { getReader: () => first.reader } }, 1);
  assert.equal(next.events[0].type, "inbox");
  assert.equal(next.events[0].revision, empty.revision + 1);
  assert.equal(next.events[0].counts.gates, 1);

  const listed = await (await f.request("/api/inbox")).json();
  assert.equal(listed.items[0].type, "gate");
  assert.equal(listed.items[0].link, "/pipelines/runs/run-waiting");
  const pending = await (await f.request("/api/inbox/gate/run-waiting")).json();
  assert.equal(pending.state, "pending");
  const gone = await (await f.request("/api/inbox/question/no-such-request")).json();
  assert.deepEqual(gone, { state: "gone" });
  const unknown = await f.request("/api/inbox/session/abc");
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).messageKey, "http.notFound");
});

test("the inbox requires the owner's login", async (t) => {
  const f = await applicationFixture(t);
  const response = await fetch(new URL("/api/inbox", f.url), {
    headers: { origin: f.url },
  });
  assert.equal(response.status, 401);
});
