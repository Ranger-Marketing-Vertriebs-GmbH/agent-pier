import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  MAX_TOKEN_BUDGET,
  budgetExceeded,
  raiseBudget,
  tokenBudgetValue,
  usedTokens,
} from "../../server/features/pipelines/run-budget.js";
import { MAX_TOKEN_BUDGET as WEB_MAX } from "../../web/features/pipelines/token-budget.js";

const run = (tokenBudget, totalTokens) => ({
  tokenBudget,
  usage: totalTokens === undefined ? null : { totalTokens },
});

test("a run exceeds its budget only once its reported tokens are above it", () => {
  assert.equal(budgetExceeded(run(100, 99)), false);
  assert.equal(budgetExceeded(run(100, 100)), false);
  assert.equal(budgetExceeded(run(100, 101)), true);
  // Without a budget, or before any turn reported usage, nothing is exceeded.
  assert.equal(budgetExceeded(run(null, 10 ** 9)), false);
  assert.equal(budgetExceeded(run(undefined, 10 ** 9)), false);
  assert.equal(budgetExceeded(run(100)), false);
  assert.equal(usedTokens(run(100)), 0);
});

test("the threshold is exactly 'reported tokens above the budget'", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: MAX_TOKEN_BUDGET }),
      fc.nat({ max: 2 * MAX_TOKEN_BUDGET }),
      (budget, used) => budgetExceeded(run(budget, used)) === used > budget,
    ),
  );
});

test("a budget is a whole number from 1 through the bound, or none", () => {
  assert.equal(tokenBudgetValue(undefined), null);
  assert.equal(tokenBudgetValue(null), null);
  assert.equal(tokenBudgetValue(1), 1);
  assert.equal(tokenBudgetValue(MAX_TOKEN_BUDGET), MAX_TOKEN_BUDGET);
  for (const value of [0, -5, 1.5, "100", MAX_TOKEN_BUDGET + 1, Number.NaN, true])
    assert.throws(() => tokenBudgetValue(value), { status: 400 });
});

test("raising the budget needs a value above the reported tokens", () => {
  const engine = { now: () => "2026-10-20T10:00:00.000Z" };
  const parked = run(100, 150);
  const node = {
    failReason: "budget-exceeded",
    failDetail: "x",
    budgetHold: { kind: "kickoff" },
  };
  for (const value of [undefined, 150, 100])
    assert.throws(() => raiseBudget(engine, parked, node, value), { status: 400 });
  const { raise, hold } = raiseBudget(engine, parked, node, 151);
  assert.deepEqual(raise, { at: engine.now(), from: 100, to: 151, used: 150 });
  assert.deepEqual(hold, { kind: "kickoff" });
  assert.equal(parked.tokenBudget, 151);
  assert.deepEqual(parked.budgetRaises, [raise]);
  assert.equal(node.failReason, undefined);
  assert.equal(node.budgetHold, undefined);
});

test("a held group resume gets back the reason it was parked for", () => {
  const engine = { now: () => "2026-10-20T10:00:00.000Z" };
  const node = {
    failReason: "budget-exceeded",
    budgetHold: { resume: true, failReason: "usage-limit-exceeded" },
  };
  const { hold } = raiseBudget(engine, run(100, 150), node, 1000);
  assert.deepEqual(hold, { resume: true });
  assert.equal(node.failReason, "usage-limit-exceeded");
});

test("the web inputs use the engine's bound", () => {
  assert.equal(WEB_MAX, MAX_TOKEN_BUDGET);
});
