import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// AgentPier was formerly called "tuiui", and its tmux sessions and socket carried that
// name. The switch to "agentpier" runs in two releases so that an update and a rollback
// never lose a running session: the release before this one still produced the legacy
// names and learned to understand the new ones; this release produces the new names,
// still understands the legacy ones, and refuses rollbacks to releases that do not
// understand the new ones (see release.json `tmuxNames`). A tmux server outlives a
// service restart, so both sides must keep reaching whatever the other one left running.

/** The tmux name form this release produces; a rollback target must understand it. */
export const PRODUCED_TMUX_NAME = "agentpier";
/** The name this release gives new sessions. */
export const SESSION_PREFIX = `${PRODUCED_TMUX_NAME}-`;
/** The name earlier releases gave them; understood here, never produced. */
export const ALTERNATE_SESSION_PREFIX = "tuiui-";
/** Every session name form this release understands, for the release manifest. */
export const TMUX_NAMES = Object.freeze(["agentpier", "tuiui"]);

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

/** `produced` is the socket this release starts; `legacy` is the earlier releases'. */
export const tmuxSocketPaths = (dataDir) => ({
  produced: socketPath("agentpier", dataDir),
  legacy: socketPath("tuiui", dataDir),
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

/** `list-sessions -F` names a session; `list-panes -a -F` lists each of its panes. */
export const SESSION_NAMES = ["list-sessions", "-F", "#{session_name}"];
export const ALL_PANES = ["list-panes", "-a", "-F", "#{session_name}|#{pane_dead}"];

/**
 * The names of the sessions with at least one live pane, from `ALL_PANES` output. A
 * session's `#{pane_dead}` alone describes only its active pane: an agent may have
 * opened another window or split that still runs.
 */
export function sessionsWithLivePanes(output) {
  return new Set(
    parseSessionLines(output)
      .filter((pane) => !pane.dead)
      .map((pane) => pane.name),
  );
}

/**
 * Asks the tmux server on the socket for its sessions: `answers` when a server runs
 * there (tmux leaves its socket file behind when its server exits), `live` when an
 * AgentPier session has any live pane (`exit-empty off` keeps a server running without
 * sessions or with dead panes only). A client hands its environment to the server: give
 * it PATH only. A probe that times out counts as both: a dead socket refuses at once,
 * so only a live but slow server can stall, and its sessions must not be left behind.
 */
export function probeTmuxServer(socket, { tmuxPath = "tmux", spawn = spawnSync } = {}) {
  const run = (args) =>
    spawn(tmuxPath, ["-S", socket, ...args], {
      env: process.env.PATH ? { PATH: process.env.PATH } : {},
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
  const timedOut = (result) => result.error?.code === "ETIMEDOUT";
  const sessions = run(SESSION_NAMES);
  if (timedOut(sessions)) return { answers: true, live: true };
  if (sessions.status !== 0) return { answers: false, live: false };
  const ours = String(sessions.stdout).split("\n").filter(sessionIdFromName);
  // list-panes -a fails on a server without sessions; nothing can be live there.
  if (!ours.length) return { answers: true, live: false };
  const panes = run(ALL_PANES);
  if (timedOut(panes) || panes.status !== 0) return { answers: true, live: true };
  const live = sessionsWithLivePanes(panes.stdout);
  return { answers: true, live: ours.some((name) => live.has(name)) };
}

/**
 * All sessions of a data directory share one tmux server, chosen at startup. The
 * produced socket wins while its server runs a live AgentPier session (or does not
 * answer in time). Otherwise the legacy socket while a server answers there: the server
 * an earlier release started keeps running across the update with its sessions, new
 * sessions join it under the new name, and AgentPier ends it once only finished
 * AgentPier sessions remain (legacy-tmux-server.js). Otherwise the produced socket,
 * where tmux starts a fresh server even over a stale socket file.
 */
export function chooseTmuxSocket(dataDir, options = {}) {
  const { produced, legacy } = tmuxSocketPaths(dataDir);
  const probe = options.probe || probeTmuxServer;
  if (ownedSocket(produced, options) && probe(produced, options).live) return produced;
  return ownedSocket(legacy, options) && probe(legacy, options).answers
    ? legacy
    : produced;
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
