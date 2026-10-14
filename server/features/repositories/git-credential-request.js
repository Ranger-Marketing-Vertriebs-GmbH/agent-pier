// Dependency-free parser for the request half of Git's credential helper protocol
// (https://git-scm.com/docs/git-credential#IOFMT). Credential helpers run as short
// subprocesses of git, so this module must never import beyond Node built-ins.

export const maxCredentialRequestLength = 65536;

/**
 * Parses the `key=value` lines git writes to a credential helper.
 *
 * - Input ends at the first blank line or at end of input; later lines are ignored.
 * - A trailing CR is stripped, as git itself reads CRLF lines.
 * - Keys ending in `[]` are multi-valued (`capability[]`, `wwwauth[]`, ...). Git 2.46+
 *   repeats them on every HTTP authentication; no AgentPier helper uses them, so they
 *   are skipped and never echoed back. Not echoing `capability[]` keeps every
 *   capability unadvertised.
 * - Other keys are singular. A repeated singular key (two `host=` lines, for example)
 *   is ambiguous and rejects the whole request.
 * - Unknown singular keys are kept; callers read only the keys they need.
 *
 * @param {string} input
 * @returns {Map<string, string> | null} singular attributes, or null when malformed
 */
export function parseCredentialRequest(input) {
  if (typeof input !== "string" || input.length > maxCredentialRequestLength) return null;
  const fields = new Map();
  for (const raw of input.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line) break;
    if (line.includes("\0")) return null;
    const at = line.indexOf("=");
    if (at < 1) return null;
    const key = line.slice(0, at);
    if (key.endsWith("[]")) continue;
    if (fields.has(key)) return null;
    fields.set(key, line.slice(at + 1));
  }
  return fields;
}
