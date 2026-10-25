import { isDeepStrictEqual } from "node:util";
import { assistantProblem } from "./assistant-validation.js";
import {
  capabilityKeys,
  memoryEnabled,
  personalEligible,
} from "./native-capabilities.js";
import { dreamingSection } from "./openclaw-config/dreaming.js";
import { patchConfig } from "./openclaw-config/live-patch.js";

export const DREAMING_MEMORY_CONFIRMATION_REQUIRED =
  "ASSISTANT_DREAMING_MEMORY_CONFIRMATION_REQUIRED";
export const DREAMING_AGENTS_BUSY = "ASSISTANT_DREAMING_AGENTS_BUSY";
/**
 * The permanent agents whose memory AgentPier switches on and keeps on while dreaming
 * is on. Temporary members dream as well (memory-core sweeps every runtime agent), but
 * follow their lead's memory and are never raised.
 */
export const dreamingCovered = (agent) => personalEligible(agent);
const dreamingPath = "plugins.entries.memory-core.config.dreaming";
const named = ({ id, name }) => ({ id, name });

/**
 * The owner's dreaming switch. Switching on first turns memory on for every permanent
 * agent without it, after the owner confirmed the list; the change then reaches the
 * running Gateway live. A change the Gateway did not take (not ready, or the patch
 * refused) stays pending until the one-minute backup tick applies it (`converge`), or a
 * start compiles it (`compiled`).
 */
export class DreamingService {
  constructor({ settings, assistants, warn = console.warn }) {
    Object.assign(this, { settings, assistants, warn });
  }
  uncovered() {
    return this.assistants.store
      .listAssistants()
      .filter((agent) => dreamingCovered(agent) && !memoryEnabled(agent));
  }
  get() {
    return { ...this.settings.get(), withoutMemory: this.uncovered().map(named) };
  }
  enabled() {
    return this.settings.get().enabled;
  }
  async save(input, revision) {
    const { confirmMemory, ...body } = input || {};
    const next = this.settings.check(body, revision);
    const uncovered = next.enabled ? this.uncovered() : [];
    if (uncovered.length && confirmMemory !== true)
      throw Object.assign(assistantProblem("dreamingMemoryConfirm", 409), {
        code: DREAMING_MEMORY_CONFIRMATION_REQUIRED,
        agents: uncovered.map(named),
      });
    // One after another; a busy agent is named and the switch stays off. Any other
    // refusal ends the switch here; agents already raised keep their memory.
    const busy = [];
    for (const { id } of uncovered) {
      const current = this.assistants.store.getAssistant(id);
      try {
        // Known boolean keys only (a stored legacy key would be refused); an unset
        // capability is off, and the update needs `reminders` stated.
        const capabilities = { reminders: false, memory: true };
        for (const key of capabilityKeys)
          if (typeof current.capabilities?.[key] === "boolean" && key !== "memory")
            capabilities[key] = current.capabilities[key];
        await this.assistants.update(id, { capabilities }, current.revision);
      } catch (error) {
        if (error?.key !== "active") throw error;
        busy.push(named(current));
      }
    }
    if (busy.length)
      throw Object.assign(assistantProblem("dreamingAgentsBusy", 409), {
        code: DREAMING_AGENTS_BUSY,
        agents: busy,
      });
    this.settings.save(next, revision);
    this.pending = true;
    await this.assistants
      .admit(() => this.converge())
      .catch((error) => {
        // The error code only: no values.
        this.warn(
          `Dreaming could not be applied to the running Gateway (${
            error?.code || error?.key || error?.name || "ERROR"
          }); it is applied once the Gateway takes it.`,
        );
      });
    return { ...this.get(), ...(this.pending ? { pending: true } : {}) };
  }
  /** The compiler's view at a Gateway start, which then holds every saved change. */
  compiled() {
    this.pending = false;
    return this.settings.compiled();
  }
  /**
   * Applies a pending change to the ready Gateway, under admission (the save, or the
   * backup tick each minute): patched only where its dreaming section differs.
   */
  async converge() {
    const client = this.assistants.runtime?.client;
    if (!this.pending || !client?.ready) return;
    const wanted = this.settings.compiled();
    const section = dreamingSection(wanted);
    await patchConfig(client, (config) =>
      isDeepStrictEqual(
        config.plugins?.entries?.["memory-core"]?.config?.dreaming,
        section,
      )
        ? null
        : {
            patch: {
              plugins: { entries: { "memory-core": { config: { dreaming: section } } } },
            },
            replacePaths: [dreamingPath],
          },
    );
    // A save while this ran stays pending for the next tick.
    if (isDeepStrictEqual(this.settings.compiled(), wanted)) this.pending = false;
  }
}
