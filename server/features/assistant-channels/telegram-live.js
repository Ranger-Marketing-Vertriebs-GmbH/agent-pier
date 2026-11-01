import { hostConnection, runtimeFor } from "../assistants/runtimes/runtime-for.js";

/**
 * Writes changed allowlists (telegramLiveChanges) into the running Gateway with
 * `config.patch`, like the MCP live apply (mcp-changes.js): the patch replaces each
 * `allowFrom` whole, then waits until the Gateway announced the written
 * configuration, so the next inbound message is checked against the new list.
 * Rejects when the Gateway refused or could not be reached. `runtime` is the
 * runtime supervisor; every step goes to the Gateway the watch began on, never to a
 * newer one (the config sub-port bound to that connection).
 */
export async function patchTelegramAllowlists(runtime, changes, adoption = {}) {
  const port = runtimeFor(null, runtime).config;
  const config = port.on(hostConnection(runtime));
  const watch = config.watchAdoption(adoption);
  try {
    watch.mark();
    const base = await config.patch({
      build: () => port.compiler.telegramLivePatch(changes),
    });
    const written = await config.get();
    await watch.settle(base?.hash, written?.hash);
  } finally {
    watch.close();
  }
}
