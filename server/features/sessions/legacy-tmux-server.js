import { chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmuxServerGone } from "./tmux-server-identity.js";
import { parseSessionLines, pickSessionNames } from "./tmux-naming.js";
import { scanSessionNames } from "./session-names.js";

// A tmux server started by a release from before the rename runs on the legacy socket
// (see tmux-naming.js). AgentPier keeps using it while it runs a live session and
// reports those sessions so the owner can stop them; once none is left, the next
// session starts on the produced socket and AgentPier stays there. The legacy server
// itself is never killed: dead panes and other sessions on it stay untouched.

/** Creates a private directory owned by this user, or refuses an unsafe one. */
export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()))
    throw new Error("Unsafe terminal storage directory");
  await chmod(directory, 0o700);
}

const onLegacyServer = (manager) =>
  !!manager?.tmuxSockets && manager.socketPath === manager.tmuxSockets.legacy;

/** The AgentPier sessions on the legacy server as id -> entry; empty when not on it. */
async function legacySessions(manager) {
  if (!onLegacyServer(manager)) return new Map();
  try {
    return pickSessionNames(
      parseSessionLines(
        await manager.tmux(["list-sessions", "-F", "#{session_name}|#{pane_dead}"]),
      ),
    );
  } catch (error) {
    if (tmuxServerGone(error.message)) return new Map();
    throw error;
  }
}

/** Ids of the sessions with a live pane on the legacy server; [] when not on it. */
async function legacySessionIds(manager) {
  return [...(await legacySessions(manager))]
    .filter(([, entry]) => !entry.dead)
    .map(([id]) => id);
}

/**
 * Moves to the produced socket once the legacy server runs no live session. Call it
 * inside the exclusive creation lock, right before a session starts, so no session can
 * start on the legacy server between the check and the move. A failing check stays.
 */
export async function leaveDrainedLegacyServer(manager) {
  if (!onLegacyServer(manager)) return;
  const sessions = await legacySessions(manager).catch(() => null);
  if (!sessions || [...sessions.values()].some((entry) => !entry.dead)) return;
  // Record an exit not seen yet while its dead pane can still be read; the dead panes
  // themselves stay on the legacy server.
  for (const id of sessions.keys()) await manager.current(id).catch(() => {});
  await privateDirectory(path.dirname(manager.tmuxSockets.produced));
  manager.socketPath = manager.tmuxSockets.produced;
  // After a rollback the produced server may hold sessions under the legacy name.
  manager.alternateSessions.clear();
  await scanSessionNames(manager);
}

/** The sessions on the legacy server, by id and stored name ("" when unknown). */
export async function legacyTmuxSessions(manager, limit = 200) {
  const ids = (await legacySessionIds(manager)).slice(0, limit);
  const sessions = [];
  for (const id of ids) {
    let name = "";
    try {
      const session = await manager.metadata(id);
      if (typeof session.name === "string") name = session.name;
    } catch {
      // A session without a stored record still holds the server; it keeps its id.
    }
    sessions.push({ id, name });
  }
  return sessions;
}
