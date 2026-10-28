import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { applyListSync } from "../../web/lib/live/list-sync.js";
import { withoutReadStamp } from "../../server/features/sessions/workspace-state.js";

const ofType = (type) => (frame) => frame.type === type;
const forState = (frame) => frame.topic === "state";

// GET /api/state once no CLI version probe is pending, so the topic's next read
// (which shares the detection cache) sees the same settled tools.
async function settledState(f) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const body = await (await f.request("/api/state")).json();
    if (!body.tools.some((tool) => tool.versionStatus === "checking")) return body;
    await delay(100);
  }
  throw new Error("CLI version probes did not settle");
}

async function subscribedState(f) {
  const live = openLive(f);
  await live.next(ofType("hello"));
  live.send({ op: "sub", topic: "state" });
  const snapshot = await live.next(forState, 5000);
  assert.equal(snapshot.type, "snapshot");
  return { live, snapshot };
}

test("the state snapshot equals GET /api/state", async (t) => {
  const f = await applicationFixture(t);
  await settledState(f);
  const { live, snapshot } = await subscribedState(f);
  const body = await (await f.request("/api/state")).json();
  const list = applyListSync(null, snapshot.data).list;
  // The same state; the GET started later, so its read stamp is higher.
  assert.deepEqual(withoutReadStamp(list), withoutReadStamp(body));
  assert.ok(body.readStartedAt > list.readStartedAt);
  live.ws.close();
});

test("PATCH /api/preferences pushes a delta within 1 s", async (t) => {
  const f = await applicationFixture(t);
  await settledState(f);
  const { live, snapshot } = await subscribedState(f);
  const held = applyListSync(null, snapshot.data);
  assert.equal(held.list.autoResumeInterrupted, true);
  const started = Date.now();
  const response = await f.request("/api/preferences", {
    method: "PATCH",
    body: { autoResumeInterrupted: false },
  });
  assert.equal(response.status, 200);
  const delta = await live.next(forState, 1000);
  assert.ok(Date.now() - started < 1000);
  assert.equal(delta.type, "delta");
  assert.ok(delta.revision > snapshot.revision);
  const next = applyListSync(held, delta.data);
  assert.equal(next.list.autoResumeInterrupted, false);
  // Only the changed row travels, with the new read stamp.
  assert.deepEqual(delta.data.upserts.map((row) => row.id).sort(), [
    "autoResumeInterrupted",
    "readStartedAt",
  ]);
  live.ws.close();
});

test("a new session reaches the topic within one collect, in the shape of GET", async (t) => {
  const f = await applicationFixture(t);
  await settledState(f);
  const { live, snapshot } = await subscribedState(f);
  await f.application.sessions.save({
    id: "pushed",
    name: "Gesendet",
    tool: "shell",
    accountId: "local-shell",
    status: "stopped",
    cwd: f.project,
  });
  const delta = await live.next(forState, 4000);
  assert.equal(delta.type, "delta");
  const list = applyListSync(applyListSync(null, snapshot.data), delta.data).list;
  assert.deepEqual(
    list.sessions.map((session) => session.id),
    ["pushed"],
  );
  assert.deepEqual(
    withoutReadStamp(list),
    withoutReadStamp(await (await f.request("/api/state")).json()),
  );
  live.ws.close();
});

test("a created account pushes a delta within 1 s", async (t) => {
  const f = await applicationFixture(t);
  await settledState(f);
  const { live, snapshot } = await subscribedState(f);
  const response = await f.request("/api/accounts", {
    method: "POST",
    body: { name: "Zweites Profil", tool: "claude" },
  });
  assert.equal(response.status, 201);
  const delta = await live.next(forState, 1000);
  const list = applyListSync(applyListSync(null, snapshot.data), delta.data).list;
  assert.ok(list.accounts.some((account) => account.name === "Zweites Profil"));
  live.ws.close();
});

test("native activity of a session reads the state again", async (t) => {
  const f = await applicationFixture(t);
  await settledState(f);
  const { live } = await subscribedState(f);
  // No collect in between: only the activity reads.
  clearInterval(f.application.operationsEvents.timer);
  let reads = 0;
  const state = f.application.workspaceState;
  const read = state.read;
  state.read = (...args) => {
    reads += 1;
    return read(...args);
  };
  f.application.chatEvents.publish("any-session", "native-activity");
  await delay(400);
  assert.equal(reads, 1);
  live.ws.close();
});

test("an unchanged collect sends no frame", async (t) => {
  const f = await applicationFixture(t);
  await settledState(f);
  const { live } = await subscribedState(f);
  // OperationsEvents collects every 2.5 s; each collect reads the state again.
  await delay(3000);
  assert.deepEqual(live.frames.filter(forState).slice(1), []);
  live.ws.close();
});

test("a user cannot subscribe to the state topic", async (t) => {
  const f = await applicationFixture(t);
  const hub = f.application.live;
  const frames = [];
  hub.subscribe({ role: "user", id: "u1" }, "state", undefined, (frame) =>
    frames.push(frame),
  );
  assert.deepEqual(frames, [{ type: "error", topic: "state", code: "unknown-topic" }]);
});
