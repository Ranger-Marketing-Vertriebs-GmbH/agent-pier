import test from "node:test";
import assert from "node:assert/strict";
import { routineFixture } from "../helpers/native-routines-fixture.js";
import { NativeHeartbeats } from "../../server/features/assistants/native-heartbeats.js";
import { reconcileRuns } from "../../server/features/assistants/run-reconciler.js";
import { finishRebind } from "../../server/features/assistants/chat-rebind.js";

// Check-ins and routines that commit into the main chat follow it across an owner's
// /reset or /new (chat-rebind.js): OpenClaw 2026.11.2 and later keep the chat as it
// was when the job was created, so the job is re-created; 2026.10.9 needs nothing.

const rebound = "session rebound for sessionKey: session";

function setup(t, version = "2026.11.3") {
  const f = routineFixture(t);
  f.store.updateAssistant(
    f.id,
    {
      capabilities: { memory: true, reminders: true },
      heartbeat: { enabled: true, interval: "1h", start: 0, end: 24, timeZone: "UTC" },
    },
    f.store.getAssistant(f.id).revision,
  );
  f.assistants.runtime.status = () => ({ version });
  // Fresh ids per job (the shared fixture counts the jobs it holds), and run records.
  const call = f.assistants.runtime.client.call;
  let next = 0;
  const runs = new Map();
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "cron.add") {
      f.calls.push({ method, input });
      const job = { ...input, id: `job-${(next += 1)}`, updatedAtMs: 1, state: {} };
      f.jobs.set(job.id, job);
      return { job };
    }
    if (method === "cron.runs") return { entries: runs.get(input.id) || [] };
    return call(method, input);
  };
  const heartbeats = new NativeHeartbeats({
    reminders: f.reminders,
    notifications: { notify: async () => {} },
  });
  const binding = (kind) => f.reminders.bindings.list(f.id).find((b) => b.kind === kind);
  const job = (kind) => f.jobs.get(binding(kind).nativeId);
  return { ...f, heartbeats, runs, binding, job };
}

// The fields of a job that make it the same routine, its id and revision aside.
const same = ({ id: _id, updatedAtMs: _at, state: _state, ...fields }) => fields;

test("a reset re-creates the check-in and chat routine jobs where the chat is pinned", async (t) => {
  const f = setup(t);
  await f.heartbeats.sync(f.id);
  const routine = await f.routines.create(f.id, f.input);
  const before = { heartbeat: f.job("heartbeat"), routine: f.job("routine") };
  assert.equal(before.heartbeat.sessionKey, "session");
  f.runs.set(before.routine.id, [{ runAtMs: 100, status: "ok" }]);

  assert.equal(await f.reminders.followChat(f.channel.conversationId), 2);
  for (const kind of ["heartbeat", "routine"]) {
    const now = f.job(kind);
    assert.notEqual(now.id, before[kind].id, kind);
    assert.ok(!f.jobs.has(before[kind].id), `${kind}: the old job is gone`);
    assert.deepEqual(same(now), same(before[kind]), `${kind}: same fields`);
    assert.deepEqual(f.binding(kind).previousNativeIds, [before[kind].id]);
    assert.equal(f.binding(kind).rebind, null);
  }
  // The binding and its run history go on.
  f.runs.set(f.job("routine").id, [{ runAtMs: 200, status: "ok" }]);
  const history = await f.routines.runs(f.id, routine.id);
  assert.deepEqual(
    history.entries.map((e) => e.runAtMs),
    [200, 100],
  );
  // A late completion of the old job still belongs to the routine.
  await f.reminders.complete(routine.id, {
    jobId: before.routine.id,
    runAtMs: 150,
    status: "ok",
    summary: "Late result.",
  });
  assert.equal(
    f.routines.results.forConversation(f.channel.conversationId).at(-1)?.text,
    "Late result.",
  );
});

test("a runtime that reads the chat at each run keeps its jobs", async (t) => {
  for (const version of ["2026.10.9", null]) {
    const f = setup(t, version);
    await f.heartbeats.sync(f.id);
    await f.routines.create(f.id, f.input);
    const ids = [...f.jobs.keys()];
    assert.equal(await f.reminders.followChat(f.channel.conversationId), 0);
    assert.deepEqual([...f.jobs.keys()], ids, String(version));
  }
});

test("a commit a reset refused re-creates the chat's jobs", async (t) => {
  const f = setup(t);
  await f.heartbeats.sync(f.id);
  const old = f.job("heartbeat").id;
  const response = await fetch(
    ...(await (async () => {
      const { url, token } = await f.reminders.start();
      return [
        `${url}/complete/${f.binding("heartbeat").id}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jobId: old,
            runAtMs: 1,
            status: "ok",
            summary: "Dentist moved.",
            deliveryStatus: "not-delivered",
            deliveryError: rebound,
          }),
        },
      ];
    })()),
  );
  assert.ok(response.ok, String(response.status));
  for (let n = 0; n < 50 && f.job("heartbeat")?.id === old; n++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.notEqual(f.job("heartbeat").id, old);
  assert.ok(!f.jobs.has(old));
});

test("a re-creation a lost Gateway left half done is finished by the next sync", async (t) => {
  const f = setup(t);
  await f.heartbeats.sync(f.id);
  await f.routines.create(f.id, f.input);
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "cron.add")
      throw Object.assign(Error("gone"), { code: "UNAVAILABLE" });
    return call(method, input);
  };
  await assert.rejects(f.reminders.followChat(f.channel.conversationId));
  assert.equal(f.jobs.size, 1, "the first job was removed, its successor not added");
  f.assistants.runtime.client.call = call;
  await f.heartbeats.sync(f.id);
  await f.routines.sync(f.id);
  for (const kind of ["heartbeat", "routine"]) {
    assert.ok(f.job(kind), kind);
    assert.ok(!f.binding(kind).rebind, kind);
  }
  assert.equal(f.jobs.size, 2);
});

test("a routine moved to another chat is re-created there where the chat is pinned", async (t) => {
  const f = setup(t);
  await f.routines.create(f.id, f.input);
  const old = f.job("routine");
  const conversation = f.store.getConversation(f.channel.conversationId);
  f.store.db
    .prepare("UPDATE conversations SET session_key=?, body=? WHERE id=?")
    .run(
      "session-2",
      JSON.stringify({ ...conversation, runtimeSessionKey: "session-2" }),
      conversation.id,
    );
  await f.routines.sync(f.id);
  const now = f.job("routine");
  assert.notEqual(now.id, old.id);
  assert.equal(now.sessionKey, "session-2");
  assert.ok(!f.calls.some((c) => c.method === "cron.update"));
});

test("a completed /reset or /new turn lets the chat's jobs follow it", async (t) => {
  const f = setup(t);
  const followed = [];
  const service = {
    closed: false,
    ledger: f.store && f.assistants.ledger,
    store: f.store,
    runtime: {
      client: {
        ready: true,
        call: async (method) =>
          method === "agent.wait" ? { status: "ok" } : { session: {} },
      },
    },
    reminders: { followChat: async (id) => followed.push(id) },
    history: async () => ({}),
    reviewable: () => true,
  };
  for (const text of ["/reset", "/new gpt-x", "hello /reset", "/newer"]) {
    const request = f.assistants.ledger.accept(f.channel.conversationId, {
      clientRequestId: text,
      text,
    });
    const attempt = f.assistants.ledger.recordAttempt(request.id);
    f.assistants.ledger.transition(attempt.id, "accepted", { runtimeRunId: attempt.id });
  }
  await reconcileRuns(service);
  assert.deepEqual(followed, [f.channel.conversationId, f.channel.conversationId]);
});

test("a refused run still shown as running is rebound; a later run is left alone", async (t) => {
  const f = setup(t);
  await f.heartbeats.sync(f.id);
  await f.routines.create(f.id, f.input);
  const heartbeat = f.job("heartbeat");
  const routine = f.job("routine");
  // The refused run of the check-in, and a newer run of the routine, both under way.
  f.jobs.get(heartbeat.id).state = { runningAtMs: 50 };
  f.jobs.get(routine.id).state = { runningAtMs: 90 };
  const refused = { jobId: heartbeat.id, runAtMs: 60 };
  assert.equal(
    await f.reminders.followChat(f.channel.conversationId, { at: 60, refused }),
    1,
  );
  assert.notEqual(f.job("heartbeat").id, heartbeat.id);
  assert.equal(f.job("routine").id, routine.id);
});

test("a job re-created since the reset or refusal is not re-created again", async (t) => {
  const f = setup(t);
  await f.heartbeats.sync(f.id);
  const first = f.job("heartbeat").id;
  const before = Date.now();
  assert.equal(await f.reminders.followChat(f.channel.conversationId, { at: before }), 1);
  const second = f.job("heartbeat").id;
  // A second refusal or reset report from before that re-creation changes nothing.
  for (let n = 0; n < 3; n++)
    assert.equal(
      await f.reminders.followChat(f.channel.conversationId, { at: before }),
      0,
    );
  assert.equal(f.job("heartbeat").id, second);
  assert.deepEqual(f.binding("heartbeat").previousNativeIds, [first]);
  // A later reset re-creates it again.
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(
    await f.reminders.followChat(f.channel.conversationId, { at: Date.now() }),
    1,
  );
});

test("a pending re-creation without a marker never adopts another job", async () => {
  const added = [];
  const patches = [];
  const reminders = {
    scheduler: () => ({
      remove: async () => assert.fail("nothing of its own is listed"),
      add: async ({ routine }) => (added.push(routine), { id: "job-new" }),
    }),
    bindings: { patch: (id, patch) => patches.push(patch) },
  };
  const binding = { id: "b", rebind: { from: "job-old", routine: { marker: null } } };
  // Someone else's job without a marker of AgentPier's.
  const jobs = [{ id: "job-user", marker: null }];
  const next = await finishRebind(reminders, {}, binding, jobs);
  assert.equal(next.id, "job-new");
  assert.equal(added.length, 1);
  assert.equal(patches[0].nativeId, "job-new");
});
