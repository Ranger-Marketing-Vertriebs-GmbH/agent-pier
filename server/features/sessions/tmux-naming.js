import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// AgentPier was formerly called "tuiui", and its tmux sessions and socket still carry
// that name. The switch to "agentpier" runs in two releases so that an update and a
// rollback never lose a running session: this release still produces the legacy names
// and only learns to understand the new ones; a later release produces the new names
// and refuses rollbacks to releases that do not understand them (see release.json
// `tmuxNames`). A tmux server outlives a service restart, so both sides must keep
// reaching whatever the other one left running.

/** The name this release gives new sessions. */
export const SESSION_PREFIX = "tuiui-";
/** The name a later release gives them; understood here, never produced. */
export const ALTERNATE_SESSION_PREFIX = "agentpier-";
/** Every session name form this release understands, for the release manifest. */
export const TMUX_NAMES = Object.freeze(["tuiui", "agentpier"]);

const id = "[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}";
const sessionName = new RegExp(`^(?:agentpier|tuiui)-(${id})$`);

/** The session id behind either tmux session name form, else null. */
export function sessionIdFromName(name) {
  return sessionName.exec(String(name))?.[1] ?? null;
}

const isAlternateName = (name) => String(name).startsWith(ALTERNATE_SESSION_PREFIX);

function socketPath(prefix, dataDir) {
  const hash = createHash("sha256")
    .update(path.resolve(dataDir))
    .digest("hex")
    .slice(0, 24);
  return `/tmp/${prefix}-${process.getuid?.() ?? "user"}-${hash}/tmux.sock`;
}

/** `produced` is the socket this release starts; `alternate` is a later release's. */
export const tmuxSocketPaths = (dataDir) => ({
  produced: socketPath("tuiui", dataDir),
  alternate: socketPath("agentpier", dataDir),
});

/**
 * Whether a socket path can belong to one of our tmux servers: a real socket in a real
 * directory, both owned by this user. Anything else on these predictable /tmp paths is
 * never used, as a tmux client hands its environment to whatever listens there.
 */
export function ownedSocket(
  file,
  { lstat = fs.lstatSync, uid = process.getuid?.() } = {},
) {
  try {
    const directory = lstat(path.dirname(file));
    const socket = lstat(file);
    return (
      directory.isDirectory() &&
      socket.isSocket() &&
      (uid === undefined || (directory.uid === uid && socket.uid === uid))
    );
  } catch {
    return false;
  }
}

/**
 * All sessions of a data directory share one tmux server, so the socket is chosen once,
 * at startup. tmux unlinks its socket when its server exits, so an owned socket file
 * means a server that may still hold sessions. The produced socket wins; a later
 * release's socket is used only when it alone exists, i.e. after a rollback from that
 * release while its server still runs. Its sessions stay reachable until the server is
 * gone (reboot or kill-server). A stale file left by a crashed server is harmless, as
 * tmux replaces it with a fresh server on the same path.
 */
export function chooseTmuxSocket(dataDir, options) {
  const { produced, alternate } = tmuxSocketPaths(dataDir);
  if (ownedSocket(produced, options)) return produced;
  return ownedSocket(alternate, options) ? alternate : produced;
}

/**
 * Chooses the tmux session for each id from `{ name, dead }` entries. A live pane wins
 * over a dead one, so a dead session never shadows a live one under the other name;
 * between two of the same state the produced name wins. Returns id -> entry with
 * `alternate` set when the chosen session carries the other name.
 */
export function pickSessionNames(entries) {
  const chosen = new Map();
  for (const entry of entries) {
    const id = sessionIdFromName(entry.name);
    if (!id) continue;
    const candidate = { ...entry, id, alternate: isAlternateName(entry.name) };
    const known = chosen.get(id);
    if (
      !known ||
      (known.dead && !candidate.dead) ||
      (known.dead === candidate.dead && known.alternate && !candidate.alternate)
    )
      chosen.set(id, candidate);
  }
  return chosen;
}

/** Parses `#{session_name}|#{pane_dead}[|…]` lines; a missing flag counts as live. */
export function parseSessionLines(output) {
  return String(output)
    .split("\n")
    .map((line) => line.trim().split("|"))
    .filter(([name]) => name)
    .map(([name, dead, ...rest]) => ({ name, dead: dead === "1", rest }));
}
