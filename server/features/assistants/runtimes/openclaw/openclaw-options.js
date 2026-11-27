import { assistantProblem } from "../../assistant-validation.js";
import { validModelId } from "../../../providers/provider-definitions.js";
import { temporaryMember } from "../../team-presentation.js";
import { isShared, isUserAgent } from "../../../users/user-access.js";

// OpenClaw's own per-agent options (`runtimeOptions.openclaw`, ADR 0007 decision 9):
// `memoryWiki: true`, the agent keeps a wiki with OpenClaw's bundled memory-wiki plugin
// (openclaw-config/memory-wiki.js compiles it). Off is stored as nothing. Only the
// owner's own agents may have one (the owner's decision of 2026-11-17): never an agent
// shared with users, never a user's own agent, never a temporary team member.
//
// `thinking` and `fastMode`: how the agent's model works, OpenClaw's per-agent
// `thinkingDefault` and `fastModeDefault` (openclaw-config/agent-entry.js compiles
// them; the pinned runtime's docs/tools/thinking.md). Unset is stored as nothing and
// leaves OpenClaw's own order in charge: the model's parameters, then the owner's
// default for all agents (Advanced settings), then the provider's. Any of the owner's
// own agents, a shared one and a user's agent may hold them; only the owner sets them
// (user-agent-settings.js locks runtimeOptions for users). A temporary team member
// stores none: it runs with its lead's (`inherited`).
//
// `loopDetection`: loop protection, OpenClaw's rolling loop detectors
// (`agents.entries.*.tools.loopDetection.enabled`, the pinned runtime's
// docs/tools/loop-detection.md), which are off by default. Unset is automatic: on
// while the agent's model comes from an endpoint connection (the owner's own, often
// a small or local model, which OpenClaw recommends them for), else off. `true` and
// `false` are the owner's choice against that rule. Held and inherited as the two
// above. Off never reaches OpenClaw as `false`, which would also switch off its
// guard after a compaction: agent-entry.js leaves the key out.
//
// `fallbacks: [{ connectionId, modelId }]`: up to two fallback models, in order,
// OpenClaw's `agents.entries.*.model.fallbacks` (the pinned runtime's
// docs/concepts/model-failover.md): when the agent's model cannot answer (a rate
// limit, an overloaded or failing provider, a refused key, a model that is gone),
// OpenClaw runs the same turn on the next one. None is stored as nothing, and the
// entry then holds `fallbacks: []`, OpenClaw's strict "no fallback". A fallback is a
// model of an OpenRouter or endpoint connection, whose provider entry and key
// AgentPier compiles itself; never a ChatGPT login: OpenClaw drops a fallback's
// account pin (`@profile`), so which of the owner's accounts answers would not be
// AgentPier's choice. Held and inherited as the model options above; a fallback whose
// connection cannot serve at a start or an apply is left out there, never refused.

/**
 * The thinking levels OpenClaw accepts (`agents.entries.*.thinkingDefault`). A level
 * the agent's model does not support is clamped by OpenClaw at each run, never
 * refused (tests/integration/assistant-model-controls-contract.test.js).
 */
export const thinkingLevels = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
  "max",
  "ultra",
]);

/** At most this many fallback models per agent. */
export const maxFallbacks = 2;
// The connection kinds a fallback may be (assistant-models.js).
const fallbackKinds = new Set(["endpoint", "openrouter"]);
const fallbackKeys = new Set(["connectionId", "modelId"]);
const sameModel = (a) => (b) =>
  a?.connectionId === b?.connectionId && a?.modelId === b?.modelId;

const optionKeys = new Set([
  "memoryWiki",
  "thinking",
  "fastMode",
  "loopDetection",
  "fallbacks",
]);
// How the model works: what a temporary member takes over from its lead.
const modelKeys = ["thinking", "fastMode", "loopDetection"];
const inheritedKeys = [...modelKeys, "fallbacks"];
const validModelOption = {
  thinking: (value) => thinkingLevels.includes(value),
  fastMode: (value) => typeof value === "boolean",
  loopDetection: (value) => typeof value === "boolean",
};
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);

// One stored fallback as it is written: two short texts, the model id as an agent's.
const wellFormed = (fallback) =>
  isRecord(fallback) &&
  Object.keys(fallback).every((key) => fallbackKeys.has(key)) &&
  typeof fallback.connectionId === "string" &&
  fallback.connectionId.length > 0 &&
  fallback.connectionId.length <= 100 &&
  typeof fallback.modelId === "string" &&
  fallback.modelId.length <= 256 &&
  validModelId(fallback.modelId);

/**
 * Why `connection` (an entry of AssistantModels.listCapabilities) cannot serve model
 * `modelId` as a fallback, or null: "kind" for a ChatGPT login or a connection of
 * another kind, "unavailable" for one that cannot serve it now (missing, without its
 * key, a model its endpoint no longer lists). Shared with the web app's rule (web
 * runtimes/openclaw/fallback-rules.js).
 */
export function fallbackProblem(connection, modelId) {
  if (!connection) return "unavailable";
  if (!fallbackKinds.has(connection.providerId)) return "kind";
  if (connection.available !== true) return "unavailable";
  if (
    connection.providerId === "endpoint" &&
    !(connection.models || []).some((model) => model.modelId === modelId)
  )
    return "unavailable";
  return null;
}

// The stored fallbacks of `value`, read tolerantly: malformed and repeated ones are
// left out, at most maxFallbacks kept.
function readFallbacks(value) {
  const kept = [];
  for (const fallback of Array.isArray(value) ? value : [])
    if (
      wellFormed(fallback) &&
      !kept.some(sameModel(fallback)) &&
      kept.length < maxFallbacks
    )
      kept.push({ connectionId: fallback.connectionId, modelId: fallback.modelId });
  return kept;
}

// The fallbacks of a write for `agent`, or a translated refusal: malformed, more
// than two, a repeated one, the agent's own model, a connection of another kind, or
// one that cannot serve now (a fallback already stored stays although its connection
// became unavailable: the compile leaves it out).
function validFallbacks(value, { agent, models }) {
  if (!Array.isArray(value) || !value.every(wellFormed))
    throw assistantProblem("optionsInvalid");
  if (value.length > maxFallbacks)
    throw assistantProblem("fallbackTooMany", 400, maxFallbacks);
  if (value.some((fallback, index) => value.findIndex(sameModel(fallback)) !== index))
    throw assistantProblem("fallbackTwice");
  if (value.some(sameModel(agent?.model))) throw assistantProblem("fallbackOwnModel");
  const listed = models?.listCapabilities?.() || [];
  const stored = readFallbacks(agent?.runtimeOptions?.openclaw?.fallbacks);
  for (const fallback of value) {
    const problem = fallbackProblem(
      listed.find((connection) => connection.id === fallback.connectionId),
      fallback.modelId,
    );
    if (problem === "unavailable" && stored.some(sameModel(fallback))) continue;
    if (problem === "kind") throw assistantProblem("fallbackKind", 400);
    if (problem) throw assistantProblem("fallbackUnavailable", 409);
  }
  return value.map(({ connectionId, modelId }) => ({ connectionId, modelId }));
}

/**
 * Why `agent` (a stored record, or a create's input with its `userAccess`) may not
 * keep a wiki, or null: "shared" (shared with users), "userAgent" (a user's own),
 * "taskMember" (a temporary team member), "channelBot" (`senderFacing`: its own
 * Telegram bot serves other people, whose prompts would write lasting pages).
 */
export function wikiRefusal(agent, { senderFacing = false } = {}) {
  if (isShared(agent)) return "shared";
  if (isUserAgent(agent)) return "userAgent";
  if (agent && temporaryMember(agent)) return "taskMember";
  if (senderFacing) return "channelBot";
  return null;
}

const refusals = {
  shared: "memoryWikiShared",
  userAgent: "memoryWikiUserAgent",
  taskMember: "memoryWikiTaskMember",
  channelBot: "memoryWikiChannelBot",
};

/**
 * OpenClaw's options as stored (`value`, any JSON) for `agent`, read tolerantly:
 * unknown keys and values are left out, the wiki of an agent that may not keep one
 * (it became shared or a user's after it was switched on) reads as off, and a
 * temporary member has no model options or fallbacks of its own. `{}` without any.
 */
export function readOpenClawOptions(value, agent, context = {}) {
  if (!isRecord(value)) return {};
  const result = {};
  if (value.memoryWiki === true && !(agent && wikiRefusal(agent, context)))
    result.memoryWiki = true;
  if (agent && temporaryMember(agent)) return result;
  for (const key of modelKeys)
    if (Object.hasOwn(value, key) && validModelOption[key](value[key]))
      result[key] = value[key];
  const fallbacks = readFallbacks(value.fallbacks);
  if (fallbacks.length) result.fallbacks = fallbacks;
  return result;
}

/**
 * What a temporary team member takes over of its lead's options (`options`, as read):
 * how the model works and its fallback models. The wiki is the lead's alone.
 */
export const inheritedOpenClawOptions = (options) =>
  Object.fromEntries(
    inheritedKeys
      .filter((key) => Object.hasOwn(options, key))
      .map((key) => [key, options[key]]),
  );

/**
 * OpenClaw's options of a write (`value`) for `agent`, or a translated refusal: an
 * unknown key, a value of the wrong kind (a thinking level OpenClaw does not name),
 * the wiki for an agent that may not keep one (409), model options or fallbacks for a
 * temporary member, which follows its lead (409), and a fallback that cannot be one
 * (validFallbacks; `models` is AssistantModels). Returns the stored form, `{}`
 * without any.
 */
export function validateOpenClawOptions(value, { agent, senderFacing, models } = {}) {
  if (!isRecord(value)) throw assistantProblem("optionsInvalid");
  const unknown = Object.keys(value).find((key) => !optionKeys.has(key));
  if (unknown) throw assistantProblem("optionsUnknownKey", 400, unknown);
  const stored = {};
  if ("memoryWiki" in value) {
    if (typeof value.memoryWiki !== "boolean") throw assistantProblem("optionsInvalid");
    const refusal = value.memoryWiki && wikiRefusal(agent, { senderFacing });
    if (refusal) throw assistantProblem(refusals[refusal], 409);
    if (value.memoryWiki) stored.memoryWiki = true;
  }
  for (const key of modelKeys) {
    if (!(key in value)) continue;
    if (!validModelOption[key](value[key])) throw assistantProblem("optionsInvalid");
    if (agent && temporaryMember(agent))
      throw assistantProblem("modelOptionsTaskMember", 409);
    stored[key] = value[key];
  }
  if ("fallbacks" in value) {
    const fallbacks = validFallbacks(value.fallbacks, { agent, models });
    if (fallbacks.length && agent && temporaryMember(agent))
      throw assistantProblem("modelOptionsTaskMember", 409);
    if (fallbacks.length) stored.fallbacks = fallbacks;
  }
  return stored;
}

/** OpenClaw's options module (runtime-options.js): validate, read and connections. */
export const openClawOptions = Object.freeze({
  validate: validateOpenClawOptions,
  read: readOpenClawOptions,
  inherited: inheritedOpenClawOptions,
  // The agent's wiki, read only, while it keeps one (descriptor.js, slot agent.page).
  pages: (options) => (options.memoryWiki ? ["wiki"] : []),
  // The fallback models' connections, for the start and the apply to resolve.
  connections: (options) => options.fallbacks || [],
});
