import { patchConfig } from "./live-patch.js";
import { watchConfigAdoption } from "./config-adoption.js";
import { boundPort } from "./openclaw-agents.js";
import { openClawCompiler } from "./openclaw-compiler.js";
import { agentDrift, agentPatch, providerPatch } from "./openclaw-config/agent-apply.js";

/**
 * The config sub-port (agent-runtime.js) over OpenClaw's live configuration, the
 * `openclaw.json` shape the compiler in openclaw-config/ produces (`compiler`,
 * openclaw-compiler.js, the same in every view). `patch`
 * applies a change computed from the current configuration with the base hash it
 * read, waits for admission, runs after every earlier write of the connection and
 * waits out a rate-limit refusal (live-patch.js), all on the one client it started
 * on; it resolves to the `{ config, hash }` it read, or null when `build` returned no
 * change. `watchAdoption` reports when the Gateway adopted a write
 * (config-adoption.js). Whether a path applies without a restart is its
 * `reloadKind` (`lookup`), as before the port.
 */
export const openClawConfig = (supervisor, clientOf) =>
  boundPort(configOver, supervisor, clientOf);

function configOver(current) {
  const call = async (...args) => current().call(...args);
  return {
    compiler: openClawCompiler,
    get: () => call("config.get", {}),
    lookup: ({ path }) => call("config.schema.lookup", { path }),
    patch: async ({ build, ...options }) => patchConfig(current(), build, options),
    // One agent's desired state (agent-desired-state.js) on the running
    // configuration: its model connection's provider, then its entry and the
    // host-wide shell tools (`state()`: what the runtime offers as the write runs,
    // agent-apply.js agentPatch). Each is a patch as above.
    applyModel: async ({ desired }) =>
      patchConfig(current(), () => providerPatch(desired), {}),
    apply: async ({ desired, state }) =>
      patchConfig(current(), (config) => agentPatch(config, desired, state), {}),
    // Synchronously, whether `config` (a get() answer's) holds what the apply wrote.
    applied: ({ desired, config, expected }) => !agentDrift(config, desired, expected),
    // Synchronous: watched from before the first write (config-adoption.js).
    watchAdoption: (options) => watchConfigAdoption(current(), options),
  };
}
