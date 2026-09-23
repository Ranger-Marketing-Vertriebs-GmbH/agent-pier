import { serverCatalogs } from "./catalogs.js";
import { createMessageIndex } from "./message-keys.js";

let identify;

/**
 * Stable key fields for a German server message. The German text stays in the
 * payload for logs and older clients; browsers translate by `messageKey`.
 */
export function messageIdentity(text) {
  identify ??= createMessageIndex(serverCatalogs.de);
  const found = identify(text);
  if (!found) return {};
  return found.args
    ? { messageKey: found.key, messageArgs: found.args }
    : { messageKey: found.key };
}
