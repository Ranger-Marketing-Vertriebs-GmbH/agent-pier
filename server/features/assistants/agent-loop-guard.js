import { assistantProblem } from "./assistant-validation.js";

// One loop guard per agent (AGENTPIER-276) in place of nine overlapping rate caps
// that never fired in seven weeks (a lead's requests per turn, minute and hour, its
// autonomous requests, members' requests to each other and their reports, project
// creation, SSH access proposals, routines on members and members' reminders). It
// counts the actions an agent starts on its own with these tools in a rolling window
// and refuses only a runaway loop (AGENT_LOOP_LIMIT); approvals, open-task rules and
// the owner's settings stay as they are. Kept in memory: a restart starts afresh.
export const loopGuardCaps = Object.freeze({ actions: 60, windowMs: 10 * 60000 });

export class AgentLoopGuard {
  constructor({ now = Date.now, caps = loopGuardCaps } = {}) {
    this.now = now;
    this.caps = caps;
    this.times = new Map();
  }
  /** Counts one action of `agentId`; throws AGENT_LOOP_LIMIT (429) past the cap. */
  take(agentId) {
    const now = this.now();
    const recent = (this.times.get(agentId) || []).filter(
      (time) => now - time < this.caps.windowMs,
    );
    if (recent.length >= this.caps.actions) {
      this.times.set(agentId, recent);
      throw assistantProblem("agentLoopLimit", 429);
    }
    recent.push(now);
    this.times.set(agentId, recent);
    // Agents that went quiet leave the map.
    if (this.times.size > 1000)
      for (const [id, times] of this.times)
        if (!times.some((time) => now - time < this.caps.windowMs)) this.times.delete(id);
  }
}

const guards = new WeakMap();
/** The one guard of an assistant service (any object that stands for it). */
export function loopGuard(owner) {
  if (!guards.has(owner)) guards.set(owner, new AgentLoopGuard());
  return guards.get(owner);
}
