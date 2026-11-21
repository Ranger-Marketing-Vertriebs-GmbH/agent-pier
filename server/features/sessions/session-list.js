import { readdir, readFile } from "node:fs/promises";
import { readPaneSnapshot } from "./tmux-pane-state.js";

// Replacement preflight owns the exclusive lock; ordinary lists lock each session.
export async function listSessions(manager, read = (id) => manager.current(id)) {
  const names = (await readdir(manager.directory)).filter((name) =>
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.json$/.test(name),
  );
  const sessions = [];
  for (const name of names) {
    try {
      sessions.push(await read(name.slice(0, -5)));
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  return sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Lists every session with one shared tmux snapshot. Callers arriving while a list
 * runs share the single next list, which starts after their call, so each still sees
 * every change made before it asked. Each caller receives its own copy.
 */
export function getSessionList(manager) {
  manager.listings ||= new Set();
  if (!manager.nextListing) {
    const previous = manager.activeListing?.catch(() => {}) ?? Promise.resolve();
    const listing = previous
      .then(() => {
        manager.nextListing = null;
        manager.activeListing = listing;
        return Promise.all([manager.ready, manager.operations.barrier]);
      })
      .then(() => {
        // Read once the first stored session needs it: an empty list asks tmux nothing.
        let panes;
        return listSessions(manager, (id) =>
          manager.serial(
            async () => manager.current(id, await (panes ||= readPaneSnapshot(manager))),
            id,
          ),
        );
      })
      .finally(() => {
        if (manager.activeListing === listing) manager.activeListing = null;
        manager.listings.delete(listing);
      });
    manager.nextListing = listing;
    manager.listings.add(listing);
  }
  return manager.nextListing.then((sessions) => structuredClone(sessions));
}

export async function drainSessionLists(manager) {
  while (manager.listings?.size) await Promise.allSettled([...manager.listings]);
}

/**
 * Every stored session's ID and name, read from its metadata file only: no tmux, no
 * per-session lock and no wait for a running replacement. Unreadable files are skipped.
 */
export async function listSessionNames(directory) {
  const names = (await readdir(directory)).filter((name) =>
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.json$/.test(name),
  );
  const sessions = [];
  for (const name of names) {
    try {
      const record = JSON.parse(await readFile(`${directory}/${name}`, "utf8"));
      if (typeof record?.name === "string")
        sessions.push({ id: name.slice(0, -5), name: record.name });
    } catch {
      // A file being rewritten or removed is simply not searchable this time.
    }
  }
  return sessions;
}
