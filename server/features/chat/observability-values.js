export const list = (value) => (Array.isArray(value) ? value : []);
export const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
export const text = (value, max = 1000) =>
  typeof value === "string" ? value.slice(0, max) : "";
export const nativeId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value)
    ? value
    : null;
export const tokens = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
export function timestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}
export const emptyContext = () => ({
  usedTokens: null,
  limitTokens: null,
  remainingPercent: null,
  source: null,
  limitSource: null,
  observedAt: null,
  modelId: null,
});
export function inputTokens(input, ...caches) {
  if (tokens(input) === null) return null;
  let result = input;
  for (const cache of caches) {
    if (cache === undefined) continue;
    if (tokens(cache) === null) return null;
    result += cache;
  }
  return tokens(result);
}
export function contextValue(
  usedTokens,
  {
    limitTokens = null,
    modelId = null,
    source = "last-api-request",
    observedAt = null,
  } = {},
) {
  const used = tokens(usedTokens),
    limit = tokens(limitTokens) > 0 ? limitTokens : null;
  return {
    usedTokens: used,
    limitTokens: limit,
    remainingPercent:
      used !== null && limit
        ? Math.round(Math.max(0, Math.min(100, (1 - used / limit) * 100)) * 10) / 10
        : null,
    source: used === null ? null : source,
    limitSource: limit ? "native" : null,
    observedAt: timestamp(observedAt),
    modelId: text(modelId, 200) || null,
  };
}
export function agentStatus(value) {
  const status = typeof value === "string" ? value : Object.keys(object(value))[0];
  if (["running", "in_progress", "started"].includes(status)) return "running";
  if (status === "completed") return "completed";
  if (["errored", "failed", "error"].includes(status)) return "failed";
  return "unknown";
}
export function putAgent(agents, id, values = {}) {
  if (!nativeId(id)) return;
  const previous = agents.get(id) || {
    id,
    name: "",
    task: "",
    status: "unknown",
    source: null,
    updatedAt: null,
  };
  const next = { ...previous, ...values, id };
  next.name = text(next.name, 120);
  next.task = text(next.task, 1000);
  next.updatedAt = timestamp(next.updatedAt);
  if (!["running", "completed", "failed", "unknown"].includes(next.status))
    next.status = "unknown";
  agents.delete(id);
  agents.set(id, next);
  if (agents.size > 100) agents.delete(agents.keys().next().value);
}

/** Codex normalizes remaining context against its fixed native prompt/tool baseline. */
export function codexRemaining(used, limit) {
  if (tokens(used) === null || !(tokens(limit) > 0)) return null;
  if (limit <= 12000) return 0;
  return Math.round(
    Math.max(
      0,
      Math.min(
        100,
        ((limit - 12000 - Math.max(0, used - 12000)) / (limit - 12000)) * 100,
      ),
    ),
  );
}
export function codexContext(used, options) {
  const context = contextValue(used, { ...options, source: "native-token-count" });
  return {
    ...context,
    remainingPercent: codexRemaining(context.usedTokens, context.limitTokens),
  };
}
