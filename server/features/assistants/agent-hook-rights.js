import { assistantProblem } from "./assistant-validation.js";
import { goalAgent } from "./goal-turns.js";
import {
  capabilityTools,
  personalCapabilities,
  shellLevels,
  shellTools,
} from "./native-capabilities.js";

/** What a new hook may do: it can tell the owner and nothing else. */
export const hookDefaults = Object.freeze({
  notify: true,
  telegram: false,
  research: false,
  coding: false,
  shell: "off",
  sshHosts: Object.freeze([]),
  folders: Object.freeze({}),
  memory: false,
  mcp: false,
});
const tickKeys = ["telegram", "research", "coding", "memory", "mcp"];
const rightKeys = Object.keys(hookDefaults);
const folderLevels = ["read", "write"];
const maxHosts = 100;
// Always present in a hook run: the agent can look up what it knows.
const baseTools = ["session_status", "memory_search", "memory_get"];

const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const exceeds = () => assistantProblem("hookRightExceeds", 400);
const invalid = () => assistantProblem("invalid", 400);
const copy = (rights) => ({
  ...rights,
  sshHosts: [...rights.sshHosts],
  folders: { ...rights.folders },
});

/** Goal agents the owner runs alone (no shared or user agents) with reminders on. */
export const hookEligible = (agent) =>
  goalAgent(agent) && personalCapabilities(agent).reminders === true;

/** A hook offers Off plus the agent's own shell level (OpenClaw sets exec per agent). */
export function shellChoices(level) {
  if (level === "approval" || level === "full") return ["off", level];
  return ["off"];
}

/** The rights of a submitted hook: exact keys, nothing above the ceiling. */
export function rightsInput(input, ceiling) {
  if (!plain(input)) throw invalid();
  if (Object.keys(input).some((key) => !rightKeys.includes(key))) throw invalid();
  const rights = copy(hookDefaults);
  if ("notify" in input) {
    if (typeof input.notify !== "boolean") throw invalid();
    rights.notify = input.notify;
  }
  for (const key of tickKeys) {
    if (!(key in input)) continue;
    if (typeof input[key] !== "boolean") throw invalid();
    if (input[key] && ceiling[key] !== true) throw exceeds();
    rights[key] = input[key];
  }
  if ("shell" in input) {
    if (!shellLevels.includes(input.shell)) throw invalid();
    if (!shellChoices(ceiling.shell).includes(input.shell)) throw exceeds();
    rights.shell = input.shell;
  }
  if ("sshHosts" in input) {
    const hosts = input.sshHosts;
    if (
      !Array.isArray(hosts) ||
      hosts.length > maxHosts ||
      hosts.some((host) => typeof host !== "string")
    )
      throw invalid();
    if (hosts.some((host) => !ceiling.sshHosts.includes(host))) throw exceeds();
    rights.sshHosts = [...new Set(hosts)];
  }
  if ("folders" in input) {
    if (!plain(input.folders)) throw invalid();
    for (const [project, level] of Object.entries(input.folders)) {
      if (!folderLevels.includes(level)) throw invalid();
      const allowed = ceiling.folders[project];
      if (!allowed || folderLevels.indexOf(level) > folderLevels.indexOf(allowed))
        throw exceeds();
      rights.folders[project] = level;
    }
  }
  return rights;
}

function effectiveShell(saved, level) {
  if (saved === level) return saved;
  // Stored "full" on an agent now at "approval" runs with approval; stored
  // "approval" on an agent now at "full" fails closed.
  return saved === "full" && level === "approval" ? "approval" : "off";
}

/** The saved rights capped by what the agent holds now (applied on every event). */
export function effectiveRights(rights, ceiling) {
  const folders = {};
  for (const [project, level] of Object.entries(rights.folders)) {
    const held = ceiling.folders[project];
    if (!held) continue;
    folders[project] =
      folderLevels.indexOf(level) <= folderLevels.indexOf(held) ? level : held;
  }
  const out = {
    notify: rights.notify,
    shell: effectiveShell(rights.shell, ceiling.shell),
    sshHosts: rights.sshHosts.filter((host) => ceiling.sshHosts.includes(host)),
    folders,
  };
  for (const key of tickKeys) out[key] = rights[key] === true && ceiling[key] === true;
  return out;
}

/** The run's toolsAllow: only what the ticks switch on. */
export function hookTools(effective, ceiling) {
  const tools = [...baseTools];
  if (effective.research) {
    if (ceiling.webSearch) tools.push(...capabilityTools.webSearch);
    if (ceiling.webFetch) tools.push(...capabilityTools.webFetch);
  }
  if (effective.coding || Object.keys(effective.folders).length)
    tools.push("agentpier_workspace");
  if (effective.shell !== "off") tools.push(...shellTools);
  if (effective.sshHosts.length) tools.push("agentpier_ssh");
  if (effective.memory) tools.push("read", "write", "edit");
  if (effective.mcp) tools.push("*__*");
  return tools;
}
