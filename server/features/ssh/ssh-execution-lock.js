import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pidStart, psField } from "../../../vendor/agentbus/core/proc.js";
import { problem } from "../../lib/storage.js";
const busy = () => problem("An SSH command is already running for this session.", 429);
const alive = (pid, start) =>
  Number.isInteger(pid) &&
  pid > 1 &&
  typeof start === "string" &&
  pidStart(pid) === start &&
  !psField(pid, "stat")?.startsWith("Z");

// SQLite serializes owner replacement. Never unlink a stale lock: another MCP
// process may already have acquired its replacement between a check and unlink.
export async function acquireExecutionLock(file) {
  let db,
    transaction = false;
  const token = randomUUID();
  try {
    const fd = fs.openSync(file, "a", 0o600);
    fs.closeSync(fd);
    db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout=1000");
    db.exec(
      "CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, pid INTEGER, start TEXT, child_pid INTEGER, child_start TEXT)",
    );
    db.exec("BEGIN IMMEDIATE");
    transaction = true;
    const previous = db.prepare("SELECT * FROM owner WHERE id=1").get();
    if (previous && alive(previous.pid, previous.start)) throw busy();
    if (previous && alive(previous.child_pid, previous.child_start)) {
      process.kill(previous.child_pid, "SIGKILL");
      for (let attempt = 0; alive(previous.child_pid, previous.child_start); attempt++) {
        if (attempt >= 50) throw busy();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const started = pidStart(process.pid);
    if (!started) throw busy();
    db.prepare("INSERT OR REPLACE INTO owner VALUES (1,?,?,?,?,?)").run(
      token,
      process.pid,
      started,
      null,
      null,
    );
    db.exec("COMMIT");
    transaction = false;
    return {
      child(pid) {
        db.prepare("UPDATE owner SET child_pid=?, child_start=? WHERE token=?").run(
          pid,
          pidStart(pid),
          token,
        );
      },
      release() {
        try {
          db.prepare("DELETE FROM owner WHERE token=?").run(token);
        } finally {
          db.close();
        }
      },
    };
  } catch {
    if (transaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* Connection failed. */
      }
    }
    db?.close();
    throw busy();
  }
}
