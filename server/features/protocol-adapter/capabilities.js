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

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when `message` names the parameter: quoted anywhere ('include', `reasoning.x`),
 * or, for names that cannot be ordinary words (containing `_` or `.`), also bare.
 */
function names(message, name) {
  const escaped = escapeRegExp(name);
  if (new RegExp(`['"\`]${escaped}(?:[.[][^'"\`]*)?['"\`]`).test(message)) return true;
  if (!/[._]/.test(name)) return false;
  return new RegExp(`(?<![A-Za-z0-9_.])${escaped}(?![A-Za-z0-9_])`).test(message);
}

/**
 * True when `message` rejects the parameter as such ("Unsupported parameter: 'reasoning'",
 * "'reasoning.effort' is not supported"), not merely quoting the word in another role
 * (an input item of type 'reasoning', a schema property).
 */
function rejectsParameter(message, name) {
  const escaped = escapeRegExp(name);
  const after = new RegExp(
    `(?:unsupported|unknown|unrecognized|invalid|extra) (?:request )?` +
      `(?:parameter|field|argument|input)s?(?: supplied)?[:\\s]+['"\`]?${escaped}(?![A-Za-z0-9_])`,
    "i",
  );
  const before = new RegExp(
    `['"\`]${escaped}(?:\\.[A-Za-z_.]*)?['"\`] (?:is|are) not (?:supported|permitted|allowed)`,
    "i",
  );
  return after.test(message) || before.test(message);
}

const UNSUPPORTED =
  /unsupported|not supported|does not support|unknown|unrecognized|not permitted|not allowed|extra (?:inputs|fields)/i;

const VALUE_ERROR = /\b(?:unsupported|invalid) value\b/i;

const paramNames = (param, name) =>
  param === name || param.startsWith(`${name}.`) || param.startsWith(`${name}[`);

const mentions = ({ message, param }, parameters) =>
  parameters.some(
    (parameter) =>
      (param !== "" && paramNames(param, parameter)) || names(message, parameter),
  );

// Each rule: [predicate over { message, param }, capability, value]. The first hit wins.
const RULES = Object.freeze({
  messages: [
    [
      ({ message }) =>
        /\badaptive\b/i.test(message) &&
        /thinking/i.test(message) &&
        (UNSUPPORTED.test(message) || /expected tags|does not match/i.test(message)),
      "thinkingBudget",
      true,
    ],
  ],
  responses: [
    [
      ({ message, param }) => {
        if (
          names(message, "include") &&
          message.includes("reasoning.encrypted_content")
        ) {
          return true;
        }
        // "Unsupported value: 'reasoning.effort' does not support 'minimal'": only the
        // value is wrong, the parameter itself is accepted.
        if (VALUE_ERROR.test(message)) return false;
        return (
          (param !== "" && (paramNames(param, "reasoning") || param === "include")) ||
          ["reasoning", "reasoning.effort", "reasoning.summary"].some((name) =>
            rejectsParameter(message, name),
          )
        );
      },
      "reasoningEffort",
      false,
    ],
    [(error) => mentions(error, ["prompt_cache_key"]), "promptCacheKey", false],
    [(error) => mentions(error, ["parallel_tool_calls"]), "parallelToolCalls", false],
  ],
  chat: [
    // DeepSeek-style thinking with tools: the upstream wants reasoning replayed.
    [
      ({ message }) => /missing\b[^.]*reasoning_content/i.test(message),
      "reasoningReplay",
      true,
    ],
    // Order matters: OpenAI's max_tokens rejection also names max_completion_tokens.
    // A non-empty `param` names the rejected field; otherwise the message must not
    // reject max_completion_tokens itself (the reverse wording names both fields).
    [
      ({ message, param }) =>
        (param !== ""
          ? param === "max_tokens"
          : names(message, "max_tokens") &&
            !rejectsParameter(message, "max_completion_tokens")) &&
        (names(message, "max_completion_tokens") || UNSUPPORTED.test(message)),
      "maxTokensField",
      "max_completion_tokens",
    ],
    [
      ({ message, param }) =>
        (param !== ""
          ? param === "max_completion_tokens"
          : names(message, "max_completion_tokens")) && UNSUPPORTED.test(message),
      "maxTokensField",
      "max_tokens",
    ],
    [
      (error) => mentions(error, ["stream_options", "include_usage"]),
      "streamUsage",
      false,
    ],
    [(error) => mentions(error, ["reasoning_effort"]), "reasoningEffort", false],
    [(error) => mentions(error, ["reasoning_content"]), "reasoningReplay", false],
    [(error) => mentions(error, ["prompt_cache_key"]), "promptCacheKey", false],
    [(error) => mentions(error, ["parallel_tool_calls"]), "parallelToolCalls", false],
  ],
});

/**
 * Capability change `{ name, value }` that avoids an upstream rejection (an IrError from
 * `classifyUpstreamError`), or null. Only 400/422 rejections qualify:
 * - Responses: `param` names `reasoning…`/`include`, the message rejects `reasoning`,
 *   `reasoning.effort` or `reasoning.summary` as a parameter, or it rejects `include`
 *   together with `reasoning.encrypted_content` → `reasoningEffort: false` (Amendment 14).
 *   Item-ordering or schema errors that merely quote these words, and value errors
 *   ("Unsupported value: 'reasoning.effort' does not support …"), do not qualify.
 *   `prompt_cache_key`, `parallel_tool_calls` named → off.
 * - Chat: "Missing `reasoning_content`" → `reasoningReplay: true`; `max_tokens` named
 *   (param or message) together with `max_completion_tokens` or an "unsupported" wording →
 *   `maxTokensField: "max_completion_tokens"`; `max_completion_tokens` rejected as
 *   unsupported → back to `max_tokens`; a non-empty `param` must name the rejected field
 *   itself. Value errors ("max_tokens is too large") do not
 *   qualify. `stream_options`/`include_usage` → `streamUsage: false`; `reasoning_effort`,
 *   `reasoning_content`, `prompt_cache_key`, `parallel_tool_calls` named → off.
 * - Messages: adaptive thinking (`thinking.type`) rejected as unsupported →
 *   `thinkingBudget: true` (Amendment 15); other messages mentioning "adaptive" do not.
 * The caller applies it with `translator.setCapability` when it differs from the current
 * value, retries once and counts the fallback.
 */
export function capabilityForError(upstream, error) {
  if (!error || typeof error !== "object" || !Object.hasOwn(RULES, upstream)) return null;
  if (error.status !== 400 && error.status !== 422) return null;
  if (error.kind === "contextLength") return null;
  const probe = {
    message: typeof error.message === "string" ? error.message : "",
    param: typeof error.param === "string" ? error.param : "",
  };
  for (const [predicate, name, value] of RULES[upstream]) {
    if (predicate(probe)) return { name, value };
  }
  return null;
}
