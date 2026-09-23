import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";
import {
  createMessageIndex,
  resolveMessage,
} from "../../server/lib/i18n/message-keys.js";
import { getLanguage } from "./i18n/index.js";

let identify;

/**
 * Shows a server message in the active UI language. Servers send German text plus a
 * stable `messageKey`; text without a key is traced back through the German catalog.
 * Unknown keys and free text (native CLI output, diagnostics) stay unchanged.
 */
export function serverText(text, key, args) {
  const catalog = serverCatalogs[getLanguage()] || serverCatalogs.de;
  const keyed = key ? resolveMessage(catalog, key, args) : undefined;
  if (keyed !== undefined) return keyed;
  if (typeof text !== "string" || getLanguage() === "de") return text;
  identify ??= createMessageIndex(serverCatalogs.de);
  const found = identify(text);
  return (found && resolveMessage(catalog, found.key, found.args)) ?? text;
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
