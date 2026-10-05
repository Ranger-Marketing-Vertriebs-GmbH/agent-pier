import {
  list,
  object,
  text,
  nativeId,
  tokens,
  timestamp,
} from "./observability-values.js";

const FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalTokens",
];
const COST_SCOPES = new Set(["session", "cli-exit-incl-subagents"]);
const MAX_AGENTS = 1024;
const own = (map, key) =>
  typeof key === "string" && Object.hasOwn(map, key) ? map[key] : null;

export const usd = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Sum of token counts; null as soon as one part is unknown. */
export function addTokens(...values) {
  let sum = 0;
  for (const value of values) {
    if (tokens(value) === null) return null;
    sum += value;
  }
  return tokens(sum);
}

function normalizeCost(value) {
  const cost = object(value);
  const amount = usd(cost.usd);
  return amount !== null && COST_SCOPES.has(cost.scope)
    ? { usd: amount, scope: cost.scope }
    : null;
}

/** Validated totals; null when neither a token count nor a cost is known. */
export function totalsValue(value) {
  const input = object(value);
  const counts = Object.fromEntries(FIELDS.map((field) => [field, tokens(input[field])]));
  const cost = normalizeCost(input.cost);
  if (FIELDS.every((field) => counts[field] === null) && !cost) return null;
  return {
    ...counts,
    outputIsLowerBound: input.outputIsLowerBound === true,
    cost,
    source: text(input.source, 60) || null,
    observedAt: timestamp(input.observedAt),
    subagents: null,
  };
}

/** Totals restored from a snapshot or produced by an observer, including subagents. */
export function normalizeTotals(value) {
  const totals = totalsValue(value);
  if (!totals) return null;
  const sub = object(value.subagents);
  totals.subagents =
    tokens(sub.count) !== null
      ? {
          count: sub.count,
          ...Object.fromEntries(FIELDS.map((field) => [field, tokens(sub[field])])),
          outputIsLowerBound: sub.outputIsLowerBound === true,
          costUsd: usd(sub.costUsd),
          workflowAgents: tokens(sub.workflowAgents) ?? 0,
          unavailable: tokens(sub.unavailable) ?? 0,
        }
      : null;
  return totals;
}

export function normalizeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = {
    ...Object.fromEntries(FIELDS.map((field) => [field, tokens(value[field])])),
    outputIsLowerBound: value.outputIsLowerBound === true,
    toolUses: tokens(value.toolUses),
    durationMs: tokens(value.durationMs),
    costUsd: usd(value.costUsd),
  };
  const known =
    FIELDS.some((field) => usage[field] !== null) ||
    usage.toolUses !== null ||
    usage.durationMs !== null ||
    usage.costUsd !== null;
  return known ? usage : null;
}

export const usageFromTotals = (totals) =>
  totals ? normalizeUsage({ ...totals, costUsd: totals.cost?.usd ?? null }) : null;

const counted = (usage) => tokens(usage?.totalTokens) !== null;

/** Field-wise sum over entries with token data; a field is null when any entry lacks it. */
export function sumUsage(entries) {
  const parts = list(entries).filter(counted);
  if (!parts.length) return null;
  const costs = parts.map((entry) => usd(entry.costUsd));
  return {
    ...Object.fromEntries(
      FIELDS.map((field) => [field, addTokens(...parts.map((entry) => entry[field]))]),
    ),
    outputIsLowerBound: parts.some((entry) => entry.outputIsLowerBound === true),
    toolUses: null,
    durationMs: null,
    costUsd: costs.every((cost) => cost !== null)
      ? costs.reduce((sum, cost) => sum + cost, 0)
      : null,
  };
}

/**
 * Claude transcript usage. Duplicates of one message.id are adjacent and their
 * output only grows, so the last record per id replaces the previous one.
 */
export function createClaudeUsage() {
  const sums = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let current = null,
    currentId = null,
    committed = 0,
    observedAt = null;
  const commit = () => {
    if (!current) return;
    for (const key of Object.keys(sums)) sums[key] += current[key];
    committed++;
    current = null;
  };
  return {
    add(message, at) {
      const usage = object(message?.usage);
      const optional = (name) =>
        usage[name] === undefined || usage[name] === null ? 0 : tokens(usage[name]);
      const record = {
        input: tokens(usage.input_tokens),
        cacheWrite: optional("cache_creation_input_tokens"),
        cacheRead: optional("cache_read_input_tokens"),
        output: optional("output_tokens"),
      };
      // Malformed usage is skipped, never counted as zero.
      if (Object.values(record).some((value) => value === null)) return;
      const id = typeof message.id === "string" && message.id ? message.id : null;
      if (!(id && id === currentId)) commit();
      current = record;
      currentId = id;
      observedAt = timestamp(at) ?? observedAt;
    },
    totals(cost = null) {
      if (!committed && !current) return totalsValue({ cost });
      const sum = (key) => sums[key] + (current ? current[key] : 0);
      const input = sum("input"),
        cacheWrite = sum("cacheWrite"),
        cacheRead = sum("cacheRead"),
        output = sum("output");
      return totalsValue({
        inputTokens: input,
        cacheWriteTokens: cacheWrite,
        cacheReadTokens: cacheRead,
        outputTokens: output,
        reasoningTokens: null,
        totalTokens: addTokens(input, cacheWrite, cacheRead, output),
        // Many responses never receive final usage in the transcript
        // (stop_reason null, placeholder output), so output is always a lower bound.
        outputIsLowerBound: true,
        cost,
        source: "claude-transcript",
        observedAt,
      });
    },
  };
}

/** Codex token usage exactly as reported: input includes cached input. */
export function codexTotals(usage, source, observedAt) {
  const value = object(usage);
  return totalsValue({
    inputTokens: value.input_tokens,
    cacheReadTokens: value.cached_input_tokens,
    cacheWriteTokens: value.cache_write_input_tokens,
    outputTokens: value.output_tokens,
    reasoningTokens: value.reasoning_output_tokens,
    totalTokens: value.total_tokens,
    source,
    observedAt,
  });
}

/** OpenCode session row: reasoning and both cache counts are separate, so all add up. */
export function openCodeTotals(row, observedAt = null) {
  const value = object(row);
  const amount = usd(value.cost);
  return totalsValue({
    inputTokens: value.tokens_input,
    outputTokens: value.tokens_output,
    reasoningTokens: value.tokens_reasoning,
    cacheReadTokens: value.tokens_cache_read,
    cacheWriteTokens: value.tokens_cache_write,
    totalTokens: addTokens(
      value.tokens_input,
      value.tokens_output,
      value.tokens_reasoning,
      value.tokens_cache_read,
      value.tokens_cache_write,
    ),
    cost: amount === null ? null : { usd: amount, scope: "session" },
    source: "opencode-session",
    observedAt,
  });
}

export function normalizeSubagentUsage(value) {
  if (!value || typeof value !== "object") return null;
  const agents = {},
    toolUses = {};
  for (const [id, entry] of Object.entries(object(value.agents)).slice(0, MAX_AGENTS)) {
    const usage = normalizeUsage(entry);
    if (nativeId(id) && usage) agents[id] = usage;
  }
  for (const [callId, agentId] of Object.entries(object(value.toolUses)).slice(
    0,
    MAX_AGENTS,
  ))
    if (nativeId(callId) && nativeId(agentId)) toolUses[callId] = agentId;
  const workflow = object(value.workflow);
  return {
    agents,
    toolUses,
    workflow:
      tokens(workflow.count) > 0
        ? { count: workflow.count, usage: normalizeUsage(workflow.usage) }
        : null,
    unavailable: tokens(value.unavailable) ?? 0,
  };
}

/** `totals.subagents`: every known agent, not only the agents the observer lists. */
export function subagentTotals(usage) {
  if (!usage) return null;
  const count = Object.keys(usage.agents).length + (usage.workflow?.count || 0);
  if (!count && !usage.unavailable) return null;
  const sum = sumUsage([
    ...Object.values(usage.agents),
    ...(usage.workflow?.usage ? [usage.workflow.usage] : []),
  ]);
  return {
    count,
    ...Object.fromEntries(FIELDS.map((field) => [field, sum ? sum[field] : null])),
    outputIsLowerBound: Boolean(sum?.outputIsLowerBound),
    costUsd: sum ? sum.costUsd : null,
    workflowAgents: usage.workflow?.count || 0,
    unavailable: usage.unavailable,
  };
}

/** Row usage: file or database tokens linked by id or tool-use id, plus notification values. */
export function agentUsage(agent, usage) {
  const previous = normalizeUsage(agent?.usage);
  const linked = usage
    ? own(usage.agents, agent?.id) ||
      own(usage.agents, own(usage.toolUses, agent?.toolUseId))
    : null;
  if (!linked) return previous;
  return normalizeUsage({
    ...linked,
    toolUses: previous?.toolUses ?? null,
    durationMs: previous?.durationMs ?? null,
  });
}
