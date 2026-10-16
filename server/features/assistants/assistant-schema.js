export function migrateAssistants(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistants (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL REFERENCES assistants(id), session_key TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), client_key TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(conversation_id,client_key));
    CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), runtime_run_id TEXT, state TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attempt_reviews (attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), reviewed_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS attempts_request ON attempts(request_id);
    CREATE TABLE IF NOT EXISTS messages (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_attachments (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), request_id TEXT, position INTEGER, body TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS agent_attachments_conversation ON agent_attachments(conversation_id, request_id);
    CREATE TABLE IF NOT EXISTS queued_messages (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), client_key TEXT NOT NULL, text TEXT NOT NULL, team_allowed INTEGER NOT NULL, attachments TEXT NOT NULL, state TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS openclaw_overrides (path TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL);
  `);
}
