import { endpointRequest, authHeaders } from "./endpoint-http.js";
import { probes } from "./endpoint-probe-plan.js";
import { capabilityForError } from "../protocol-adapter/capabilities.js";
import { classifyUpstreamError } from "../protocol-adapter/errors.js";

// Capability probe of the connection test: one extra request per optional parameter. The
// result is a proposal for `adapterCapabilities`; only fixed values leave this module, so
// upstream response text can never reach a result.

const TOKENS = 16;
const KEY = "agentpier-probe";
const PROBE_TOOL = {
  name: "probe_noop",
  parameters: { type: "object", properties: {} },
};
const TOOL_CHAT = { type: "function", function: PROBE_TOOL };
const TOOL_RESPONSES = { type: "function", ...PROBE_TOOL };

const turn = (role, content) => ({ role, content });

// Smallest request providers accept for an enabled budget: budget_tokens >= 1024 and
// max_tokens > budget_tokens.
const THINKING_ENABLED = {
  body: (base) => ({
    ...base,
    max_tokens: 1025,
    thinking: { type: "enabled", budget_tokens: 1024 },
  }),
  accepted: true,
  rejected: undefined,
};

/** The probe table: `body(base)` adds the request delta to the (16-token) base body. */
export const CAPABILITY_PROBES = Object.freeze([
  {
    protocol: "responses",
    capability: "reasoningEffort",
    body: (base) => ({
      ...base,
      reasoning: { effort: "low", summary: "auto" },
      include: ["reasoning.encrypted_content"],
    }),
    accepted: true,
    rejected: false,
  },
  {
    protocol: "responses",
    capability: "promptCacheKey",
    body: (base) => ({ ...base, prompt_cache_key: KEY }),
    accepted: true,
    rejected: false,
  },
  {
    protocol: "responses",
    capability: "parallelToolCalls",
    body: (base) => ({ ...base, tools: [TOOL_RESPONSES], parallel_tool_calls: true }),
    accepted: true,
    rejected: false,
  },
  {
    protocol: "chatCompletions",
    capability: "streamUsage",
    body: (base) => ({ ...base, stream: true, stream_options: { include_usage: true } }),
    accepted: true,
    rejected: false,
  },
  {
    protocol: "chatCompletions",
    capability: "reasoningEffort",
    body: (base) => ({ ...base, reasoning_effort: "low" }),
    accepted: true,
    rejected: false,
  },
  {
    protocol: "chatCompletions",
    capability: "promptCacheKey",
    body: (base) => ({ ...base, prompt_cache_key: KEY }),
    accepted: true,
    rejected: false,
  },
  {
    protocol: "chatCompletions",
    capability: "parallelToolCalls",
    body: (base) => ({ ...base, tools: [TOOL_CHAT], parallel_tool_calls: true }),
    accepted: true,
    rejected: false,
  },
  {
    protocol: "chatCompletions",
    capability: "systemMessages",
    body: (base) => ({
      ...base,
      messages: [
        turn("user", "ok"),
        turn("assistant", "ok"),
        turn("system", "Answer briefly."),
        turn("user", "ok"),
      ],
    }),
    accepted: "inline",
    rejected: "merge",
  },
  {
    protocol: "messages",
    capability: "promptCache",
    body: (base) => ({
      ...base,
      system: [{ type: "text", text: "ok", cache_control: { type: "ephemeral" } }],
    }),
    accepted: true,
    rejected: false,
  },
  {
    protocol: "messages",
    capability: "thinkingBudget",
    body: (base) => ({
      ...base,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    }),
    accepted: false,
    // Adaptive thinking refused: a second request decides between the budget and none.
    rejected: THINKING_ENABLED,
  },
]);

const maxCompletionBody = ({ max_tokens: _dropped, ...base }) => ({
  ...base,
  max_completion_tokens: TOKENS,
});

const isOk = (result) =>
  !!result && !result.reason && result.status >= 200 && result.status < 300;

const UPSTREAM = {
  messages: "messages",
  responses: "responses",
  chatCompletions: "chat",
};
// Capabilities without a capabilityForError rule: a rejection counts when it names one
// of these keywords.
const KEYWORDS = { promptCache: ["cache_control"], systemMessages: ["system"] };

const isRefused = (result) =>
  !!result && !result.reason && (result.status === 400 || result.status === 422);

/**
 * "accepted" for 2xx; "rejected" only for a 400/422 that names the probed parameter (the
 * same mapping the runtime retry uses). Value errors, unrelated 400s ("model does not
 * support tools"), 401, 429, 5xx and transport failures answer null (key omitted).
 * The streamUsage probe streams: a 2xx is judged by status alone (the body is read to
 * its end, bounded by timeoutMs and the 1 MB cap).
 */
function verdictOf(result, protocol, probe) {
  if (isOk(result)) return "accepted";
  if (!result || result.reason || (result.status !== 400 && result.status !== 422))
    return null;
  const error = classifyUpstreamError({
    protocol: UPSTREAM[protocol],
    status: result.status,
    body: result.json,
  });
  const change = capabilityForError(UPSTREAM[protocol], error);
  if (change) return change.name === probe.capability ? "rejected" : null;
  const words = KEYWORDS[probe.capability];
  if (!words) return null;
  const text = `${error.message} ${error.param ?? ""}`.toLowerCase();
  return words.some((word) => text.includes(word)) ? "rejected" : null;
}

/** Base body of a protocol with the probe token budget. */
const baseBody = (name, body) =>
  name === "responses"
    ? { ...body, max_output_tokens: TOKENS }
    : { ...body, max_tokens: TOKENS };

/**
 * Proposes `adapterCapabilities` per upstream protocol by sending one request per optional
 * parameter. A key is present only when its probe answered 2xx (accepted) or 400/422
 * (rejected); auth errors, timeouts, 5xx and the deadline omit it.
 */
export async function probeCapabilities({
  endpoint,
  apiKey,
  model,
  results,
  signal,
  lookup,
  timeoutMs = 30_000,
}) {
  const planned = probes(endpoint, model);
  const headers = authHeaders(apiKey, endpoint.authHeader);
  // After a timeout or an abort (including the test deadline) no further request is sent.
  let stopped = false;
  const send = async (name, body) => {
    if (stopped || signal?.aborted) {
      stopped = true;
      return null;
    }
    try {
      return await endpointRequest({
        url: planned[name].url,
        method: "POST",
        body,
        headers: { ...headers, ...(planned[name].headers || {}) },
        timeoutMs,
        signal,
        lookup,
      });
    } catch (error) {
      if (error?.reason === "timeout" || signal?.aborted) stopped = true;
      return null;
    }
  };
  const out = {};
  for (const name of ["messages", "responses", "chatCompletions"]) {
    const base = results?.[name];
    if (stopped || !planned[name] || !base) continue;
    let body = baseBody(name, planned[name].body);
    const entry = {};
    if (name === "chatCompletions" && isRefused(base)) {
      // The base request was refused: only a max_completion_tokens answer proves the
      // protocol works at all (reasoning models reject max_tokens).
      body = maxCompletionBody(body);
      if (!isOk(await send(name, body))) continue;
      entry.maxTokensField = "max_completion_tokens";
    } else if (!(isOk(base) && base.json)) continue;
    for (const probe of CAPABILITY_PROBES.filter((item) => item.protocol === name)) {
      let current = probe;
      let verdict = verdictOf(await send(name, current.body(body)), name, current);
      while (
        verdict === "rejected" &&
        current.rejected &&
        typeof current.rejected === "object"
      ) {
        current = current.rejected;
        verdict = verdictOf(await send(name, current.body(body)), name, probe);
      }
      if (verdict === "accepted") entry[probe.capability] = current.accepted;
      else if (verdict === "rejected" && current.rejected !== undefined)
        entry[probe.capability] = current.rejected;
    }
    // A protocol without any proposal has no entry.
    if (Object.keys(entry).length > 0) out[name] = entry;
  }
  return out;
}
