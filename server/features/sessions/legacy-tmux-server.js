import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { tmuxServerGone } from "./tmux-server-identity.js";
import {
  ALL_PANES,
  SESSION_NAMES,
  sessionIdFromName,
  sessionsWithLivePanes,
} from "./tmux-naming.js";
import { diagnostic, scanSessionNames } from "./session-names.js";

// A tmux server started by a release from before the rename runs on the legacy socket
// (see tmux-naming.js). AgentPier keeps using it while one of its sessions runs there
// and reports those sessions so the owner can stop them. Once only finished AgentPier
// sessions remain, it records their exits, ends that server and moves to the produced
// socket: one server at all times, and no legacy server left for a rollback to pick.
// A live pane or any session that is not AgentPier's keeps the legacy server.

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

/** Every readable stored session by id; an unreadable record is skipped with a trace. */
async function storedSessions(manager) {
  const stored = new Map();
  for (const file of await readdir(manager.directory)) {
    const id = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})\.json$/.exec(file)?.[1];
    if (!id) continue;
    try {
      const session = await manager.metadata(id);
      if (session && typeof session === "object") stored.set(id, session);
    } catch (error) {
      // Removed meanwhile, or one corrupt record: it counts as no AgentPier session.
      if (error.status !== 404) diagnostic("could not read a stored session", error);
    }
  }
  return stored;
}

/**
 * The legacy server's sessions, split into AgentPier's (a session name with a stored
 * record: id -> live) and every other one; null when not on it, and an empty result
 * when no server runs there.
 */
async function legacyServerSessions(manager) {
  if (!onLegacyServer(manager)) return null;
  let names;
  try {
    names = String(await manager.tmux(SESSION_NAMES))
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean);
  } catch (error) {
    if (tmuxServerGone(error.message)) return { gone: true, ours: new Map(), other: 0 };
    throw error;
  }
  // Any live pane keeps a session live, not just its active one. list-panes -a fails
  // on a server without sessions, so it is asked only when there are some.
  const live = names.length
    ? sessionsWithLivePanes(await manager.tmux(ALL_PANES))
    : new Set();
  const stored = await storedSessions(manager);
  const ours = new Map();
  let other = 0;
  for (const name of names) {
    const id = sessionIdFromName(name);
    if (!id || !stored.has(id)) other++;
    // Either name form of one id: a live pane under either keeps it live.
    else
      ours.set(id, {
        live: live.has(name) || !!ours.get(id)?.live,
        session: stored.get(id),
      });
  }
  return { gone: false, ours, other, stored };
}

/**
 * Ends the legacy server once it runs no live AgentPier pane and nothing else, and
 * moves to the produced socket. Call it only where no session can start meanwhile:
 * at startup and inside the exclusive creation lock right before a session starts.
 * Anything that cannot be confirmed keeps the legacy server.
 */
export async function leaveDrainedLegacyServer(manager) {
  let found;
  try {
    found = await legacyServerSessions(manager);
  } catch (error) {
    diagnostic("could not check the old tmux server", error);
    return;
  }
  if (!found || [...found.ours.values()].some((entry) => entry.live)) return;
  if (!found.gone) {
    // Record every exit while this server can still be read: a session still marked
    // running would otherwise count as lost with its server. Dead panes keep their
    // last screen this way.
    for (const session of found.stored.values()) {
      if (session.status !== "running") continue;
      try {
        await manager.current(session.id);
      } catch (error) {
        // An unrecorded state could later read as a lost server: keep this one.
        if (error.status !== 404) {
          diagnostic("could not read a session before ending the old tmux server", error);
          return;
        }
      }
    }
    if (found.other) {
      console.error(
        `AgentPier keeps the old tmux server: ${found.other} session(s) there are not AgentPier's.`,
      );
      return;
    }
  }
  try {
    await privateDirectory(path.dirname(manager.tmuxSockets.produced));
  } catch (error) {
    diagnostic("could not prepare the new tmux socket folder", error);
    return;
  }
  if (!found.gone) {
    try {
      // Only the legacy socket: socketPath is still the legacy one here.
      await manager.tmux(["kill-server"]);
    } catch (error) {
      if (!tmuxServerGone(error.message)) {
        diagnostic("could not end the old tmux server", error);
        return;
      }
    }
  }
  manager.socketPath = manager.tmuxSockets.produced;
  manager.alternateSessions.clear();
  await scanSessionNames(manager);
}

/** The AgentPier sessions with a live pane on the legacy server, by id and name. */
export async function legacyTmuxSessions(manager, limit = 200) {
  const found = await legacyServerSessions(manager);
  if (!found) return [];
  return [...found.ours]
    .filter(([, entry]) => entry.live)
    .slice(0, limit)
    .map(([id, { session }]) => ({
      id,
      name: typeof session.name === "string" ? session.name : "",
    }));
}
