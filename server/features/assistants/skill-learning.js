import { traitOf } from "./runtimes/runtime-descriptors.js";
import { isUserAgent } from "../users/user-access.js";
import { userProblem } from "../users/user-errors.js";

// "Learns its own skills" (docs/adr/0007-runtime-descriptor.md, step 6): the agent
// reviews finished work in the background and saves reusable procedures as skills of
// its own. One field of AgentPier's agent model, `skillLearning`, which each runtime's
// compiler maps onto its own mechanism. A profile without the field follows its
// runtime's default (trait `skills.learnsByDefault`), so an agent from before the
// field behaves as it did.

/**
 * Whether the agent can never learn: an agent of restricted users (own or shared) on
 * a runtime whose learned skills bypass the skill lists that limit what such an agent
 * reads (trait `skills.userAgentsLearn`).
 */
export const learningLocked = (agent) =>
  isUserAgent(agent) && !traitOf(agent, "skills", "userAgentsLearn");

/**
 * Why the agent cannot learn, or null: `userAgent` (learningLocked), `channelBot` (it
 * has its own bot for other people, `senderFacing`, on a runtime whose review would
 * read their chats, trait `skills.channelBotsLearn`).
 */
export const learningLock = (agent, { senderFacing = false } = {}) =>
  learningLocked(agent)
    ? "userAgent"
    : senderFacing && !traitOf(agent, "skills", "channelBotsLearn")
      ? "channelBot"
      : null;

/**
 * Whether the agent learns: never while locked, whatever is stored; else the stored
 * choice, else its runtime's default. Every compile reads this, so an agent that
 * comes to serve users stops learning with its next apply. A runtime's compiler
 * also leaves out an agent whose bot for other people it runs (`senderFacing`).
 */
export const learnsSkills = (agent, options) =>
  !learningLock(agent, options) &&
  (typeof agent?.skillLearning === "boolean"
    ? agent.skillLearning
    : traitOf(agent, "skills", "learnsByDefault"));

/**
 * The profile as the app shows it: the effective value, and why the switch is locked
 * (`skillLearningLocked`, learningLock) while it is. `senderFacing`: the agent has
 * its own bot for other people.
 */
export const learningView = (profile, options) => {
  if (!profile) return profile;
  const lock = learningLock(profile, options);
  return {
    ...profile,
    skillLearning: learnsSkills(profile, options),
    ...(lock && { skillLearningLocked: lock }),
  };
};

/** 409 USER_AGENT_SKILL_LEARNING: switching learning on for a locked agent. */
export function refuseLearning(agent, patch = {}) {
  if (patch.skillLearning !== true || !learningLocked(agent)) return;
  throw userProblem("USER_AGENT_SKILL_LEARNING");
}
