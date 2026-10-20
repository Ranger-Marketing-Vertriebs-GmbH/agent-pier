import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

// A run's token budget bounds the tokens its turns report (`run.usage.totalTokens`, as
// aggregateUsage sums them). It is checked whenever a turn would start: a run above its
// budget starts no new turn, a turn already running is never stopped, and the run waits
// at the stage that would have started until the owner raises the budget.
export const MAX_TOKEN_BUDGET = 1_000_000_000;

/** A budget from a definition or a run start: null for none, else 1 through the bound. */
export function tokenBudgetValue(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TOKEN_BUDGET)
    throw problem(serverMessages.pipelines.invalidTokenBudget);
  return value;
}

/** The tokens the run's turns reported so far. */
export const usedTokens = (run) =>
  Number.isFinite(run.usage?.totalTokens) ? run.usage.totalTokens : 0;

/** True once the reported tokens are above the run's budget. */
export const budgetExceeded = (run) =>
  Number.isSafeInteger(run.tokenBudget) &&
  run.tokenBudget > 0 &&
  usedTokens(run) > run.tokenBudget;

/**
 * Holds the turn `node` was about to start and parks the run at that stage. `hold` is
 * what starts it again: the turn's launch options, or `{ progress: true }` for a
 * parallel group whose pending members wait. The stage becomes the run's current one;
 * a stage that had not started yet has no attempt of its own.
 */
export function holdTurn(engine, run, node, hold) {
  if (run.currentNodeId !== node.id) {
    run.currentNodeId = node.id;
    run.currentAttemptId = null;
  }
  // A held group resume after a usage limit starts only the members that hit it.
  node.budgetHold = {
    ...hold,
    at: engine.now(),
    ...(node.failReason && node.failReason !== "budget-exceeded"
      ? { failReason: node.failReason }
      : {}),
  };
  node.status = "awaiting-gate";
  node.failReason = "budget-exceeded";
  node.failDetail = serverMessages.pipelines.budgetExceeded;
  run.status = "awaiting-human";
  run.usageResumeAt = null;
  delete run.pendingTurn;
  delete run.pendingConclusion;
  delete run.pendingAdvance;
  engine.store.save(run);
}

/**
 * A member's turn waits as a queued turn of a pending member; the group parks once its
 * running members settled (see progressGroup).
 */
export function holdMember(engine, run, member, queued) {
  member.status = "pending";
  member.queuedTurn = queued;
  engine.store.save(run);
}

/**
 * The owner's new budget for a run parked at its budget: above the tokens reported so
 * far, within the bound. Records the change and returns the hold to start again.
 */
export function raiseBudget(engine, run, node, value) {
  const budget = tokenBudgetValue(value ?? Number.NaN);
  const used = usedTokens(run);
  if (budget <= used) throw problem(serverMessages.pipelines.budgetBelowUsage(used));
  const raise = { at: engine.now(), from: run.tokenBudget, to: budget, used };
  run.tokenBudget = budget;
  run.budgetRaises = [...(run.budgetRaises || []), raise].slice(-20);
  const hold = node.budgetHold || {};
  delete node.budgetHold;
  delete node.failDetail;
  if (hold.failReason) node.failReason = hold.failReason;
  else delete node.failReason;
  delete hold.failReason;
  delete hold.at;
  return { raise, hold };
}
