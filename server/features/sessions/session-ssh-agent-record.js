// The SSH agent a session record keeps (ssh-session-agents.js): its generation, the
// socket token and the OpenSSH binaries chosen at launch. A restart listens again from
// these and a stop removes the socket folder they name, so a malformed value is dropped
// as a whole rather than kept in part.
import path from "node:path";

const generationPattern = /^[0-9a-f-]{36}$/;
const tokenPattern = /^[0-9a-f]{32}$/;
const binaryNames = new Set(["ssh", "scp", "sftp"]);

const binaryPath = (value) =>
  typeof value === "string" &&
  value.length <= 4096 &&
  path.isAbsolute(value) &&
  !/[\x00-\x1f\x7f]/.test(value);

function binariesRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (
    !binaryPath(value.ssh) ||
    entries.some(([name, file]) => !binaryNames.has(name) || !binaryPath(file))
  )
    return null;
  return Object.fromEntries(entries);
}

/** `{ enabled, generation, token, binaries }`, or undefined for anything malformed. */
export function sessionSshAgentRecord(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.enabled !== true ||
    typeof value.generation !== "string" ||
    !generationPattern.test(value.generation) ||
    typeof value.token !== "string" ||
    !tokenPattern.test(value.token)
  )
    return undefined;
  const binaries = binariesRecord(value.binaries);
  if (!binaries) return undefined;
  return { enabled: true, generation: value.generation, token: value.token, binaries };
}
