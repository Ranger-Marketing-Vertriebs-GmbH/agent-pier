import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_TEXT_BYTES = 16 * 1024;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/;

function privateHome(home) {
  if (typeof home !== "string" || !path.isAbsolute(home))
    throw new Error("agentbus: invalid queue home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("agentbus: unsafe queue home");
  fs.chmodSync(home, 0o700);
}

function queueFile(home) {
  const file = path.join(home, "queue.sqlite");
  if (!fs.existsSync(file))
    fs.closeSync(
      fs.openSync(
        file,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          fs.constants.O_NOFOLLOW,
        0o600,
      ),
    );
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const stat = fs.lstatSync(file + suffix);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error("agentbus: unsafe queue database");
      fs.chmodSync(file + suffix, 0o600);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return file;
}

function validateMessage(message) {
  if (!message || typeof message !== "object") throw new Error("agentbus: invalid message");
  if (typeof message.id !== "string" || !idPattern.test(message.id))
    throw new Error("agentbus: invalid message id");
  if (!Number.isSafeInteger(message.ts) || message.ts < 0)
    throw new Error("agentbus: invalid message timestamp");
  if (!message.from || typeof message.from !== "object")
    throw new Error("agentbus: invalid message sender");
  if (typeof message.text !== "string" || Buffer.byteLength(message.text, "utf8") > MAX_TEXT_BYTES)
    throw new Error("agentbus: text überschreitet 16 KiB");
  if (typeof message.to !== "string" || !idPattern.test(message.to))
    throw new Error("agentbus: invalid message recipient");
}

function rowMessage(row) {
  const message = {
    id: row.id,
    ts: row.ts,
    from: {
      runtime: row.from_runtime,
      name: row.from_name,
      sessionId: row.from_session,
      cwd: row.from_cwd,
    },
    to: row.recipient,
    toName: row.to_name,
    text: row.text,
  };
  if (row.reply_to) message.replyTo = row.reply_to;
  if (row.status) message.status = row.status;
  return message;
}

function importLegacy(db, home) {
  const inbox = path.join(home, "inbox");
  try {
    const stat = fs.lstatSync(inbox);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("agentbus: symlinked legacy inbox is not supported");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO messages
      (id, ts, from_runtime, from_name, from_session, from_cwd, recipient, to_name, text, reply_to, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const recipient of fs.readdirSync(inbox)) {
    const recipientDir = path.join(inbox, recipient);
    const recipientStat = fs.lstatSync(recipientDir);
    if (!recipientStat.isDirectory() || recipientStat.isSymbolicLink())
      throw new Error("agentbus: symlinked legacy inbox is not supported");
    for (const [folder, status] of [
      ["pending", "pending"],
      ["done", "acked"],
    ]) {
      const directory = path.join(recipientDir, folder);
      let files;
      try {
        const directoryStat = fs.lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
          throw new Error("agentbus: symlinked legacy inbox is not supported");
        files = fs.readdirSync(directory);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      for (const file of files) {
        if (file.startsWith(".")) continue;
        try {
          const full = path.join(directory, file);
          const stat = fs.lstatSync(full);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const message = JSON.parse(fs.readFileSync(full, "utf8"));
          validateMessage(message);
          insert.run(
            message.id,
            message.ts,
            String(message.from.runtime || "unknown"),
            String(message.from.name || "unknown"),
            String(message.from.sessionId || "unknown"),
            String(message.from.cwd || "unknown"),
            message.to || recipient,
            String(message.toName || "unknown"),
            message.text,
            message.replyTo ? String(message.replyTo) : null,
            status,
            message.ts,
          );
        } catch {
          // Invalid legacy records remain in place for diagnostics.
        }
      }
    }
  }
}

export function openQueue(home) {
  privateHome(home);
  const file = queueFile(home);
  const db = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      from_runtime TEXT NOT NULL,
      from_name TEXT NOT NULL,
      from_session TEXT NOT NULL,
      from_cwd TEXT NOT NULL,
      recipient TEXT NOT NULL,
      to_name TEXT NOT NULL,
      text TEXT NOT NULL,
      reply_to TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'acked')),
      claim_owner TEXT,
      lease_until INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_recipient_status
      ON messages (recipient, status, ts, id);
  `);
  importLegacy(db, home);

  const reclaim = (now) =>
    db.prepare(
      "UPDATE messages SET status='pending', claim_owner=NULL, lease_until=NULL, updated_at=? WHERE status='claimed' AND lease_until<=?",
    ).run(now, now);

  return {
    enqueue(message) {
      validateMessage(message);
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO messages
            (id, ts, from_runtime, from_name, from_session, from_cwd, recipient, to_name, text, reply_to, status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          message.id,
          message.ts,
          String(message.from.runtime || "unknown"),
          String(message.from.name || "unknown"),
          String(message.from.sessionId || "unknown"),
          String(message.from.cwd || "unknown"),
          message.to,
          String(message.toName || "unknown"),
          message.text,
          message.replyTo ? String(message.replyTo) : null,
          Date.now(),
        );
      return result.changes === 1 ? "inserted" : "existing";
    },

    summary(recipient, now = Date.now()) {
      reclaim(now);
      const rows = db
        .prepare(
          "SELECT from_name, COUNT(*) AS count FROM messages WHERE recipient=? AND status <> 'acked' GROUP BY from_name ORDER BY from_name",
        )
        .all(recipient);
      return {
        count: rows.reduce((sum, row) => sum + Number(row.count), 0),
        senders: rows.map((row) => row.from_name),
      };
    },

    claim(recipient, owner, now = Date.now(), leaseMs = 30000) {
      if (typeof owner !== "string" || !owner) throw new Error("agentbus: invalid claim owner");
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(leaseMs) || leaseMs < 1)
        throw new Error("agentbus: invalid claim lease");
      db.exec("BEGIN IMMEDIATE");
      try {
        reclaim(now);
        const rows = db
          .prepare(
            "SELECT * FROM messages WHERE recipient=? AND status='pending' ORDER BY ts, id",
          )
          .all(recipient);
        const update = db.prepare(
          "UPDATE messages SET status='claimed', claim_owner=?, lease_until=?, attempts=attempts+1, updated_at=? WHERE id=? AND status='pending'",
        );
        const claimIds = [];
        for (const row of rows) {
          const result = update.run(owner, now + leaseMs, now, row.id);
          if (result.changes === 1) claimIds.push(row.id);
        }
        db.exec("COMMIT");
        return { rows: rows.filter((row) => claimIds.includes(row.id)).map(rowMessage), claimIds };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    ack(owner, ids) {
      if (!Array.isArray(ids) || !ids.length) return 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        const update = db.prepare(
          "UPDATE messages SET status='acked', claim_owner=NULL, lease_until=NULL, updated_at=? WHERE id=? AND status='claimed' AND claim_owner=?",
        );
        let count = 0;
        for (const id of new Set(ids)) count += Number(update.run(Date.now(), id, owner).changes);
        db.exec("COMMIT");
        return count;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    rows({ recipient, status, limit = 5000 } = {}) {
      const params = [];
      const where = [];
      if (recipient !== undefined) {
        where.push("recipient=?");
        params.push(recipient);
      }
      if (status !== undefined) {
        where.push("status=?");
        params.push(status);
      }
      params.push(limit);
      return db
        .prepare(
          `SELECT * FROM messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts DESC, id DESC LIMIT ?`,
        )
        .all(...params)
        .map(rowMessage);
    },

    close() {
      db.close();
    },
  };
}
