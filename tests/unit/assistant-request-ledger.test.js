import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
test("duplicate delivery survives reopen and terminal results cannot regress", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-ledger-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let store = new AssistantStore({ dataDir });
  const a = store.createAssistant({
    name: "Home",
    instructions: "",
    model: { connectionId: "test", modelId: "test" },
  });
  const c = store.saveConversation({ assistantId: a.id, runtimeSessionKey: "test" });
  let ledger = new RequestLedger(store.db);
  const request = ledger.accept(c.id, {
    clientRequestId: "delivery-1",
    text: "Plan dinner",
  });
  const attempt = ledger.recordAttempt(request.id, {});
  ledger.transition(attempt.id, "accepted", { runtimeRunId: "runtime-1" });
  store.close();
  store = new AssistantStore({ dataDir });
  t.after(() => store.close());
  ledger = new RequestLedger(store.db);
  assert.equal(
    ledger.accept(c.id, { clientRequestId: "delivery-1", text: "Plan dinner" }).id,
    request.id,
  );
  assert.throws(
    () => ledger.accept(c.id, { clientRequestId: "delivery-1", text: "Changed" }),
    { status: 409 },
  );
  assert.equal(ledger.pending()[0].runtimeRunId, "runtime-1");
  ledger.transition(attempt.id, "completed", {});
  ledger.transition(attempt.id, "running", {});
  assert.equal(ledger.getAttempt(attempt.id).state, "completed");
  assert.equal(ledger.pending().length, 0);
});
test("reviewing an uncertain request keeps its unknown outcome and leaves reconciliation", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-review-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AssistantStore({ dataDir });
  t.after(() => store.close());
  const a = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const c = store.saveConversation({ assistantId: a.id, runtimeSessionKey: "c" });
  const ledger = new RequestLedger(store.db);
  const r = ledger.accept(c.id, { clientRequestId: "first", text: "Hello" });
  const attempt = ledger.recordAttempt(r.id);
  assert.throws(() => ledger.review(attempt.id), { status: 409 });
  ledger.transition(attempt.id, "uncertain");
  ledger.review(attempt.id);
  assert.equal(ledger.getAttempt(attempt.id).state, "uncertain");
  assert.ok(ledger.getAttempt(attempt.id).reviewedAt);
  assert.equal(ledger.pending().length, 0);
  assert.equal(ledger.unresolved().length, 0);
  ledger.transition(attempt.id, "completed");
  assert.equal(ledger.getAttempt(attempt.id).state, "completed");
  assert.ok(ledger.getAttempt(attempt.id).reviewedAt);
  assert.equal(ledger.unresolved().length, 0);
});
test("latest request per conversation carries its latest attempt and review", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-latest-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AssistantStore({ dataDir });
  t.after(() => store.close());
  const a = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const busy = store.saveConversation({ assistantId: a.id, runtimeSessionKey: "busy" });
  const done = store.saveConversation({ assistantId: a.id, runtimeSessionKey: "done" });
  store.saveConversation({ assistantId: a.id, runtimeSessionKey: "empty" });
  const ledger = new RequestLedger(store.db);
  const old = ledger.accept(busy.id, { clientRequestId: "old", text: "First" });
  ledger.transition(ledger.recordAttempt(old.id).id, "completed");
  const current = ledger.accept(busy.id, { clientRequestId: "new", text: "Second" });
  const attempt = ledger.recordAttempt(current.id);
  ledger.transition(attempt.id, "accepted", { runtimeRunId: "run" });
  const lost = ledger.accept(done.id, { clientRequestId: "lost", text: "Third" });
  const lostAttempt = ledger.recordAttempt(lost.id);
  ledger.transition(lostAttempt.id, "uncertain");
  ledger.review(lostAttempt.id);

  const rows = ledger.latestByConversation();

  assert.equal(rows.length, 2, "conversations without requests are omitted");
  const byId = Object.fromEntries(rows.map((r) => [r.conversationId, r]));
  assert.deepEqual(byId[busy.id], {
    conversationId: busy.id,
    requestId: current.id,
    requestState: "accepted",
    attemptId: attempt.id,
    attemptState: "accepted",
    reviewedAt: null,
  });
  assert.equal(byId[done.id].attemptState, "uncertain");
  assert.ok(byId[done.id].reviewedAt);
});

test("a request without an attempt reports null attempt fields", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-latest-none-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AssistantStore({ dataDir });
  t.after(() => store.close());
  const a = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const c = store.saveConversation({ assistantId: a.id, runtimeSessionKey: "c" });
  const ledger = new RequestLedger(store.db);
  const r = ledger.accept(c.id, { clientRequestId: "only", text: "Hi" });
  assert.deepEqual(ledger.latestByConversation(), [
    {
      conversationId: c.id,
      requestId: r.id,
      requestState: "pending",
      attemptId: null,
      attemptState: null,
      reviewedAt: null,
    },
  ]);
});

test("the newest request of a conversation is read on its own", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-ledger-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AssistantStore({ dataDir });
  t.after(() => store.close());
  const a = store.createAssistant({
    name: "Home",
    instructions: "",
    model: { connectionId: "test", modelId: "test" },
  });
  const c = store.saveConversation({ assistantId: a.id, runtimeSessionKey: "test" });
  const other = store.saveConversation({ assistantId: a.id, runtimeSessionKey: "other" });
  const ledger = new RequestLedger(store.db);
  assert.equal(ledger.latestRequest(c.id), null);
  ledger.accept(c.id, { clientRequestId: "1", text: "First" });
  const second = ledger.accept(c.id, { clientRequestId: "2", text: "Second" });
  ledger.accept(other.id, { clientRequestId: "3", text: "Elsewhere" });
  assert.deepEqual(ledger.latestRequest(c.id), ledger.requests(c.id).at(-1));
  assert.equal(ledger.latestRequest(c.id).id, second.id);
});
