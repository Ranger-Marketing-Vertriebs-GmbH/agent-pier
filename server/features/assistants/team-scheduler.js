import { TeamProvisioning } from "./team-provisioning.js";
import { memberTerminal, TeamResults } from "./team-results.js";
export class TeamScheduler {
  constructor({ teams, assistants, now = Date.now }) {
    Object.assign(this, { teams, assistants, now });
    this.provisioning = new TeamProvisioning({ teams, assistants });
    this.results = new TeamResults({ teams, assistants });
    // A claim without step evidence did nothing yet and returns to the queue; a
    // started step is resolved from runtime evidence by TeamProvisioning.
    for (const m of teams.members())
      if (m.phase === "provisioning")
        teams.write(
          m,
          m.stopRequested
            ? { phase: "cancelled" }
            : m.provisionStep
              ? { phase: "provisioning_uncertain" }
              : { phase: "queued", claimedAt: undefined },
        );
  }
  tick() {
    if (this.closed || !this.assistants.runtime.client?.ready) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.advance().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async advance() {
    const { teams, assistants: a } = this;
    for (const t of teams.list()) if (t.phase === "approved") teams.reserve(t.id);
    for (const m of teams.members()) await this.observe(m.id);
    if (this.closed) return;
    const selected = teams.transaction(() => {
      const members = teams.members();
      let occupied = members.filter(
        (m) => m.phase !== "queued" && teams.activeMember(m),
      ).length;
      return members
        .filter((m) => {
          if (m.phase !== "queued") return false;
          if (m.stopRequested) {
            teams.write(m, { phase: "cancelled" });
            return false;
          }
          if (occupied >= teams.settings().hostMaxConcurrent) return false;
          teams.write(m, { phase: "provisioning", claimedAt: this.now() });
          occupied++;
          return true;
        })
        .map((m) => m.id);
    });
    const existing = teams
      .members()
      .filter((m) => ["provisioning_uncertain", "ready", "admitting"].includes(m.phase))
      .map((m) => m.id);
    await Promise.allSettled(
      [...new Set([...selected, ...existing])].map((id) => this.dispatch(id)),
    );
    let failure;
    for (const { id } of teams.list()) {
      // A concurrent write to one team must not starve the others; the team is
      // re-read on the next tick.
      try {
        const t = teams.get(id);
        if (t.phase === "queued" && teams.members(id).some((m) => m.phase !== "queued"))
          teams.write(t, { phase: "running" });
        await this.results.collect(id);
        if (!this.closed) await this.results.dispatch(id);
      } catch (error) {
        if (error.status !== 409) failure ??= error;
      }
    }
    a.changed();
    if (failure) throw failure;
  }
  async dispatch(id) {
    const { teams, assistants: a } = this;
    if (this.closed) return;
    let m = teams.member(id);
    if (!m.conversationId) {
      try {
        m = await a.admit(() => this.provisioning.advance(id));
      } catch (error) {
        if (error.status !== 503) throw error;
        // Admission gates (maintenance, recovery, shutdown) reject before any step
        // ran, so a fresh claim is released instead of holding its slot.
        const current = teams.member(id);
        if (current.phase === "provisioning")
          teams.write(current, {
            phase: "queued",
            provisionStep: undefined,
            claimedAt: undefined,
          });
        return;
      }
    }
    if (!["ready", "admitting"].includes(m.phase) || this.closed) return;
    if (m.stopRequested) {
      teams.write(m, { phase: "cancelled" });
      return;
    }
    teams.write(m, { phase: "admitting" });
    try {
      const sent = await a.send(
        m.conversationId,
        { clientRequestId: `team-member:${id}`, text: m.assignment },
        { kind: "team-member", teamId: m.teamId, memberId: id },
      );
      m = teams.member(id);
      teams.write(m, {
        attemptId: sent.attempt.id,
        phase: sent.attempt.state === "uncertain" ? "uncertain" : "running",
        startedAt: this.now(),
      });
      if (m.stopRequested) await this.stop(id);
    } catch {
      // No automatic execution retry after admission; send() itself persists
      // before RPC and returns an uncertain attempt after acknowledgement loss.
      teams.write(teams.member(id), { phase: "ready" });
    }
  }
  async observe(id) {
    const { teams, assistants: a } = this;
    const m = teams.member(id);
    if (!m.attemptId || memberTerminal.has(m.phase)) return;
    const attempt = a.ledger.getAttempt(m.attemptId);
    // A run the owner stopped ends as cancelled even when the runtime reports the
    // abort as a failure; a deadline stop stays a failure, and a stop persisted
    // before stop reasons were recorded keeps its earlier failure classification.
    if (memberTerminal.has(attempt.state))
      teams.write(m, {
        phase:
          attempt.state === "failed" && m.stopRequested && m.stopReason === "owner"
            ? "cancelled"
            : attempt.state,
      });
    else if (attempt.reviewedAt)
      teams.write(m, { phase: "failed", diagnostic: "OUTCOME_REVIEWED" });
    else if (
      ["uncertain", "interrupted"].includes(attempt.state) &&
      m.phase !== "stopping"
    ) {
      if (m.phase !== "uncertain") teams.write(m, { phase: "uncertain" });
    } else if (
      m.phase !== "stopping" &&
      this.now() - m.startedAt >= teams.get(m.teamId).policy.runTimeoutMinutes * 60000
    )
      await this.stop(id, "deadline");
  }
  async stop(id, reason = "owner") {
    const { teams, assistants: a } = this;
    let m = teams.member(id);
    if (memberTerminal.has(m.phase) || m.phase === "stopping") return m;
    m = teams.write(m, {
      stopRequested: true,
      stopReason: reason,
      phase: ["queued", "provisioning", "ready"].includes(m.phase)
        ? "cancelled"
        : m.attemptId
          ? "stopping"
          : m.phase,
    });
    if (m.attemptId)
      try {
        await a.cancel(m.attemptId);
      } catch {
        /* Keep stopping until evidence arrives. */
      }
    return teams.member(id);
  }
  async close() {
    this.closed = true;
    await this.running;
  }
}
