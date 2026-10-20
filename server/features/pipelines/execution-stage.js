import { serverMessages } from "../../lib/i18n/de.js";
import { checkpointStage } from "./stage-checkpoint.js";
import { randomUUID } from "node:crypto";
import { clearVerdict, readVerdict } from "./stage-verdict.js";
import {
  answersNudge,
  claimAnswersNudge,
  filterAnswers,
  missingAnswers,
  recordResponses,
  recordRound,
} from "./loop-rounds.js";
import {
  prepareReportDirectory,
  recordReportDigests,
  reportDirectory,
} from "./stage-reports.js";
import { resumedRepairPrompt, stagePrompt } from "./stage-prompt.js";
import { parkForPublish, publishCheck, riskGate } from "./risk-gate.js";
import {
  adoptSpec,
  checkSpec,
  claimCriteriaNudge,
  criteriaNudge,
  freezeSpec,
  holdSpec,
  missingCriteria,
} from "./run-spec.js";
import {
  RESUMED_REPAIR,
  contextExhausted,
  freshAfterResume,
  repairLaunch,
  sessionKey,
} from "./loop-session.js";
import { launchGroup } from "./parallel-group.js";
import { aggregateUsage, verificationFailure } from "./turn-results.js";
import {
  activeNode,
  clearTurn,
  currentAttempt,
  memberTurn,
  nodeAttempt,
  failDecision,
  outgoing,
  edgeKey,
  loopResetSet,
} from "./graph-navigation.js";

export async function launchStage(engine, run, node, options = {}) {
  if (node.kind === "parallel") return launchGroup(engine, run, node, options);
  // prepareStage records the turn whose port block it reserves here; the block is
  // settled once that turn is saved with it, or the launch failed.
  const reservation = { turnId: null };
  try {
    return await prepareStage(engine, run, node, options, reservation);
  } catch (error) {
    engine.recordError(error);
    park(
      engine,
      run,
      node,
      "session-error",
      [400, 409].includes(error.status)
        ? error.message
        : serverMessages.pipelines.stageWorkspaceUnsafe,
    );
  } finally {
    if (reservation.turnId) engine.ports.settle(reservation.turnId);
  }
}
async function prepareStage(
  engine,
  run,
  node,
  { kind = "kickoff", feedback = "", resumeNativeId, repair } = {},
  reservation,
) {
  // A group member's turn starts beside its siblings: it is queued on the member and
  // never moves the run's current stage, attempt or usage-limit resume time.
  const member = Boolean(node.group);
  const queued = {
    kind,
    feedback,
    ...(resumeNativeId ? { resumeNativeId } : {}),
    ...(repair ? { repair } : {}),
  };
  if (member) node.queuedTurn = queued;
  else run.pendingTurn = { nodeId: node.id, ...queued };
  engine.store.save(run);
  // A resumed repair opens a new attempt like a kickoff, in the target's earlier session.
  if (opensAttempt(kind)) {
    node.verdictContinuations = 0;
    node.verifyAttempts = 0;
    delete node.verifyResult;
    delete node.verified;
    delete node.nativeId;
    node.attemptId = randomUUID();
  }
  if (kind === RESUMED_REPAIR) node.nativeId = resumeNativeId;
  const now = engine.now();
  // The spec freezes before another stage reads it, and the file holds the recorded text.
  freezeSpec(run, node, now);
  const identity = {
    runId: run.id,
    nodeId: node.id,
    attemptId: node.attemptId,
    turnId: randomUUID(),
    sessionId: randomUUID(),
  };
  const verdictPath = `.pipeline/turns/${identity.turnId}/verdict.json`;
  clearVerdict(run.workingDir, identity.turnId);
  const reportDir = prepareReportDirectory(
    run.workingDir,
    turnReportDirectory(run, node, kind, identity.turnId),
  );
  const workspaceState = engine.workspace.inspect
    ? await engine.workspace.inspect(run.workspace)
    : null;
  // A stage keeps its block across turns while it stays free, so a URL it reported holds.
  reservation.turnId = identity.turnId;
  const ports = await engine.ports.lease({
    turnId: identity.turnId,
    prefer: run.executionLog.findLast((a) => a.nodeId === node.id && a.ports)?.ports.base,
  });
  const prompt =
    kind === RESUMED_REPAIR
      ? resumedRepairPrompt(run, node, feedback, verdictPath, reportDir, ports)
      : stagePrompt(run, node, feedback, verdictPath, reportDir, ports);
  const attempt = {
    id: identity.turnId,
    ...identity,
    kind,
    ...(repair ? { repair } : {}),
    sessionKey: sessionKey(node.profileSnapshot),
    verdictPath,
    reportDir,
    ports,
    startedAt: now,
    status: "launching",
    baseSha: workspaceState?.headSha || run.workspace.baseSha,
    ...(member ? { groupAttemptId: run.currentAttemptId } : {}),
  };
  // Verdicts belong to the turn that produced them; history retains prior results.
  // An override applies to the turn it overrode, never to this new one.
  delete node.verdict;
  delete node.overridden;
  delete node.gateBypassed;
  delete node.riskGate;
  node.status = "running";
  node.startedAt = now;
  delete node.finishedAt;
  delete node.failReason;
  delete node.failDetail;
  run.executionLog.push(attempt);
  const turn = { ...identity, kind, startedAt: now, ports };
  run.activityAt = now;
  if (member) {
    delete node.queuedTurn;
    run.activeTurns = { ...run.activeTurns, [node.id]: turn };
  } else {
    run.status = "running";
    delete run.pendingTurn;
    delete run.pendingConclusion;
    delete run.pendingAdvance;
    run.currentNodeId = node.id;
    run.currentAttemptId = attempt.id;
    run.activeTurns = { [node.id]: turn };
    run.usageResumeAt = null;
  }
  engine.store.save(run);
  try {
    const receipt = await engine.driver.start({
      ...identity,
      profileSnapshot: node.profileSnapshot,
      cwd: run.workingDir,
      prompt,
      verdictPath,
      ports,
      kind,
      ...(resumeNativeId ? { resumeNativeId } : {}),
    });
    if (receipt.sessionId !== identity.sessionId)
      throw Error("Stage driver returned a different session identity.");
    attempt.status = "running";
    node.sessionId = identity.sessionId;
    turn.sessionId = identity.sessionId;
    if (receipt.nativeId) {
      node.nativeId = receipt.nativeId;
      turn.nativeId = receipt.nativeId;
    }
    engine.store.save(run);
  } catch (error) {
    await engine.driver.cancel(identity).catch(() => {});
    // The failed turn gives its block back; a fresh fallback turn may take it again.
    engine.ports.settle(identity.turnId);
    if (kind === RESUMED_REPAIR) {
      engine.recordError(error);
      await resumeFallback(engine, run, node, attempt, "resume-failed", error.message);
      return;
    }
    park(
      engine,
      run,
      node,
      "session-error",
      [400, 409].includes(error.status)
        ? error.message
        : serverMessages.pipelines.stageLaunchFailed,
    );
    engine.recordError(error);
  }
}
const opensAttempt = (kind) => kind === "kickoff" || kind === RESUMED_REPAIR;
// A kickoff opens its attempt's report directory; a verdict nudge continues the turn it
// nudges; feedback and verification-repair turns write into a subdirectory of their own.
function turnReportDirectory(run, node, kind, turnId) {
  if (opensAttempt(kind)) return reportDirectory(node.id, node.attemptId);
  const previous = nodeAttempt(run, node);
  if (kind === "verdict-nudge" && previous?.nodeId === node.id && previous.reportDir)
    return previous.reportDir;
  return reportDirectory(node.id, node.attemptId, turnId);
}
export function park(engine, run, node, reason, detail, verdict) {
  const retryable = [
    "session-error",
    "inactivity-timeout",
    "turn-timeout",
    "pr-failed",
    "usage-limit-exceeded",
    "members-blocked",
  ].includes(reason);
  node.status = retryable ? "failed" : "awaiting-gate";
  node.failReason = reason;
  if (detail) node.failDetail = detail.slice(0, 500);
  if (verdict) node.verdict = verdict;
  // A member whose turn never started keeps its earlier rounds' attempts as they were.
  const attempt = node.group ? memberTurn(run, node) : nodeAttempt(run, node);
  if (attempt) {
    attempt.finishedAt = engine.now();
    attempt.failReason = reason;
    if (verdict) attempt.verdict = verdict;
  }
  clearTurn(run, node.id);
  // A parked member waits for its siblings; the group parks once they all settled.
  if (node.group) delete node.queuedTurn;
  else {
    run.status = "awaiting-human";
    delete run.pendingTurn;
    delete run.pendingConclusion;
    delete run.pendingAdvance;
  }
  engine.store.save(run);
}
export async function applyOutcome(
  engine,
  run,
  outcome,
  node = activeNode(run),
  attempt = currentAttempt(run),
) {
  if (!node || !attempt) return;
  attempt.finishedAt = outcome.finishedAt || engine.now();
  attempt.status = "finished";
  attempt.quiesced = outcome.quiesced === true;
  holdSpec(run, attempt.finishedAt, { attempt });
  if (outcome.nativeId) node.nativeId = outcome.nativeId;
  if (outcome.usage && !attempt.usage) {
    attempt.usage = outcome.usage;
    run.usage = aggregateUsage(run.executionLog);
  }
  clearTurn(run, node.id);
  // A CLI stopped by AgentPier after its own completion event keeps its native result.
  const settled =
    Boolean(attempt.settledAfterCompletion) &&
    outcome.quiesced === true &&
    outcome.nativeResult === "completed" &&
    !outcome.observationError;
  if (Number.isInteger(outcome.exitCode)) attempt.exitCode = outcome.exitCode;
  if (!settled && (outcome.exitCode !== 0 || outcome.isError)) {
    // An exhausted conversation is never continued by a later loop back.
    if (contextExhausted(outcome)) attempt.contextExhausted = true;
    if (
      outcome.usageLimit ||
      outcome.errorCode === 429 ||
      outcome.errorCode === "rate_limit_exceeded"
    ) {
      const reset = Number(outcome.usageLimit?.resetAt);
      const resetAt = Number.isFinite(reset) && reset > 0 ? reset : null;
      node.usageLimit = { resetAt };
      // A group sets one resume time for all its members once they settled.
      if (!node.group)
        run.usageResumeAt = new Date(
          resetAt ? resetAt * 1000 + 60000 : engine.nowMs() + 3600000,
        ).toISOString();
      park(
        engine,
        run,
        node,
        "usage-limit-exceeded",
        serverMessages.pipelines.usageLimitReached,
      );
      return;
    }
    // A resumed session that failed is replaced by a fresh kickoff of the same round.
    // Output that could not be validated still stops for a person.
    if (attempt.kind === RESUMED_REPAIR && !outcome.observationError) {
      await resumeFallback(
        engine,
        run,
        node,
        attempt,
        attempt.contextExhausted ? "context-exhausted" : "resume-failed",
        outcome.error,
      );
      return;
    }
    park(
      engine,
      run,
      node,
      "session-error",
      outcome.observationError ||
        (outcome.error
          ? serverMessages.pipelines.nativeTurnFailedWith(outcome.error)
          : serverMessages.pipelines.nativeTurnFailed),
    );
    return;
  }
  const found = checkSpec(
    run,
    node,
    filterAnswers(run, node, attempt, readVerdict(run, attempt)),
  );
  if (!found.present) {
    // A rejected spec leaves the owner a way to supply one at the stage's gate.
    if (found.specError) node.specRejected = true;
    node.verdictContinuations = (node.verdictContinuations || 0) + 1;
    if (node.verdictContinuations <= 2) {
      await launchStage(engine, run, node, {
        kind: "verdict-nudge",
        resumeNativeId: node.nativeId,
        feedback:
          found.reason ||
          "Write the required structured verdict after completing the work.",
      });
      return;
    }
    // A repair turn for failed verification is blocked by that failure, not by its verdict.
    const failure = verificationFailure(node);
    if (failure) park(engine, run, node, "verify-failed", failure);
    else
      park(
        engine,
        run,
        node,
        found.invalid ? "verdict-invalid" : "verdict-missing",
        found.reason || serverMessages.pipelines.verdictMissing,
      );
    return;
  }
  // A repair turn that leaves findings of its round unanswered, or an implementation
  // turn that leaves acceptance criteria unreported, is asked once for them.
  const missing = missingAnswers(run, node, attempt, found.verdict);
  const unreported = missingCriteria(run, node, found.verdict);
  const nudges = [
    missing.length && claimAnswersNudge(run, node, attempt) && answersNudge(missing),
    unreported.length && claimCriteriaNudge(node) && criteriaNudge(unreported),
  ].filter(Boolean);
  if (nudges.length) {
    attempt.verdict = found.verdict;
    recordReportDigests(run, attempt);
    recordResponses(run, node, attempt, found.verdict, { accepted: false });
    await launchStage(engine, run, node, {
      kind: "verdict-nudge",
      resumeNativeId: node.nativeId,
      feedback: nudges.join("\n\n"),
    });
    return;
  }
  node.verdict = found.verdict;
  attempt.verdict = found.verdict;
  recordReportDigests(run, attempt);
  recordResponses(run, node, attempt, found.verdict);
  adoptSpec(run, node, attempt, found, attempt.finishedAt);
  if (node.group) {
    // A member reports; its group concludes once every member has a verdict.
    node.status = "reported";
    node.finishedAt = attempt.finishedAt;
    engine.store.save(run);
    return;
  }
  run.pendingConclusion = { nodeId: node.id, verdict: found.verdict };
  engine.store.save(run);
  await conclude(engine, run, node, found.verdict);
}
async function resumeFallback(engine, run, node, attempt, reason, detail) {
  attempt.finishedAt ??= engine.now();
  if (attempt.status === "launching") attempt.status = "finished";
  attempt.failReason = reason;
  // The CLI's own words tell a vanished conversation from a transient error.
  if (typeof detail === "string" && detail) attempt.failDetail = detail.slice(0, 500);
  clearTurn(run, node.id);
  delete node.nativeId;
  await launchStage(engine, run, node, freshAfterResume(attempt, reason));
}
export async function conclude(engine, run, node, verdict) {
  if (!(await checkpointStage(engine, run, node))) return;
  // An explicit override accepts the stage result; its verification and gate still apply.
  const decision = node.overridden
    ? "pass"
    : verdict.requiresHuman
      ? "escalate"
      : verdict.result === "pass"
        ? "pass"
        : failDecision(run, node, verdict);
  const selected =
    decision === "route"
      ? outgoing(run, node.id, "fail")
      : outgoing(run, node.id, "pass") || outgoing(run, node.id, "default");
  node.forwardCondition = decision === "route" ? "fail" : selected?.condition;
  Object.assign(
    node,
    selected?.effects || { humanGate: false, verify: false, createPr: false },
  );
  // Risky changes wait for the owner before verification, approval, a pull request or
  // the next stage; a loop back repairs first and the gate follows its conclusion.
  if (decision !== "loop" && (await riskGate(engine, run, node, park))) return;
  if (node.verify && !node.verified && ["pass", "route"].includes(decision)) {
    await engine.beginVerification(run, node);
    return;
  }
  if (decision === "loop") {
    await loopBack(engine, run, node, verdict);
    return;
  }
  if (decision === "escalate") {
    park(engine, run, node, "verdict-fail", undefined, verdict);
    return;
  }
  if (node.humanGate && !node.gateBypassed) {
    node.status = "awaiting-gate";
    run.status = "awaiting-human";
    engine.store.save(run);
    return;
  }
  await advance(engine, run, node);
}
export async function advance(engine, run, node) {
  if (!(await checkpointStage(engine, run, node))) return;
  node.status = "passed";
  node.finishedAt = engine.now();
  delete node.failReason;
  delete node.failDetail;
  delete node.gateBypassed;
  run.status = "running";
  delete run.pendingConclusion;
  run.pendingAdvance = { nodeId: node.id };
  engine.store.save(run);
  // What a push publishes is checked first: verification or a late process may have
  // changed the worktree since the stage's checkpoint.
  let expectedSha;
  if (node.createPr || run.pullRequestUrl) {
    const checked = await publishCheck(engine, run, node, park, "advance");
    if (checked.parked) return;
    expectedSha = checked.sha;
  }
  if (node.createPr && !run.pullRequestUrl) {
    try {
      const pr = await engine.workspace.createPr({
        workspace: run.workspace,
        run,
        ...(expectedSha ? { expectedSha } : {}),
      });
      run.pullRequestUrl = pr.url;
      engine.store.save(run);
    } catch (error) {
      engine.recordError(error);
      park(
        engine,
        run,
        node,
        "pr-failed",
        serverMessages.pipelines.pullRequestPublishFailed,
      );
      return;
    }
  } else if (run.pullRequestUrl) {
    try {
      const pr = await engine.workspace.createPr({
        workspace: run.workspace,
        run,
        ...(expectedSha ? { expectedSha } : {}),
      });
      run.pullRequestUrl = pr.url;
      engine.store.save(run);
    } catch (error) {
      engine.recordError(error);
      park(
        engine,
        run,
        node,
        "pr-failed",
        serverMessages.pipelines.pullRequestUpdateFailed,
      );
      return;
    }
  }
  const next = node.forwardCondition
    ? outgoing(run, node.id, node.forwardCondition)
    : outgoing(run, node.id, "pass") || outgoing(run, node.id, "default");
  if (next?.to) {
    await launchStage(
      engine,
      run,
      run.nodes.find((n) => n.id === next.to),
    );
    return;
  }
  run.status = "completed";
  delete run.pendingAdvance;
  run.finishedAt = engine.now();
  run.activeTurns = {};
  engine.store.save(run);
}
/**
 * Publishes a completed run as a pull request. Its last stage checks what the push
 * publishes; risky changes reopen the run at that stage's risk gate, and the owner's
 * approval publishes it.
 */
export async function publishCompleted(engine, run) {
  const node = run.nodes.find((n) => n.id === run.currentNodeId);
  const checked = node
    ? await publishCheck(engine, run, node, parkForPublish, "publish")
    : {};
  if (checked.parked) return;
  const pr = await engine.workspace.createPr({
    workspace: run.workspace,
    run,
    ...(checked.sha ? { expectedSha: checked.sha } : {}),
  });
  run.pullRequestUrl = pr.url;
  engine.store.save(run);
}
export async function loopBack(engine, run, node, verdict, feedback) {
  const edge = outgoing(run, node.id, "fail"),
    key = edgeKey(edge);
  const iteration = (run.loopState[key]?.iterations || 0) + 1;
  run.loopState[key] = { iterations: iteration, maxIterations: edge.maxIterations };
  recordRound(run, node, edge, verdict, {
    iteration,
    operatorNote: feedback,
    at: engine.now(),
  });
  const target = run.nodes.find((n) => n.id === edge.to);
  // Decided before the reset below drops the target's session.
  const launch = repairLaunch(run, target, edge, { edgeKey: key, iteration });
  for (const id of loopResetSet(run, edge)) {
    const n = run.nodes.find((n) => n.id === id);
    n.status = "pending";
    for (const k of [
      "verdict",
      "failReason",
      "failDetail",
      "sessionId",
      "nativeId",
      "gateBypassed",
      "verified",
      "verifyResult",
      "gateDecision",
      "loop",
    ])
      delete n[k];
  }
  // The round history holds the findings and the operator's note; the loop context
  // points at its edge.
  target.loop = {
    edge: key,
    fromNodeId: node.id,
    iteration,
    maxIterations: edge.maxIterations,
  };
  run.pendingTurn = { nodeId: target.id, ...launch };
  delete run.pendingConclusion;
  delete run.pendingAdvance;
  engine.store.save(run);
  await launchStage(engine, run, target, launch);
}
