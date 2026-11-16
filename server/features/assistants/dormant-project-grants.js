import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Each query takes the project id as ?1; a table an older database lacks is skipped.
const checks = [
  [
    "assistant_access",
    `SELECT 1 FROM assistant_access WHERE
       EXISTS (SELECT 1 FROM json_each(body,'$.projectIds') WHERE value=?1)
       OR EXISTS (SELECT 1 FROM json_each(body,'$.sessionProjectIds') WHERE value=?1)
       OR EXISTS (SELECT 1 FROM json_each(body,'$.talkProjectIds') WHERE value=?1)
       OR EXISTS (SELECT 1 FROM json_each(body,'$.projectFiles') WHERE key=?1)
     LIMIT 1`,
  ],
  ["agent_created_projects", "SELECT 1 FROM agent_created_projects WHERE project_id=?1"],
  [
    "assistant_lead_shares",
    "SELECT 1 FROM assistant_lead_shares WHERE json_extract(body,'$.projectId')=?1",
  ],
  [
    "assistant_actions",
    `SELECT 1 FROM assistant_actions WHERE json_extract(body,'$.payload.projectId')=?1
       AND json_extract(body,'$.state') IN ('awaiting_approval','approved') LIMIT 1`,
  ],
];

/**
 * Whether the agents' database, read directly while the agent services are off,
 * still holds a grant, share, creation or unstarted approval naming one of
 * `projectIds`. No database: false. A database that cannot be read: true, since it
 * may hold one.
 */
export function dormantProjectGrants(dataDir, projectIds) {
  const file = path.join(dataDir, "assistants", "assistants.sqlite");
  if (!projectIds.length || !fs.existsSync(file)) return false;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    for (const [table, sql] of checks) {
      if (!tables.has(table)) continue;
      const query = db.prepare(sql);
      if (projectIds.some((id) => query.get(id))) return true;
    }
    return false;
  } catch {
    return true;
  } finally {
    db?.close();
  }
}
