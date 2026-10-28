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
// The `skills.status` source of a skill the Gateway loaded from a plugin manifest.
export const pluginSkillSource = "openclaw-plugin";

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

/** The skill names compiled for the agent: its own skills plus eligible built-ins. */
export function compiledSkillNames(assistant, { senderFacing = false } = {}) {
  return [
    ...new Set([
      ...personalSkills(assistant),
      ...builtInSkills(assistant, { senderFacing }),
    ]),
  ].sort();
}

/** Whether every `skills.status` entry of one name is the plugin's copy. */
export function pluginSkillReported(entries) {
  return (
    entries.length > 0 && entries.every((entry) => entry?.source === pluginSkillSource)
  );
}
