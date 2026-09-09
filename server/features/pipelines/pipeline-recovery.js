import { activeNode, currentAttempt, terminal } from "./graph-navigation.js";
import { applyOutcome, launchStage, park, conclude, advance } from "./execution-stage.js";
import { provisionRun } from "./execution-workspace.js";
import { cancelRun } from "./pipeline-actions.js";
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
      "The prior operation was interrupted. Inspect the preserved workspace before retrying.",
    );
    return;
  }
  const identity = run.activeTurn;
  const outcome = await engine.driver.inspect(identity);
  if (outcome.status === "running") {
    const activity = outcome.lastActivityAt
      ? Date.parse(outcome.lastActivityAt)
      : Date.parse(identity.startedAt);
    if (Number.isFinite(activity) && engine.nowMs() - activity >= 7200000) {
      await engine.driver.cancel(identity);
      park(
        engine,
        run,
        node,
        "inactivity-timeout",
        "The native stage exceeded its two-hour inactivity budget.",
      );
    }
    return;
  }
  if (["missing", "unknown"].includes(outcome.status)) {
    if (engine.nowMs() - Date.parse(identity.startedAt) < 5000) return;
    park(
      engine,
      run,
      node,
      "session-error",
      "The exact native turn could not be recovered. Its workspace is preserved.",
    );
    return;
  }
  if (!["completed", "failed"].includes(outcome.status)) return;
  const attempt = currentAttempt(run);
  if (!attempt || attempt.sessionId !== identity.sessionId) return;
  await applyOutcome(engine, run, outcome);
}
