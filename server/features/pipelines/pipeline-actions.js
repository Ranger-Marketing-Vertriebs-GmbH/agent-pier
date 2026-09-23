import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { activeNode, currentAttempt, outgoing, terminal } from "./graph-navigation.js";
import { advance, conclude, launchStage, loopBack } from "./execution-stage.js";
import { readVerdict } from "./stage-verdict.js";
export function requireLiveRun(run) {
  if (run.imported?.historyOnly)
    throw problem(serverMessages.pipelines.importedHistoryReadOnly, 409);
}
export function availableActions(run) {
  if (run.imported?.historyOnly) return ["delete"];
  if (terminal(run))
    return ["delete", ...(run.workspace && !run.pullRequestUrl ? ["create-pr"] : [])];
  const actions = ["abort"];
  if (run.status !== "awaiting-human") return actions;
  const node = activeNode(run);
  if (node.status === "awaiting-gate") {
    actions.push(node.failReason ? "override" : "accept");
    if (node.nativeId) actions.push("feedback");
  }
  if (node.status === "failed") {
    if (node.failReason === "usage-limit-exceeded")
      actions.push("wait-for-reset", "resume-now");
    else actions.push("retry");
    if (
      ["session-error", "inactivity-timeout"].includes(node.failReason) &&
      currentAttempt(run)?.status !== "launching"
    ) {
      actions.push("reconcile");
      if (currentAttempt(run)) actions.push("override");
    }
  }
  if (outgoing(run, node.id, "fail")?.maxIterations) actions.push("loop-back");
  return actions;
}
export async function gateAction(engine, run, { action, feedback, resumeAt } = {}) {
  requireLiveRun(run);
  if (!availableActions(run).includes(action) || ["delete", "create-pr"].includes(action))
    throw problem(serverMessages.pipelines.actionUnavailable, 409);
  const node = activeNode(run);
  if (action === "abort") return cancelRun(engine, run);
  if (action === "retry" || action === "resume-now") {
    if (node.failReason === "pr-failed") {
      await advance(engine, run, node);
      return;
    }
    run.usageResumeAt = null;
    await launchStage(engine, run, node);
    return;
  }
  if (action === "wait-for-reset") {
    const parsed = resumeAt ? Date.parse(resumeAt) : null;
    if (resumeAt && (!Number.isFinite(parsed) || parsed <= engine.nowMs()))
      throw problem(serverMessages.pipelines.invalidUsageResetTime);
    run.usageResumeAt = new Date(
      parsed ||
        (node.usageLimit?.resetAt
          ? node.usageLimit.resetAt * 1000 + 60000
          : engine.nowMs() + 3600000),
    ).toISOString();
    engine.store.save(run);
    return;
  }
  if (action === "feedback") {
    if (
      typeof feedback !== "string" ||
      !feedback.trim() ||
      Buffer.byteLength(feedback) > 32768
    )
      throw problem(serverMessages.pipelines.feedbackSize);
    node.gateDecision = "feedback";
    node.gateDecidedAt = engine.now();
    node.verified = false;
    node.verifyAttempts = 0;
    delete node.verifyResult;
    await launchStage(engine, run, node, {
      kind: "gate-feedback",
      resumeNativeId: node.nativeId,
      feedback,
    });
    return;
  }
  if (action === "loop-back") {
    if (
      feedback !== undefined &&
      (typeof feedback !== "string" || Buffer.byteLength(feedback) > 32768)
    )
      throw problem(serverMessages.pipelines.invalidLoopFeedback);
    node.gateDecision = "looped-back";
    node.gateDecidedAt = engine.now();
    await loopBack(
      engine,
      run,
      node,
      node.verdict || {
        result: "fail",
        summary: serverMessages.pipelines.operatorRepairRound,
      },
      feedback,
    );
    return;
  }
  if (action === "reconcile") {
    const attempt = currentAttempt(run);
    const outcome = await engine.driver.inspect({
      runId: run.id,
      nodeId: node.id,
      attemptId: attempt.attemptId,
      turnId: attempt.turnId,
      sessionId: attempt.sessionId,
    });
    if (
      outcome.status !== "completed" ||
      outcome.exitCode !== 0 ||
      outcome.isError ||
      outcome.quiesced !== true
    )
      throw problem(serverMessages.pipelines.reconcileRequiresQuiescedTurn, 409);
    const found = readVerdict(run, attempt);
    if (!found.present) throw problem(serverMessages.pipelines.noFreshVerdict, 409);
    node.verified = false;
    node.verifyAttempts = 0;
    run.status = "running";
    node.status = "running";
    node.verdict = found.verdict;
    attempt.verdict = found.verdict;
    attempt.quiesced = true;
    run.pendingConclusion = { nodeId: node.id, verdict: found.verdict };
    delete node.failReason;
    delete node.failDetail;
    engine.store.save(run);
    await conclude(engine, run, node, found.verdict);
    return;
  }
  if (action === "override" && node.status === "failed") {
    const attempt = currentAttempt(run);
    const outcome = await engine.driver.inspect({
      runId: run.id,
      nodeId: node.id,
      attemptId: attempt.attemptId,
      turnId: attempt.turnId,
      sessionId: attempt.sessionId,
    });
    if (
      run.activeTurn ||
      run.verifyJob ||
      !["completed", "failed"].includes(outcome.status) ||
      outcome.quiesced !== true
    )
      throw problem(serverMessages.pipelines.overrideRequiresStoppedTurn, 409);
    attempt.quiesced = true;
  }
  if (action === "override") {
    const selected = node.forwardCondition
      ? outgoing(run, node.id, node.forwardCondition)
      : outgoing(run, node.id, "pass") || outgoing(run, node.id, "default");
    node.forwardCondition = selected?.condition;
    Object.assign(
      node,
      selected?.effects || { humanGate: false, verify: false, createPr: false },
    );
  }
  node.gateDecision = action === "override" ? "overridden" : "accepted";
  node.gateDecidedAt = engine.now();
  node.overridden = action === "override";
  await advance(engine, run, node);
}
export async function cancelRun(engine, run) {
  requireLiveRun(run);
  if (terminal(run)) throw problem(serverMessages.pipelines.runAlreadyFinished, 409);
  run.cancelRequested = true;
  engine.store.save(run);
  if (run.activeTurn) await engine.driver.cancel(run.activeTurn);
  if (run.verifyJob) await engine.verify.cancel(run.verifyJob);
  run.status = "cancelled";
  run.finishedAt = engine.now();
  run.activeTurn = null;
  run.verifyJob = null;
  run.usageResumeAt = null;
  const a = currentAttempt(run);
  if (a && !a.finishedAt) {
    a.finishedAt = engine.now();
    a.status = "cancelled";
  }
  engine.store.save(run);
}
