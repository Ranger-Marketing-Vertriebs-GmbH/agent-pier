import { webCapabilityKeys } from "../assistants/native-capabilities.js";
import { userProblem } from "./user-errors.js";

/**
 * Which users an agent serves, and how much each of them may configure. An agent with
 * `userAccess` is a user agent: "own" serves exactly one user, "shared" one or more.
 * `released` lists the web capabilities an Extended user may switch on herself.
 * Every user agent runs under the hard lock (user-agent-lock.js).
 */
export const userLevels = ["chat", "personalize", "extended"];
export const userAccessModes = ["own", "shared"];
const maxMembers = 100;

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const invalid = () => userProblem("USER_AGENT_ACCESS_INVALID");

function knownUser(users, userId) {
  if (typeof userId !== "string" || !userId) throw invalid();
  try {
    users.get(userId);
  } catch {
    throw invalid();
  }
}

/** A submitted assignment, checked against the existing users; 400 when malformed. */
export function validateUserAccess(value, users) {
  if (
    !record(value) ||
    Object.keys(value).some((k) => !["mode", "members", "released"].includes(k)) ||
    !userAccessModes.includes(value.mode) ||
    !Array.isArray(value.members) ||
    value.members.length < 1 ||
    value.members.length > maxMembers ||
    (value.mode === "own" && value.members.length !== 1)
  )
    throw invalid();
  const seen = new Set();
  const members = value.members.map((member) => {
    if (
      !record(member) ||
      Object.keys(member).some((k) => !["userId", "level"].includes(k)) ||
      !userLevels.includes(member.level)
    )
      throw invalid();
    knownUser(users, member.userId);
    if (seen.has(member.userId)) throw invalid();
    seen.add(member.userId);
    return { userId: member.userId, level: member.level };
  });
  const released = value.released ?? [];
  if (
    !Array.isArray(released) ||
    released.some((key) => !webCapabilityKeys.includes(key)) ||
    new Set(released).size !== released.length
  )
    throw invalid();
  return { mode: value.mode, members, released: [...released].sort() };
}

/** Whether the agent serves restricted users (own or shared): the hard lock applies. */
export function isUserAgent(agent) {
  return !!agent?.userAccess;
}

export function isShared(agent) {
  return agent?.userAccess?.mode === "shared";
}

/** The user's level on the agent, or null when she is not one of its users. */
export function memberLevel(agent, userId) {
  return (
    agent?.userAccess?.members?.find((member) => member.userId === userId)?.level ?? null
  );
}
