import { personalCapabilities } from "./native-capabilities.js";

/**
 * Every Gateway start compiles its agents without write and edit (runtime-config.js)
 * until the team plugin reports its write guard. A chat turn or a settings save
 * re-applies one agent, but a scheduled routine fires inside the Gateway without
 * any apply. So once the guard is live for a generation, every active memory agent
 * is applied once: each apply is the verified hot `config.patch`, never a restart.
 * The plugin repeats its report periodically; one generation is applied only once,
 * after both the guard report and the Gateway's readiness, whichever comes last.
 */
export class WriteGuardReapply {
  constructor({ assistants, live, generation, warn = console.warn }) {
    Object.assign(this, { assistants, live, generation, warn });
    this.done = null;
    this.running = null;
  }
  /** Called on every guard report and on every readiness (gatewayEvents.ready). */
  request() {
    const generation = this.generation();
    // The plugin reports while the Gateway still starts, before it is ready (an
    // apply then fails); readiness asks again. Maintenance absorbs readiness and
    // drains admission; leaving it asks again too.
    if (
      !this.live() ||
      this.assistants.runtime?.status?.().availability !== "ready" ||
      this.assistants.maintenance ||
      this.done === generation
    )
      return this.running || Promise.resolve();
    this.done = generation;
    const pass = this.assistants
      .admit(() => this.run(generation))
      .catch((error) => {
        // Refused admission (recovering, closing): the next report tries again.
        if (this.done === generation) this.done = null;
        this.warn(`Write guard re-apply deferred: ${error?.code || error?.message}`);
      })
      .finally(() => {
        if (this.running === pass) this.running = null;
      });
    this.running = pass;
    return pass;
  }
  async run(generation) {
    for (const assistant of this.assistants.store.listAssistants()) {
      // A newer start, or a lost guard, makes this pass meaningless.
      if (this.generation() !== generation || !this.live()) return;
      if (assistant.archivedAt || !personalCapabilities(assistant).memory) continue;
      // Not retried here: the agent's next turn, save or routine trigger applies it.
      await this.assistants.config.apply(assistant.id).catch((error) => {
        this.warn(
          `Write guard re-apply failed for ${assistant.id}: ${error?.code || error?.message}`,
        );
      });
    }
  }
}
