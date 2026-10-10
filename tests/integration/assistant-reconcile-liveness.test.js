import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { TeamResults } from "../../server/features/assistants/team-results.js";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";

function parentChat(f, key) {
  const parent = f.store.createAssistant({
    name: "Parent",
    model: { connectionId: "c", modelId: "m" },
  });
  return f.store.saveConversation({ assistantId: parent.id, runtimeSessionKey: key });
}
function archive(f, assistantId) {
  const a = f.store.getAssistant(assistantId);
  const next = { ...a, archivedAt: new Date().toISOString(), revision: a.revision + 1 };
  f.store.db
    .prepare("UPDATE assistants SET body=?,revision=? WHERE id=?")
    .run(JSON.stringify(next), next.revision, a.id);
}

test("one unavailable session never stops run reconciliation and retries with backoff", async (t) => {
  const f = teamFixture(t);
  let clock = 0;
  f.assistants.now = () => clock;
  const gone = parentChat(f, "gone"),
    live = parentChat(f, "live");
  const request = f.assistants.ledger.accept(live.id, {
    clientRequestId: "live",
    text: "Hello",
  });
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  f.assistants.ledger.transition(attempt.id, "accepted", { runtimeRunId: attempt.id });
  f.runs.set(attempt.id, { key: "live", status: "ok" });
  const call = f.assistants.runtime.client.call;
  let goneSubscribes = 0;
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "sessions.messages.subscribe" && input.key === "gone") {
      goneSubscribes++;
      throw Object.assign(Error("gone"), { code: "gone" });
    }
    return call(method, input);
  };
  await f.assistants.reconcile();
  assert.equal(f.assistants.ledger.getAttempt(attempt.id).state, "completed");
  const listed = (id) => f.assistants.list().conversations.find((c) => c.id === id);
  assert.equal(listed(gone.id).diagnostic, "SESSION_UNAVAILABLE");
  assert.equal(listed(live.id).diagnostic, undefined);
  assert.equal(goneSubscribes, 1);
  clock = 59999;
  await f.assistants.reconcile();
  assert.equal(goneSubscribes, 1, "a failing session is retried at most once per minute");
  clock = 60000;
  await f.assistants.reconcile();
  assert.equal(goneSubscribes, 2);
  f.assistants.runtime.client.call = call;
  clock = 120000;
  await f.assistants.reconcile();
  assert.equal(listed(gone.id).diagnostic, undefined);
});

async function settle(f) {
  for (let n = 0; n < 5; n++) {
    await new Promise((resolve) => setImmediate(resolve));
    await f.assistants.reconciling;
  }
}
test("the poll alone retries an unavailable session once its backoff expires", async (t) => {
  const f = teamFixture(t);
  let clock = 0,
    healthy = false;
  f.assistants.now = () => clock;
  const gone = parentChat(f, "gone");
  const call = f.assistants.runtime.client.call;
  const subscribed = [];
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "sessions.messages.subscribe") {
      subscribed.push(input.key);
      if (!healthy) throw Object.assign(Error("gone"), { code: "gone" });
    }
    return call(method, input);
  };
  const listed = () => f.assistants.list().conversations.find((c) => c.id === gone.id);
  f.assistants.runtime.emit("status", { availability: "ready" });
  await settle(f);
  assert.deepEqual(subscribed, ["gone"]);
  assert.equal(listed().diagnostic, "SESSION_UNAVAILABLE");
  clock = 30000;
  f.assistants.pollReconcile();
  await settle(f);
  assert.deepEqual(subscribed, ["gone"]);
  healthy = true;
  clock = 60000;
  f.assistants.pollReconcile();
  await settle(f);
  assert.deepEqual(subscribed, ["gone", "gone"]);
  assert.equal(listed().diagnostic, undefined);
  f.assistants.pollReconcile();
  await settle(f);
  assert.equal(subscribed.length, 2, "an idle poll performs no further subscriptions");
});

test("a connection drop mid-reconcile resubscribes every session after reconnect", async (t) => {
  const f = teamFixture(t);
  const chats = ["a", "b", "c"].map((key) => parentChat(f, key));
  const client = f.assistants.runtime.client,
    call = client.call;
  let subscribed = [],
    fail = (key) => key === "c",
    drop = () => false;
  client.call = async (method, input) => {
    if (method === "sessions.messages.subscribe") {
      subscribed.push(input.key);
      if (drop(input.key)) {
        client.ready = false;
        throw Object.assign(Error("closed"), { code: "CLOSED" });
      }
      if (fail(input.key)) throw Object.assign(Error("gone"), { code: "gone" });
    }
    return call(method, input);
  };
  const diagnostics = () => f.assistants.list().conversations.map((c) => c.diagnostic);
  f.assistants.runtime.emit("status", { availability: "ready" });
  await settle(f);
  assert.deepEqual(diagnostics(), [undefined, undefined, "SESSION_UNAVAILABLE"]);
  fail = () => false;
  drop = (key) => key === "b";
  subscribed = [];
  f.assistants.runtime.emit("status", { availability: "failed" });
  f.assistants.runtime.emit("status", { availability: "ready" });
  await settle(f);
  assert.deepEqual(subscribed, ["a", "b"]);
  assert.deepEqual(diagnostics(), [undefined, undefined, undefined]);
  drop = () => false;
  client.ready = true;
  subscribed = [];
  f.assistants.runtime.emit("status", { availability: "failed" });
  f.assistants.runtime.emit("status", { availability: "ready" });
  await settle(f);
  assert.deepEqual(
    subscribed,
    chats.map((c) => c.runtimeSessionKey),
  );
  assert.deepEqual(diagnostics(), [undefined, undefined, undefined]);
});

test("reviewed uncertain attempts leave the reconciliation poll idle", async (t) => {
  const f = teamFixture(t);
  const chat = parentChat(f, "review");
  const request = f.assistants.ledger.accept(chat.id, {
    clientRequestId: "lost",
    text: "Hello",
  });
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  f.assistants.ledger.transition(attempt.id, "uncertain");
  await f.assistants.recover(attempt.id, { acknowledgeUnknownOutcome: true });
  assert.ok(f.assistants.ledger.getAttempt(attempt.id).reviewedAt);
  assert.equal(f.assistants.ledger.getAttempt(attempt.id).state, "uncertain");
  assert.equal(f.assistants.ledger.unresolved().length, 0);
  f.calls.length = 0;
  for (let n = 0; n < 3; n++) {
    f.assistants.pollReconcile();
    await f.assistants.reconciling;
  }
  assert.equal(f.calls.length, 0);
});

test("a member report never matches a history message without run identity", async () => {
  let written;
  const results = new TeamResults({
    teams: {
      get: () => ({ id: "team" }),
      members: () => [
        { id: "m", name: "M", role: "R", phase: "completed", attemptId: "a" },
      ],
      write: (_team, value) => (written = value),
    },
    assistants: {
      ledger: { getAttempt: () => ({ id: "a", runtimeRunId: null }) },
      history: async () => ({
        stale: false,
        messages: [{ role: "assistant", text: "Another run", runId: null }],
      }),
      changed() {},
    },
  });
  await results.collect("team");
  assert.equal(written.resultBatch[0].reportAvailable, false);
});

test("an archived parent skips synthesis once and never retries it", async (t) => {
  const f = teamFixture(t),
    { team, attempt, parent, chat } = await f.proposal({ count: 1 });
  await f.service.reconcile();
  f.complete(f.service.store.members(team.id)[0].attemptId);
  f.assistants.ledger.transition(attempt.id, "completed");
  archive(f, parent.id);
  await f.service.reconcile();
  const skipped = f.service.store.get(team.id);
  assert.equal(skipped.resultState, "skipped");
  assert.equal(skipped.resultDiagnostic, "PARENT_ARCHIVED");
  await f.service.reconcile();
  assert.equal(f.service.store.get(team.id).revision, skipped.revision);
  const sends = f.calls.filter(
    (c) => c.method === "sessions.send" && c.input.key === chat.runtimeSessionKey,
  );
  assert.equal(sends.length, 0);
});

test("a cancelled team spends no synthesis turn", async (t) => {
  const f = teamFixture(t),
    { team, attempt, chat } = await f.proposal({ count: 1 });
  await f.service.reconcile();
  const member = f.service.store.members(team.id)[0];
  f.assistants.ledger.transition(attempt.id, "completed");
  await f.service.stop(team.id);
  f.runs.set(member.attemptId, { ...f.runs.get(member.attemptId), status: "aborted" });
  f.assistants.ledger.transition(member.attemptId, "cancelled");
  await f.service.reconcile();
  await f.service.reconcile();
  const current = f.service.store.get(team.id);
  assert.equal(current.phase, "cancelled");
  assert.equal(current.resultState, "skipped");
  assert.equal(current.resultDiagnostic, "TEAM_CANCELLED");
  const sends = f.calls.filter(
    (c) => c.method === "sessions.send" && c.input.key === chat.runtimeSessionKey,
  );
  assert.equal(sends.length, 0);
});

test("a permanently rejected routine binding is reported without blocking others", async () => {
  const triggered = [];
  const fake = {
    bindings: {
      list: () =>
        ["denied", "accepted"].map((id) => ({
          id,
          kind: "routine",
          state: "bound",
          definition: { trigger: { kind: "event", eventKind: "coding.completed" } },
        })),
    },
    async trigger(_assistantId, id, input) {
      triggered.push(id);
      if (id === "denied") throw assistantProblem("active", 409);
      return { eventId: input.eventId, status: "queued" };
    },
  };
  const results = await NativeRoutines.prototype.emit.call(fake, {
    assistantId: "a",
    kind: "coding.completed",
    eventId: "coding:x:completed",
  });
  assert.deepEqual(triggered, ["denied", "accepted"]);
  assert.deepEqual(
    results.map((r) => [r.id, r.status]),
    [
      ["denied", "skipped"],
      ["accepted", "queued"],
    ],
  );
  assert.equal(results[0].reason, "CONFLICT");
  fake.trigger = async () => {
    throw assistantProblem("unavailable", 503);
  };
  await assert.rejects(
    NativeRoutines.prototype.emit.call(fake, {
      assistantId: "a",
      kind: "coding.completed",
      eventId: "coding:x:completed",
    }),
    { status: 503 },
  );
});
