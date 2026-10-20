import { randomUUID } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { currentAttempt, nodeAttempt, outgoing } from "./graph-navigation.js";
import { conclude, launchStage, park } from "./execution-stage.js";
import { checkpointStage } from "./stage-checkpoint.js";
import { budgetExceeded, holdTurn } from "./run-budget.js";

// A parallel group runs 2–N read-only reviewer members on the run's shared worktree at
// the same time, at most `concurrency` of them at once. The group is the run's current
// stage: it has one group attempt in the execution log and one pass/fail/default edge
// set. Each member turn is an ordinary attempt of its member. Once every member has a
// verdict, the group joins them into one verdict and concludes like a stage.
export const groupMembers = (run, group) =>
  group.members.map((id) => run.nodes.find((node) => node.id === id));

const MEMBER_FIELDS = [
  "verdict",
  "failReason",
  "failDetail",
  "sessionId",
  "nativeId",
  "overridden",
  "queuedTurn",
  "usageLimit",
  "gateDecision",
  "gateDecidedAt",
  "finishedAt",
];
function resetMember(member) {
  member.status = "pending";
  for (const key of MEMBER_FIELDS) delete member[key];
}
const GROUP_FIELDS = [
  "verdict",
  "overridden",
  "gateBypassed",
  "riskGate",
  "verified",
  "verifyResult",
  "verifyAttempts",
  "usageLimit",
  "finishedAt",
  "failReason",
  "failDetail",
];

/**
 * Starts a group: a fresh launch opens a group attempt and starts every member again;
 * `resume` (a retry, resuming after a usage limit) keeps the members that reported and
 * starts the others again; after a usage limit only the members that hit it.
 */
export async function launchGroup(engine, run, group, { resume = false } = {}) {
  run.pendingTurn = { nodeId: group.id, kind: "kickoff", ...(resume ? { resume } : {}) };
  engine.store.save(run);
  const now = engine.now();
  const previous = currentAttempt(run);
  const own = previous?.kind === "group" && previous.nodeId === group.id;
  // A launch that stopped before any member started (a restart during its starting
  // checkpoint) continues in its attempt instead of leaving it open forever.
  const unstarted =
    own &&
    !previous.finishedAt &&
    !run.executionLog.some((a) => a.groupAttemptId === previous.id);
  let attempt = previous;
  if (resume && own) {
    previous.status = "running";
    delete previous.finishedAt;
    delete previous.failReason;
    const limitOnly = group.failReason === "usage-limit-exceeded";
    for (const member of groupMembers(run, group))
      if (
        member.status !== "reported" &&
        !run.activeTurns?.[member.id] &&
        (!limitOnly || member.failReason === "usage-limit-exceeded")
      )
        resetMember(member);
    delete group.failReason;
    delete group.failDetail;
    delete group.usageLimit;
  } else {
    for (const key of GROUP_FIELDS) delete group[key];
    group.startedAt = now;
    for (const member of groupMembers(run, group)) resetMember(member);
    if (unstarted) {
      previous.status = "running";
      group.attemptId = previous.attemptId;
    } else {
      group.attemptId = randomUUID();
      attempt = {
        id: randomUUID(),
        nodeId: group.id,
        attemptId: group.attemptId,
        kind: "group",
        startedAt: now,
        status: "running",
      };
      run.executionLog.push(attempt);
      run.currentNodeId = group.id;
      run.currentAttemptId = attempt.id;
    }
  }
  // Members are read-only reviewers: what the worktree holds when they start is
  // committed, and the join refuses a worktree that differs from this commit. A retry
  // after a failed starting checkpoint takes it then.
  if (!attempt.baseSha && readOnlyCheckable(engine, run)) {
    try {
      attempt.baseSha = (
        await engine.workspace.checkpoint({ workspace: run.workspace, run, node: group })
      ).sha;
    } catch (error) {
      engine.recordError(error);
      park(
        engine,
        run,
        group,
        "session-error",
        [400, 409].includes(error.status)
          ? error.message
          : serverMessages.pipelines.checkpointFailed,
      );
      return;
    }
  }
  group.status = "running";
  run.status = "running";
  run.usageResumeAt = null;
  run.activityAt = now;
  delete run.pendingTurn;
  delete run.pendingConclusion;
  delete run.pendingAdvance;
  engine.store.save(run);
  await progressGroup(engine, run, group);
}
const readOnlyCheckable = (engine, run) =>
  Boolean(engine.workspace.checkpoint && run.workspace);

/**
 * Starts members while the group has free slots, then settles the group once no member
 * is pending or running. A member whose queued turn never started (an interrupted
 * launch) starts it first.
 */
export async function progressGroup(engine, run, group) {
  const members = groupMembers(run, group);
  const live = () => run.status === "running" && run.currentNodeId === group.id;
  for (const member of members)
    if (live() && member.status === "running" && member.queuedTurn && !turn(run, member))
      await launchStage(engine, run, member, member.queuedTurn);
  // Above the run's token budget no member starts; running members finish, then the
  // group waits for the owner with its pending members.
  for (;;) {
    if (!live()) return;
    const busy = members.filter((member) => member.status === "running").length;
    const next = members.find((member) => member.status === "pending");
    if (budgetExceeded(run)) {
      if (next && !busy) holdTurn(engine, run, group, { progress: true });
      if (next) return;
      break;
    }
    if (!next || busy >= group.concurrency) break;
    await launchStage(engine, run, next, next.queuedTurn || {});
  }
  await settleGroup(engine, run, group, members);
}
const turn = (run, node) => run.activeTurns?.[node.id];

async function settleGroup(engine, run, group, members) {
  if (run.status !== "running" || group.status !== "running") return;
  if (members.some((member) => ["pending", "running"].includes(member.status))) return;
  const blocked = members.filter((member) => member.status !== "reported");
  if (blocked.length) {
    parkGroup(engine, run, group, blocked);
    return;
  }
  const attempt = currentAttempt(run);
  const verdict = joinVerdict(run, group, members);
  group.verdict = verdict;
  attempt.verdict = verdict;
  attempt.status = "finished";
  attempt.finishedAt = engine.now();
  attempt.quiesced = members.every(
    (member) => member.overridden || nodeAttempt(run, member)?.quiesced === true,
  );
  // One checkpoint for the whole group: a member that changed the worktree is refused.
  if (!(await checkpointStage(engine, run, group))) return;
  // Without its starting commit the group cannot prove that the members left the
  // worktree unchanged; it stops for the owner as if they had changed it.
  const unproven = readOnlyCheckable(engine, run) && !attempt.baseSha;
  if (unproven || (attempt.endSha && attempt.endSha !== attempt.baseSha)) {
    park(
      engine,
      run,
      group,
      "group-changed-files",
      unproven
        ? serverMessages.pipelines.groupReadOnlyUnproven
        : serverMessages.pipelines.groupChangedFiles,
    );
    return;
  }
  run.pendingConclusion = { nodeId: group.id, verdict };
  engine.store.save(run);
  await conclude(engine, run, group, verdict);
}

// A usage limit parks the whole group with one resume time; any other blocked member
// parks it for the owner, who decides per member or for the group.
function parkGroup(engine, run, group, blocked) {
  const limited = blocked.filter(
    (member) => member.failReason === "usage-limit-exceeded",
  );
  if (!limited.length) {
    park(engine, run, group, "members-blocked", serverMessages.pipelines.membersBlocked);
    return;
  }
  const resets = limited.map((member) => Number(member.usageLimit?.resetAt));
  const resetAt = resets.every((reset) => Number.isFinite(reset) && reset > 0)
    ? Math.max(...resets)
    : null;
  group.usageLimit = { resetAt };
  run.usageResumeAt = new Date(
    resetAt ? resetAt * 1000 + 60000 : engine.nowMs() + 3600000,
  ).toISOString();
  park(
    engine,
    run,
    group,
    "usage-limit-exceeded",
    serverMessages.pipelines.usageLimitReached,
  );
}

const FILES = 50;
/**
 * The group's verdict: it fails when any member fails, where the low-severity-only rule
 * of a bounded review loop applies per member, and it requires a person when any member
 * does. Findings of every member are kept, tagged with the member and its profile.
 */
export function joinVerdict(run, group, members) {
  const loop = outgoing(run, group.id, "fail")?.maxIterations !== undefined;
  const entries = members.map((member) => {
    const verdict = member.verdict;
    const findings = Array.isArray(verdict?.findings) ? verdict.findings : [];
    const lowOnly = findings.length > 0 && findings.every((f) => f.severity === "low");
    return {
      member,
      verdict,
      findings,
      name: member.profileSnapshot?.name || member.id,
      passes:
        member.overridden === true ||
        verdict?.result === "pass" ||
        (verdict?.result === "fail" && loop && lowOnly),
    };
  });
  const asking = entries.filter((e) => !e.member.overridden && e.verdict?.requiresHuman);
  const files = [...new Set(asking.flatMap((e) => e.verdict.files || []))].slice(
    0,
    FILES,
  );
  const question = asking.find((e) => e.verdict.question)?.verdict.question;
  return {
    result: entries.every((e) => e.passes) ? "pass" : "fail",
    summary: entries
      .filter((e) => e.verdict?.summary)
      .map((e) => `${e.name}: ${e.verdict.summary}`)
      .join("\n")
      .slice(0, 4000),
    findings: entries.flatMap((e) =>
      e.findings.map((f) => ({ ...f, member: e.member.id, profile: e.name })),
    ),
    requiresHuman: asking.length > 0,
    ...(question ? { question } : {}),
    ...(files.length ? { files } : {}),
    members: entries.map((e) => ({
      nodeId: e.member.id,
      result: e.verdict?.result ?? null,
      passes: e.passes,
      ...(e.member.overridden ? { overridden: true } : {}),
    })),
  };
}
