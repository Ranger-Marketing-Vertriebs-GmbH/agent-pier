import test from "node:test";
import assert from "node:assert/strict";
import {
  awaitingConfirmation,
  quietAfterMs,
} from "../../web/features/assistants/unconfirmed-turn.js";

test("an unconfirmed turn is awaited only until its run has been quiet", () => {
  const createdAt = new Date(1000000).toISOString();
  const attempt = { state: "uncertain", unconfirmed: true, reviewedAt: null, createdAt };
  assert.equal(awaitingConfirmation(attempt, 0, 1000000 + 1000), true);
  assert.equal(awaitingConfirmation(attempt, 0, 1000000 + quietAfterMs), false);
  // Progress restarts the quiet period.
  assert.equal(
    awaitingConfirmation(attempt, 1000000 + quietAfterMs, 1000000 + quietAfterMs + 1),
    true,
  );
  for (const other of [
    { ...attempt, unconfirmed: undefined },
    { ...attempt, reviewedAt: createdAt },
    { ...attempt, state: "interrupted" },
    { ...attempt, state: "running" },
    undefined,
  ])
    assert.equal(awaitingConfirmation(other, 0, 1000000 + 1000), false);
});
