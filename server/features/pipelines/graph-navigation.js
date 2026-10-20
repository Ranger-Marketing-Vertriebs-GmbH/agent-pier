import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { isStage } from "./graph-validation.js";
const stageNode = (id, profile, extra = {}) => ({
  id,
  ...extra,
  profileSnapshot: structuredClone(profile),
  humanGate: false,
  verify: false,
  createPr: false,
  status: "pending",
});
// A parallel group compiles to its group node, which routes like a stage, followed by
// one node per member that runs the member's profile.
function groupNodes(group, profiles) {
  const members = group.members.map((m) =>
    stageNode(m.id, profiles[m.profileId], { group: group.id }),
  );
  return [
    {
      id: group.id,
      kind: "parallel",
      members: members.map((m) => m.id),
      concurrency: group.concurrency ?? members.length,
      label: members.map((m) => m.profileSnapshot?.name || m.id).join(" · "),
      humanGate: false,
      verify: false,
      createPr: false,
      status: "pending",
    },
    ...members,
  ];
}
export function compileSnapshot({ pipeline, profiles }) {
  const graph = structuredClone(pipeline.graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes = graph.nodes
    .filter(isStage)
    .flatMap((n) =>
      n.kind === "parallel"
        ? groupNodes(n, profiles)
        : [stageNode(n.id, profiles[n.profileId])],
    );
  const edges = graph.edges
    .filter((e) => isStage(byId.get(e.from)))
    .flatMap((e) => {
      let to = e.to;
      const seen = new Set();
      const effects = { humanGate: false, verify: false, createPr: false };
      while (!isStage(byId.get(to))) {
        if (seen.has(to))
          throw problem(serverMessages.pipelineGraph.invalidSideEffectCycle);
        seen.add(to);
        effects[
          { gate: "humanGate", verify: "verify", createPr: "createPr" }[byId.get(to).kind]
        ] = true;
        const edge = graph.edges.find((x) => x.from === to);
        if (!edge) return [{ ...e, to: null, effects }];
        to = edge.to;
      }
      return [{ ...e, to, effects }];
    });
  if (nodes.some((n) => n.kind !== "parallel" && !n.profileSnapshot))
    throw problem(serverMessages.pipelineGraph.profileSnapshotMissing, 409);
  return { entry: graph.entry, nodes, edges };
}
export const outgoing = (run, id, condition) =>
  run.edges.find((e) => e.from === id && e.condition === condition);
export const edgeKey = (e) => `${e.from}->${e.to}`;
export function failDecision(run, node, verdict) {
  const e = outgoing(run, node.id, "fail");
  if (!e || verdict.requiresHuman) return "escalate";
  if (e.maxIterations === undefined) return "route";
  // A parallel group's join already applied this rule to each member's findings.
  if (
    node.kind !== "parallel" &&
    verdict.findings?.length &&
    verdict.findings.every((f) => f.severity === "low")
  )
    return "pass";
  return (run.loopState[edgeKey(e)]?.iterations || 0) < e.maxIterations
    ? "loop"
    : "escalate";
}
function reach(edges, start) {
  const seen = new Set([start]),
    pending = [start];
  while (pending.length) {
    const id = pending.pop();
    for (const e of edges)
      if (e.from === id && !seen.has(e.to)) {
        seen.add(e.to);
        pending.push(e.to);
      }
  }
  return seen;
}
export function loopResetSet(run, edge) {
  const edges = run.edges.filter((e) => e.maxIterations === undefined);
  const a = reach(edges, edge.to),
    b = reach(
      edges.map((e) => ({ from: e.to, to: e.from })),
      edge.from,
    );
  // A parallel group in the loop resets with its members.
  return [...a]
    .filter((id) => b.has(id))
    .flatMap((id) => [
      id,
      ...((run.nodes || []).find((n) => n.id === id)?.members || []),
    ]);
}
export function activeNode(run) {
  return run.nodes.find((n) => n.id === run.currentNodeId);
}
export function currentAttempt(run) {
  return run.executionLog.find((a) => a.id === run.currentAttemptId);
}
// The attempt a stage's turn belongs to: a group member's newest turn, otherwise the
// run's current attempt (a group's own attempt while the group is current).
export function nodeAttempt(run, node) {
  return node?.group
    ? run.executionLog.findLast((a) => a.nodeId === node.id)
    : currentAttempt(run);
}
// The turns a run has active, one per stage (several while a parallel group runs).
export const activeTurnList = (run) => Object.values(run.activeTurns || {});
export function clearTurn(run, nodeId) {
  if (run.activeTurns) delete run.activeTurns[nodeId];
}
export const terminal = (run) =>
  ["completed", "failed", "cancelled"].includes(run.status);
