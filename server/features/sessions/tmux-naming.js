import { createHash } from "node:crypto";
import path from "node:path";

/** The tmux name form this release produces; a rollback target must understand it. */
export const PRODUCED_TMUX_NAME = "agentpier";
/** The name this release gives new sessions. */
export const SESSION_PREFIX = `${PRODUCED_TMUX_NAME}-`;
/** Every session name form this release understands, for the release manifest. */
export const TMUX_NAMES = Object.freeze([PRODUCED_TMUX_NAME]);

const id = "[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}";
const sessionName = new RegExp(`^${SESSION_PREFIX}(${id})$`);

/** The session id behind a tmux session name, else null. */
export function sessionIdFromName(name) {
  return sessionName.exec(String(name))?.[1] ?? null;
}

/**
 * All sessions of a data directory share one tmux server on a private socket, derived
 * from the data directory so separate installations and test runs never meet.
 */
export function tmuxSocketPath(dataDir) {
  const hash = createHash("sha256")
    .update(path.resolve(dataDir))
    .digest("hex")
    .slice(0, 24);
  return `/tmp/${PRODUCED_TMUX_NAME}-${process.getuid?.() ?? "user"}-${hash}/tmux.sock`;
}

/**
 * Chooses one pane per session id from `{ name, dead }` entries (`list-panes -a`
 * lists every window and split): a live pane wins over a dead one. Returns id -> entry.
 */
export function pickSessionPanes(entries) {
  const chosen = new Map();
  for (const entry of entries) {
    const id = sessionIdFromName(entry.name);
    if (!id) continue;
    const known = chosen.get(id);
    if (!known || (known.dead && !entry.dead)) chosen.set(id, { ...entry, id });
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
