import {
  createMessageIndex,
  resolveMessage,
} from "../../server/lib/i18n/message-keys.js";
import { getLanguage, subscribeLanguage } from "./i18n/index.js";

// Servers send German text plus a stable `messageKey`. German users see that text
// as is; English catalogs load on demand so they stay out of the initial bundle.
let english;
let loading;
// Views render stored server text through serverText(); a loaded catalog bumps this
// version so they render again in English instead of keeping the German fallback.
let version = 0;
const listeners = new Set();

export function subscribeServerMessages(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function serverMessagesVersion() {
  return version;
}

/** Loads the English server catalog; resolves at once for German users. */
export function serverMessagesReady() {
  if (getLanguage() !== "en") return Promise.resolve();
  loading ??= Promise.all([
    import("../../server/lib/i18n/catalog-en.js"),
    import("../../server/lib/i18n/catalog-de.js"),
  ]).then(
    ([en, de]) => {
      english = {
        catalog: en.englishServerMessages,
        identify: createMessageIndex(de.germanServerMessages),
      };
      version += 1;
      for (const listener of listeners) listener();
    },
    () => {
      // A failed chunk load keeps German server text; a later switch retries.
      loading = undefined;
    },
  );
  return loading;
}
subscribeLanguage(() => void serverMessagesReady());

/**
 * Shows a server message in the active UI language. Text without a key is traced
 * back through the German catalog. Unknown keys, free text (native CLI output,
 * diagnostics) and a not yet loaded catalog keep the server text.
 */
export function serverText(text, key, args) {
  if (getLanguage() !== "en") return text;
  if (!english) {
    void serverMessagesReady();
    return text;
  }
  const keyed = key ? resolveMessage(english.catalog, key, args) : undefined;
  if (keyed !== undefined) return keyed;
  if (typeof text !== "string") return text;
  const found = english.identify(text);
  return (found && resolveMessage(english.catalog, found.key, found.args)) ?? text;
}

/** Resolves the `error` of a JSON problem or the `message` of a socket error. */
export function serverProblemText(data, fallback) {
  const text = data?.error ?? data?.message;
  return (
    serverText(
      typeof text === "string" && text ? text : fallback,
      data?.messageKey,
      data?.messageArgs,
    ) || fallback
  );
}
