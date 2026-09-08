import { problem } from "../../lib/storage.js";
export function compileSnapshot({ pipeline, profiles }) {
  const graph = structuredClone(pipeline.graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes = graph.nodes
    .filter((n) => n.kind === "profile")
    .map((n) => ({
      id: n.id,
      profileSnapshot: structuredClone(profiles[n.profileId]),
      humanGate: false,
      verify: false,
      createPr: false,
      status: "pending",
    }));
  const edges = graph.edges
    .filter((e) => byId.get(e.from)?.kind === "profile")
    .flatMap((e) => {
      let to = e.to;
      const seen = new Set();
      const effects = { humanGate: false, verify: false, createPr: false };
      while (byId.get(to)?.kind !== "profile") {
        if (seen.has(to)) throw problem("Invalid side-effect cycle.");
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
  if (nodes.some((n) => !n.profileSnapshot))
    throw problem("Pipeline profile snapshot is missing.", 409);
  return { entry: graph.entry, nodes, edges };
}
export const outgoing = (run, id, condition) =>
  run.edges.find((e) => e.from === id && e.condition === condition);
export const edgeKey = (e) => `${e.from}->${e.to}`;
export function failDecision(run, node, verdict) {
  const e = outgoing(run, node.id, "fail");
  if (!e || verdict.requiresHuman) return "escalate";
  if (e.maxIterations === undefined) return "route";
  if (verdict.findings?.length && verdict.findings.every((f) => f.severity === "low"))
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
  return [...a].filter((id) => b.has(id));
}
export function activeNode(run) {
  return run.nodes.find((n) => n.id === run.currentNodeId);
}
export function currentAttempt(run) {
  return run.executionLog.find((a) => a.id === run.currentAttemptId);
}
export const terminal = (run) =>
  ["completed", "failed", "cancelled"].includes(run.status);
