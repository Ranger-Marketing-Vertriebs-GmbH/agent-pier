import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { storedRights } from "./agent-hook-rights.js";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** A new hook secret: shown once, only its SHA-256 hex is stored. */
export function newSecret() {
  const secret = `aph_${randomBytes(32).toString("base64url")}`;
  return { secret, hash: sha256(secret) };
}

/** Compares digests in constant time; a hook without a secret never matches. */
export function secretMatches(hash, supplied) {
  if (typeof hash !== "string" || typeof supplied !== "string") return false;
  const expected = Buffer.from(hash, "hex");
  const actual = Buffer.from(sha256(supplied), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// A hook as stored, its rights in the current shape (a hook saved before a right
// existed holds it switched off).
const parsed = (body) => {
  const hook = JSON.parse(body);
  return hook.rights ? { ...hook, rights: storedRights(hook.rights) } : hook;
};

export class HookStore {
  constructor(db) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS assistant_hooks (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, body TEXT NOT NULL)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS assistant_hooks_assistant ON assistant_hooks(assistant_id)",
    );
  }
  create(fields) {
    const hook = {
      ...fields,
      id: randomUUID(),
      revision: 1,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO assistant_hooks (id, assistant_id, body) VALUES (?,?,?)")
      .run(hook.id, hook.assistantId, JSON.stringify(hook));
    return hook;
  }
  get(id) {
    const row = this.db.prepare("SELECT body FROM assistant_hooks WHERE id=?").get(id);
    return row ? parsed(row.body) : null;
  }
  list(assistantId) {
    return this.db
      .prepare("SELECT body FROM assistant_hooks WHERE assistant_id=? ORDER BY rowid")
      .all(assistantId)
      .map((row) => parsed(row.body));
  }
  patch(id, fields, revision) {
    const current = this.get(id);
    if (!current) throw assistantProblem("invalid", 404);
    if (revision !== undefined && revision !== current.revision)
      throw assistantProblem("conflict", 409);
    const next = {
      ...current,
      ...fields,
      id: current.id,
      assistantId: current.assistantId,
      revision: current.revision + 1,
    };
    this.db
      .prepare("UPDATE assistant_hooks SET body=? WHERE id=?")
      .run(JSON.stringify(next), id);
    return next;
  }
  /** Sets bookkeeping fields without a new revision (no conflict for an open draft). */
  flag(id, fields) {
    const current = this.get(id);
    if (!current) return null;
    const next = { ...current, ...fields };
    this.db
      .prepare("UPDATE assistant_hooks SET body=? WHERE id=?")
      .run(JSON.stringify(next), id);
    return next;
  }
  remove(id) {
    this.db.prepare("DELETE FROM assistant_hooks WHERE id=?").run(id);
  }
}
