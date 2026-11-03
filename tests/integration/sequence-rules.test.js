// Label rules feeding a ticket sequence: TicketSequenceService.appendFromRule and the
// dedupe between rules, sequences and manual starts. Fake trackers and sessions only.
import test from "node:test";
import assert from "node:assert/strict";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { TicketRuleStore } from "../../server/features/tickets/rule-store.js";
import { TicketSequenceService } from "../../server/features/tickets/sequence-service.js";
import { issueTicket, sequenceFixture } from "../helpers/sequence-fixture.js";

const copy = serverMessages.tickets;
const SESSION = { tool: "claude", accountId: "a1" };
const ruleInput = (extra = {}) => ({
  source: "github",
  label: "agent",
  kind: "session",
  paused: false,
  options: { allowMerge: false, session: SESSION },
  ...extra,
});
const labelled = (n, labels = ["Agent"]) => issueTicket(`acme/app#${n}`, { labels });

async function setup(t, options) {
  const f = await sequenceFixture(t, options);
  const rules = new TicketRuleStore({ dataDir: f.dataDir, now: () => f.clock.now });
  // The wiring of createTicketServices (Task 6).
  f.tickets.taken = (projectId, source, key) =>
    f.store.contains(projectId, source, key) === "active"
      ? "queued"
      : rules.picked(projectId, source, key)
        ? "picked"
        : null;
  const service = new TicketSequenceService({
    store: f.store,
    engine: f.engine,
    tickets: f.tickets,
    sessions: f.sessionsApi,
    worktrees: f.worktrees,
    rules,
    now: () => f.clock.now,
  });
  const project = { id: "p1", path: f.repoPath };
  const append = (ruleId, tickets) => service.appendFromRule(project, ruleId, tickets);
  return { f, rules, service, project, append };
}
async function settled(f) {
  while (f.engine.locks.size)
    await Promise.all([...f.engine.locks.values()].map((lock) => lock.promise));
}
/** Parks the head, so the steps after an append start nothing. */
function parkHead(f) {
  const head = f.store.head("p1");
  f.store.patch("p1", head.id, { state: "running" });
  f.store.patch("p1", head.id, {
    state: "needs-owner",
    needsOwner: { reason: "idle", at: f.clock.now },
  });
}
/** Holds the queue's lock until the returned function is called. */
function holdLock(f) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  f.engine.exclusive("p1", () => held).catch(() => {});
  return release;
}
const startManual = (f, key, extra = {}) =>
  f.tickets.start("p1", {
    source: "github",
    key,
    kind: "session",
    session: SESSION,
    ...extra,
  });

test("appendFromRule appends in given order with a rule origin", async (t) => {
  const { f, rules, append } = await setup(t);
  f.append(["acme/app#1"]);
  parkHead(f);
  const rule = rules.create("p1", ruleInput());
  const result = await append(rule.id, [labelled(5), labelled(3)]);
  assert.deepEqual(result, { added: ["acme/app#5", "acme/app#3"], full: false });
  const [, five, three] = f.items();
  for (const item of [five, three]) {
    assert.deepEqual(item.origin, { kind: "rule", ruleId: rule.id });
    assert.equal(item.state, "waiting");
    assert.equal(item.kind, "session");
    assert.deepEqual(item.options, { allowMerge: false, session: SESSION });
  }
  assert.equal(five.title, "Fix thing 5");
  assert.equal(rules.picked("p1", "github", "acme/app#5").itemId, five.id);
  assert.equal(rules.picked("p1", "github", "acme/app#3").itemId, three.id);
  assert.equal(rules.picked("p1", "github", "acme/app#3").ruleId, rule.id);
  await settled(f);
  assert.equal(f.launched.length, 0);
});

test("appendFromRule skips picked, queued, done and started tickets", async (t) => {
  const { f, rules, append } = await setup(t);
  const rule = rules.create("p1", ruleInput());
  f.append(["acme/app#1", "acme/app#2"]);
  const [done] = f.items();
  f.store.patch("p1", done.id, { state: "done", doneBy: "owner", doneAt: 1 });
  parkHead(f);
  rules.addPickups("p1", [
    { source: "github", key: "acme/app#3", ruleId: "gone", itemId: "x", at: 1 },
  ]);
  f.ticketStore.addStart({
    projectId: "p1",
    source: "github",
    key: "acme/app#4",
    title: "Four",
    url: "",
    kind: "session",
    targetId: "s0",
    writeBack: { state: "done" },
  });
  const result = await append(
    rule.id,
    [1, 2, 3, 4, 5].map((n) => labelled(n)),
  );
  assert.deepEqual(result, { added: ["acme/app#5"], full: false });
  assert.equal(f.items().length, 3);
});

test("appendFromRule skips tickets of another source, without the label, or listed twice", async (t) => {
  const { f, rules, append } = await setup(t);
  f.append(["acme/app#1"]);
  parkHead(f);
  const rule = rules.create("p1", ruleInput());
  const result = await append(rule.id, [
    { ...labelled(2), source: "plane" },
    labelled(3, ["bug"]),
    labelled(4, [" AGENT "]),
    labelled(4),
  ]);
  assert.deepEqual(result.added, ["acme/app#4"]);
});

test("appendFromRule skips a rule deleted or paused during the read", async (t) => {
  for (const change of ["remove", "pause", "relabel"]) {
    const { f, rules, append } = await setup(t);
    const rule = rules.create("p1", ruleInput());
    const release = holdLock(f);
    const pending = append(rule.id, [labelled(1), labelled(2)]);
    if (change === "remove") rules.remove("p1", rule.id);
    if (change === "pause") rules.update("p1", rule.id, ruleInput({ paused: true }));
    if (change === "relabel") rules.update("p1", rule.id, ruleInput({ label: "ai" }));
    release();
    assert.deepEqual(await pending, { added: [], full: false }, change);
    assert.deepEqual(f.items(), [], change);
    assert.equal(rules.pickupCount("p1", rule.id), 0, change);
  }
});

test("appendFromRule uses the rule's options as they are when it appends", async (t) => {
  const { f, rules, append } = await setup(t);
  f.append(["acme/app#1"]);
  parkHead(f);
  const rule = rules.create("p1", ruleInput());
  const release = holdLock(f);
  const pending = append(rule.id, [labelled(2)]);
  rules.update(
    "p1",
    rule.id,
    ruleInput({ kind: "pipeline", options: { allowMerge: true, pipeline: { id: "x" } } }),
  );
  release();
  await pending;
  const item = f.items()[1];
  assert.equal(item.kind, "pipeline");
  assert.equal(item.options.allowMerge, true);
});

test("appendFromRule fills free slots and reports full", async (t) => {
  const { f, rules, append } = await setup(t);
  f.append(Array.from({ length: 199 }, (_, i) => `acme/app#${i + 100}`));
  parkHead(f);
  const rule = rules.create("p1", ruleInput());
  const result = await append(rule.id, [labelled(1), labelled(2), labelled(3)]);
  assert.deepEqual(result, { added: ["acme/app#1"], full: true });
  assert.equal(f.store.freeSlots("p1"), 0);
  assert.equal(rules.picked("p1", "github", "acme/app#2"), null);
  // A full queue with nothing new to add is not full for the rule.
  assert.deepEqual(await append(rule.id, [labelled(1)]), { added: [], full: false });
  assert.deepEqual(await append(rule.id, [labelled(2)]), { added: [], full: true });
});

test("rule tickets append while the head needs the owner", async (t) => {
  const { f, rules, append } = await setup(t);
  f.append(["acme/app#1"]);
  parkHead(f);
  const rule = rules.create("p1", ruleInput());
  await append(rule.id, [labelled(2), labelled(3)]);
  await settled(f);
  assert.deepEqual(
    f.items().map((item) => item.state),
    ["needs-owner", "waiting", "waiting"],
  );
  assert.equal(f.launched.length, 0);
});

test("pickup write failure after append does not duplicate on next pass", async (t) => {
  const { f, rules, append } = await setup(t);
  f.append(["acme/app#1"]);
  parkHead(f);
  const rule = rules.create("p1", ruleInput());
  const real = rules.addPickups.bind(rules);
  let failures = 1;
  rules.addPickups = (...args) => {
    if (failures-- > 0) throw new Error("disk full");
    return real(...args);
  };
  assert.deepEqual((await append(rule.id, [labelled(2)])).added, ["acme/app#2"]);
  assert.equal(rules.picked("p1", "github", "acme/app#2"), null);
  assert.ok(f.errors.some((entry) => entry.step === "rule-pickups"));
  // The item itself blocks the next pass, which records the missing pickup.
  assert.deepEqual(await append(rule.id, [labelled(2)]), { added: [], full: false });
  assert.equal(f.items().length, 2);
  const item = f.items()[1];
  assert.equal(rules.picked("p1", "github", "acme/app#2").itemId, item.id);
  // Done and later pruned from the queue: the pickup alone still blocks it.
  f.store.patch("p1", item.id, { state: "done", doneBy: "owner", doneAt: 2 });
  f.store.remove("p1", item.id);
  assert.deepEqual((await append(rule.id, [labelled(2)])).added, []);
});

test("a ticket queued by hand or started stays skipped after both records are pruned", async (t) => {
  const { f, rules, append } = await setup(t);
  // A manual queue item for #1 (parked) and a start record for #2.
  f.append(["acme/app#1"]);
  parkHead(f);
  const [manual] = f.items();
  const start = f.ticketStore.addStart({
    projectId: "p1",
    source: "github",
    key: "acme/app#2",
    title: "Two",
    url: "",
    kind: "session",
    targetId: "s0",
    writeBack: { state: "done" },
  });
  // Created after both: the first pass records them as picked.
  const rule = rules.create("p1", ruleInput());
  assert.deepEqual(await append(rule.id, [labelled(1), labelled(2)]), {
    added: [],
    full: false,
  });
  assert.deepEqual(rules.picked("p1", "github", "acme/app#1"), {
    projectId: "p1",
    source: "github",
    key: "acme/app#1",
    ruleId: rule.id,
    itemId: manual.id,
    at: manual.addedAt,
  });
  assert.equal(rules.picked("p1", "github", "acme/app#2").itemId, start.id);
  // Both records pruned (done and over the caps): the pickups alone still block them.
  f.store.patch("p1", manual.id, { state: "done", doneBy: "owner", doneAt: 2 });
  f.store.remove("p1", manual.id);
  f.ticketStore.startRecords = [];
  f.ticketStore.save();
  assert.equal(f.ticketStore.findStart("p1", "github", "acme/app#2"), undefined);
  assert.deepEqual(await append(rule.id, [labelled(1), labelled(2)]), {
    added: [],
    full: false,
  });
  assert.deepEqual(f.items(), []);
});

test("two rules matching one ticket append it once", async (t) => {
  const { f, rules, append } = await setup(t);
  f.append(["acme/app#1"]);
  parkHead(f);
  const agent = rules.create("p1", ruleInput());
  const ai = rules.create("p1", ruleInput({ label: "ai" }));
  const ticket = labelled(2, ["agent", "ai"]);
  const results = await Promise.all([
    append(agent.id, [ticket]),
    append(ai.id, [ticket]),
  ]);
  assert.deepEqual(
    results.map((r) => r.added.length),
    [1, 0],
  );
  assert.equal(f.items().length, 2);
  assert.equal(rules.picked("p1", "github", "acme/app#2").ruleId, agent.id);
});

test("two racing passes of one rule append each ticket once", async (t) => {
  const { f, rules, append } = await setup(t);
  f.append(["acme/app#1"]);
  parkHead(f);
  const rule = rules.create("p1", ruleInput());
  const tickets = [labelled(2), labelled(3)];
  const results = await Promise.all([append(rule.id, tickets), append(rule.id, tickets)]);
  assert.deepEqual(
    results.map((r) => r.added),
    [["acme/app#2", "acme/app#3"], []],
  );
  assert.equal(f.items().length, 3);
});

test("a rule leaves a ticket alone that the owner is starting by hand", async (t) => {
  const { f, rules, append } = await setup(t);
  f.append(["acme/app#1"]);
  parkHead(f);
  const rule = rules.create("p1", ruleInput());
  let during;
  f.chatDelivery.deliver = () => {
    during = append(rule.id, [labelled(2)]);
    return { status: "handed-off" };
  };
  await startManual(f, "acme/app#2");
  assert.deepEqual(await during, { added: [], full: false });
  // Started now: later passes skip it through its start record.
  assert.deepEqual((await append(rule.id, [labelled(2)])).added, []);
  assert.equal(f.items().length, 1);
  assert.equal(f.launched.length, 1);
});

test("manual start of a rule-queued ticket is refused", async (t) => {
  const { f, rules, append } = await setup(t);
  f.append(["acme/app#1"]);
  parkHead(f);
  const rule = rules.create("p1", ruleInput());
  await append(rule.id, [labelled(2)]);
  for (const again of [false, true])
    await assert.rejects(startManual(f, "ACME/app#2", { again }), {
      status: 409,
      message: copy.ticketQueued,
    });
  // Done: the pickup remains, so a manual start needs `again`.
  const item = f.items()[1];
  f.store.patch("p1", item.id, { state: "done", doneBy: "owner", doneAt: 3 });
  await assert.rejects(startManual(f, "acme/app#2"), {
    status: 409,
    message: copy.alreadyStarted,
  });
  await startManual(f, "acme/app#2", { again: true });
  assert.equal(f.launched.length, 1);
});

const addInput = (keys, extra = {}) => ({
  tickets: keys.map((key) => ({ source: "github", key })),
  kind: "session",
  allowMerge: false,
  session: SESSION,
  ...extra,
});

test("sequence add of a picked ticket needs again", async (t) => {
  const { f, rules, service } = await setup(t);
  f.append(["acme/app#1"]);
  parkHead(f);
  rules.addPickups("p1", [
    { source: "github", key: "acme/app#2", ruleId: "r1", itemId: "i1", at: 1 },
  ]);
  await assert.rejects(service.add("p1", addInput(["acme/app#2"])), {
    status: 409,
    message: copy.alreadyStarted,
  });
  await service.add("p1", addInput(["acme/app#2"], { again: true }));
  assert.equal(f.items().length, 2);
});

test("sequence add refuses a ticket a rule queued while the tracker was read", async (t) => {
  const { f, rules, service, append } = await setup(t);
  f.append(["acme/app#1"]);
  parkHead(f);
  const rule = rules.create("p1", ruleInput());
  const get = f.tickets.sources.github.get;
  f.tickets.sources.github.get = async (access, key) => {
    await append(rule.id, [labelled(2)]);
    return get(access, key);
  };
  await assert.rejects(service.add("p1", addInput(["acme/app#2"], { again: true })), {
    status: 409,
    message: copy.ticketQueued,
  });
  assert.equal(f.items().length, 2);
  assert.equal(f.items()[1].origin.kind, "rule");
});

test("sequence add refuses a ticket the owner started while the tracker was read", async (t) => {
  const { f, service } = await setup(t);
  f.append(["acme/app#1"]);
  parkHead(f);
  const get = f.tickets.sources.github.get;
  let manual;
  f.tickets.sources.github.get = async (access, key) => {
    f.tickets.sources.github.get = get;
    manual = startManual(f, "acme/app#2");
    for (let i = 0; i < 1000 && !f.tickets.isStarting("p1", "github", key); i += 1)
      await new Promise((resolve) => setImmediate(resolve));
    return get(access, key);
  };
  await assert.rejects(service.add("p1", addInput(["acme/app#2"])), { status: 409 });
  await manual;
  assert.equal(f.items().length, 1);
  assert.equal(f.launched.length, 1);
});
