import { problem } from "../../lib/storage.js";
import { validateGraph } from "../pipelines/graph-validation.js";
export function requireScope(grant, scope) {
  if (!grant?.scopes?.includes(scope))
    throw problem("This MCP grant does not allow that action.", 403);
}
export function requireResource(grant, kind, id) {
  if (!grant?.[kind]?.includes(id))
    throw problem("This resource is outside the MCP grant.", 403);
}
export function requireProfile(grant, profile) {
  requireResource(grant, "accountIds", profile?.config?.accountId);
  if (profile.config.providerConnectionId)
    requireResource(grant, "connectionIds", profile.config.providerConnectionId);
  if (profile.accountSnapshot && profile.accountSnapshot.id !== profile.config.accountId)
    throw problem("The frozen source account does not match its profile.", 409);
  if (
    profile.providerConnectionSnapshot &&
    profile.providerConnectionSnapshot.id !== profile.config.providerConnectionId
  )
    throw problem("The frozen provider connection does not match its profile.", 409);
}
export function requirePipeline(
  grant,
  pipeline,
  definitions,
  { executing = false } = {},
) {
  const graph = validateGraph(pipeline.graph);
  for (const node of graph.nodes)
    if (node.kind === "profile")
      requireProfile(grant, definitions.getProfile(node.profileId));
  if (executing && graph.nodes.some((node) => node.kind === "createPr"))
    requireScope(grant, "runs:publish");
  return graph;
}
export function requireRun(grant, run, request) {
  requireResource(grant, "projectIds", run.projectId || request?.projectId);
  for (const node of run.nodes) requireProfile(grant, node.profileSnapshot);
}
export function visible(check) {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}
export function pageItems(items, { page = 1, query = "" } = {}) {
  const filtered = items.filter(
    (item) =>
      !query ||
      String(item.name || item.pipelineName || item.id)
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return {
    items: filtered.slice((page - 1) * 20, page * 20),
    total: filtered.length,
    page,
    pageSize: 20,
  };
}
export function runSummary(run, baseUrl) {
  return {
    id: run.id,
    pipelineId: run.pipelineId,
    pipelineName: run.pipelineName,
    projectId: run.projectId,
    status: run.status,
    phase: run.phase,
    currentNodeId: run.currentNodeId,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    url: `${baseUrl || ""}/pipelines/runs/${encodeURIComponent(run.id)}`,
    nodes: run.nodes.map((node) => ({
      id: node.id,
      status: node.status,
      profileId: node.profileSnapshot.id,
      profileName: node.profileSnapshot.name,
      tool: node.profileSnapshot.config.cliTool,
      model: node.profileSnapshot.config.models.default,
    })),
    usage: run.usage,
    pullRequestUrl: run.pullRequestUrl,
    ...(run.failDetail ? { failure: run.failDetail } : {}),
  };
}

/** Count both text and structured copies, including JSON escaping and the RPC ID. */
export function boundedToolResult(data, requestId = null) {
  const result = (value) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: Array.isArray(value) ? { items: value } : value,
  });
  const fits = (value) =>
    Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: requestId, result: value })) <
    262144;
  const complete = result(data);
  if (fits(complete)) return complete;
  const field = ["text", "diff", "log"].find((key) => typeof data?.[key] === "string");
  if (!field)
    throw problem(
      "Tool output exceeds its limit. Request a smaller page or individual item.",
      413,
    );
  const source = data[field];
  const prefix = (length) => {
    if (length && /[\uD800-\uDBFF]/.test(source[length - 1])) length--;
    return result({ ...data, [field]: source.slice(0, length), truncated: true });
  };
  let low = 0;
  let high = Math.min(source.length, 262144);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(prefix(middle))) low = middle;
    else high = middle - 1;
  }
  const bounded = prefix(low);
  if (!fits(bounded)) throw problem("Tool metadata exceeds its response limit.", 413);
  return bounded;
}
