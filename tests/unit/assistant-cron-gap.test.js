import test from "node:test";
import assert from "node:assert/strict";
import { cronField, minGapMinutes } from "../../server/features/assistants/cron-gap.js";

test("the shortest gap between runs of a five-field cron", () => {
  for (const [expr, gap] of [
    ["0 9 * * *", 1440],
    ["*/15 * * * *", 15],
    ["*/5 * * * *", 5],
    ["0,10 9 * * *", 10],
    ["0 */2 * * *", 120],
    ["30 8-18 * * 1-5", 60],
    ["*/30 8-18 * * 1-5", 30],
    // Across midnight: 23:50 to 00:00 the next day.
    ["0,50 0,23 * * *", 10],
    ["5/20 * * * *", 20],
  ])
    assert.equal(minGapMinutes(expr), gap, expr);
});

test("anything not understood is refused, never guessed", () => {
  for (const expr of [
    "0 9 * * * *",
    "0 9 * *",
    "MON 9 * * *",
    "60 9 * * *",
    "0 24 * * *",
    "*/0 * * * *",
    "9-3 * * * *",
    "@daily",
    "",
  ])
    assert.equal(minGapMinutes(expr), null, expr);
  assert.deepEqual(cronField("1-5/2,10", 0, 59), [1, 3, 5, 10]);
});
