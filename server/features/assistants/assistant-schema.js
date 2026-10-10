export function migrateAssistants(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistants (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL REFERENCES assistants(id), session_key TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), client_key TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(conversation_id,client_key));
    CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), runtime_run_id TEXT, state TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attempt_reviews (attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), reviewed_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS attempts_request ON attempts(request_id);
    CREATE TABLE IF NOT EXISTS messages (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), body TEXT NOT NULL);
  `);
}
