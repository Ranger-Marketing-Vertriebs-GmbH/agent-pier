import fs from "node:fs";
import path from "node:path";

/**
 * Whether `target`, a resolved agent placeholder (agent-placeholders.js), reaches the
 * agent's own `workspace` without following a link: every part of the way that exists
 * must be a real directory (the last part may be a file), never a symbolic link. A
 * part that does not exist yet ends the check; the server or OpenClaw creates it. The
 * workspace root above `workspace` belongs to AgentPier and is not checked. Never
 * throws; anything unreadable counts as unsafe.
 */
export function safeAgentPath(target, workspace) {
  const relative = path.relative(workspace, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const parts = relative ? relative.split(path.sep) : [];
  let current = workspace;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      return error?.code === "ENOENT";
    }
    if (stat.isSymbolicLink()) return false;
    if (index < parts.length - 1 && !stat.isDirectory()) return false;
  }
  return true;
}
