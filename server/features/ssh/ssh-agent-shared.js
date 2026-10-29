// Formats and helpers shared by the session SSH agent modules (ssh-session-agents.js,
// ssh-agent-socket.js, ssh-session-config.js, ssh-user-config*.js) and by the session
// record's `sshAgent` parser (sessions/session-ssh-agent-record.js).
import fs from "node:fs";
import path from "node:path";

// A session id that is a plain file name (R11).
export const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
// The 128-bit socket token of one agent (ssh-agent-socket.js newAgentToken).
export const tokenPattern = /^[0-9a-f]{32}$/;
// An agent generation (a UUID) and a catalog key id.
export const generationPattern = /^[0-9a-f-]{36}$/;
export const keyIdPattern = /^[0-9a-f-]{36}$/;
// A DNS-safe session alias of up to 40 characters.
export const aliasPattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const validSessionId = (id) => typeof id === "string" && sessionIdPattern.test(id);

/** An Error with a `code`; the message defaults to the code. */
export function codedError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

/** The real path of an existing file, or null. */
export function realPathOrNull(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/** Whether `real` is one of `roots` or lies below one. */
export function withinRoots(real, roots) {
  return roots.some((root) => real === root || real.startsWith(`${root}${path.sep}`));
}

/** An existing executable regular file whose real path is not inside any of `roots`. */
export function executableOutside(file, roots = []) {
  const real = realPathOrNull(file);
  if (!real || withinRoots(real, roots)) return false;
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The folders from `top` down to `folder`, both included, by path only (nothing is
 * read). Throws `unsafe()` unless `folder` lies strictly below `top`. Callers walk the
 * list without following links: the socket creates each one with privateFolder, folder
 * removal checks each one with lstat.
 */
export function foldersBetween(top, folder, unsafe) {
  const relative = path.relative(top, folder);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw unsafe();
  const chain = [top];
  for (const part of relative.split(path.sep)) chain.push(path.join(chain.at(-1), part));
  return chain;
}
