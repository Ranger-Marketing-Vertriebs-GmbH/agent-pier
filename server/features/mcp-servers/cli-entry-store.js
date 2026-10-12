const schema = `
CREATE TABLE IF NOT EXISTS cli_entries(
  server_id TEXT NOT NULL,
  cli TEXT NOT NULL CHECK(cli IN ('claude','codex','opencode')),
  name TEXT NOT NULL, hash TEXT, pending_hash TEXT, written_at INTEGER,
  PRIMARY KEY(server_id, cli));`;

const row = (r) => ({
  serverId: r.server_id,
  cli: r.cli,
  name: r.name,
  hash: r.hash,
  pendingHash: r.pending_hash,
  writtenAt: r.written_at,
});

/**
 * The native entries AgentPier wrote into the CLIs: name and hashes, never the entry.
 * A row outlives its server or binding until the reconciler removed the file entry.
 * `pending_hash` is a write recorded before it reached the file.
 */
export class CliEntryStore {
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
    db.exec(schema);
  }
  list(cli) {
    return this.db
      .prepare("SELECT * FROM cli_entries WHERE cli=? ORDER BY name, server_id")
      .all(cli)
      .map(row);
  }
  get(serverId, cli) {
    const found = this.db
      .prepare("SELECT * FROM cli_entries WHERE server_id=? AND cli=?")
      .get(serverId, cli);
    return found ? row(found) : null;
  }
  /** Records a write of `hash` under `name` before it happens; a new name drops the old hash. */
  intend(serverId, cli, name, hash) {
    this.db
      .prepare(
        `INSERT INTO cli_entries(server_id,cli,name,hash,pending_hash) VALUES (?,?,?,NULL,?)
         ON CONFLICT(server_id,cli) DO UPDATE SET
           hash=CASE WHEN name=excluded.name THEN hash ELSE NULL END,
           name=excluded.name, pending_hash=excluded.pending_hash`,
      )
      .run(serverId, cli, name, hash);
  }
  /** The file holds `hash` now. */
  settle(serverId, cli, hash) {
    this.db
      .prepare(
        "UPDATE cli_entries SET hash=?, pending_hash=NULL, written_at=? WHERE server_id=? AND cli=?",
      )
      .run(hash, this.now(), serverId, cli);
  }
  forget(serverId, cli) {
    this.db
      .prepare("DELETE FROM cli_entries WHERE server_id=? AND cli=?")
      .run(serverId, cli);
  }
}
