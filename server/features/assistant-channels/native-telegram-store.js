import { destroyBackupKeys } from "../assistants/backup-credentials.js";
import { assistantProblem, textValue } from "../assistants/assistant-validation.js";

export const maxPeople = 50;
const telegramUserId = /^[1-9]\d{0,19}$/;

/**
 * The people an agent's own bot admits: `[{ id, name }]` with numeric Telegram user
 * ids (unique) and a display name the owner chose. Throws on anything else.
 */
export function validPeople(value) {
  if (!Array.isArray(value) || value.length > maxPeople)
    throw assistantProblem("invalid");
  const seen = new Set();
  return value.map((person) => {
    if (
      !person ||
      typeof person !== "object" ||
      Array.isArray(person) ||
      Object.keys(person).some((k) => !["id", "name"].includes(k)) ||
      typeof person.id !== "string" ||
      !telegramUserId.test(person.id) ||
      seen.has(person.id)
    )
      throw assistantProblem("invalid");
    seen.add(person.id);
    return { id: person.id, name: textValue(person.name, 100).trim() };
  });
}

/**
 * The agents' own Telegram bots (one per agent), in the channel database next to the
 * owner's AgentPier bots: one bot id can serve only one of them. Tokens live in their
 * own table, which update backups seal (backup-credentials.js); replacing or removing
 * a token destroys every backup key first.
 */
export class NativeTelegramStore {
  constructor({ db, root }) {
    Object.assign(this, { db, root });
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS native_telegram(assistant_id TEXT PRIMARY KEY, bot_id TEXT UNIQUE NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_telegram_credentials(assistant_id TEXT PRIMARY KEY REFERENCES native_telegram(assistant_id), token TEXT NOT NULL);`);
  }
  transaction(operation) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** The stored bot of an agent without its token, or null. */
  get(assistantId) {
    const row = this.db
      .prepare("SELECT body FROM native_telegram WHERE assistant_id=?")
      .get(assistantId);
    return row ? JSON.parse(row.body) : null;
  }
  list() {
    return this.db
      .prepare("SELECT body FROM native_telegram ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(row.body));
  }
  /** What a Gateway start compiles: every bot with its token and allowed ids. */
  compiled() {
    return this.db
      .prepare(
        "SELECT n.body, c.token FROM native_telegram n JOIN native_telegram_credentials c USING(assistant_id) ORDER BY n.rowid",
      )
      .all()
      .map((row) => {
        const record = JSON.parse(row.body);
        return {
          assistantId: record.assistantId,
          botId: record.botId,
          token: row.token,
          // Tells a replaced token without reading it (telegram-senders.js).
          tokenRevision: record.tokenRevision ?? 1,
          people: record.people.map((person) => person.id),
        };
      });
  }
  /** Whether one of the agents' own bots uses this Telegram bot id. */
  usesBot(botId) {
    return !!this.db
      .prepare("SELECT 1 FROM native_telegram WHERE bot_id=?")
      .get(String(botId));
  }
  /** Whether the owner's AgentPier bot uses this Telegram bot id. */
  agentPierBot(botId) {
    return !!this.db.prepare("SELECT 1 FROM channels WHERE bot_id=?").get(String(botId));
  }
  // A bot serves one purpose: never the owner's AgentPier bot, never two agents.
  requireFree(botId, assistantId) {
    const other = this.db
      .prepare("SELECT assistant_id FROM native_telegram WHERE bot_id=?")
      .get(String(botId));
    if (this.agentPierBot(botId) || (other && other.assistant_id !== assistantId))
      throw assistantProblem("telegramBotInUse", 409);
  }
  requireRevision(assistantId, revision) {
    const current = this.get(assistantId);
    if (!current) throw assistantProblem("notFound", 404);
    if (!Number.isSafeInteger(revision) || revision !== current.revision)
      throw assistantProblem("conflict", 409);
    return current;
  }
  /**
   * Stores a new bot (`revision` null) or replaces an agent's bot or its people.
   * `identity` ({ id, username, token }) is the verified bot, when its token changes.
   */
  save(assistantId, { identity, people }, revision) {
    textValue(assistantId, 100);
    const current =
      revision === null ? null : this.requireRevision(assistantId, revision);
    if (revision === null && this.get(assistantId))
      throw assistantProblem("conflict", 409);
    if (!current && !identity) throw assistantProblem("invalid");
    if (identity) {
      if (
        !Number.isSafeInteger(identity.id) ||
        identity.id <= 0 ||
        !/^[a-zA-Z0-9_]{5,32}$/.test(identity.username)
      )
        throw assistantProblem("invalid");
      textValue(identity.token, 256);
      // Update backups must not keep a replaced bot token readable.
      if (current) destroyBackupKeys(this.root);
    }
    const next = {
      assistantId,
      botId: identity ? String(identity.id) : current.botId,
      username: identity ? identity.username : current.username,
      tokenRevision: identity
        ? (current?.tokenRevision ?? 0) + 1
        : (current.tokenRevision ?? 1),
      people: people === undefined ? current?.people || [] : validPeople(people),
      revision: (current?.revision || 0) + 1,
    };
    return this.transaction(() => {
      // Inside the write lock, so a concurrent AgentPier bot setup cannot slip in.
      if (identity) this.requireFree(identity.id, assistantId);
      if (current) {
        const changed = this.db
          .prepare(
            "UPDATE native_telegram SET bot_id=?, revision=?, body=? WHERE assistant_id=? AND revision=?",
          )
          .run(next.botId, next.revision, JSON.stringify(next), assistantId, revision);
        if (!changed.changes) throw assistantProblem("conflict", 409);
      } else
        this.db
          .prepare("INSERT INTO native_telegram VALUES (?,?,?,?)")
          .run(assistantId, next.botId, next.revision, JSON.stringify(next));
      if (identity)
        this.db
          .prepare(
            "INSERT INTO native_telegram_credentials VALUES (?,?) ON CONFLICT(assistant_id) DO UPDATE SET token=excluded.token",
          )
          .run(assistantId, identity.token);
      return next;
    });
  }
  /** Removes an agent's bot and its token. */
  remove(assistantId, revision) {
    this.requireRevision(assistantId, revision);
    destroyBackupKeys(this.root);
    this.transaction(() => {
      this.db
        .prepare("DELETE FROM native_telegram_credentials WHERE assistant_id=?")
        .run(assistantId);
      this.db
        .prepare("DELETE FROM native_telegram WHERE assistant_id=?")
        .run(assistantId);
    });
  }
}
