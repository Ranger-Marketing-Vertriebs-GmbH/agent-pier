import { uploadStore } from "./chat-upload-store.js";
import { chatUploadsCopy as copy } from "../../lib/i18n/messages/chat-uploads.js";

/**
 * An already-mounted second tab may not yet know about another tab's files.
 * Focus/pageshow restores briefly hold the same lock, so wait for it instead of
 * reporting pending uploads; only saved recovery files or a lock held beyond
 * the timeout (an upload in another tab) block sending.
 */
export async function withReadyUploads(
  scope,
  send,
  {
    locks = globalThis.navigator?.locks,
    list = () => uploadStore(scope, "list"),
    timeoutMs = 3000,
  } = {},
) {
  if (!locks) throw new Error(copy.storageFailed);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let acquired = false;
  try {
    return await locks.request(
      `agentpier.upload:${scope}`,
      { signal: controller.signal },
      async () => {
        acquired = true;
        clearTimeout(timer);
        let pending;
        try {
          pending = await list();
        } catch {
          throw new Error(copy.storageFailed);
        }
        if (pending.length) throw new Error(copy.pendingMessage);
        return send();
      },
    );
  } catch (error) {
    if (!acquired && controller.signal.aborted) throw new Error(copy.pendingMessage);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
