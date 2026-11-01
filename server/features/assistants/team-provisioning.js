import { runtimeFor } from "./runtimes/runtime-for.js";

export class TeamProvisioning {
  constructor({ teams, assistants }) {
    Object.assign(this, { teams, assistants });
  }
  // Profile application and session creation never reach the model, so both may
  // run again when evidence shows they did not complete. Only an ambiguous
  // session match stays uncertain; execution itself is never replayed here.
  async advance(id) {
    const { teams, assistants: a } = this;
    const m = teams.member(id);
    if (m.conversationId || !["provisioning", "provisioning_uncertain"].includes(m.phase))
      return m;
    if (m.stopRequested) return teams.write(m, { phase: "cancelled" });
    const agent = a.store.getAssistant(m.assistantId);
    const profile = agent.runtimeAgentId;
    const label = `AgentPier member ${id}`;
    try {
      if (m.phase === "provisioning_uncertain" && m.provisionStep === "session") {
        const matches = await runtimeFor(agent, a.runtime).sessions.list({
          agentId: profile,
          label,
        });
        const current = this.interrupted(id);
        if (current || matches.length > 1) return current || teams.member(id);
        if (matches.length === 1) return this.adopt(id, matches[0].key);
        return await this.createSession(id, profile, label);
      }
      teams.write(teams.member(id), { phase: "provisioning", provisionStep: "profile" });
      await a.config.apply(m.assistantId);
      return this.interrupted(id) || (await this.createSession(id, profile, label));
    } catch {
      const current = teams.member(id);
      if (current.phase === "cancelled") return current;
      return teams.write(current, {
        phase: current.stopRequested ? "cancelled" : "provisioning_uncertain",
      });
    }
  }
  async createSession(id, agentId, label) {
    const { teams, assistants: a } = this;
    teams.write(teams.member(id), { phase: "provisioning", provisionStep: "session" });
    const { sessions } = runtimeFor(
      a.store.getAssistant(teams.member(id).assistantId),
      a.runtime,
    );
    let created;
    try {
      created = await sessions.create({ agentId, label }, a.sessionCreate);
    } catch (error) {
      if (!sessions.notCreated(error)) throw error;
      // The Gateway answered that no session exists: the claim returns to the
      // queue and the next tick provisions the member again.
      const m = teams.member(id);
      if (m.phase === "cancelled") return m;
      return teams.write(
        m,
        m.stopRequested
          ? { phase: "cancelled" }
          : { phase: "queued", provisionStep: undefined, claimedAt: undefined },
      );
    }
    if (!created.key) throw Error("Unconfirmed session");
    return this.adopt(id, created.key);
  }
  // A stop that arrived while a step was in flight wins over continuing.
  interrupted(id) {
    const m = this.teams.member(id);
    if (m.phase === "cancelled") return m;
    return m.stopRequested ? this.teams.write(m, { phase: "cancelled" }) : null;
  }
  adopt(id, key) {
    const { teams, assistants } = this;
    return teams.transaction(() => {
      const m = teams.member(id);
      const conversation = assistants.store.saveConversation({
        assistantId: m.assistantId,
        runtimeSessionKey: key,
      });
      return teams.write(m, {
        conversationId: conversation.id,
        phase: m.stopRequested ? "cancelled" : "ready",
      });
    });
  }
}
