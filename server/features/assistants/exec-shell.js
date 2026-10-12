import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { privateFolder } from "./runtime-paths.js";

// Exec children run as the owner: with the owner's real HOME and login PATH, while
// the Gateway keeps its private HOME, state and config. OpenClaw has no exec
// environment setting and refuses a per-call HOME, so the Gateway's SHELL points to
// a wrapper that sets HOME and hands over to /bin/sh, and the PATH reaches exec
// through tools.exec.pathPrepend (docs/assistant-shell-qualification.md, fact d).

// Package manager directories a login profile commonly adds; used when present.
export const standardPathDirectories = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/home/linuxbrew/.linuxbrew/bin",
];

/** A POSIX single-quoted word: safe for quotes, `$`, backticks and newlines. */
export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

/** The wrapper's content: sets the owner's HOME, then execs /bin/sh unchanged. */
export function execShellScript(home) {
  if (!path.isAbsolute(home) || home.includes("\0"))
    throw Error("The owner's home directory must be an absolute path.");
  return `#!/bin/sh\nexport HOME=${shellQuote(home)}\nexec /bin/sh "$@"\n`;
}

/**
 * The owner's account as AgentPier's own service user sees it, computed without
 * starting a login shell (which would run the owner's profile scripts):
 * - `home`: the account's home from the user database, not $HOME, which a service
 *   manager or the AgentPier environment may override;
 * - `pathPrepend`: the AgentPier service's PATH plus the standard package manager
 *   directories that exist, absolute and without duplicates.
 */
export function ownerShellEnvironment({
  env = process.env,
  userInfo = os.userInfo,
  exists = fs.existsSync,
} = {}) {
  const candidates = [
    ...String(env.PATH || "").split(path.delimiter),
    ...standardPathDirectories,
  ];
  const pathPrepend = [];
  for (const directory of candidates)
    if (
      path.isAbsolute(directory) &&
      !pathPrepend.includes(directory) &&
      exists(directory)
    )
      pathPrepend.push(directory);
  return { home: userInfo().homedir, pathPrepend };
}

/**
 * The owner's environment, or null with a logged diagnostic when the account
 * cannot be resolved (for example a uid without a passwd entry) or its home is not
 * absolute. The Gateway then starts without the wrapper: agents with shell run with
 * the Gateway's private HOME and PATH instead of failing the start.
 */
export function resolveShellOwner(compute = ownerShellEnvironment) {
  try {
    const owner = compute();
    if (typeof owner?.home !== "string" || !path.isAbsolute(owner.home))
      throw Error("the home directory is not an absolute path");
    return owner;
  } catch (error) {
    console.error(
      `AgentPier runs shell commands without the owner's environment: ${error?.message}`,
    );
    return null;
  }
}

/**
 * Writes the wrapper as `<assistant root>/exec-shell/sh`, read-only and executable
 * by the owner alone (0500) in a private folder, atomically replacing an earlier
 * one. Its name makes OpenClaw report the shell as "sh" in the system prompt, which
 * is what runs. The path is never listed in /etc/shells, so OpenClaw's own
 * login-shell probe keeps using /bin/sh with the Gateway's private HOME.
 */
export function writeExecShell(paths, home) {
  const target = path.join(privateFolder(path.join(paths.root, "exec-shell")), "sh");
  const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, execShellScript(home), { mode: 0o500, flag: "wx" });
    fs.chmodSync(temporary, 0o500);
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}
