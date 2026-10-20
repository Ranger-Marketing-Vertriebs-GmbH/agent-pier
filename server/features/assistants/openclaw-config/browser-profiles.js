import {
  browserVisible,
  inheritsFromLead,
  personalCapabilities,
  personalEligible,
} from "../native-capabilities.js";

// Verified against OpenClaw 2026.10.3: managed profiles keep their data below
// <state>/browser/<name>/user-data, and a name is [a-z0-9][a-z0-9-]*, at most 64.
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The persistent browser profile of a permanent agent. */
export function agentProfileName(id) {
  const name = `agent-${String(id).toLowerCase()}`;
  return PROFILE_NAME.test(name) ? name : null;
}
/**
 * Temporary team members get a slot of their own for the time they exist; its data
 * is discarded when the member ends (agent-browsers.js). Slots exist per kind, so a
 * member follows its lead's visible setting without a Gateway restart.
 */
export const memberSlotCount = 3;
export const memberSlotName = (visible, index) =>
  `${visible ? "member-visible" : "member"}-${index + 1}`;
// OpenClaw's managed CDP range is gateway + 11 to + 110; + 11 is its own default
// profile and + 12, + 13 the redefined "user" and "chrome" profiles. The member
// slots hold fixed ports from + 14, the agents follow from + 20.
const slotPort = 14,
  agentPort = slotPort + 2 * memberSlotCount;
export const lastCdpOffset = 110;

/** Permanent, eligible agents whose own settings switch the browser on, by id. */
export function browserAgents(profiles = []) {
  return profiles
    .filter(
      (profile) =>
        personalEligible(profile) &&
        !inheritsFromLead(profile) &&
        personalCapabilities(profile).browser,
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Every AgentPier browser profile a Gateway start compiles, by profile name:
 * `{ cdpPort, headless, agentId? , slot? }`. A visible window needs the agent's own
 * setting and a separate agent browser app with a display (detectBrowser().visible).
 * Agents beyond the CDP port range get no profile; their browser calls are refused.
 */
export function browserProfileMap({ profiles, browser, port }) {
  const visibleApp = browser?.visible?.available === true;
  const agents = browserAgents(profiles);
  const map = {};
  const anyVisible = visibleApp && agents.some(browserVisible);
  if (agents.length)
    for (const visible of anyVisible ? [false, true] : [false])
      for (let index = 0; index < memberSlotCount; index++)
        map[memberSlotName(visible, index)] = {
          cdpPort: port + slotPort + (visible ? memberSlotCount : 0) + index,
          headless: !visible,
          slot: true,
        };
  let offset = agentPort;
  for (const agent of agents) {
    const name = agentProfileName(agent.id);
    if (!name || offset > lastCdpOffset) continue;
    map[name] = {
      cdpPort: port + offset++,
      headless: !(visibleApp && browserVisible(agent)),
      agentId: agent.id,
    };
  }
  return map;
}
