import fs from "node:fs";
import path from "node:path";
import {
  personalCapabilities,
  personalEligible,
  personalSkills,
} from "./native-capabilities.js";
import { isUserAgent } from "../users/user-access.js";

// AgentPier's own skills, shipped inside the team plugin and compiled into an agent's
// skill list without the owner switching them on. The shopping gate keeps shopping
// guidance out of agents that serve other people (users, team members, sender-facing
// bots); it is not a technical barrier against buying, which the approval flow guards.
export const shoppingSkill = "agentpier-shopping";
export const builtInSkillNames = [shoppingSkill];
// OpenClaw 2026.10.7 reports a plugin's skill like a `skills.load.extraDirs` one, as
// `openclaw-extra`; only its path tells them apart. The Gateway links each plugin
// skill below `<state>/plugin-skills/<name>` (OPENCLAW_STATE_DIR, runtime-paths.js).
export const pluginSkillSource = "openclaw-extra";

/** The folder the Gateway publishes plugin skills to, below the runtime root. */
export const pluginSkillsDir = (runtimeRoot) =>
  path.join(runtimeRoot, "state", "plugin-skills");

/**
 * Whether the agent gets the shopping skill: the owner's own, unarchived agent with
 * browser and memory on. Memory brings the `read` tool, without which OpenClaw lists
 * no skill to the agent (assistant-skill-catalog-contract.test.js).
 */
export function shoppingEligible(assistant, { senderFacing = false } = {}) {
  if (!personalEligible(assistant) || assistant.teamMemberId) return false;
  if (isUserAgent(assistant) || senderFacing) return false;
  const caps = personalCapabilities(assistant);
  return caps.browser && caps.memory;
}

/** The built-in skills the agent is eligible for. */
export function builtInSkills(assistant, { senderFacing = false } = {}) {
  return shoppingEligible(assistant, { senderFacing }) ? [shoppingSkill] : [];
}

/**
 * The skill names compiled for the agent: its own skills without any built-in name
 * (a stored or inherited one never counts), plus the built-ins it is eligible for.
 */
export function compiledSkillNames(assistant, { senderFacing = false } = {}) {
  const own = personalSkills(assistant).filter(
    (name) => !builtInSkillNames.includes(name),
  );
  return [...new Set([...own, ...builtInSkills(assistant, { senderFacing })])].sort();
}

const inside = (file, root) => {
  if (typeof file !== "string" || !root) return false;
  const relative = path.relative(root, path.resolve(file));
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};
const realDir = (dir) => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
};

/**
 * Whether the `skills.status` entries of one built-in name are all the plugin's own
 * copy: reported as `pluginSkillSource` with a file below `<pluginSkills>/<name>/`. A
 * same-named workspace, managed or catalog copy fails, and so does no entry at all.
 */
export function pluginSkillReported(entries, pluginSkills) {
  if (!Array.isArray(entries) || !entries.length || !pluginSkills) return false;
  const roots = [pluginSkills, realDir(pluginSkills)].filter(Boolean);
  return entries.every(
    (entry) =>
      entry?.source === pluginSkillSource &&
      builtInSkillNames.includes(entry.name) &&
      roots.some((root) => inside(entry.filePath, path.join(root, entry.name))),
  );
}
