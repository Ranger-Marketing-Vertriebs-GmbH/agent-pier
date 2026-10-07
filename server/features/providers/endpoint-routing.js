import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import {
  assertCapability,
  CAPABILITY_DEFAULTS,
  resolveCapabilities,
} from "../protocol-adapter/capabilities.js";
import { TOOL_PROTOCOL } from "./provider-definitions.js";

const messages = serverMessages.providers;
export const PROTOCOLS = Object.freeze(["messages", "responses", "chatCompletions"]);
export const ROUTE_MODES = Object.freeze(["native", "adapter", "sdk"]);
export const ROUTE_CHOICES = Object.freeze({
  claude: ["auto", "native", "adapter:responses", "adapter:chatCompletions", "off"],
  codex: ["auto", "native", "adapter:messages", "adapter:chatCompletions", "off"],
  opencode: ["auto", "messages", "responses", "chatCompletions", "off"],
});
export const DEFAULT_ROUTING = Object.freeze({
  claude: "auto",
  codex: "auto",
  opencode: "auto",
});
/**
 * Whether `auto` may fall back to an adapter route. Off until PR 3 ships the "via adapter"
 * labels, so existing connections do not silently start offering translated CLIs.
 * Explicit `adapter:*` choices work regardless.
 */
export const ADAPTER_AUTO_ROUTES = false;
const ADAPTER_ORDER = ["responses", "messages", "chatCompletions"];
const OPENCODE_ORDER = ["chatCompletions", "responses", "messages"];
const LIBRARY = Object.freeze({
  messages: "messages",
  responses: "responses",
  chatCompletions: "chat",
});
const plainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

export const libraryProtocol = (source) => LIBRARY[source];

export function validateRouting(value) {
  if (value === undefined || value === null) return { ...DEFAULT_ROUTING };
  if (
    !plainObject(value) ||
    Object.keys(value).some((tool) => !Object.hasOwn(ROUTE_CHOICES, tool))
  )
    throw problem(messages.invalidEndpointRouting);
  const routing = { ...DEFAULT_ROUTING, ...value };
  for (const [tool, choice] of Object.entries(routing))
    if (!ROUTE_CHOICES[tool].includes(choice))
      throw problem(messages.invalidEndpointRouting);
  return routing;
}

export function validateAdapterCapabilities(value) {
  if (value === undefined || value === null) return {};
  if (!plainObject(value) || Object.keys(value).some((key) => !PROTOCOLS.includes(key)))
    throw problem(messages.invalidEndpointCapabilities);
  const result = {};
  for (const [source, given] of Object.entries(value)) {
    if (!plainObject(given)) throw problem(messages.invalidEndpointCapabilities);
    const upstream = LIBRARY[source];
    const kept = {};
    for (const [name, setting] of Object.entries(given)) {
      if (!Object.hasOwn(CAPABILITY_DEFAULTS[upstream], name)) continue; // unknown → ignored
      if (setting === undefined || setting === null) continue; // same rule as resolveCapabilities
      try {
        assertCapability(upstream, name, setting);
      } catch {
        throw problem(messages.invalidEndpointCapabilities);
      }
      kept[name] = setting;
    }
    result[source] = kept;
  }
  return result;
}

const enabled = (endpoint, source) =>
  endpoint.protocols?.[source] === true &&
  (source !== "messages" || !!endpoint.anthropicBaseUrl) &&
  (source === "messages" || !!endpoint.openaiBaseUrl);

export function resolveRoute(endpoint, tool, { adapterAuto = ADAPTER_AUTO_ROUTES } = {}) {
  const choice = endpoint?.routing?.[tool] ?? "auto";
  if (choice === "off" || !Object.hasOwn(ROUTE_CHOICES, tool)) return null;
  if (tool === "opencode") {
    const source =
      choice === "auto" ? OPENCODE_ORDER.find((s) => enabled(endpoint, s)) : choice;
    if (!source || !enabled(endpoint, source)) return null;
    // "sdk" routes (Messages/Responses through OpenCode's own SDK providers) are part of
    // the route contract from this change on; the OpenCode launch and profile snapshot
    // consume `mode` and `source` from the endpoint-launch changes of the same branch.
    return { mode: source === "chatCompletions" ? "native" : "sdk", source };
  }
  const native = TOOL_PROTOCOL[tool];
  if (choice === "native" || choice === "auto") {
    if (enabled(endpoint, native)) return { mode: "native", source: native };
    if (choice === "native" || !adapterAuto) return null;
    const source = ADAPTER_ORDER.find((s) => s !== native && enabled(endpoint, s));
    return source ? { mode: "adapter", source } : null;
  }
  const source = choice.slice("adapter:".length);
  return enabled(endpoint, source) ? { mode: "adapter", source } : null;
}

export const toolRoutes = (endpoint) =>
  Object.fromEntries(
    ["claude", "codex", "opencode"].map((tool) => [tool, resolveRoute(endpoint, tool)]),
  );

export const routeBaseUrl = (endpoint, route) =>
  !route
    ? null
    : route.source === "messages"
      ? endpoint.anthropicBaseUrl || null
      : endpoint.openaiBaseUrl || null;

export const adapterCapabilitiesFor = (endpoint, source) => ({
  ...(endpoint.adapterCapabilities?.[source] ?? {}),
});

export function adapterReasoning(endpoint, source) {
  if (source === "messages") return true;
  return (
    resolveCapabilities(LIBRARY[source], adapterCapabilitiesFor(endpoint, source))
      .reasoningEffort === true
  );
}
