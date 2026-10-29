import fs from "node:fs";
import path from "node:path";

// "Always allow" for AgentPier's own SSH wrappers (owner A16): an agent's bin/ssh,
// bin/scp and bin/sftp (agent-ssh-shell.js, ssh-session-config.js renderWrapper)
// may be allowlisted, although ssh, scp and sftp count as interpreters
// (exec-allowlist-policy.js). The agent socket's signing policy limits the hosts
// AgentPier's keys reach. The entry allows any arguments (exec-decisions.js), so
// options that run local programs and sftp's !commands run too (owner A19: accepted).
const wrapperNames = new Set(["ssh", "scp", "sftp"]);

const realDir = (dir) => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

/** The tool name when `real` is ssh, scp or sftp directly in one of `dirs`, else null. */
export function sshWrapper(real, dirs = []) {
  if (typeof real !== "string" || !path.isAbsolute(real)) return null;
  const name = path.basename(real);
  if (!wrapperNames.has(name)) return null;
  const dir = path.dirname(real);
  return dirs.some((d) => typeof d === "string" && realDir(d) === dir) ? name : null;
}
