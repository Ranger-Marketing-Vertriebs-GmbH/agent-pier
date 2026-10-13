import { readdir, readFile } from "node:fs/promises";

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

export function getSessionList(manager) {
  manager.listings ||= new Set();
  const listing = Promise.all([manager.ready, manager.operations.barrier])
    .then(() => listSessions(manager, (id) => manager.get(id)))
    .finally(() => {
      manager.listings.delete(listing);
    });
  manager.listings.add(listing);
  return listing;
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
