import { optionConnections } from "./runtimes/runtime-options.js";

/**
 * The model connections the runtime options of `agent` name
 * (runtimes/runtime-options.js), each resolved by `models` (assistant-models.js) as
 * the agent's own model connection is: `{ connectionId, modelId, ref, providerId,
 * provider, display }`, a ChatGPT login with its `chatgpt` too, or `{ connectionId,
 * modelId, unavailable }` (the refusal's key) for one that cannot serve now. The
 * runtime's compiler decides what it can use. Each lease is released at once: the
 * apply holds the provider it read. Never fails.
 */
export async function resolveOptionConnections(models, agent) {
  const resolved = [];
  for (const { connectionId, modelId } of optionConnections(agent)) {
    let lease;
    try {
      lease = await models.resolve({ connectionId, modelId });
      resolved.push({
        connectionId,
        modelId,
        ref: lease.modelRef,
        providerId: lease.providerId,
        provider: lease.provider,
        display: lease.display,
        ...(lease.chatgpt && { chatgpt: lease.chatgpt }),
      });
    } catch (error) {
      resolved.push({ connectionId, modelId, unavailable: error?.key || "provider" });
    } finally {
      lease?.release?.();
    }
  }
  return resolved;
}
