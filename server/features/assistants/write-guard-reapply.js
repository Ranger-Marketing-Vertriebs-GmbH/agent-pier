import { guardNeeded } from "./write-guard-wait.js";

/**
 * Every Gateway start compiles its agents without write and edit (runtime-config.js)
 * until the team plugin reports its write guard. A chat turn or a settings save
 * re-applies one agent, but a scheduled routine fires inside the Gateway without
 * any apply. So once the guard is live for a generation and the Gateway is ready
 * (whichever comes last), every active memory or browser agent is applied: each apply is the
 * verified hot `config.patch`, never a restart, and is admitted on its own so chat
 * turns interleave. A generation stays open until every agent applied; a pass cut
 * short (guard lost on reconnect, failed apply, refused admission) resumes with the
 * remaining agents on the next guard report or readiness, at most once per agent
 * per request. A finished generation ignores the plugin's periodic reports.
 */
export class WriteGuardReapply {
  constructor({
    assistants,
    live,
    generation,
    blocked = () => false,
    warn = console.warn,
    info = console.info,
  }) {
    Object.assign(this, { assistants, live, generation, blocked, warn, info });
    this.current = null;
    this.applied = new Set();
    this.warned = new Set();
    this.running = null;
  }
  // Guard, readiness and no maintenance: maintenance absorbs readiness and drains
  // admission, and leaving it asks again (gatewayEvents.ready).
  usable(generation) {
    return (
      this.generation() === generation &&
      this.live() &&
      this.assistants.runtime?.status?.().availability === "ready" &&
      !this.assistants.maintenance
    );
  }
  remaining() {
    return this.assistants.store
      .listAssistants()
      .filter(
        (a) =>
          !a.archivedAt &&
          guardNeeded(a) &&
          !this.blocked(a.id) &&
          !this.applied.has(a.id),
      )
      .map((a) => a.id);
  }
  /**
   * The guard went away within a generation (a reconnect): applies made until it
   * reports again lack the guarded tools, so its next report applies every agent.
   */
  guardLost() {
    this.applied.clear();
  }
  /** Called on every guard report and on every readiness (gatewayEvents.ready). */
  request() {
    const generation = this.generation();
    if (this.running) {
      // A newer start reported while the old pass runs: that pass stops at its
      // next agent, then this generation runs once.
      return this.running.generation === generation
        ? this.running
        : this.running.then(() => this.request());
    }
    if (!this.usable(generation)) return Promise.resolve();
    if (this.current !== generation) {
      this.current = generation;
      this.applied.clear();
      this.warned.clear();
    }
    const ids = this.remaining();
    if (!ids.length) return Promise.resolve();
    const pass = this.run(generation, ids).finally(() => {
      if (this.running === pass) this.running = null;
    });
    pass.generation = generation;
    this.running = pass;
    return pass;
  }
  async run(generation, ids) {
    for (const id of ids) {
      if (!this.usable(generation)) return;
      let outcome;
      try {
        // The apply's own error resolves, so a rejection is the refused admission.
        outcome = await this.assistants.admit(() =>
          this.usable(generation)
            ? this.assistants.config.apply(id).then(
                () => ({ applied: true }),
                (error) => ({ failure: error || Error("apply failed") }),
              )
            : { skipped: true },
        );
      } catch (error) {
        // Recovering or closing: expected, and the next report resumes.
        this.info(`Write guard re-apply deferred: ${error?.code || error?.message}`);
        return;
      }
      // The guard or readiness went away while this agent waited for admission.
      if (outcome.skipped) return;
      const { failure } = outcome;
      if (!failure) {
        // Compiled while the guard was live; a later reconnect keeps the config.
        if (this.generation() === generation) this.applied.add(id);
        continue;
      }
      // Retried on the next report; warned once per agent and generation.
      if (this.warned.has(id)) continue;
      this.warned.add(id);
      this.warn(
        `Write guard re-apply failed for ${id}: ${failure?.code || failure?.message}`,
      );
    }
  }
}
