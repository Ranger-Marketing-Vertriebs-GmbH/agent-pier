import { assistantProblem } from "../../assistant-validation.js";
import { temporaryMember } from "../../team-presentation.js";
import { isShared, isUserAgent } from "../../../users/user-access.js";

// OpenClaw's own per-agent options (`runtimeOptions.openclaw`, ADR 0007 decision 9):
// `memoryWiki: true`, the agent keeps a wiki with OpenClaw's bundled memory-wiki plugin
// (openclaw-config/memory-wiki.js compiles it). Off is stored as nothing. Only the
// owner's own agents may have one (the owner's decision of 2026-11-17): never an agent
// shared with users, never a user's own agent, never a temporary team member.

const optionKeys = new Set(["memoryWiki"]);
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Why `agent` (a stored record, or a create's input with its `userAccess`) may not
 * keep a wiki, or null: "shared" (shared with users), "userAgent" (a user's own),
 * "taskMember" (a temporary team member).
 */
export function wikiRefusal(agent) {
  if (isShared(agent)) return "shared";
  if (isUserAgent(agent)) return "userAgent";
  if (agent && temporaryMember(agent)) return "taskMember";
  return null;
}

const refusals = {
  shared: "memoryWikiShared",
  userAgent: "memoryWikiUserAgent",
  taskMember: "memoryWikiTaskMember",
};

/**
 * OpenClaw's options as stored (`value`, any JSON) for `agent`, read tolerantly:
 * unknown keys are left out, and the wiki of an agent that may not keep one (it
 * became shared or a user's after it was switched on) reads as off. `{}` when off.
 */
export function readOpenClawOptions(value, agent) {
  if (!isRecord(value) || value.memoryWiki !== true) return {};
  if (agent && wikiRefusal(agent)) return {};
  return { memoryWiki: true };
}

/**
 * OpenClaw's options of a write (`value`) for `agent`, or a translated refusal: an
 * unknown key, a value that is not a boolean, and the wiki for an agent that may not
 * keep one (409). Returns the stored form, `{}` when off.
 */
export function validateOpenClawOptions(value, { agent } = {}) {
  if (!isRecord(value)) throw assistantProblem("optionsInvalid");
  const unknown = Object.keys(value).find((key) => !optionKeys.has(key));
  if (unknown) throw assistantProblem("optionsUnknownKey", 400, unknown);
  if (!("memoryWiki" in value)) return {};
  if (typeof value.memoryWiki !== "boolean") throw assistantProblem("optionsInvalid");
  if (!value.memoryWiki) return {};
  const refusal = wikiRefusal(agent);
  if (refusal) throw assistantProblem(refusals[refusal], 409);
  return { memoryWiki: true };
}

/** OpenClaw's options module (runtime-options.js): validate, read and connections. */
export const openClawOptions = Object.freeze({
  validate: validateOpenClawOptions,
  read: readOpenClawOptions,
  // The wiki names no model connection.
  connections: () => [],
});
