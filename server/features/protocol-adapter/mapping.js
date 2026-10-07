// Pure mapping tables shared by all adapter directions: effort <-> budget, Anthropic
// thinking constraints, usage conversion and stop reasons.

export const EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const EFFORT_ALIASES = Object.freeze({ ultra: "max", persistent: "max" });

const BUDGETS = Object.freeze({
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32768,
});

export const MIN_THINKING_BUDGET = 1024;
const DEFAULT_MAX_TOKENS = 32000;

/** Normalizes an open effort string; unknown values become `medium` with `unknown: true`. */
export function normalizeEffortWithInfo(value) {
  if (value === undefined || value === null) return { effort: "medium", unknown: false };
  if (typeof value !== "string") return { effort: "medium", unknown: true };
  const key = value.trim().toLowerCase();
  if (EFFORTS.includes(key)) return { effort: key, unknown: false };
  if (Object.hasOwn(EFFORT_ALIASES, key)) {
    return { effort: EFFORT_ALIASES[key], unknown: false };
  }
  return { effort: "medium", unknown: true };
}

export function normalizeEffort(value) {
  return normalizeEffortWithInfo(value).effort;
}

/** Thinking budget for an effort (`none` → 0). */
export function budgetForEffort(effort) {
  const normalized = normalizeEffort(effort);
  return normalized === "none" ? 0 : BUDGETS[normalized];
}

/** Nearest effort for a budget; ties go to the lower effort; non-positive → `none`. */
export function effortForBudget(budget) {
  if (!Number.isFinite(budget) || budget <= 0) return "none";
  let best = "minimal";
  for (const [effort, value] of Object.entries(BUDGETS)) {
    if (Math.abs(value - budget) < Math.abs(BUDGETS[best] - budget)) best = effort;
  }
  return best;
}

/**
 * Normalized effort; an unknown value becomes `medium` and is reported through `adjust`
 * as `effortUnknown` (every upstream effort path uses this).
 */
export function resolveEffort(value, adjust = () => {}) {
  const { effort, unknown } = normalizeEffortWithInfo(value);
  if (unknown) adjust("effortUnknown");
  return effort;
}

/** Anthropic accepts low|medium|high|xhigh|max; `none` means omit thinking. */
function effortForMessages(effort, adjustments) {
  const normalized = resolveEffort(effort, (name) => adjustments.push(name));
  if (normalized === "minimal") {
    adjustments.push("effortMinimalToLow");
    return "low";
  }
  return normalized;
}

function isForcedToolChoice(toolChoice) {
  return (
    toolChoice === "required" || (typeof toolChoice === "object" && toolChoice !== null)
  );
}

function withDisplay(thinking, display) {
  return display ? { ...thinking, display } : thinking;
}

function resolveEnabled(thinking, maxTokens, adjustments) {
  if (maxTokens <= MIN_THINKING_BUDGET) {
    adjustments.push("thinkingDisabledMaxTokens");
    return null;
  }
  let budget = thinking.budgetTokens;
  if (budget === undefined || budget === null) {
    const effort = resolveEffort(thinking.effort, (name) => adjustments.push(name));
    budget = budgetForEffort(effort);
  }
  if (!budget) {
    adjustments.push("thinkingOmittedEffortNone");
    return null;
  }
  if (budget < MIN_THINKING_BUDGET) {
    budget = MIN_THINKING_BUDGET;
    adjustments.push("thinkingBudgetRaised");
  }
  if (budget >= maxTokens) {
    budget = maxTokens - 1;
    adjustments.push("thinkingBudgetClamped");
  }
  return withDisplay({ type: "enabled", budget_tokens: budget }, thinking.display);
}

function resolveEffortThinking(thinking, adjustments) {
  if (thinking.effort === undefined || thinking.effort === null) {
    return { thinking: withDisplay({ type: thinking.mode }, thinking.display) };
  }
  const effort = effortForMessages(thinking.effort, adjustments);
  if (effort === "none") {
    adjustments.push("thinkingOmittedEffortNone");
    return { thinking: null };
  }
  return { thinking: withDisplay({ type: thinking.mode }, thinking.display), effort };
}

/**
 * The `max_tokens` cutoff applies only to `enabled` (budget) thinking: a budget needs at
 * least 1024 tokens below `max_tokens`. Adaptive thinking has no budget and is kept.
 */
function resolveThinkingShape(thinking, maxTokens, adjustments) {
  if (!thinking || thinking.mode === "disabled") return { thinking: null };
  if (thinking.mode === "enabled") {
    return { thinking: resolveEnabled(thinking, maxTokens, adjustments) };
  }
  if (thinking.mode === "adaptive" || thinking.mode === "between_tools") {
    return resolveEffortThinking(thinking, adjustments);
  }
  throw new TypeError(`thinking.mode: unsupported value ${String(thinking.mode)}`);
}

/**
 * Applies Anthropic's constraints to IR thinking for a Messages upstream. Sampling values
 * (temperature, top_p, top_k) are always dropped; the result never carries them.
 * Returns `{ thinking, effort?, toolChoice, adjustments }` where `thinking` is the
 * Messages `thinking` object or null (omit) and `effort` goes to `output_config.effort`.
 */
export function resolveThinkingForMessages({
  thinking,
  maxTokens,
  temperature,
  topP,
  topK,
  toolChoice,
}) {
  const adjustments = [];
  if (temperature !== undefined && temperature !== null) {
    adjustments.push("temperatureDropped");
  }
  if (topP !== undefined && topP !== null) adjustments.push("topPDropped");
  if (topK !== undefined && topK !== null) adjustments.push("topKDropped");
  const resolved = resolveThinkingShape(thinking, maxTokens, adjustments);
  let resolvedToolChoice = toolChoice;
  if (resolved.thinking && isForcedToolChoice(toolChoice)) {
    resolvedToolChoice = "auto";
    adjustments.push("toolChoiceRelaxed");
  }
  const result = {
    thinking: resolved.thinking,
    toolChoice: resolvedToolChoice,
    adjustments,
  };
  if (resolved.effort) result.effort = resolved.effort;
  return result;
}

/**
 * Messages `max_tokens`: explicit value (clamped to the model output limit), model output
 * limit, or a share of the context.
 */
export function maxTokensFor({ sampling, model } = {}, adjust = () => {}) {
  const requested = sampling?.maxOutputTokens;
  if (requested !== undefined && requested !== null) {
    return clampMaxTokens(requested, model, adjust);
  }
  const explicit = model?.outputTokens;
  if (explicit !== undefined && explicit !== null) return explicit;
  if (!Number.isFinite(model?.contextTokens)) return DEFAULT_MAX_TOKENS;
  // Never 0: Anthropic requires `max_tokens >= 1`, even for a tiny context window.
  return Math.max(1, Math.min(Math.floor(model.contextTokens / 4), DEFAULT_MAX_TOKENS));
}

/**
 * Client max output tokens limited to the model's output limit when the model record
 * knows it (Chat and Responses upstreams; Messages uses `maxTokensFor`). Calls `adjust`
 * with `maxTokens.clamped` when the value was lowered.
 */
export function clampMaxTokens(value, model, adjust = () => {}) {
  const limit = model?.outputTokens;
  if (!Number.isInteger(limit) || limit <= 0 || !(value > limit)) return value;
  adjust("maxTokens.clamped");
  return limit;
}

// Token counts are non-negative integers in the IR. Sloppy gateways may report fractional
// or negative values; they are rounded or zeroed rather than discarding a valid answer.
const count = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/**
 * IR usage follows Messages semantics: `input` excludes cache reads and writes.
 * OpenAI prompt tokens include cached (and written) tokens.
 */
export function usageFromOpenAI({
  prompt,
  completion,
  cached,
  cacheWrite,
  reasoning,
  estimated = false,
}) {
  const cacheRead = count(cached);
  const written = count(cacheWrite);
  return {
    input: Math.max(0, count(prompt) - cacheRead - written),
    output: count(completion),
    cacheRead,
    cacheWrite: written,
    reasoning: count(reasoning),
    estimated: Boolean(estimated),
  };
}

export function usageFromMessages({
  input,
  output,
  cacheRead,
  cacheWrite,
  reasoning,
  estimated = false,
}) {
  return {
    input: count(input),
    output: count(output),
    cacheRead: count(cacheRead),
    cacheWrite: count(cacheWrite),
    reasoning: count(reasoning),
    estimated: Boolean(estimated),
  };
}

/**
 * IR usage fields estimated when an upstream reports no usage: characters / 4 (rounded
 * up) of the serialized upstream request (`ctx.requestChars`) and of the output text.
 */
export function estimatedUsage(ctx, outputChars) {
  return {
    input: Math.ceil(count(ctx?.requestChars) / 4),
    output: Math.ceil(count(outputChars) / 4),
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    estimated: true,
  };
}

export function usageToMessages(ir) {
  return {
    input_tokens: count(ir.input),
    output_tokens: count(ir.output),
    cache_read_input_tokens: count(ir.cacheRead),
    cache_creation_input_tokens: count(ir.cacheWrite),
  };
}

/**
 * Responses-style usage object (complete, as Codex requires when present). Codex reads
 * the optional `input_tokens_details.cache_write_tokens` (facts §3.6).
 */
export function usageToOpenAI(ir) {
  const input = count(ir.input) + count(ir.cacheRead) + count(ir.cacheWrite);
  const output = count(ir.output);
  return {
    input_tokens: input,
    output_tokens: output,
    input_tokens_details: {
      cached_tokens: count(ir.cacheRead),
      cache_write_tokens: count(ir.cacheWrite),
    },
    output_tokens_details: { reasoning_tokens: count(ir.reasoning) },
    total_tokens: input + output,
  };
}

export const STOP_REASONS = Object.freeze([
  "end",
  "length",
  "toolUse",
  "stopSequence",
  "contentFilter",
  "refusal",
]);

const FROM_MESSAGES = Object.freeze({
  end_turn: "end",
  max_tokens: "length",
  stop_sequence: "stopSequence",
  tool_use: "toolUse",
  refusal: "refusal",
  model_context_window_exceeded: "length",
  pause_turn: "end",
});

const FROM_CHAT = Object.freeze({
  stop: "end",
  length: "length",
  tool_calls: "toolUse",
  function_call: "toolUse",
  content_filter: "contentFilter",
});

const TO_MESSAGES = Object.freeze({
  end: "end_turn",
  length: "max_tokens",
  toolUse: "tool_use",
  stopSequence: "stop_sequence",
  contentFilter: "refusal",
  refusal: "refusal",
});

const TO_RESPONSES = Object.freeze({
  end: { status: "completed" },
  length: { status: "completed" },
  toolUse: { status: "completed" },
  stopSequence: { status: "completed" },
  contentFilter: { status: "failed", errorCode: "invalid_prompt" },
  refusal: { status: "completed", refusalAsText: true },
});

export function stopFromMessages(stopReason) {
  return FROM_MESSAGES[stopReason] ?? "end";
}

export function stopFromResponses(status, incompleteReason, hasToolCalls) {
  if (status === "incomplete") {
    if (incompleteReason === "max_output_tokens") return "length";
    if (incompleteReason === "content_filter") return "contentFilter";
  }
  return hasToolCalls ? "toolUse" : "end";
}

export function stopFromChat(finishReason) {
  return FROM_CHAT[finishReason] ?? "end";
}

function knownStop(reason) {
  if (!STOP_REASONS.includes(reason)) {
    throw new TypeError(`stop.reason: unsupported value ${String(reason)}`);
  }
  return reason;
}

export function stopToMessages(reason) {
  return TO_MESSAGES[knownStop(reason)];
}

/** Responses client status; never `incomplete` (Codex treats it as an error). */
export function stopToResponses(reason) {
  return { ...TO_RESPONSES[knownStop(reason)] };
}
