import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { record, values } from "../extensions/mcp-config.js";
import { clis } from "./cli-native.js";
import { parsePlaceholder } from "./agent-placeholders.js";

export const messages = serverMessages.mcpServers;
export const targetKinds = ["agent", "cli"];

/**
 * A URL as responses show it: origin and path only. The query string and fragment
 * can carry tokens and stay in the store; the compiler alone reads the full URL.
 */
export function publicUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}
/** `auth` and `oauthScope` of a remote definition; a stdio server has neither. */
export function cleanAuth(input) {
  const auth = input.auth ?? "headers";
  if (auth !== "headers" && auth !== "oauth") throw invalid();
  if (input.transport === "stdio") {
    if (input.auth !== undefined || input.oauthScope) throw invalid();
    return { auth: "headers", oauthScope: null };
  }
  let scope = input.oauthScope;
  if (scope === undefined || scope === null) scope = "";
  if (typeof scope !== "string") throw invalid();
  scope = scope.trim();
  if (scope.length > 512 || /[\x00-\x1f\x7f]/.test(scope) || !scope.isWellFormed())
    throw invalid();
  // A scope only means something with OAuth; with headers it is dropped.
  return { auth, oauthScope: auth === "oauth" && scope ? scope : null };
}
export const invalid = (message = messages.invalidRequest) => problem(message);
export const target = (kind, id) => {
  if (!targetKinds.includes(kind)) throw invalid(messages.invalidTarget);
  if (typeof id !== "string" || !id || id.length > 200 || /[\x00-\x1f]/.test(id))
    throw invalid(messages.invalidTarget);
  if (kind === "cli" && !clis.includes(id)) throw invalid(messages.invalidTarget);
};
export function cleanArgs(value = []) {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some(
      (a) =>
        typeof a !== "string" ||
        a.length > 16384 ||
        a.includes("\0") ||
        // A lone surrogate has no UTF-8 form: no CLI file could hold it.
        !a.isWellFormed(),
    )
  )
    throw invalid(serverMessages.extensions.invalidArgumentList);
  return value;
}
export function cleanCwd(value) {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(value) ||
    !value.isWellFormed() ||
    // An agent placeholder resolves to an absolute folder per agent.
    !(path.isAbsolute(value) || parsePlaceholder(value))
  )
    throw invalid(messages.invalidCwd);
  return value;
}
/** Split a patch map into values to set and names to remove (`null`). */
export function splitMap(input, headers) {
  if (input === undefined) return { set: {}, drop: [] };
  if (!record(input))
    throw invalid(serverMessages.extensions.invalidEnvironmentOrHeadersObject);
  const set = {};
  const drop = [];
  for (const [key, value] of Object.entries(input))
    if (value === null) drop.push(key);
    else set[key] = value;
  values(set, headers);
  values(Object.fromEntries(drop.map((k) => [k, ""])), headers);
  return { set, drop };
}
