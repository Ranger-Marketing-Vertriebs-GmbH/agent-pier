import { problem } from "../../lib/storage.js";

const nodeId = /^[A-Za-z0-9_-]{1,64}$/;
export const isLoopEdge = (edge) =>
  edge.condition === "fail" && edge.maxIterations !== undefined;

function reachable(edges, start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const id = queue.pop();
    for (const edge of edges)
      if (edge.from === id && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
  }
  return seen;
}

function cyclic(ids, edges) {
  const visiting = new Set(),
    done = new Set();
  function visit(id) {
    if (visiting.has(id)) return true;
    if (done.has(id)) return false;
    visiting.add(id);
    for (const edge of edges) if (edge.from === id && visit(edge.to)) return true;
    visiting.delete(id);
    done.add(id);
    return false;
  }
  return [...ids].some(visit);
}

/** Validate before copying: unknown graph shapes must never silently become a chain. */
export function validateGraph(graph) {
  if (!Array.isArray(graph?.nodes) || !graph.nodes.length || graph.nodes.length > 100)
    throw problem("A pipeline requires between 1 and 100 nodes");
  if (!Array.isArray(graph.edges) || graph.edges.length > 300)
    throw problem("A pipeline may contain at most 300 edges");
  const ids = new Set();
  const nodes = graph.nodes.map((node) => {
    if (typeof node?.id !== "string" || !nodeId.test(node.id) || ids.has(node.id))
      throw problem("Invalid or duplicate node ID");
    ids.add(node.id);
    const kind = node.kind ?? "profile";
    if (!["profile", "gate", "verify", "createPr"].includes(kind))
      throw problem(`Unsupported pipeline node kind: ${kind}`);
    if (
      kind === "profile"
        ? typeof node.profileId !== "string"
        : node.profileId !== undefined
    )
      throw problem(`Invalid profile reference on node ${node.id}`);
    return {
      id: node.id,
      kind,
      ...(kind === "profile" ? { profileId: node.profileId } : {}),
    };
  });
  if (nodes.filter((node) => node.kind === "createPr").length > 1)
    throw problem("A pipeline may create only one pull request");
  if (
    !ids.has(graph.entry) ||
    nodes.find((node) => node.id === graph.entry)?.kind !== "profile"
  )
    throw problem("The entry must reference a profile node");
  const conditions = new Set();
  const edges = graph.edges.map((edge) => {
    if (
      !ids.has(edge?.from) ||
      !ids.has(edge?.to) ||
      !["default", "pass", "fail"].includes(edge.condition)
    )
      throw problem("Invalid pipeline edge");
    const key = `${edge.from}:${edge.condition}`;
    if (conditions.has(key)) throw problem("A node may have only one edge per condition");
    conditions.add(key);
    if (
      edge.maxIterations !== undefined &&
      (edge.condition !== "fail" ||
        !Number.isInteger(edge.maxIterations) ||
        edge.maxIterations < 1 ||
        edge.maxIterations > 5)
    )
      throw problem("Fail loop budgets must be between 1 and 5");
    return {
      from: edge.from,
      to: edge.to,
      condition: edge.condition,
      ...(edge.maxIterations !== undefined ? { maxIterations: edge.maxIterations } : {}),
    };
  });
  for (const node of nodes) {
    if (node.kind === "profile") continue;
    const incoming = edges.filter((edge) => edge.to === node.id);
    const outgoing = edges.filter((edge) => edge.from === node.id);
    if (
      incoming.length !== 1 ||
      incoming[0].condition === "fail" ||
      outgoing.length > 1 ||
      outgoing.some((edge) => edge.condition !== "default")
    )
      throw problem(`Invalid side-effect routing on node ${node.id}`);
  }
  if (
    cyclic(
      ids,
      edges.filter((edge) => !isLoopEdge(edge)),
    )
  )
    throw problem("Every cycle requires a bounded fail edge");
  for (const edge of edges)
    if (isLoopEdge(edge) && !reachable(edges, edge.to).has(edge.from))
      throw problem("A budgeted fail edge must close a cycle");
  if (reachable(edges, graph.entry).size !== ids.size)
    throw problem("Every node must be reachable from the entry");
  return { entry: graph.entry, nodes, edges };
}
