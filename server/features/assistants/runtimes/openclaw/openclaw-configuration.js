import { patchConfig } from "./live-patch.js";
import { watchConfigAdoption } from "./config-adoption.js";
import { boundPort } from "./openclaw-agents.js";
import { openClawCompiler } from "./openclaw-compiler.js";

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
    // Synchronous: watched from before the first write (config-adoption.js).
    watchAdoption: (options) => watchConfigAdoption(current(), options),
  };
}
