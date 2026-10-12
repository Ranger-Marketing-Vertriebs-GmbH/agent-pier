import { personalShell, shellTools } from "../native-capabilities.js";

// Verified against OpenClaw 2026.9.8, see docs/assistant-shell-qualification.md.
// `shellTools` (exec, process) are offered only to an agent with shell access.
export { shellTools };

/**
 * The per-agent `tools.exec` override for a shell level, or undefined for "off".
 * The per-agent mode replaces the global "deny" (fact b). `strictInlineEval` makes
 * `python -c` and the like ask even once the interpreter is allowlisted; under
 * "full" it would make them ask as well, so only "approval" sets it (fact f).
 * `pathPrepend` carries the owner's login PATH (fact d).
 */
export function agentExec(level, pathPrepend = []) {
  const path = pathPrepend.length ? { pathPrepend: [...pathPrepend] } : {};
  if (level === "approval") return { mode: "ask", strictInlineEval: true, ...path };
  if (level === "full") return { mode: "full", ...path };
  return undefined;
}

/**
 * The Gateway sections the agents' shell levels need. Pure. `globalTools`: names
 * to append to the global `tools.allow`; empty unless some eligible agent has
 * shell (the global list is an upper bound for every agent). The per-agent
 * override comes from agentExec through agentEntry.
 */
export function shellSections({ profiles = [] }) {
  const any = profiles.some((profile) => personalShell(profile) !== "off");
  return { globalTools: any ? [...shellTools] : [] };
}

/** Appends `sections.globalTools` to the global `tools.allow` once. */
export function applyShell(config, sections) {
  const allow = (config.tools.allow || []).filter((tool) => !shellTools.includes(tool));
  config.tools.allow = [...allow, ...sections.globalTools];
  return config;
}

/**
 * Removes shell grants from an agent entry AgentPier does not manage (or before it
 * recompiles one), so only a profile with a shell level ever keeps them.
 */
export function withoutShell(entry) {
  if (!entry?.tools) return entry;
  if (Array.isArray(entry.tools.allow))
    entry.tools.allow = entry.tools.allow.filter((tool) => !shellTools.includes(tool));
  delete entry.tools.exec;
  return entry;
}
