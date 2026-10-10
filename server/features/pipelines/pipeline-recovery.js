import { serverMessages } from "../../lib/i18n/de.js";
import { activeNode, currentAttempt, terminal } from "./graph-navigation.js";
import { applyOutcome, launchStage, park, conclude, advance } from "./execution-stage.js";
import { provisionRun } from "./execution-workspace.js";
import { cancelRun } from "./pipeline-actions.js";
// Graceful stop through the launcher keeps the exit status and quiescence receipt,
// so a stopped turn stays inspectable (and overridable). Killing the tmux session
// would lose both; it is only the fallback of drivers without `finish`.
function stopTurn(engine, identity) {
  return engine.driver.finish
    ? engine.driver.finish(identity)
    : engine.driver.cancel(identity);
}
// The launcher escalates its group stop to SIGKILL after one second. A repeated
// SIGTERM that lands while it exits kills it by signal, losing the exit status
// that its quiescence receipt is compared with.
const RESTOP_MIN_MS = 2000;
/**
 * Some CLIs (observed with `opencode run`) report their terminal event and then
 * never exit. A completed turn that stays idle for the grace period is stopped and
 * concluded from its native result; any other turn is bounded by the timeouts.
 */
async function superviseRunningTurn(engine, run, node, identity, outcome) {
  const { completionGraceMs, inactivityTimeoutMs, turnTimeoutMs } = engine.timing;
  const now = engine.nowMs(),
    started = Date.parse(identity.startedAt),
    activity = outcome.lastActivityAt ? Date.parse(outcome.lastActivityAt) : started,
    attempt = currentAttempt(run);
  // Only the turn this attempt launched may be stopped on its behalf.
  if (!attempt || attempt.sessionId !== identity.sessionId) return;
  const settledAt = Date.parse(attempt.settledAfterCompletion);
  if (
    outcome.nativeResult === "completed" &&
    Number.isFinite(activity) &&
    now - activity >= completionGraceMs &&
    // A stop that did not land is repeated after another grace period.
    (!attempt.settledAfterCompletion ||
      !Number.isFinite(settledAt) ||
      now - settledAt >= Math.max(completionGraceMs, RESTOP_MIN_MS))
  ) {
    attempt.settledAfterCompletion = engine.now();
    engine.store.save(run);
    await stopTurn(engine, identity);
    return;
  }
  const timeout =
    turnTimeoutMs > 0 && Number.isFinite(started) && now - started >= turnTimeoutMs
      ? ["turn-timeout", serverMessages.pipelines.turnTimeout]
      : Number.isFinite(activity) && now - activity >= inactivityTimeoutMs
        ? ["inactivity-timeout", serverMessages.pipelines.inactivityTimeout]
        : null;
  if (!timeout) return;
  await stopTurn(engine, identity);
  attempt.stopped = true;
  park(engine, run, node, ...timeout);
}
export async function reconcileRun(engine, run) {
  // The polling snapshot may predate a gate action holding the run lock.
  // Recheck the freshly loaded state before interpreting absent active work.
  if (terminal(run) || run.imported?.historyOnly) return;
  if (run.phase === "provisioning" && !run.cancelRequested) {
    await provisionRun(engine, run);
    return;
  }
  if (run.cancelRequested && run.status !== "cancelled") {
    await cancelRun(engine, run);
    return;
  }
  if (run.status === "awaiting-human") {
    if (
      run.usageResumeAt &&
      Date.parse(run.usageResumeAt) <= engine.nowMs() &&
      activeNode(run)?.failReason === "usage-limit-exceeded"
    )
      await launchStage(engine, run, activeNode(run));
    return;
  }
  if (run.verifyJob) {
    await engine.settleVerification(run);
    return;
  }
  const node = activeNode(run);
  if (run.pendingTurn) {
    const queued = run.pendingTurn;
    await launchStage(
      engine,
      run,
      run.nodes.find((n) => n.id === queued.nodeId),
      queued,
    );
    return;
  }
  if (run.pendingAdvance) {
    await advance(engine, run, node);
    return;
  }
  if (run.pendingConclusion) {
    node.verdict = run.pendingConclusion.verdict;
    await conclude(engine, run, node, node.verdict);
    return;
  }
  if (!run.activeTurn) {
    park(
      engine,
      run,
      node,
      "session-error",
      serverMessages.pipelines.operationInterrupted,
    );
    return;
  }
  const identity = run.activeTurn;
  const outcome = await engine.driver.inspect(identity);
  if (outcome.status === "running") {
    await superviseRunningTurn(engine, run, node, identity, outcome);
    return;
  }
  if (["missing", "unknown"].includes(outcome.status)) {
    if (engine.nowMs() - Date.parse(identity.startedAt) < 5000) return;
    park(engine, run, node, "session-error", serverMessages.pipelines.turnNotRecovered);
    return;
  }
  if (!["completed", "failed"].includes(outcome.status)) return;
  const attempt = currentAttempt(run);
  if (!attempt || attempt.sessionId !== identity.sessionId) return;
  await applyOutcome(engine, run, outcome);
}
