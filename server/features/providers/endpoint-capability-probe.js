import { endpointRequest, authHeaders } from "./endpoint-http.js";
import { probes } from "./endpoint-probe.js";

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
const isRefused = (result) =>
  !!result && !result.reason && (result.status === 400 || result.status === 422);
const verdictOf = (result) =>
  isOk(result) ? "accepted" : isRefused(result) ? "rejected" : null;

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
  const send = async (name, body) => {
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
    } catch {
      return null;
    }
  };
  const out = {};
  for (const name of ["messages", "responses", "chatCompletions"]) {
    const base = results?.[name];
    if (!planned[name] || !base) continue;
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
      let verdict = verdictOf(await send(name, current.body(body)));
      while (
        verdict === "rejected" &&
        current.rejected &&
        typeof current.rejected === "object"
      ) {
        current = current.rejected;
        verdict = verdictOf(await send(name, current.body(body)));
      }
      if (verdict === "accepted") entry[probe.capability] = current.accepted;
      else if (verdict === "rejected" && current.rejected !== undefined)
        entry[probe.capability] = current.rejected;
    }
    out[name] = entry;
  }
  return out;
}
