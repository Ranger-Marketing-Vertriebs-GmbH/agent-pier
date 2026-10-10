export function migrateTeams(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_team_records (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent_id TEXT,
    operation_key TEXT UNIQUE, phase TEXT, revision INTEGER NOT NULL, body TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS assistant_teams_parent ON assistant_team_records(parent_id,kind);`);
}
