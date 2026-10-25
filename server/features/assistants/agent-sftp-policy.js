import { sshModes, unattended } from "./agent-ssh-origin.js";

// What an agent's SFTP action may do on its grant (spec "Decisions by the owner"):
// reads never ask, writes ask unless the owner trusts the host, deletes always ask,
// routines and hooks never delete. Pure, like agent-ssh-origin.js.
const kinds = ["read", "write", "delete"];
const reads = new Set(["list", "stat", "download"]);
const writes = new Set(["upload", "mkdir", "rename"]);

/**
 * `read`, `write` or `delete`. A sync down without `deleteExtra` only reads the
 * server; any sync with `deleteExtra` deletes on its target side; a dry run only
 * plans and changes nothing.
 */
export function sftpKind(action, input = {}) {
  if (!reads.has(action) && !writes.has(action) && !["sync", "delete"].includes(action))
    throw new TypeError("Not an SFTP file action.");
  if (input.dryRun === true || reads.has(action)) return "read";
  if (action === "delete" || input.deleteExtra === true) return "delete";
  if (action === "sync") return input.direction === "down" ? "read" : "write";
  return "write";
}

/** `run` without a card, `card` for an owner approval, or `refuse`. */
export function sftpPermits(mode, cls, kind) {
  if (!sshModes.includes(mode) || !kinds.includes(kind)) return "refuse";
  if (unattended(cls)) return mode === "routines" && kind !== "delete" ? "run" : "refuse";
  if (!["owner", "delegated"].includes(cls)) return "refuse";
  if (kind === "read") return "run";
  if (kind === "delete") return "card";
  return mode === "approval" ? "card" : "run";
}
