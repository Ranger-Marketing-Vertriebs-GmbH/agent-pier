import fs from "node:fs";
import path from "node:path";

// "Always allow" for AgentPier's own SSH wrappers (owner A16): an agent's bin/ssh,
// bin/scp and bin/sftp (agent-ssh-shell.js, ssh-session-config.js renderWrapper)
// may be allowlisted, although ssh, scp and sftp count as interpreters
// (exec-allowlist-policy.js). The agent socket's signing policy limits the hosts
// AgentPier's keys reach. A request whose options run a local program is allowed
// once only; the entry itself allows any arguments (exec-decisions.js).
const wrapperNames = new Set(["ssh", "scp", "sftp"]);

// Per tool: the option letters that take a value (OpenSSH getopt strings, as in
// renderWrapper) and those that name a local program, library or command file.
const options = {
  ssh: { values: "BbcDEeFIiJLlmOoPpQRSWw", local: "FI" },
  scp: { values: "cDFiJloPSX", local: "FS" },
  sftp: { values: "BbcDFiJloPRSsX", local: "bDFS" },
};
// ssh_config keywords that run a local command or load a library, read in any case.
const localKeywords = new Set([
  ...["proxycommand", "localcommand", "permitlocalcommand", "knownhostscommand"],
  ...["pkcs11provider", "securitykeyprovider", "match", "include"],
]);
const localKeyword = (value) =>
  localKeywords.has(String(value).trimStart().split(/[=\s]/, 1)[0].toLowerCase());

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

/**
 * Whether the arguments of one wrapper call ask OpenSSH to run a local program:
 * `-o` with a command or library keyword, a config file (`-F`), a PKCS#11 library
 * (`-I`), a transport program (`-S`), an sftp server (`-D`) or batch file (`-b`).
 * ssh stops at its remote command; scp and sftp are read to the end, as a
 * permuting getopt would.
 */
export function runsLocalProgram(tool, args) {
  const rules = options[tool];
  let operands = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return false;
    if (!arg.startsWith("-") || arg === "-") {
      operands++;
      if (tool === "ssh" && operands > 1) return false;
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const c = arg[j];
      if (!rules.values.includes(c)) continue;
      const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
      if (rules.local.includes(c)) return true;
      if (c === "o" && value !== undefined && localKeyword(value)) return true;
      break;
    }
  }
  return false;
}
