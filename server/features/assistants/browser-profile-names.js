// The names of AgentPier's agent browser profiles, runtime-neutral: the browser
// sub-port addresses a profile by this name (agent-browsers.js), backups and deletes
// find its data by it. A name is [a-z0-9][a-z0-9-]*, at most 64, which OpenClaw
// 2026.10.3 also requires of its managed profiles (runtimes/openclaw/openclaw-config/
// browser-profiles.js compiles them).
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
