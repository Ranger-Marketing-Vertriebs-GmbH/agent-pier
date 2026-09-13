export const terminalStates = [
  "completed",
  "partially_completed",
  "failed",
  "cancelled",
  "interrupted",
];
export const jobStates = [
  "queued",
  "running",
  "waiting_for_conflict",
  "cancelling",
  ...terminalStates,
];
export const retentionMs = 7 * 86400000;

export const fileSchema = `
CREATE TABLE IF NOT EXISTS jobs (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, scope_id TEXT NOT NULL, kind TEXT NOT NULL,
 status TEXT NOT NULL, operation TEXT NOT NULL, document TEXT NOT NULL,
 parent_job_id TEXT REFERENCES jobs(id), entry_id TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_scope ON jobs(scope_id,created_at,id);
CREATE TABLE IF NOT EXISTS requests (
 scope_id TEXT NOT NULL, request_id TEXT NOT NULL, body_hash TEXT NOT NULL,
 job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
 PRIMARY KEY(scope_id,request_id)
);
CREATE TABLE IF NOT EXISTS job_entries (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 id TEXT NOT NULL, document TEXT NOT NULL, UNIQUE(job_id,id)
);
CREATE TABLE IF NOT EXISTS publications (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), phase TEXT NOT NULL,
 document TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trash_entries (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), scope_id TEXT NOT NULL,
 document TEXT NOT NULL, deleted_at INTEGER NOT NULL
);
`;
