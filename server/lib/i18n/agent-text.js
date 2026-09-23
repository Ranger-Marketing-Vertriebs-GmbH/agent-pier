import { germanServerMessages } from "./catalog-de.js";
import { englishServerMessages } from "./catalog-en.js";
import { createMessageIndex, resolveMessage } from "./message-keys.js";

let identify;

/**
 * Coding agents always read English. Catalog text (German server text, or an
 * explicit key) resolves in the English catalog; free text stays unchanged.
 */
export function agentText(text, key, args) {
  const keyed = key ? resolveMessage(englishServerMessages, key, args) : undefined;
  if (keyed !== undefined) return keyed;
  if (typeof text !== "string") return text;
  identify ??= createMessageIndex(germanServerMessages);
  const found = identify(text);
  return (found && resolveMessage(englishServerMessages, found.key, found.args)) ?? text;
}
