import { uploadStore } from "./chat-upload-store.js";
import { chatUploadsCopy as copy } from "../../lib/i18n/messages/chat-uploads.js";

/** An already-mounted second tab may not yet know about another tab's files. */
export async function withReadyUploads(scope, send) {
  if (!navigator.locks) throw new Error(copy.storageFailed);
  return navigator.locks.request(
    `agentpier.upload:${scope}`,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) throw new Error(copy.pendingMessage);
      let pending;
      try {
        pending = await uploadStore(scope, "list");
      } catch {
        throw new Error(copy.storageFailed);
      }
      if (pending.length) throw new Error(copy.pendingMessage);
      return send();
    },
  );
}
