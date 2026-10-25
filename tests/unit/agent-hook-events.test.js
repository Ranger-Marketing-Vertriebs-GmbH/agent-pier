import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  HookEvents,
  eventIdOf,
} from "../../server/features/assistants/agent-hook-events.js";

const day = 86400000;
let clock, events, db;
const hook = { id: "h1", assistantId: "a1", hourlyLimit: 20 };
const input = (eventId, extra = {}) => ({
  eventId,
  payload: `{"n":"${eventId}"}`,
  size: 10,
  contentType: "application/json",
  source: "local",
  ...extra,
});
beforeEach(() => {
  clock = 1_000_000_000_000;
  db = new DatabaseSync(":memory:");
  events = new HookEvents(db, { now: () => clock });
});

test("eventIdOf prefers headers, then scalar ids, then the body hash", () => {
  assert.equal(
    eventIdOf({ headers: { "idempotency-key": "k1" }, text: "{}", json: { id: "x" } }),
    "k1",
  );
  assert.equal(eventIdOf({ headers: { "x-event-id": "e1" }, text: "{}" }), "e1");
  assert.equal(
    eventIdOf({ headers: {}, text: '{"eventId":7}', json: { eventId: 7 } }),
    "7",
  );
  assert.match(eventIdOf({ headers: {}, text: "plain" }), /^sha256:[a-f0-9]{64}$/);
});

test("eventIdOf ignores non-scalar ids", () => {
  assert.match(
    eventIdOf({ headers: {}, text: '{"id":{"a":1}}', json: { id: { a: 1 } } }),
    /^sha256:/,
  );
  assert.match(
    eventIdOf({ headers: { "x-event-id": "a".repeat(201) }, text: "x" }),
    /^sha256:/,
  );
});

test("admit is atomic per event id", () => {
  const first = events.admit(hook, input("e1")),
    again = events.admit(hook, input("e1"));
  assert.equal(first.outcome, "fresh");
  assert.equal(first.event.status, "pending");
  assert.equal(again.outcome, "duplicate");
  assert.equal(again.event.id, first.event.id);
  assert.equal(events.get(first.event.id).duplicates, 1);
});

test("the rolling hour throttles beyond the hook's limit and flags only the first", () => {
  const small = { ...hook, hourlyLimit: 2 };
  events.admit(small, input("a"));
  events.admit(small, input("b"));
  const c = events.admit(small, input("c")),
    d = events.admit(small, input("d"));
  assert.equal(c.outcome, "throttled");
  assert.equal(c.event.status, "throttled");
  assert.equal(c.firstThrottled, true);
  assert.equal(d.firstThrottled, false);
  clock += 3600001;
  assert.equal(events.admit(small, input("e")).outcome, "fresh");
});

test("find is read-only and unsettled lists pending and running rows", () => {
  assert.equal(events.find("h1", "e1"), null);
  const { event } = events.admit(hook, input("e1"));
  assert.equal(events.find("h1", "e1").id, event.id);
  assert.equal(events.find("h1", "e1").duplicates, 0);
  const other = events.admit(hook, input("e2")).event;
  events.patch(other.id, { status: "running", jobId: "j1" });
  const done = events.admit(hook, input("e3")).event;
  events.patch(done.id, { status: "done" });
  assert.deepEqual(
    events
      .unsettled()
      .map((e) => e.eventId)
      .sort(),
    ["e1", "e2"],
  );
  assert.equal(events.byJob("j1").id, other.id);
  assert.equal(events.byJob("nope"), null);
});

test("forAssistant lists newest first without payload; payload, remove and forget work", () => {
  const a = events.admit(hook, input("a")).event;
  clock += 10;
  const b = events.admit(hook, input("b")).event;
  assert.deepEqual(
    events.forAssistant("a1").map((e) => e.eventId),
    ["b", "a"],
  );
  assert.equal(events.forAssistant("a1", { limit: 1 }).length, 1);
  assert.equal("payload" in events.forAssistant("a1")[0], false);
  assert.equal(events.payload(a.id), '{"n":"a"}');
  events.remove(a.id);
  assert.equal(events.get(a.id), null);
  events.forget("h1");
  assert.equal(events.get(b.id), null);
});

test("retention keeps 30 days of receipts and the newest 200 payloads", () => {
  const big = { ...hook, hourlyLimit: 1000 };
  const first = events.admit(big, input("e0")).event;
  for (let i = 1; i <= 200; i++) {
    clock += 1;
    events.admit(big, input(`e${i}`));
  }
  assert.equal(events.payload(first.id), null);
  assert.equal(events.get(first.id).eventId, "e0");
  assert.equal(events.forAssistant("a1", { limit: 500 }).length, 201);
  assert.notEqual(events.payload(events.find("h1", "e1").id), null);
  clock += 30 * day + 1;
  events.admit(big, input("late"));
  assert.equal(events.find("h1", "e200"), null);
  assert.equal(events.get(first.id), null);
  assert.equal(events.forAssistant("a1", { limit: 500 }).length, 1);
});
