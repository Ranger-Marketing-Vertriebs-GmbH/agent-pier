import { createHash } from "node:crypto";
import path from "node:path";

// A tmux server outlives a service restart, so a rollback must reach whatever the newer
// release left running: release.json lists the session name forms a release understands
// in `tmuxNames`, and activation and rollback refuse a release whose manifest lacks the
// form this release produces.

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

/** The private tmux socket of a data directory. */
export function tmuxSocketPath(dataDir) {
  const hash = createHash("sha256")
    .update(path.resolve(dataDir))
    .digest("hex")
    .slice(0, 24);
  return `/tmp/agentpier-${process.getuid?.() ?? "user"}-${hash}/tmux.sock`;
}

/** Parses `#{session_name}|#{pane_dead}[|…]` lines; a missing flag counts as live. */
export function parseSessionLines(output) {
  return String(output)
    .split("\n")
    .map((line) => line.trim().split("|"))
    .filter(([name]) => name)
    .map(([name, dead, ...rest]) => ({ name, dead: dead === "1", rest }));
}
