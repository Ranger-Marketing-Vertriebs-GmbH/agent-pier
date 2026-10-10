import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { activeNode, currentAttempt, outgoing, terminal } from "./graph-navigation.js";
import { advance, conclude, launchStage, loopBack } from "./execution-stage.js";
import { readVerdict } from "./stage-verdict.js";
export function requireLiveRun(run) {
  if (run.imported?.historyOnly)
    throw problem(serverMessages.pipelines.importedHistoryReadOnly, 409);
}
/**
 * What an override of the active stage does, so the confirmation and the audit can
 * name it: a failed turn continues into its verification and gate, a failed
 * verification is accepted as is, and at any other parked gate the override is
 * that gate's decision.
 */
export function overridePath(node) {
  if (node?.status === "failed") return "checks-follow";
  return node?.failReason === "verify-failed" ? "skips-checks" : "gate-decision";
}
export function availableActions(run) {
  if (run.imported?.historyOnly) return ["delete"];
  if (terminal(run))
    return [
      "delete",
      // Only a completed run publishes; runs prepared before remotes were recorded
      // keep offering the action.
      ...(run.status === "completed" &&
      run.workspace &&
      run.workspace.hasRemote !== false &&
      !run.pullRequestUrl
        ? ["create-pr"]
        : []),
    ];
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
    const attempt = currentAttempt(run);
    if (
      ["session-error", "inactivity-timeout", "turn-timeout"].includes(node.failReason) &&
      attempt?.status !== "launching"
    ) {
      if (recheckable(attempt)) actions.push("reconcile");
      if (attempt) actions.push("override");
    }
  }
  if (outgoing(run, node.id, "fail")?.maxIterations) actions.push("loop-back");
  return actions;
}
// A recorded non-zero exit or an AgentPier stop is final: checking again cannot succeed.
// A clean exit whose process group was not yet proven stopped may still settle.
function recheckable(attempt) {
  return !(
    attempt?.stopped ||
    (Number.isInteger(attempt?.exitCode) && attempt.exitCode !== 0)
  );
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
  if (action === "override") return overrideStage(engine, run, node);
  node.gateDecision = "accepted";
  node.gateDecidedAt = engine.now();
  node.overridden = node.overridden === true;
  await advance(engine, run, node);
}
async function overrideStage(engine, run, node) {
  const failed = node.status === "failed",
    attempt = currentAttempt(run);
  if (failed) {
    const identity = {
      runId: run.id,
      nodeId: node.id,
      attemptId: attempt.attemptId,
      turnId: attempt.turnId,
      sessionId: attempt.sessionId,
    };
    let outcome = await engine.driver.inspect(identity);
    // A turn AgentPier just stopped may need a moment to exit and leave its receipt.
    for (let i = 0; attempt.stopped && outcome.status === "running" && i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      outcome = await engine.driver.inspect(identity);
    }
    if (
      run.activeTurn ||
      run.verifyJob ||
      !["completed", "failed"].includes(outcome.status) ||
      outcome.quiesced !== true
    )
      throw problem(serverMessages.pipelines.overrideRequiresStoppedTurn, 409);
    attempt.quiesced = true;
  }
  const reason = node.failReason;
  node.overrides = [
    ...(Array.isArray(node.overrides) ? node.overrides : []),
    { at: engine.now(), failReason: reason ?? null, attemptId: attempt?.id ?? null },
  ].slice(-20);
  node.gateDecision = "overridden";
  node.gateDecidedAt = engine.now();
  node.overridden = true;
  if (reason === "verify-failed") {
    // The operator at the gate explicitly accepts the failed verification itself.
    const selected = node.forwardCondition
      ? outgoing(run, node.id, node.forwardCondition)
      : outgoing(run, node.id, "pass") || outgoing(run, node.id, "default");
    node.forwardCondition = selected?.condition;
    Object.assign(
      node,
      selected?.effects || { humanGate: false, verify: false, createPr: false },
    );
    await advance(engine, run, node);
    return;
  }
  // At a parked gate the operator decides as that gate. A failed native turn has not
  // reached its gate yet: verification and the human approval still follow.
  if (!failed) node.gateBypassed = true;
  delete node.failReason;
  delete node.failDetail;
  node.status = "running";
  run.status = "running";
  run.pendingConclusion = { nodeId: node.id, verdict: node.verdict };
  engine.store.save(run);
  await conclude(engine, run, node, node.verdict);
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
  // A terminal run leaves no stage working or waiting for a decision.
  for (const node of run.nodes)
    if (["running", "awaiting-gate"].includes(node.status)) {
      node.status = "cancelled";
      node.finishedAt ??= run.finishedAt;
    }
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
