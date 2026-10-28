import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";

const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), "the awaited change arrived");
};

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

test("the inbox lists, announces revisions and resolves stable item addresses", async (t) => {
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
  assert.deepEqual(state.inbox, {
    instance: empty.instance,
    revision: empty.revision,
    counts: empty.counts,
  });

  // A run that starts waiting reaches a subscriber as counts and a new revision.
  const pushed = [];
  t.after(f.application.inbox.subscribe((event) => pushed.push(event)));
  const store = f.application.pipelines.store;
  const original = store.withStatus.bind(store);
  store.withStatus = (status) =>
    status === "awaiting-human" ? [waitingRun] : original(status);
  f.application.inbox.changed();
  await until(() => pushed.length > 0);
  assert.equal(pushed[0].type, "inbox");
  assert.equal(pushed[0].revision, empty.revision + 1);
  assert.equal(pushed[0].counts.gates, 1);

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

test("the inbox event stream is gone: the live inbox topic is the only push", async (t) => {
  const f = await applicationFixture(t);
  const response = await f.request("/api/inbox/events");
  assert.equal(response.status, 404);
  assert.doesNotMatch(response.headers.get("content-type") || "", /event-stream/);
});
