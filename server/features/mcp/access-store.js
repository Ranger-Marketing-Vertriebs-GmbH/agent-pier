import { privateDatabase } from "../../lib/private-database.js";
import { TooManyRequestsError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const limits = {
  client: 1000,
  pending: 1000,
  grant: 2000,
  code: 4000,
  access: 20000,
  refresh: 20000,
};

export function createAccessStore(directory, now) {
  const db = privateDatabase(directory, "access.sqlite");
  db.exec(`CREATE TABLE IF NOT EXISTS records (
    kind TEXT NOT NULL, id TEXT NOT NULL, expires INTEGER NOT NULL,
    value TEXT NOT NULL, PRIMARY KEY(kind,id));
    CREATE INDEX IF NOT EXISTS records_expiry ON records(expires);`);
  const get = db.prepare("SELECT value FROM records WHERE kind=? AND id=?");
  const put = db.prepare(
    "INSERT INTO records(kind,id,expires,value) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET expires=excluded.expires,value=excluded.value",
  );
  const remove = db.prepare("DELETE FROM records WHERE kind=? AND id=?");
  const count = db.prepare("SELECT count(*) AS count FROM records WHERE kind=?");
  const prune = db.prepare("DELETE FROM records WHERE expires < ?");
  return {
    get(kind, id) {
      const row = get.get(kind, id);
      return row ? JSON.parse(row.value) : null;
    },
    put(kind, id, value) {
      prune.run(now());
      if (!get.get(kind, id) && count.get(kind).count >= limits[kind])
        throw new TooManyRequestsError(
          "Authorization capacity reached. Try again later.",
        );
      put.run(kind, id, value.expiresAt, JSON.stringify(value));
    },
    remove(kind, id) {
      remove.run(kind, id);
    },
    list(kind) {
      return db
        .prepare("SELECT value FROM records WHERE kind=? ORDER BY rowid DESC")
        .all(kind)
        .map((row) => JSON.parse(row.value));
    },
    transaction(action) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = action();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}
