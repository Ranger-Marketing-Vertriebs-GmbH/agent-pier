import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateAssistants } from "../../server/features/assistants/assistant-schema.js";
import { settle, setup } from "../helpers/assistant-queue-fixture.js";

const day = 24 * 3600 * 1000;
const clockOf = (service) => {
  const clock = { now: Date.now() };
  service.now = () => clock.now;
  service.queued.now = () => clock.now;
  return clock;
};
const refuse = (service, status, times = Infinity) => {
  const send = service.send.bind(service);
  const state = { left: times, calls: 0 };
  service.send = async (...args) => {
    state.calls++;
    if (state.left-- > 0) throw Object.assign(new Error("refused"), { status });
    return send(...args);
  };
  return state;
};

for (const [label, status] of [
  ["an unready service", 503],
  ["a busy member", 409],
])
  test(`a refusal by ${label} is retried by the poll with backoff, quietly`, async (t) => {
    const { service, c, sent, finish } = setup(t);
    let clock = Date.now();
    service.now = () => clock;
    await service.send(c.id, { clientRequestId: "first", text: "One" });
    service.queue(c.id, { text: "Later" });
    const send = service.send.bind(service);
    let refusals = 2;
    service.send = async (...args) => {
      if (refusals-- > 0) throw Object.assign(new Error("refused"), { status });
      return send(...args);
    };
    await finish(service);
    assert.equal(service.queued.get(c.id).state, "waiting");
    assert.equal(service.ledger.unresolved().length, 0);
    const changes = [];
    const stop = service.events.subscribe((event) => changes.push(event.type));
    // Within the first backoff the poll leaves it alone.
    service.pollReconcile();
    await settle();
    assert.equal(refusals, 1);
    clock += 2100;
    service.pollReconcile();
    await settle();
    assert.equal(refusals, 0);
    assert.equal(sent.length, 1);
    // A refusal that only returns it to waiting is no news for the browsers.
    assert.deepEqual(changes, []);
    clock += 2100;
    service.pollReconcile();
    await settle();
    assert.equal(sent.length, 1, "the backoff doubled to 4 s");
    clock += 2100;
    service.pollReconcile();
    await settle();
    assert.equal(sent.length, 2);
    assert.equal(service.queued.get(c.id), null);
    stop?.();
  });

test("a 25 h turn still delivers its queued message", async (t) => {
  const { service, c, sent, finish } = setup(t);
  const clock = clockOf(service);
  await service.send(c.id, { clientRequestId: "first", text: "One" });
  service.queue(c.id, { text: "After a long turn" });
  clock.now += day + 3600 * 1000;
  service.pollReconcile();
  await settle();
  assert.equal(service.queued.get(c.id).state, "waiting");
  await finish(service);
  assert.deepEqual(
    sent.map((s) => s.message),
    ["One", "After a long turn"],
  );
});

test("a message that could not go out for a day expires; archived agents take none", async (t) => {
  const { service, store, c, sent, finish } = setup(t);
  const clock = clockOf(service);
  await service.send(c.id, { clientRequestId: "first", text: "One" });
  await finish(service);
  refuse(service, 503);
  service.queue(c.id, { text: "Stale" });
  await settle();
  assert.equal(service.queued.get(c.id).state, "waiting");
  clock.now += day + 60000;
  service.pollReconcile();
  await settle();
  const { queued } = await service.history(c.id);
  assert.equal(queued.state, "failed");
  assert.equal(queued.messageKey, "assistants.queuedExpired");
  assert.equal(sent.length, 1);

  service.takeBackQueued(c.id);
  const { assistantId } = store.getConversation(c.id);
  store.db
    .prepare("UPDATE assistants SET body=json_set(body,'$.archivedAt',?) WHERE id=?")
    .run(new Date().toISOString(), assistantId);
  assert.throws(() => service.queue(c.id, { text: "Archived" }), {
    status: 409,
    key: "queuedArchived",
  });
});

test("server faults keep being retried every 30 s and say so after ten tries", async (t) => {
  const { service, c, sent, finish } = setup(t);
  const clock = clockOf(service);
  await service.send(c.id, { clientRequestId: "first", text: "One" });
  service.queue(c.id, { text: "Keep trying" });
  const refusal = refuse(service, 500);
  await finish(service);
  const changes = [];
  service.events.subscribe((event) => changes.push(event.type));
  for (let i = 0; i < 9; i++) {
    assert.equal((await service.history(c.id)).queued.retrying, false, `try ${i + 1}`);
    clock.now += 31000;
    service.pollReconcile();
    await settle();
  }
  const { queued } = await service.history(c.id);
  assert.equal(queued.state, "waiting");
  assert.equal(queued.retrying, true);
  // The browsers hear of it once, when the notice changes.
  assert.deepEqual(changes, ["change"]);
  clock.now += 31000;
  service.pollReconcile();
  await settle();
  assert.equal(refusal.calls, 11);
  refusal.left = 0;
  clock.now += 31000;
  service.pollReconcile();
  await settle();
  assert.equal(sent.length, 2);
  assert.equal(service.queued.get(c.id), null);
});

test("a refusal behind another turn is retried as soon as that turn ends", async (t) => {
  const { service, store, c, sent, finish } = setup(t);
  clockOf(service);
  await service.send(c.id, { clientRequestId: "first", text: "One" });
  await finish(service);
  const other = store.saveConversation({
    assistantId: store.getConversation(c.id).assistantId,
    runtimeSessionKey: "member",
  });
  await service.send(other.id, { clientRequestId: "member", text: "Member works" });
  // The busy member refuses the owner's turn, like assertMemberTurn does.
  const send = service.send.bind(service);
  service.send = async (id, ...args) => {
    if (id === c.id && service.ledger.pending().length)
      throw Object.assign(new Error("member busy"), { status: 409 });
    return send(id, ...args);
  };
  service.queue(c.id, { text: "When the member is done" });
  await settle();
  assert.equal(service.queued.get(c.id).state, "waiting");
  // No clock moves: the backoff alone would hold it for 2 s.
  await finish(service);
  assert.equal(sent.at(-1).message, "When the member is done");
});

test("reading a queued message writes nothing", (t) => {
  const { service, c } = setup(t);
  service.queue(c.id, { text: "Read me" });
  const changes = () => service.store.db.prepare("SELECT total_changes() AS n").get().n;
  const before = changes();
  service.queued.get(c.id);
  assert.equal(changes(), before);
});

test("a queue table from an earlier build gains its new columns", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE queued_messages (conversation_id TEXT PRIMARY KEY, client_key TEXT NOT NULL, text TEXT NOT NULL, team_allowed INTEGER NOT NULL, attachments TEXT NOT NULL, state TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  migrateAssistants(db);
  migrateAssistants(db);
  const columns = db
    .prepare("PRAGMA table_info(queued_messages)")
    .all()
    .map((c) => c.name);
  for (const name of ["last_append", "deliverable_since", "retrying"])
    assert.ok(columns.includes(name), name);
});
