import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";

async function fixture(t, phase = "pasted") {
  const f = await applicationFixture(t);
  const delivery = f.application.chatDelivery;
  const session = {
    id: "recover",
    tool: "codex",
    accountId: "fixture",
    status: "running",
  };
  const text = "Hello\nworld",
    deliveryId = randomUUID();
  const scope = JSON.stringify([session.id, session.accountId, session.tool, null]);
  const file = delivery.file(session.id, deliveryId);
  delivery.write(file, {
    version: 1,
    deliveryId,
    scope,
    hash: createHash("sha256")
      .update(JSON.stringify([text, true]))
      .digest("hex"),
    status: phase === "reserved" ? "rejected" : "uncertain",
    attemptId: deliveryId,
    journal: { phase, generation: "runtime-a" },
  });
  let composer = {
    state: phase === "reserved" ? "empty" : "text",
    text: phase === "reserved" ? null : text,
  };
  let generation = "runtime-a";
  const writes = [];
  f.application.requests.list = async () => ({ requests: [] });
  f.application.requests.hasPending = () => false;
  f.application.models.guardInput = async () => {};
  f.application.sessions.get = async () => session;
  f.application.sessions.withChatInput = (id, operation) =>
    f.application.sessions.serial(
      () =>
        operation({
          session,
          raw: "",
          generation,
          recoveryGeneration: generation,
          composer,
          write: async (value, { submitOnly, onPhase }) => {
            if (!submitOnly) {
              await onPhase("paste-intent");
              writes.push(["paste", value]);
              await onPhase("pasted");
            }
            await onPhase("submit-intent");
            writes.push(["submit"]);
            await onPhase("submitted");
            composer = { state: "empty", text: null };
          },
        }),
      id,
    );
  const body = {
    attemptId: randomUUID(),
    expectedAttemptId: deliveryId,
    deliveryScope: scope,
    text,
    mode: "retry",
  };
  const post = async (value = body) => {
    const response = await f.request(
      `/api/sessions/${session.id}/input/${deliveryId}/recovery`,
      { method: "POST", body: value },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  return {
    f,
    post,
    body,
    writes,
    file,
    delivery,
    setComposer: (value) => (composer = value),
    setGeneration: (value) => (generation = value),
  };
}

test("recovery submits the complete existing input once without pasting it again", async (t) => {
  const x = await fixture(t);
  const result = await x.post();
  assert.equal(result.recovery.action, "submitted-existing");
  assert.equal(result.status, "handed-off");
  assert.deepEqual(x.writes, [["submit"]]);
  assert.deepEqual(await x.post(), result);
  assert.deepEqual(x.writes, [["submit"]]);
});

test("a proven pre-write rejection can be pasted and submitted explicitly", async (t) => {
  const x = await fixture(t, "reserved");
  assert.equal((await x.post()).recovery.action, "resent");
  assert.deepEqual(x.writes, [["paste", x.body.text], ["submit"]]);
});

for (const phase of ["paste-intent", "submit-intent", "submitted"]) {
  test(`recovery never guesses from matching text after ${phase}`, async (t) => {
    const x = await fixture(t, phase);
    assert.equal((await x.post()).recovery.action, "blocked");
    assert.deepEqual(x.writes, []);
  });
}

test("changed composer and replaced runtime block retry without modifying input", async (t) => {
  const x = await fixture(t);
  x.setComposer({ state: "text", text: "Hello" });
  assert.equal((await x.post()).recovery.action, "blocked");
  x.setComposer({ state: "text", text: x.body.text });
  x.setGeneration("runtime-b");
  assert.equal(
    (await x.post({ ...x.body, attemptId: randomUUID() })).recovery.action,
    "blocked",
  );
  assert.deepEqual(x.writes, []);
});

test("check mode and racing attempts cannot cause duplicate submit", async (t) => {
  const x = await fixture(t);
  assert.equal(
    (await x.post({ ...x.body, attemptId: randomUUID(), mode: "check" })).recovery.action,
    "none",
  );
  assert.deepEqual(x.writes, []);
  const results = await Promise.all([
    x.post(),
    x.post({ ...x.body, attemptId: randomUUID() }),
  ]);
  assert.equal(
    results.filter((r) => r.recovery.action === "submitted-existing").length,
    1,
  );
  assert.deepEqual(x.writes, [["submit"]]);
});

test("an interrupted recovery ID cannot write again after a process restart", async (t) => {
  const x = await fixture(t);
  const original = x.f.application.sessions.withChatInput;
  x.f.application.sessions.withChatInput = (id, operation) =>
    original(id, (tx) =>
      operation({
        ...tx,
        write: async (_text, { onPhase }) => {
          await onPhase("submit-intent");
          throw Error("Disconnected before submit outcome");
        },
      }),
    );
  const failed = await x.post();
  assert.equal(failed.status, "uncertain");
  assert.equal(failed.recovery.action, "blocked");
  x.f.application.sessions.withChatInput = original;
  // Drop all in-process ownership. Durable phases alone must prevent resending.
  x.delivery.active.clear();
  assert.deepEqual(await x.post(), failed);
  const next = await x.post({
    ...x.body,
    attemptId: randomUUID(),
    expectedAttemptId: x.body.attemptId,
  });
  assert.equal(next.recovery.action, "blocked");
  assert.deepEqual(x.writes, []);
});

test("legacy uncertain receipts and empty composers never imply safe resending", async (t) => {
  const x = await fixture(t);
  const receipt = x.delivery.read(x.file);
  delete receipt.journal;
  x.delivery.write(x.file, receipt);
  x.setComposer({ state: "empty", text: null });
  assert.equal((await x.post()).recovery.action, "blocked");
  assert.deepEqual(x.writes, []);
});

test("recovery persists intent before submit and a journal error prevents any bytes", async (t) => {
  const x = await fixture(t);
  const write = x.delivery.write.bind(x.delivery);
  let failed = false;
  x.delivery.write = (file, receipt) => {
    if (!failed && receipt.journal?.phase === "submit-intent") {
      failed = true;
      throw Error("Disk unavailable");
    }
    return write(file, receipt);
  };
  const result = await x.post();
  assert.equal(result.status, "uncertain");
  assert.deepEqual(x.writes, []);
  assert.equal((await x.post()).recovery.action, "blocked");
});

test("a completed recovery replays its receipt even if a new native dialog blocks input", async (t) => {
  const x = await fixture(t);
  const result = await x.post();
  x.f.application.requests.list = async () => ({ requests: [{ id: "later-dialog" }] });
  x.f.application.sessions.withChatInput = async () => {
    throw Error("Session no longer accepts input");
  };
  assert.deepEqual(await x.post(), result);
  assert.deepEqual(x.writes, [["submit"]]);
});

test("persisted submit intent without a recovery result remains non-repeatable", async (t) => {
  const x = await fixture(t, "submit-intent");
  const receipt = x.delivery.read(x.file);
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify([
        x.body.expectedAttemptId,
        x.body.deliveryScope,
        receipt.hash,
        x.body.mode,
      ]),
    )
    .digest("hex");
  receipt.attemptId = x.body.attemptId;
  receipt.recoveries = { [x.body.attemptId]: { requestHash } };
  x.delivery.write(x.file, receipt);
  x.delivery.active.clear();
  const result = await x.post();
  assert.equal(result.status, "uncertain");
  assert.equal(result.recovery.action, "blocked");
  assert.deepEqual(x.writes, []);
});

test("a fresh session without a native recovery identity cannot authorize a retry", async (t) => {
  const x = await fixture(t, "reserved");
  const original = x.f.application.sessions.withChatInput;
  x.f.application.sessions.withChatInput = (id, operation) =>
    original(id, (tx) => operation({ ...tx, recoveryGeneration: null }));
  assert.equal((await x.post()).recovery.action, "blocked");
  assert.deepEqual(x.writes, []);
});
