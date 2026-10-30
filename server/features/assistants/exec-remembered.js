import { createHash } from "node:crypto";

// "Always allow" for a command OpenClaw cannot allowlist safely (an interpreter, an
// inline script, shell syntax AgentPier cannot pin to programs, exec-allowlist-
// policy.js): until AGENTPIER-276 it was silently allowed once only, so the same
// command asked again every time. AgentPier now remembers exactly that command for
// the agent, by the SHA-256 of its full text: the identical command is allowed again
// without a card (exec-approvals.js), any other command, also the same program with
// other arguments, still asks. Nothing broader is allowed: no program-wide entry for
// an interpreter. The owner sees each remembered command among the agent's always
// allowed commands and can delete it (exec-allowlist.js).

const schema = `CREATE TABLE IF NOT EXISTS assistant_exec_commands(
  assistant_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(assistant_id, hash)
)`;
/** The hash a command is remembered by: its full text, exactly as requested. */
export const commandHash = (command) =>
  createHash("sha256").update(String(command)).digest("hex");
/** The allowlist entry id of a remembered command (`cmd-` and 32 hex digits). */
export const rememberedId = (hash) => `cmd-${hash.slice(0, 32)}`;
export const isRememberedId = (id) =>
  typeof id === "string" && /^cmd-[0-9a-f]{32}$/.test(id);

export class ExecRemembered {
  constructor(db, now = () => new Date().toISOString()) {
    this.db = db;
    this.now = now;
    db.exec(schema);
  }
  /** Remembers a command (`hash` from intake, `command` as shown); idempotent. */
  remember(assistantId, { hash, command, cwd = null }) {
    if (!/^[0-9a-f]{64}$/.test(hash || "") || typeof command !== "string") return false;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO assistant_exec_commands(assistant_id,hash,command,cwd,created_at) VALUES(?,?,?,?,?)",
      )
      .run(assistantId, hash, command, cwd, this.now());
    return true;
  }
  has(assistantId, hash) {
    return !!this.db
      .prepare("SELECT 1 FROM assistant_exec_commands WHERE assistant_id=? AND hash=?")
      .get(assistantId, hash);
  }
  /** The agent's remembered commands as allowlist entries (exec-allowlist.js present). */
  entries(assistantId) {
    return this.db
      .prepare(
        "SELECT hash, command, cwd, created_at FROM assistant_exec_commands WHERE assistant_id=? ORDER BY rowid",
      )
      .all(assistantId)
      .map((row) => ({
        id: rememberedId(row.hash),
        pattern: "",
        source: "agentpier",
        kind: "command",
        command: row.command,
        ...(row.cwd ? { cwd: row.cwd } : {}),
        requestedAt: row.created_at,
      }));
  }
  /** Forgets one remembered command by its entry id; whether it was there. */
  remove(assistantId, entryId) {
    if (!isRememberedId(entryId)) return false;
    return (
      this.db
        .prepare(
          "DELETE FROM assistant_exec_commands WHERE assistant_id=? AND substr(hash,1,32)=?",
        )
        .run(assistantId, entryId.slice(4)).changes > 0
    );
  }
}

const instances = new WeakMap();
/** The one store per database. */
export function rememberedCommands(db) {
  if (!instances.has(db)) instances.set(db, new ExecRemembered(db));
  return instances.get(db);
}
