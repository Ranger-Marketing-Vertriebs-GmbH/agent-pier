import { readdir } from "node:fs/promises";

// The caller owns the session-manager lock, including during replacement preflight.
export async function listSessions(manager) {
  const names = (await readdir(manager.directory)).filter((name) =>
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.json$/.test(name),
  );
  const sessions = [];
  for (const name of names) sessions.push(await manager.current(name.slice(0, -5)));
  return sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
