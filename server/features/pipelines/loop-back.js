import { clearTurn, edgeKey, loopResetSet, outgoing } from "./graph-navigation.js";
import { freshAfterResume, repairLaunch } from "./loop-session.js";
import { recordRound } from "./loop-rounds.js";
import { launchStage } from "./execution-stage.js";

// Repair turns: a loop back over a bounded fail edge, and the fresh kickoff that
// replaces a resumed repair session that could not continue.
export async function resumeFallback(engine, run, node, attempt, reason, detail) {
  attempt.finishedAt ??= engine.now();
  if (attempt.status === "launching") attempt.status = "finished";
  attempt.failReason = reason;
  // The CLI's own words tell a vanished conversation from a transient error.
  if (typeof detail === "string" && detail) attempt.failDetail = detail.slice(0, 500);
  clearTurn(run, node.id);
  delete node.nativeId;
  await launchStage(engine, run, node, freshAfterResume(attempt, reason));
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
