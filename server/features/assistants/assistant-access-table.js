import { sshGrantMode } from "./agent-ssh-origin.js";

// The assistant_access table AssistantAccess keeps its policies in (assistant-access.js).

// A policy with every SSH grant in a current mode: the former "routines" (trusted
// including routines, owner A15) reads as "trusted"; anything else is left as it is.
function withCurrentModes(policy) {
  const grants = policy?.sshAccesses;
  if (!Array.isArray(grants) || !grants.some((g) => g?.mode === "routines"))
    return policy;
  return {
    ...policy,
    sshAccesses: grants.map((g) =>
      g?.mode === "routines" ? { ...g, mode: sshGrantMode(g.mode) } : g,
    ),
  };
}

/** One stored policy body, parsed, with its SSH grants in a current mode. */
export const accessBody = (text) => withCurrentModes(JSON.parse(text));

/**
 * Creates the table and rewrites stored "routines" grants as "trusted", keeping
 * every other field, the revision included. Idempotent: a row without such a grant
 * is never written.
 */
export function createAccessTable(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS assistant_access(assistant_id TEXT PRIMARY KEY REFERENCES assistants(id),body TEXT NOT NULL)",
  );
  const update = db.prepare("UPDATE assistant_access SET body=? WHERE assistant_id=?");
  for (const row of db
    .prepare("SELECT assistant_id, body FROM assistant_access WHERE body LIKE ?")
    .all('%"routines"%')) {
    let body;
    try {
      body = JSON.parse(row.body);
    } catch {
      continue;
    }
    const next = withCurrentModes(body);
    if (next !== body) update.run(JSON.stringify(next), row.assistant_id);
  }
}
