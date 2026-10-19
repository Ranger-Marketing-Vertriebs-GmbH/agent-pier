import { patchConfig } from "../assistants/openclaw-config/live-patch.js";
import { watchConfigAdoption } from "../assistants/openclaw-config/config-adoption.js";
import { telegramLivePatch } from "../assistants/openclaw-config/telegram-senders.js";

/**
 * Writes changed allowlists (telegramLiveChanges) into the running Gateway with
 * `config.patch`, like the MCP live apply (mcp-changes.js): the patch replaces each
 * `allowFrom` whole, then waits until the Gateway announced the written
 * configuration, so the next inbound message is checked against the new list.
 * Rejects when the Gateway refused or could not be reached.
 */
export async function patchTelegramAllowlists(client, changes, adoption = {}) {
  const watch = watchConfigAdoption(client, adoption);
  try {
    watch.mark();
    const base = await patchConfig(client, () => telegramLivePatch(changes));
    const written = await client.call("config.get", {});
    await watch.settle(base?.hash, written?.hash);
  } finally {
    watch.close();
  }
}
