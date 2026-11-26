import { assistantProblem } from "./assistant-validation.js";
import { ownSkills } from "./native-capabilities.js";
import { builtInSkillNames } from "./built-in-skills.js";
import { isUserAgent } from "../users/user-access.js";
import { refusedStates } from "./agent-skills.js";

// Skills a lead shares with its permanent members (AGENTPIER-499, lead-shares.js kind
// `skill`): the lead switches on, for one member, a skill that is switched on for the
// lead itself, without the owner. A share is one row per member, lead and skill name,
// standing only, and only an upper bound: the member holds the skill while the lead
// has it on (lead-capability-shares.js resolves it on every read into `leadSkills`),
// apart from the member's own list, which stays the owner's. A shared name compiles
// like an own one, so every check of the compile applies to it.

/**
 * The skill names of a share or revocation: `"all"` becomes the skills the lead has
 * on now (a revocation: the ones it shares with this member), a list must be held by
 * the lead (`teamGrantNotHeld`); a revocation's names are taken as given. AgentPier's
 * built-in skills are never shared: each agent gets them by its own switches.
 */
export function heldSkills(w, lead, member, skills, { revoke = false } = {}) {
  if (!skills?.length) return [];
  if (revoke) {
    if (skills !== "all") return skills;
    return w.shares
      .rows(member.assistantId)
      .filter((row) => row.kind === "skill" && row.leadId === lead.id && !row.requestId)
      .map((row) => row.skill)
      .sort();
  }
  const held = ownSkills(lead).filter((name) => !builtInSkillNames.includes(name));
  const names = skills === "all" ? held : skills;
  if (!names.length || names.some((name) => !held.includes(name)))
    throw assistantProblem("teamGrantNotHeld", 409);
  return names;
}

/**
 * The names of `skills` that can be on for the member, as the owner's own switch
 * would check them (AgentSkills.check): not for an agent of users (only the owner
 * widens what such an agent reads), and no skill its skills page lists as shadowed,
 * damaged, needing settings, unavailable in its runtime or already its own there.
 * A named skill that fails refuses the share (`skillUnavailable`); of `all` the
 * failing ones are left out and returned as `skipped`. While the member's page
 * cannot be read (its agent service is not running) nothing is refused here: the
 * compile drops such a name at every apply and the page shows its state.
 */
export async function memberSkills(w, member, skills, { all = false } = {}) {
  if (!skills.length) return { skills: [], skipped: [] };
  const refuse = () => {
    throw assistantProblem("skillUnavailable", 409);
  };
  let agent;
  try {
    agent = w.a.store.getAssistant(member.assistantId);
  } catch {
    refuse();
  }
  if (isUserAgent(agent)) refuse();
  let listed;
  try {
    listed = (await w.a.skills.list(agent.id)).skills;
  } catch {
    return { skills, skipped: [] };
  }
  const blocked = skills.filter((name) => {
    const skill = listed.find((entry) => entry.name === name);
    return !skill || refusedStates.includes(skill.state);
  });
  if (blocked.length && (!all || blocked.length === skills.length)) refuse();
  return {
    skills: skills.filter((name) => !blocked.includes(name)),
    skipped: blocked,
  };
}
