import test from "node:test";
import assert from "node:assert/strict";
import {
  greetingOf,
  shortSpan,
  summaryParts,
} from "../../web/features/dashboard/start-header.js";

test("the greeting follows the time of day", () => {
  assert.deepEqual([0, 4, 5, 10, 11, 17, 18, 23].map(greetingOf), [
    "evening",
    "evening",
    "morning",
    "morning",
    "day",
    "day",
    "evening",
    "evening",
  ]);
});

test("the summary shows only known parts and never an invented zero", () => {
  assert.deepEqual(summaryParts({}), []);
  assert.deepEqual(summaryParts({ sessions: 0, agents: null, attention: 0 }), []);
  assert.deepEqual(
    summaryParts({ sessions: 5, agents: 3, attention: 2 }).map((part) => [
      part.id,
      part.count,
    ]),
    [
      ["sessions", 5],
      ["agents", 3],
      ["attention", 2],
    ],
  );
});

test("short spans count minutes, hours and days", () => {
  const now = Date.parse("2026-10-27T18:00:00Z");
  assert.deepEqual(shortSpan(now - 20_000, now), { unit: "now" });
  assert.deepEqual(shortSpan(now - 3 * 60_000, now), { unit: "minutes", value: 3 });
  assert.deepEqual(shortSpan(now - 125 * 60_000, now), { unit: "hours", value: 2 });
  assert.deepEqual(shortSpan(now - 50 * 3600_000, now), { unit: "days", value: 2 });
  assert.equal(shortSpan(0, now), null);
  assert.equal(shortSpan(now + 60_000, now), null);
});
