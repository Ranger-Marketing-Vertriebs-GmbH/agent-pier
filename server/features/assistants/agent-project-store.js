/**
 * Which projects an agent created itself (agentpier_project): one row per project and
 * agent. The agent may switch coding sessions only for these; the projects stay the
 * owner's, and the rows go with the agent (agent-deletion.js agentTables).
 */
export class AgentProjectStore {
  constructor(db) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS agent_created_projects(project_id TEXT NOT NULL, assistant_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id, assistant_id))",
    );
  }
  add({ projectId, assistantId, createdAt }) {
    this.db
      .prepare(
        "INSERT INTO agent_created_projects(project_id,assistant_id,created_at) VALUES(?,?,?)",
      )
      .run(projectId, assistantId, createdAt);
  }
  /** The agent's created projects, oldest first. */
  list(assistantId) {
    return this.db
      .prepare(
        "SELECT project_id AS projectId, created_at AS createdAt FROM agent_created_projects WHERE assistant_id=? ORDER BY created_at, project_id",
      )
      .all(assistantId)
      .map((row) => ({ projectId: row.projectId, createdAt: row.createdAt }));
  }
  createdBy(assistantId, projectId) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM agent_created_projects WHERE assistant_id=? AND project_id=?",
      )
      .get(assistantId, projectId);
  }
  /** When the agent created its projects, in ms, for the daily limit. */
  times(assistantId) {
    return this.list(assistantId).map((row) => Date.parse(row.createdAt));
  }
}
