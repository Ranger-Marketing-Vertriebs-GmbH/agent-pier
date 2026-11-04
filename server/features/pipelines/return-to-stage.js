import { serverMessages } from "../../lib/i18n/de.js";
import { activeNode, loopResetSet } from "./graph-navigation.js";
import { resetStages } from "./loop-back.js";
import { recordRound } from "./loop-rounds.js";
import { repairLaunch } from "./loop-session.js";
import { launchStage } from "./execution-stage.js";

const RETURNS_KEPT = 20;

// The stages the owner can send a run back to: those that ran at least once, without
// parallel groups and their members, in rail order.
export function returnableStages(run) {
  const ran = new Set((run.executionLog || []).map((a) => a.nodeId));
  return (run.nodes || [])
    .filter((n) => !n.group && n.kind !== "parallel" && ran.has(n.id))
    .map((n) => ({ id: n.id, name: n.profileSnapshot?.name || n.id }));
}

// Reopens a finished run at `nodeId` with the owner's note as the repair instruction.
// The round is recorded but no loop limit counts it: `run.loopState` stays untouched.
// A request id that was already applied does nothing.
export async function reopenAtStage(engine, run, { nodeId, note, requestId }) {
  if ((run.returns || []).some((r) => r.requestId === requestId))
    return { repeated: true };
  const target = run.nodes.find((n) => n.id === nodeId);
  const edge = {
    from: run.currentNodeId,
    to: nodeId,
    condition: "owner-return",
    continueSession: true,
  };
  // Not the real loop edge's key: owner rounds count on their own.
  const key = `owner:${edge.from}->${edge.to}`;
  // The history keeps only the newest rounds per key, so the count would stall.
  const iteration =
    Math.max(
      0,
      ...(run.loopRounds || []).filter((r) => r.edge === key).map((r) => r.round),
    ) + 1;
  const at = engine.now();
  recordRound(
    run,
    activeNode(run),
    edge,
    { result: "fail", summary: serverMessages.pipelines.operatorRepairRound },
    { iteration, operatorNote: note, at, key },
  );
  // Decided before the reset below drops the target's session.
  const launch = repairLaunch(run, target, edge, { edgeKey: key, iteration });
  resetStages(run, loopResetSet(run, edge));
  target.loop = { edge: key, fromNodeId: edge.from, iteration, owner: true };
  run.status = "running";
  delete run.finishedAt;
  delete run.pendingConclusion;
  delete run.pendingAdvance;
  run.returns = [...(run.returns ?? []), { requestId, nodeId, at }].slice(-RETURNS_KEPT);
  run.pendingTurn = { nodeId, ...launch };
  engine.store.save(run);
  await launchStage(engine, run, target, launch);
  return { repeated: false };
}
