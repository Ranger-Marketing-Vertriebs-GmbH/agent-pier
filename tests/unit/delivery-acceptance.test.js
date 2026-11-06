import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DeliveryAcceptance,
  EVENT_BUFFER_MS,
} from "../../server/features/chat/delivery-acceptance.js";

function setup() {
  const clock = { t: 1000 };
  const matches = [];
  const acceptance = new DeliveryAcceptance({
    now: () => clock.t,
    onMatch: (sessionId, deliveryId, outcome) =>
      matches.push({ sessionId, deliveryId, outcome }),
  });
  return { clock, matches, acceptance };
}

const accepted = (at, imageNames = [], extra = {}) => ({
  kind: "accepted",
  at,
  imageNames,
  imageCount: imageNames?.length ?? 0,
  ...extra,
});

test("matches the first event after Enter", () => {
  const { matches, acceptance } = setup();
  acceptance.expect("s1", { deliveryId: "d1", since: 1000, imageNames: [] });
  acceptance.report("s1", accepted(1010, [], { queued: true }));
  assert.deepEqual(matches, [
    { sessionId: "s1", deliveryId: "d1", outcome: { kind: "accepted", queued: true } },
  ]);
});

test("event before since does not match", () => {
  const { matches, acceptance } = setup();
  acceptance.expect("s1", { deliveryId: "d1", since: 1000, imageNames: [] });
  acceptance.report("s1", accepted(999));
  assert.equal(matches.length, 0);
  acceptance.report("s1", accepted(1001));
  assert.equal(matches.length, 1);
});

test("foreign event does not match", () => {
  const { matches, acceptance } = setup();
  acceptance.expect("s1", { deliveryId: "d1", since: 1000, imageNames: ["a.png"] });
  acceptance.report("s1", accepted(1010, ["b.png"]));
  assert.equal(matches.length, 0);
  acceptance.report("s1", accepted(1020, ["a.png"]));
  assert.equal(matches[0].deliveryId, "d1");
});

test("image names compare as an order-insensitive multiset", () => {
  const { matches, acceptance } = setup();
  acceptance.expect("s1", { deliveryId: "d1", since: 1000, imageNames: ["a", "b", "a"] });
  acceptance.report("s1", accepted(1010, ["a", "b", "b"]));
  assert.equal(matches.length, 0);
  acceptance.report("s1", accepted(1020, ["b", "a", "a"]));
  assert.equal(matches.length, 1);
});

test("codex event matches by count", () => {
  const { matches, acceptance } = setup();
  acceptance.expect("s1", { deliveryId: "d1", since: 1000, imageNames: ["a", "b"] });
  acceptance.report("s1", {
    kind: "accepted",
    at: 1010,
    imageNames: null,
    imageCount: 1,
  });
  assert.equal(matches.length, 0);
  acceptance.report("s1", {
    kind: "accepted",
    at: 1020,
    imageNames: null,
    imageCount: 2,
  });
  assert.equal(matches.length, 1);
});

test("two deliveries in turn: Enter, event, Enter, event", () => {
  const { matches, acceptance } = setup();
  acceptance.expect("s1", { deliveryId: "d1", since: 1000, imageNames: [] });
  acceptance.report("s1", accepted(1010));
  acceptance.expect("s1", { deliveryId: "d2", since: 1020, imageNames: [] });
  acceptance.report("s1", accepted(1030));
  assert.deepEqual(
    matches.map((m) => m.deliveryId),
    ["d1", "d2"],
  );
});

test("events reported after both Enters still go to their own delivery by time", () => {
  const { matches, acceptance } = setup();
  acceptance.expect("s1", { deliveryId: "d1", since: 1000, imageNames: [] });
  acceptance.expect("s1", { deliveryId: "d2", since: 1005, imageNames: [] });
  // Both reach the matcher after the second Enter, dated between and after it.
  acceptance.report("s1", accepted(1003));
  acceptance.report("s1", accepted(1010));
  assert.deepEqual(
    matches.map((m) => m.deliveryId),
    ["d1", "d2"],
  );
});

test("a delivery without an event never takes the next delivery's event", () => {
  const { matches, acceptance } = setup();
  // D1 is hook-blocked without an event (or a command with no submit event).
  acceptance.expect("s1", { deliveryId: "d1", since: 1000, imageNames: [] });
  acceptance.expect("s1", { deliveryId: "d2", since: 2000, imageNames: [] });
  acceptance.report("s1", accepted(2010));
  assert.deepEqual(
    matches.map((m) => m.deliveryId),
    ["d2"],
  );
  // D1 is retired: it stays handed-off and a later event finds nothing open.
  acceptance.report("s1", accepted(2020));
  acceptance.expect("s1", { deliveryId: "d3", since: 2030, imageNames: [] });
  assert.deepEqual(
    matches.map((m) => m.deliveryId),
    ["d2"],
  );
});

test("an event dated after two Enters goes to the newest; the older one asks", () => {
  const { matches, acceptance } = setup();
  acceptance.expect("s1", { deliveryId: "d1", since: 1000, imageNames: [] });
  acceptance.expect("s1", { deliveryId: "d2", since: 1005, imageNames: [] });
  acceptance.report("s1", accepted(1010));
  acceptance.report("s1", accepted(1020));
  assert.deepEqual(
    matches.map((m) => m.deliveryId),
    ["d2"],
  );
});

test("a match retires older deliveries, also those the event did not fit", () => {
  const { matches, acceptance } = setup();
  acceptance.expect("s1", { deliveryId: "d1", since: 1000, imageNames: ["a.png"] });
  acceptance.expect("s1", { deliveryId: "d2", since: 1005, imageNames: [] });
  acceptance.report("s1", accepted(1010));
  // D2 matched and retired D1, which the event never fit: it gets no late match.
  acceptance.report("s1", accepted(1020, ["a.png"]));
  assert.deepEqual(
    matches.map((m) => m.deliveryId),
    ["d2"],
  );
});

test("a buffered event goes to the delivery it fits and keeps newer ones open", () => {
  const { matches, acceptance } = setup();
  acceptance.report("s1", accepted(1010));
  acceptance.expect("s1", { deliveryId: "d1", since: 1020, imageNames: [] });
  acceptance.expect("s1", { deliveryId: "d2", since: 1005, imageNames: [] });
  assert.deepEqual(
    matches.map((m) => m.deliveryId),
    ["d2"],
  );
  acceptance.report("s1", accepted(1030));
  assert.deepEqual(
    matches.map((m) => m.deliveryId),
    ["d2", "d1"],
  );
});

test("buffered event matches a later expectation", () => {
  const { clock, matches, acceptance } = setup();
  acceptance.report("s1", accepted(1010));
  clock.t = 1100;
  acceptance.expect("s1", { deliveryId: "d1", since: 1000, imageNames: [] });
  assert.equal(matches.length, 1);
  acceptance.expect("s1", { deliveryId: "d2", since: 1000, imageNames: [] });
  assert.equal(matches.length, 1);
});

test("buffer expires after EVENT_BUFFER_MS", () => {
  const { clock, matches, acceptance } = setup();
  acceptance.report("s1", accepted(1010));
  clock.t = 1000 + EVENT_BUFFER_MS + 1;
  acceptance.expect("s1", { deliveryId: "d1", since: 1000, imageNames: [] });
  assert.equal(matches.length, 0);
});

test("dropped outcome carries reason", () => {
  const { matches, acceptance } = setup();
  acceptance.expect("s1", { deliveryId: "d1", since: 1000, imageNames: [] });
  acceptance.report("s1", { ...accepted(1010), kind: "dropped", reason: "rejected" });
  assert.deepEqual(matches[0].outcome, { kind: "dropped", reason: "rejected" });
});

test("forget clears state", () => {
  const { matches, acceptance } = setup();
  acceptance.ready("s1", "codex-proxy");
  acceptance.expect("s1", { deliveryId: "d1", since: 1000, imageNames: [] });
  acceptance.report("s2", accepted(1005));
  acceptance.forget("s1");
  assert.equal(acceptance.supports("s1"), false);
  acceptance.report("s1", accepted(1010));
  assert.equal(matches.length, 0);
});

test("supports only after ready", () => {
  const { acceptance } = setup();
  assert.equal(acceptance.supports("s1"), false);
  acceptance.ready("s1", "claude-mod");
  assert.equal(acceptance.supports("s1"), true);
  assert.equal(acceptance.supports("s2"), false);
});

test("expired expectations are dropped and a throwing listener keeps state intact", (t) => {
  t.mock.method(console, "error", () => {});
  const clock = { t: 1000 };
  const seen = [];
  const acceptance = new DeliveryAcceptance({
    now: () => clock.t,
    onMatch: (_s, deliveryId) => {
      seen.push(deliveryId);
      throw new Error("boom");
    },
  });
  acceptance.expect("s1", { deliveryId: "old", since: 1000, imageNames: [] });
  clock.t += 600001;
  acceptance.report("s1", accepted(clock.t));
  assert.deepEqual(seen, []);
  acceptance.expect("s1", { deliveryId: "d1", since: clock.t, imageNames: [] });
  acceptance.expect("s1", { deliveryId: "d2", since: clock.t, imageNames: [] });
  acceptance.report("s1", accepted(clock.t + 1));
  assert.deepEqual(seen, ["d1", "d2"]);
});

test("a withdrawn expectation never matches and later events buffer again", () => {
  const { matches, acceptance } = setup();
  acceptance.expect("s1", { deliveryId: "d1", since: 1000, imageNames: [] });
  acceptance.expect("s1", { deliveryId: "d2", since: 1000, imageNames: [] });
  acceptance.withdraw("s1", "d1");
  acceptance.report("s1", accepted(1010));
  assert.deepEqual(
    matches.map((match) => match.deliveryId),
    ["d2"],
  );
  acceptance.withdraw("s1", "d2");
  acceptance.withdraw("s1", "unknown");
  // With nothing expected, an event is buffered for a later Enter.
  acceptance.report("s1", accepted(1020));
  acceptance.expect("s1", { deliveryId: "d3", since: 1015, imageNames: [] });
  assert.deepEqual(
    matches.map((match) => match.deliveryId),
    ["d2", "d3"],
  );
});

test("expect replaces an earlier expectation of the same delivery", () => {
  const { matches, acceptance } = setup();
  acceptance.expect("s1", { deliveryId: "a", since: 1000, imageNames: [] });
  acceptance.expect("s1", { deliveryId: "a", since: 1100, imageNames: [] });
  acceptance.expect("s1", { deliveryId: "b", since: 1200, imageNames: [] });
  acceptance.report("s1", accepted(1150));
  acceptance.report("s1", accepted(1250));
  assert.deepEqual(
    matches.map((match) => match.deliveryId),
    ["a", "b"],
  );
});
