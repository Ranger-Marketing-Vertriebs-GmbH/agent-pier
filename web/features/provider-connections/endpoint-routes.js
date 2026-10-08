// web/features/provider-connections/endpoint-routes.js
// Mirrors server/features/providers/endpoint-routing.js (pinned by
// tests/unit/endpoint-routes-parity.test.js) so the dialog shows routes before saving.
export const ROUTE_TOOLS = ["claude", "codex", "opencode"];
export const NATIVE_SOURCE = { claude: "messages", codex: "responses" };
export const ROUTE_CHOICES = {
  claude: ["auto", "native", "adapter:responses", "adapter:chatCompletions", "off"],
  codex: ["auto", "native", "adapter:messages", "adapter:chatCompletions", "off"],
  opencode: ["auto", "messages", "responses", "chatCompletions", "off"],
};
export const DEFAULT_ROUTING = { claude: "auto", codex: "auto", opencode: "auto" };
const ADAPTER_ORDER = ["responses", "messages", "chatCompletions"];
const OPENCODE_ORDER = ["chatCompletions", "responses", "messages"];
const filled = (value) => typeof value === "string" && value.trim() !== "";

function unavailable(endpoint, source) {
  if (source === "messages" && !filled(endpoint.anthropicBaseUrl))
    return "anthropicUrlMissing";
  if (source !== "messages" && !filled(endpoint.openaiBaseUrl)) return "openaiUrlMissing";
  return endpoint.protocols?.[source] === true ? null : "protocolOff";
}
const enabled = (endpoint, source) => unavailable(endpoint, source) === null;

/** The source a choice names, or null for "auto" and "off". */
export function choiceSource(tool, choice) {
  if (choice === "auto" || choice === "off") return null;
  if (tool === "opencode") return choice;
  return choice === "native" ? NATIVE_SOURCE[tool] : choice.slice("adapter:".length);
}

export function resolveDraftRoute(endpoint, tool) {
  const choice = endpoint?.routing?.[tool] ?? "auto";
  if (choice === "off" || !ROUTE_CHOICES[tool]) return null;
  if (tool === "opencode") {
    const source =
      choice === "auto" ? OPENCODE_ORDER.find((s) => enabled(endpoint, s)) : choice;
    if (!source || !enabled(endpoint, source)) return null;
    return { mode: source === "chatCompletions" ? "native" : "sdk", source };
  }
  const native = NATIVE_SOURCE[tool];
  if (choice === "native" || choice === "auto") {
    if (enabled(endpoint, native)) return { mode: "native", source: native };
    if (choice === "native") return null;
    const source = ADAPTER_ORDER.find((s) => s !== native && enabled(endpoint, s));
    return source ? { mode: "adapter", source } : null;
  }
  const source = choiceSource(tool, choice);
  return enabled(endpoint, source) ? { mode: "adapter", source } : null;
}

export const routeOptions = (endpoint, tool) =>
  ROUTE_CHOICES[tool].map((choice) => {
    const source = choiceSource(tool, choice);
    const reason = source ? unavailable(endpoint, source) : null;
    return { choice, source, available: reason === null, reason };
  });

export const adapterSources = (endpoint) => {
  const used = new Set(
    ["claude", "codex"]
      .map((tool) => resolveDraftRoute(endpoint, tool))
      .filter((route) => route?.mode === "adapter")
      .map((route) => route.source),
  );
  return ["messages", "responses", "chatCompletions"].filter((s) => used.has(s));
};

const flag = (name, value) => ({ name, default: value });
export const CAPABILITY_FIELDS = {
  messages: [flag("promptCache", true), flag("thinkingBudget", false)],
  responses: [
    flag("promptCacheKey", false),
    flag("reasoningEffort", true),
    flag("parallelToolCalls", false),
  ],
  chatCompletions: [
    flag("promptCacheKey", false),
    flag("streamUsage", true),
    flag("reasoningEffort", false),
    flag("parallelToolCalls", false),
    flag("reasoningReplay", false),
    { name: "systemMessages", default: "merge", choices: ["merge", "inline"] },
    {
      name: "maxTokensField",
      default: "max_tokens",
      choices: ["max_tokens", "max_completion_tokens"],
    },
  ],
};
