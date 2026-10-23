import {
  browserVisible,
  inheritsFromLead,
  personalCapabilities,
  personalEligible,
  releasedCapabilities,
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

/**
 * Permanent, eligible agents whose own settings switch the browser on, or whose user
 * may switch it on herself (released), by id.
 */
export function browserAgents(profiles = []) {
  return profiles
    .filter(
      (profile) =>
        personalEligible(profile) &&
        !inheritsFromLead(profile) &&
        (personalCapabilities(profile).browser ||
          releasedCapabilities(profile).includes("browser")),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Every AgentPier browser profile a Gateway start compiles, by profile name:
 * `{ cdpPort, headless, agentId? , slot? }`. The member slots exist whenever the
 * browser is compiled (both kinds when a visible window is possible), so an agent
 * switching the browser or its window on or off changes only its own profile, which
 * the running Gateway applies live (nextBrowserProfiles). A visible window needs the
 * agent's own setting and a separate agent browser app with a display
 * (detectBrowser().visible). Agents beyond the CDP port range get no profile; their
 * browser calls are refused.
 */
export function browserProfileMap({ profiles, browser, port }) {
  const visibleApp = browser?.visible?.available === true;
  const slots = {};
  for (const visible of visibleApp ? [false, true] : [false])
    for (let index = 0; index < memberSlotCount; index++)
      slots[memberSlotName(visible, index)] = {
        cdpPort: port + slotPort + (visible ? memberSlotCount : 0) + index,
        headless: !visible,
        slot: true,
      };
  return nextBrowserProfiles({ current: slots, profiles, visibleApp, port });
}

/**
 * The profiles once `profiles` are applied to the running map `current`: an agent
 * keeps its CDP port and only its window mode follows its setting, a new agent takes
 * the lowest free port, and an agent without the browser loses its profile. Slots
 * stay as compiled.
 */
export function nextBrowserProfiles({ current = {}, profiles, visibleApp, port }) {
  const next = Object.fromEntries(
    Object.entries(current).filter(([, entry]) => !entry.agentId),
  );
  const agents = browserAgents(profiles).flatMap((agent) => {
    const name = agentProfileName(agent.id);
    return name ? [{ agent, name }] : [];
  });
  const headless = (agent) => !(visibleApp && browserVisible(agent));
  for (const { agent, name } of agents)
    if (current[name]?.agentId === agent.id)
      next[name] = { ...current[name], headless: headless(agent) };
  const used = new Set(Object.values(next).map((entry) => entry.cdpPort));
  let offset = agentPort;
  for (const { agent, name } of agents) {
    if (next[name]) continue;
    while (offset <= lastCdpOffset && used.has(port + offset)) offset++;
    if (offset > lastCdpOffset) break;
    used.add(port + offset);
    next[name] = { cdpPort: port + offset, headless: headless(agent), agentId: agent.id };
  }
  return next;
}

/** A profile as the Gateway configuration holds it. */
export const compiledProfile = ({ cdpPort, headless }) => ({
  driver: "openclaw",
  cdpPort,
  headless,
});

/**
 * The `browser.profiles` merge patch from `current` to `next`, or null when nothing
 * changed: changed or added profiles, and null for removed ones.
 */
export function browserProfilesPatch(current = {}, next = {}) {
  const patch = {};
  for (const [name, entry] of Object.entries(next)) {
    const before = current[name];
    if (!before || before.cdpPort !== entry.cdpPort || before.headless !== entry.headless)
      patch[name] = compiledProfile(entry);
  }
  for (const name of Object.keys(current)) if (!(name in next)) patch[name] = null;
  return Object.keys(patch).length ? patch : null;
}
