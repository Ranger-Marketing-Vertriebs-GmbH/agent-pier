// Adapter capabilities per upstream protocol: explicit defaults, validation and the pure
// mapping from an upstream rejection to the capability change that avoids it (the
// caller retries once with it, PR 2).

/**
 * Every capability an upstream builder reads, with its default. Booleans opt in (`false`
 * default) or opt out (`true` default) of one optional request feature:
 *
 * Messages upstream
 * - `promptCache` (opt-out): automatic `cache_control` breakpoints on the last system
 *   block and the last user block (client breakpoints are always kept, at most 4).
 * - `thinkingBudget` (opt-in): effort-only thinking is sent as `enabled` +
 *   `budget_tokens` from the effort table instead of `adaptive` + `output_config.effort`
 *   (models without adaptive thinking, Amendment 15).
 *
 * Responses upstream
 * - `promptCacheKey` (opt-in): send `prompt_cache_key` (client key, else the session key).
 * - `reasoningEffort` (opt-out): send `reasoning` (effort, summary) and
 *   `include: ["reasoning.encrypted_content"]` (Amendment 14).
 * - `parallelToolCalls` (opt-in): forward the client's `parallel_tool_calls`.
 *
 * Chat Completions upstream
 * - `promptCacheKey` (opt-in): as for Responses.
 * - `streamUsage` (opt-out): `stream_options: { include_usage: true }` on streams.
 * - `reasoningEffort` (opt-in): send `reasoning_effort`.
 * - `parallelToolCalls` (opt-in): forward the client's `parallel_tool_calls`.
 * - `reasoningReplay` (opt-in): echo reasoning as `reasoning_content` on assistant
 *   messages and keep it in carriers (DeepSeek/Kimi/GLM thinking in tool loops).
 * - `systemMessages`: `"merge"` (default, mid-conversation system text joins the next
 *   user turn) or `"inline"` (kept as `system` messages in place, Amendment 13).
 * - `maxTokensField`: `"max_tokens"` (default, local servers) or
 *   `"max_completion_tokens"` (OpenAI/Azure reasoning models reject `max_tokens`).
 */
export const CAPABILITY_DEFAULTS = Object.freeze({
  messages: Object.freeze({ promptCache: true, thinkingBudget: false }),
  responses: Object.freeze({
    promptCacheKey: false,
    reasoningEffort: true,
    parallelToolCalls: false,
  }),
  chat: Object.freeze({
    promptCacheKey: false,
    streamUsage: true,
    reasoningEffort: false,
    parallelToolCalls: false,
    reasoningReplay: false,
    systemMessages: "merge",
    maxTokensField: "max_tokens",
  }),
});

const CHOICES = Object.freeze({
  systemMessages: Object.freeze(["merge", "inline"]),
  maxTokensField: Object.freeze(["max_tokens", "max_completion_tokens"]),
});

function validValue(name, value) {
  if (Object.hasOwn(CHOICES, name)) return CHOICES[name].includes(value);
  return typeof value === "boolean";
}

/** Throws a TypeError unless `name` is a capability of `upstream` and `value` fits it. */
export function assertCapability(upstream, name, value) {
  if (!Object.hasOwn(CAPABILITY_DEFAULTS[upstream], name)) {
    throw new TypeError(
      `capabilities.${String(name)}: unknown for ${upstream} upstreams`,
    );
  }
  if (!validValue(name, value)) {
    const expected = CHOICES[name]?.join("|") ?? "a boolean";
    throw new TypeError(`capabilities.${name}: expected ${expected}`);
  }
}

/**
 * Effective capabilities: the upstream's defaults overridden by the given values.
 * Unknown names are ignored (stored connection settings may hold other protocols' or
 * future capabilities); a known name with an invalid value throws a TypeError.
 */
export function resolveCapabilities(upstream, capabilities) {
  const resolved = { ...CAPABILITY_DEFAULTS[upstream] };
  const given = capabilities && typeof capabilities === "object" ? capabilities : {};
  for (const [name, value] of Object.entries(given)) {
    if (!Object.hasOwn(resolved, name) || value === undefined || value === null) continue;
    assertCapability(upstream, name, value);
    resolved[name] = value;
  }
  return resolved;
}

// Rejections naming one of these parameters are retried once with the capability change.
// Order matters: OpenAI's max_tokens error also names max_completion_tokens.
const RULES = Object.freeze({
  messages: [[["adaptive"], "thinkingBudget", true]],
  responses: [
    [
      ["reasoning", "reasoning.effort", "reasoning.summary", "include"],
      "reasoningEffort",
      false,
    ],
    [["prompt_cache_key"], "promptCacheKey", false],
    [["parallel_tool_calls"], "parallelToolCalls", false],
  ],
  chat: [
    [["max_tokens"], "maxTokensField", "max_completion_tokens"],
    [["max_completion_tokens"], "maxTokensField", "max_tokens"],
    [["stream_options", "include_usage"], "streamUsage", false],
    [["reasoning_effort"], "reasoningEffort", false],
    [["reasoning_content"], "reasoningReplay", false],
    [["prompt_cache_key"], "promptCacheKey", false],
    [["parallel_tool_calls"], "parallelToolCalls", false],
  ],
});

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when `message` names the parameter: quoted anywhere ('include', `reasoning.x`),
 * or, for names that cannot be ordinary words (containing `_` or `.`), also bare.
 */
function names(message, name) {
  const escaped = escapeRegExp(name);
  if (new RegExp(`['"\`]${escaped}(?:[.[][^'"\`]*)?['"\`]`).test(message)) return true;
  if (name === "adaptive") return /\badaptive\b/i.test(message);
  if (!/[._]/.test(name)) return false;
  return new RegExp(`(?<![A-Za-z0-9_.])${escaped}(?![A-Za-z0-9_])`).test(message);
}

const paramNames = (param, name) =>
  param === name || param.startsWith(`${name}.`) || param.startsWith(`${name}[`);

/**
 * Capability change `{ name, value }` that avoids an upstream rejection (an IrError from
 * `classifyUpstreamError`), or null. Only 400/422 rejections that name an optional
 * parameter (in `param` or the message) qualify:
 * - Responses: `reasoning`, `reasoning.effort`, `reasoning.summary`, `include` →
 *   `reasoningEffort: false` (Amendment 14); `prompt_cache_key`, `parallel_tool_calls`.
 * - Chat: `max_tokens` → `maxTokensField: "max_completion_tokens"` (and back);
 *   `stream_options`/`include_usage` → `streamUsage: false`; `reasoning_effort`,
 *   `reasoning_content`, `prompt_cache_key`, `parallel_tool_calls` → off.
 * - Messages: "adaptive" thinking rejected → `thinkingBudget: true` (Amendment 15).
 * The caller applies it with `translator.setCapability` when it differs from the current
 * value, retries once and counts the fallback.
 */
export function capabilityForError(upstream, error) {
  if (!error || typeof error !== "object" || !Object.hasOwn(RULES, upstream)) return null;
  if (error.status !== 400 && error.status !== 422) return null;
  if (error.kind === "contextLength") return null;
  const message = typeof error.message === "string" ? error.message : "";
  const param = typeof error.param === "string" ? error.param : "";
  for (const [parameters, name, value] of RULES[upstream]) {
    const hit = parameters.some(
      (parameter) =>
        (param !== "" && paramNames(param, parameter)) || names(message, parameter),
    );
    if (hit) return { name, value };
  }
  return null;
}
