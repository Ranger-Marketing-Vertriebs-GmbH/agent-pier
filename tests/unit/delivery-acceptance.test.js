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

test("two deliveries take events in order", () => {
  const { matches, acceptance } = setup();
  acceptance.expect("s1", { deliveryId: "d1", since: 1000, imageNames: [] });
  acceptance.expect("s1", { deliveryId: "d2", since: 1005, imageNames: [] });
  acceptance.report("s1", accepted(1010));
  acceptance.report("s1", accepted(1020));
  assert.deepEqual(
    matches.map((m) => m.deliveryId),
    ["d1", "d2"],
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
