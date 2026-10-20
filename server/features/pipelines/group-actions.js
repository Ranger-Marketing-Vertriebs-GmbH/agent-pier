import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { activeNode, nodeAttempt, terminal } from "./graph-navigation.js";
import { conclude, launchStage } from "./execution-stage.js";
import { groupMembers, progressGroup } from "./parallel-group.js";
import { readVerdict } from "./stage-verdict.js";
import { recordReportDigests } from "./stage-reports.js";
import { adoptSpec, checkSpec } from "./run-spec.js";
import { filterAnswers } from "./loop-rounds.js";

// Decisions on the members of the current parallel group. They are offered while the
// group still collects verdicts: while other members run, and once the group parked
// because a member is blocked or hit a usage limit.
const COLLECTING = ["members-blocked", "usage-limit-exceeded"];
const TURN_FAILURES = ["session-error", "inactivity-timeout", "turn-timeout"];

function collectingGroup(run) {
  const group = activeNode(run);
  if (group?.kind !== "parallel" || terminal(run) || run.imported?.historyOnly)
    return null;
  return group.status === "running" || COLLECTING.includes(group.failReason)
    ? group
    : null;
}

// A recorded non-zero exit or an AgentPier stop is final: checking again cannot succeed.
export function recheckable(attempt) {
  return !(
    attempt?.stopped ||
    (Number.isInteger(attempt?.exitCode) && attempt.exitCode !== 0)
  );
}

function actionsOf(run, member) {
  const attempt = nodeAttempt(run, member);
  if (member.status === "failed") {
    const actions = ["retry"];
    if (TURN_FAILURES.includes(member.failReason) && attempt?.status !== "launching") {
      if (recheckable(attempt)) actions.push("reconcile");
      if (attempt) actions.push("override");
    }
    return actions;
  }
  if (member.status === "awaiting-gate")
    return ["override", ...(member.nativeId ? ["feedback"] : [])];
  return [];
}

/** The actions each blocked member of the current group offers, by member id. */
export function memberActions(run) {
  const group = collectingGroup(run);
  if (!group) return {};
  const actions = {};
  for (const member of groupMembers(run, group)) {
    const list = actionsOf(run, member);
    if (list.length) actions[member.id] = list;
  }
  return actions;
}

// Acting on a member reopens a group that parked for its members.
function reopen(engine, run, group) {
  if (group.status === "running") return;
  group.status = "running";
  delete group.failReason;
  delete group.failDetail;
  delete group.usageLimit;
  run.status = "running";
  run.usageResumeAt = null;
  const attempt = nodeAttempt(run, group);
  if (attempt?.kind === "group") {
    attempt.status = "running";
    delete attempt.finishedAt;
    delete attempt.failReason;
  }
}

const identityOf = (run, member, attempt) => ({
  runId: run.id,
  nodeId: member.id,
  attemptId: attempt.attemptId,
  turnId: attempt.turnId,
  sessionId: attempt.sessionId,
});

// An override accepts a member without its verdict; a failed turn must have stopped.
async function assertStopped(engine, run, member) {
  if (member.status !== "failed") return;
  const attempt = nodeAttempt(run, member);
  const identity = identityOf(run, member, attempt);
  let outcome = await engine.driver.inspect(identity);
  for (let i = 0; attempt.stopped && outcome.status === "running" && i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    outcome = await engine.driver.inspect(identity);
  }
  if (
    run.activeTurns?.[member.id] ||
    !["completed", "failed"].includes(outcome.status) ||
    outcome.quiesced !== true
  )
    throw problem(serverMessages.pipelines.overrideRequiresStoppedTurn, 409);
  attempt.quiesced = true;
}
function overrideMember(engine, member, attempt) {
  member.overrides = [
    ...(Array.isArray(member.overrides) ? member.overrides : []),
    {
      at: engine.now(),
      failReason: member.failReason ?? null,
      attemptId: attempt?.id ?? null,
    },
  ].slice(-20);
  member.gateDecision = "overridden";
  member.gateDecidedAt = engine.now();
  member.overridden = true;
  member.status = "reported";
  member.finishedAt ??= engine.now();
  delete member.failReason;
  delete member.failDetail;
}

/** One gate action on a member of the current group (`input.nodeId`). */
export async function memberAction(engine, run, { action, nodeId, feedback } = {}) {
  const group = collectingGroup(run);
  const member = group && run.nodes.find((n) => n.id === nodeId && n.group === group.id);
  if (!member || !(memberActions(run)[member.id] || []).includes(action))
    throw problem(serverMessages.pipelines.actionUnavailable, 409);
  const attempt = nodeAttempt(run, member);
  if (action === "feedback") {
    if (
      typeof feedback !== "string" ||
      !feedback.trim() ||
      Buffer.byteLength(feedback) > 32768
    )
      throw problem(serverMessages.pipelines.feedbackSize);
    member.gateDecision = "feedback";
    member.gateDecidedAt = engine.now();
    reopen(engine, run, group);
    await launchStage(engine, run, member, {
      kind: "gate-feedback",
      resumeNativeId: member.nativeId,
      feedback,
    });
  } else if (action === "retry") {
    reopen(engine, run, group);
    member.status = "pending";
    for (const key of ["failReason", "failDetail", "usageLimit", "queuedTurn"])
      delete member[key];
  } else if (action === "override") {
    await assertStopped(engine, run, member);
    overrideMember(engine, member, attempt);
    reopen(engine, run, group);
  } else if (action === "reconcile") {
    const outcome = await engine.driver.inspect(identityOf(run, member, attempt));
    if (
      outcome.status !== "completed" ||
      outcome.exitCode !== 0 ||
      outcome.isError ||
      outcome.quiesced !== true
    )
      throw problem(serverMessages.pipelines.reconcileRequiresQuiescedTurn, 409);
    const found = checkSpec(
      run,
      member,
      filterAnswers(run, member, attempt, readVerdict(run, attempt)),
    );
    if (!found.present)
      throw problem(found.reason || serverMessages.pipelines.noFreshVerdict, 409);
    member.verdict = found.verdict;
    attempt.verdict = found.verdict;
    attempt.quiesced = true;
    recordReportDigests(run, attempt);
    adoptSpec(run, member, attempt, found, engine.now());
    member.status = "reported";
    member.finishedAt = engine.now();
    delete member.failReason;
    delete member.failDetail;
    reopen(engine, run, group);
  }
  engine.store.save(run);
  await progressGroup(engine, run, group);
}

/**
 * An override of the group itself. With blocked members it accepts each of them
 * without a verdict and joins; at `group-changed-files` it accepts the members' changes
 * and concludes with the joined verdict. Returns false for every other gate, where the
 * stage override applies.
 */
export async function overrideGroup(engine, run, group) {
  if (group.failReason === "members-blocked") {
    const blocked = groupMembers(run, group).filter((m) => m.status !== "reported");
    for (const member of blocked) await assertStopped(engine, run, member);
    for (const member of blocked)
      overrideMember(engine, member, nodeAttempt(run, member));
    reopen(engine, run, group);
    engine.store.save(run);
    await progressGroup(engine, run, group);
    return true;
  }
  if (group.failReason !== "group-changed-files") return false;
  group.overrides = [
    ...(Array.isArray(group.overrides) ? group.overrides : []),
    {
      at: engine.now(),
      failReason: group.failReason,
      attemptId: nodeAttempt(run, group)?.id ?? null,
    },
  ].slice(-20);
  group.gateDecision = "overridden";
  group.gateDecidedAt = engine.now();
  delete group.failReason;
  delete group.failDetail;
  group.status = "running";
  run.status = "running";
  run.pendingConclusion = { nodeId: group.id, verdict: group.verdict };
  engine.store.save(run);
  await conclude(engine, run, group, group.verdict);
  return true;
}
