import test from "node:test";
import assert from "node:assert/strict";
import {
  awaitingConfirmation,
  quietAfterMs,
} from "../../web/features/assistants/unconfirmed-turn.js";

test("an unconfirmed turn is awaited only until its run has been quiet", () => {
  const attempt = { id: "a", state: "uncertain", unconfirmed: true, reviewedAt: null };
  const since = 1000000;
  assert.equal(awaitingConfirmation(attempt, since, since + 1000), true);
  assert.equal(awaitingConfirmation(attempt, since, since + quietAfterMs), false);
  for (const other of [
    { ...attempt, unconfirmed: undefined },
    { ...attempt, reviewedAt: "2026-10-18T09:52:00.000Z" },
    { ...attempt, state: "interrupted" },
    { ...attempt, state: "running" },
    undefined,
  ])
    assert.equal(awaitingConfirmation(other, since, since + 1000), false);
});
