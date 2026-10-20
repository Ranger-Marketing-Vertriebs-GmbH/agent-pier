import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

const nodeId = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_GROUP_MEMBERS = 8;
// Stages run a profile: one profile, or a parallel group of 2–8 member profiles.
export const isStage = (node) => node?.kind === "profile" || node?.kind === "parallel";
/** Every profile a graph runs, with the stage or member id that runs it. */
export const stageProfiles = (graph) =>
  (graph?.nodes || []).flatMap((node) =>
    node.kind === "parallel"
      ? (node.members || []).map((member) => ({
          id: member.id,
          profileId: member.profileId,
        }))
      : node.kind === "profile"
        ? [{ id: node.id, profileId: node.profileId }]
        : [],
  );
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

// A parallel group: 2–8 members, each with an id unique in the graph and a profile, and
// an optional concurrency cap from 1 to the member count.
function parallelNode(node, taken) {
  const members = node.members;
  const invalid = () =>
    problem(serverMessages.pipelineGraph.invalidParallelGroup(node.id));
  if (!Array.isArray(members) || members.length < 2 || members.length > MAX_GROUP_MEMBERS)
    throw invalid();
  for (const member of members) {
    if (
      typeof member?.id !== "string" ||
      !nodeId.test(member.id) ||
      taken.has(member.id) ||
      typeof member.profileId !== "string" ||
      Object.keys(member).some((key) => !["id", "profileId"].includes(key))
    )
      throw invalid();
    taken.add(member.id);
  }
  // Each member is a lens of its own: the same profile twice would review the same
  // changes the same way twice.
  if (new Set(members.map((member) => member.profileId)).size !== members.length)
    throw problem(serverMessages.pipelineGraph.duplicateGroupProfile(node.id));
  if (
    node.concurrency !== undefined &&
    (!Number.isInteger(node.concurrency) ||
      node.concurrency < 1 ||
      node.concurrency > members.length)
  )
    throw problem(serverMessages.pipelineGraph.invalidParallelConcurrency(node.id));
  return {
    id: node.id,
    kind: "parallel",
    members: members.map(({ id, profileId }) => ({ id, profileId })),
    ...(node.concurrency !== undefined ? { concurrency: node.concurrency } : {}),
  };
}

// Untrusted edge values named in a message are bounded plain text.
const edgePart = (value) =>
  typeof value === "string" && value
    ? value.replace(/[\x00-\x1f]/g, "").slice(0, 64)
    : "?";

/** Validate before copying: unknown graph shapes must never silently become a chain. */
export function validateGraph(graph) {
  if (!Array.isArray(graph?.nodes) || !graph.nodes.length || graph.nodes.length > 100)
    throw problem(serverMessages.pipelineGraph.nodeCount);
  if (!Array.isArray(graph.edges) || graph.edges.length > 300)
    throw problem(serverMessages.pipelineGraph.edgeLimit);
  const ids = new Set();
  // Node and member ids share one namespace: a member is addressed like a stage.
  const taken = new Set();
  const nodes = graph.nodes.map((node) => {
    if (typeof node?.id !== "string" || !nodeId.test(node.id) || taken.has(node.id))
      throw problem(serverMessages.pipelineGraph.invalidNodeId);
    ids.add(node.id);
    taken.add(node.id);
    const kind = node.kind ?? "profile";
    if (!["profile", "parallel", "gate", "verify", "createPr"].includes(kind))
      throw problem(serverMessages.pipelineGraph.unsupportedNodeKind(kind));
    if (kind === "parallel") {
      if (node.profileId !== undefined)
        throw problem(serverMessages.pipelineGraph.invalidProfileReference(node.id));
      return parallelNode(node, taken);
    }
    if (
      kind === "profile"
        ? typeof node.profileId !== "string"
        : node.profileId !== undefined
    )
      throw problem(serverMessages.pipelineGraph.invalidProfileReference(node.id));
    return {
      id: node.id,
      kind,
      ...(kind === "profile" ? { profileId: node.profileId } : {}),
    };
  });
  if (nodes.filter((node) => node.kind === "createPr").length > 1)
    throw problem(serverMessages.pipelineGraph.singlePullRequest);
  if (
    !ids.has(graph.entry) ||
    nodes.find((node) => node.id === graph.entry)?.kind !== "profile"
  )
    throw problem(serverMessages.pipelineGraph.entryMustBeProfile);
  const conditions = new Set();
  const edges = graph.edges.map((edge) => {
    if (
      !ids.has(edge?.from) ||
      !ids.has(edge?.to) ||
      !["default", "pass", "fail"].includes(edge.condition)
    )
      throw problem(
        serverMessages.pipelineGraph.invalidEdge(
          edgePart(edge?.from),
          edgePart(edge?.to),
          edgePart(edge?.condition),
        ),
      );
    const key = `${edge.from}:${edge.condition}`;
    if (conditions.has(key))
      throw problem(serverMessages.pipelineGraph.oneEdgePerCondition);
    conditions.add(key);
    if (
      edge.maxIterations !== undefined &&
      (edge.condition !== "fail" ||
        !Number.isInteger(edge.maxIterations) ||
        edge.maxIterations < 1 ||
        edge.maxIterations > 5)
    )
      throw problem(serverMessages.pipelineGraph.loopBudgetRange);
    // Only a bounded loop sends a stage back into its own earlier session.
    if (
      edge.continueSession !== undefined &&
      (typeof edge.continueSession !== "boolean" ||
        (edge.continueSession && edge.maxIterations === undefined))
    )
      throw problem(serverMessages.pipelineGraph.continueSessionLoopOnly);
    return {
      from: edge.from,
      to: edge.to,
      condition: edge.condition,
      ...(edge.maxIterations !== undefined ? { maxIterations: edge.maxIterations } : {}),
      ...(edge.continueSession ? { continueSession: true } : {}),
    };
  });
  for (const edge of edges)
    if (
      edge.condition === "fail" &&
      nodes.find((node) => node.id === edge.to).kind === "parallel"
    )
      throw problem(serverMessages.pipelineGraph.failEdgeIntoParallelGroup(edge.to));
  for (const node of nodes) {
    if (isStage(node)) continue;
    const incoming = edges.filter((edge) => edge.to === node.id);
    const outgoing = edges.filter((edge) => edge.from === node.id);
    if (
      incoming.length !== 1 ||
      incoming[0].condition === "fail" ||
      outgoing.length > 1 ||
      outgoing.some((edge) => edge.condition !== "default")
    )
      throw problem(serverMessages.pipelineGraph.invalidSideEffectRouting(node.id));
  }
  if (
    cyclic(
      ids,
      edges.filter((edge) => !isLoopEdge(edge)),
    )
  )
    throw problem(serverMessages.pipelineGraph.cycleNeedsFailEdge);
  for (const edge of edges)
    if (isLoopEdge(edge) && !reachable(edges, edge.to).has(edge.from))
      throw problem(serverMessages.pipelineGraph.failEdgeMustCloseCycle);
  if (reachable(edges, graph.entry).size !== ids.size)
    throw problem(serverMessages.pipelineGraph.unreachableNode);
  return { entry: graph.entry, nodes, edges };
}
