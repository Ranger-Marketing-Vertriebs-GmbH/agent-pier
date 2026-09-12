import { readdir } from "node:fs/promises";

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
