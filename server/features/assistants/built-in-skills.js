import fs from "node:fs";
import path from "node:path";
import {
  inheritsFromLead,
  memoryEnabled,
  personalCapabilities,
  personalSkills,
} from "./native-capabilities.js";
import { isUserAgent } from "../users/user-access.js";
import { insideRoot } from "./skill-paths.js";
import { teamPluginDirectory } from "./team-plugin-install.js";

// AgentPier's own skills, shipped inside the team plugin and compiled into an agent's
// skill list without the owner switching them on. Shopping reaches the owner's own
// agents, leads, permanent and task members and agents with their own Telegram bot;
// agents of users never get it. The skill asks only the owner, in the owner's own
// chat, before buying (SKILL.md); nothing in AgentPier stops a purchase.
export const shoppingSkill = "agentpier-shopping";
export const builtInSkillNames = [shoppingSkill];
// OpenClaw 2026.10.7 reports a plugin's skill like a `skills.load.extraDirs` one, as
// `openclaw-extra`; only its path tells them apart. The Gateway links each plugin
// skill below `<state>/plugin-skills/<name>` (OPENCLAW_STATE_DIR, runtime-paths.js).
// Every agent of the Gateway, members included, shares that one state folder.
export const pluginSkillSource = "openclaw-extra";

/** The folder the Gateway publishes plugin skills to, below the runtime root. */
export const pluginSkillsDir = (runtimeRoot) =>
  path.join(runtimeRoot, "state", "plugin-skills");

/**
 * Why the agent cannot get the shopping skill, or null: `archived`, `userAgent`, or
 * the missing `browser` or `memory`. Memory brings the `read` tool, without which
 * OpenClaw lists no skill to the agent (assistant-skill-catalog-contract.test.js); a
 * task member always has its own memory and the browser only as its lead's grant.
 */
export function shoppingBlocker(assistant) {
  if (!assistant || assistant.archivedAt) return "archived";
  if (isUserAgent(assistant)) return "userAgent";
  if (!personalCapabilities(assistant).browser) return "browser";
  if (!memoryEnabled(assistant)) return "memory";
  return null;
}
export const shoppingEligible = (assistant) => shoppingBlocker(assistant) === null;
/**
 * The owner's per-agent switch, stored on the profile as `shopping: false` and on
 * otherwise. A task member has none of its own: it follows its lead's switch
 * (memberInheritance), since a save is refused while it works.
 */
export const shoppingOn = (assistant) =>
  inheritsFromLead(assistant)
    ? assistant.inherited.shopping !== false
    : assistant?.shopping !== false;

/** The built-in skills the agent gets. */
export function builtInSkills(assistant) {
  return shoppingEligible(assistant) && shoppingOn(assistant) ? [shoppingSkill] : [];
}

/**
 * The skill names compiled for the agent: its own skills without any built-in name
 * (a stored or inherited one never counts), plus the built-ins it gets.
 */
export function compiledSkillNames(assistant) {
  const own = personalSkills(assistant).filter(
    (name) => !builtInSkillNames.includes(name),
  );
  return [...new Set([...own, ...builtInSkills(assistant)])].sort();
}

/**
 * Whether `<plugin-skills>/<name>` is the Gateway's link into this AgentPier version's
 * team plugin (team-plugin-install.js). OpenClaw leaves a real folder there alone and
 * would load it, so a folder, or a link anywhere else, is never the plugin's copy.
 */
function linkedToPlugin(runtimeRoot, name) {
  const link = path.join(pluginSkillsDir(runtimeRoot), name);
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return false;
    const shipped = path.join(teamPluginDirectory(runtimeRoot), "skills", name);
    return fs.realpathSync(link) === fs.realpathSync(shipped);
  } catch {
    return false;
  }
}

/**
 * Whether the `skills.status` entries of one built-in name are all the plugin's own
 * copy: reported as `pluginSkillSource` with a file below `<plugin-skills>/<name>/`,
 * where the Gateway's link leads into the provisioned team plugin. A same-named
 * workspace, managed or catalog copy fails, a planted folder or link fails, and so
 * does no entry at all. `runtimeRoot` holds `state/` and `plugins/` (runtime-paths.js).
 */
export function pluginSkillReported(entries, runtimeRoot) {
  if (!Array.isArray(entries) || !entries.length || !runtimeRoot) return false;
  const pluginSkills = pluginSkillsDir(runtimeRoot);
  return entries.every(
    (entry) =>
      entry?.source === pluginSkillSource &&
      builtInSkillNames.includes(entry.name) &&
      insideRoot(entry.filePath, pluginSkills, entry.name) &&
      linkedToPlugin(runtimeRoot, entry.name),
  );
}
