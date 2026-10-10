import path from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { privateDatabase } from "../../lib/private-database.js";
import { fencedDatabase } from "../assistants/ledger-fence.js";
import { destroyBackupKeys } from "../assistants/backup-credentials.js";
import { assistantProblem, textValue } from "../assistants/assistant-validation.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const strangerQuietMs = 86400000;
/**
 * The AgentPier address notices link back to: a plain http(s) origin without
 * credentials, path, query or fragment, or null for no links.
 */
export function appOrigin(value) {
  if (value === null) return null;
  let url;
  try {
    if (typeof value !== "string" || value.length > 512) throw Error();
    url = new URL(value);
  } catch {
    throw assistantProblem("invalid");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw assistantProblem("invalid");
  return url.origin;
}
/** Language of the notices a channel writes: "de" (default) or "en". */
export function channelLanguage(value) {
  if (value === undefined) return "de";
  if (value !== "de" && value !== "en") throw assistantProblem("invalid");
  return value;
}
export class ChannelStore {
  constructor({ dataDir }) {
    this.root = path.join(dataDir, "assistants");
    this.db = fencedDatabase(
      privateDatabase(this.root, "channels.sqlite"),
      this.root,
      "channels.sqlite",
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY, bot_id TEXT UNIQUE NOT NULL, assistant_id TEXT UNIQUE NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_credentials(id TEXT PRIMARY KEY REFERENCES channels(id), token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_pairing(id TEXT PRIMARY KEY REFERENCES channels(id), digest TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_offsets(id TEXT PRIMARY KEY REFERENCES channels(id), offset INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_strangers(id TEXT NOT NULL REFERENCES channels(id), chat TEXT NOT NULL, notified INTEGER NOT NULL, PRIMARY KEY(id, chat));`);
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
  record(id) {
    const row = this.db.prepare("SELECT body FROM channels WHERE id=?").get(id);
    if (!row) throw assistantProblem("notFound", 404);
    return JSON.parse(row.body);
  }
  get(id) {
    const record = this.record(id);
    return {
      ...record,
      language: record.language || "de",
      hasSecret: !!this.secret(id),
      pairingExpiresAt:
        this.db.prepare("SELECT expires FROM channel_pairing WHERE id=?").get(id)
          ?.expires || null,
    };
  }
  list() {
    return this.db
      .prepare("SELECT id FROM channels ORDER BY rowid")
      .all()
      .map((row) => this.get(row.id));
  }
  secret(id) {
    return (
      this.db.prepare("SELECT token FROM channel_credentials WHERE id=?").get(id)
        ?.token || null
    );
  }
  create({
    assistantId,
    conversationId,
    botId,
    username,
    token,
    appUrl = null,
    language,
  }) {
    textValue(assistantId, 100);
    textValue(conversationId, 100);
    textValue(token, 256);
    if (
      !Number.isSafeInteger(botId) ||
      botId <= 0 ||
      !/^[a-zA-Z0-9_]{5,32}$/.test(username)
    )
      throw assistantProblem("invalid");
    if (
      this.db
        .prepare("SELECT id FROM channels WHERE bot_id=? OR assistant_id=?")
        .get(String(botId), assistantId)
    )
      throw assistantProblem("conflict", 409);
    const record = {
      id: randomUUID(),
      provider: "telegram",
      assistantId,
      conversationId,
      botId: String(botId),
      username,
      chatId: null,
      userId: null,
      appUrl: appOrigin(appUrl),
      language: channelLanguage(language),
      enabled: false,
      revision: 1,
      diagnostic: null,
    };
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO channels VALUES (?,?,?,?,?)")
        .run(record.id, record.botId, assistantId, 1, JSON.stringify(record));
      this.db
        .prepare("INSERT INTO channel_credentials VALUES (?,?)")
        .run(record.id, token);
      this.db.prepare("INSERT INTO channel_offsets VALUES (?,0)").run(record.id);
    });
    return this.get(record.id);
  }
  write(record, revision) {
    const next = { ...record, revision: revision + 1 };
    if (
      !this.db
        .prepare("UPDATE channels SET body=?,revision=? WHERE id=? AND revision=?")
        .run(JSON.stringify(next), next.revision, record.id, revision).changes
    )
      throw assistantProblem("conflict", 409);
    return this.get(record.id);
  }
  requireRevision(id, revision) {
    const current = this.record(id);
    if (!Number.isSafeInteger(revision) || revision !== current.revision)
      throw assistantProblem("conflict", 409);
    return current;
  }
  update(id, patch, revision) {
    const current = this.requireRevision(id, revision);
    const keys = Object.keys(patch || {});
    if (
      !keys.length ||
      keys.some((key) => !["enabled", "appUrl", "language"].includes(key)) ||
      ("enabled" in patch &&
        (typeof patch.enabled !== "boolean" ||
          (patch.enabled && (!current.chatId || !this.secret(id)))))
    )
      throw assistantProblem("invalid");
    const next = { ...current, ...patch };
    if ("appUrl" in patch) next.appUrl = appOrigin(patch.appUrl);
    if ("language" in patch)
      next.language = channelLanguage(patch.language === null ? "" : patch.language);
    // Changing only the address or language keeps a running pairing intact.
    if (!("enabled" in patch)) return this.write(next, revision);
    return this.transaction(() => {
      this.db.prepare("DELETE FROM channel_pairing WHERE id=?").run(id);
      return this.write({ ...next, diagnostic: null }, revision);
    });
  }
  rotate(id, token, revision) {
    const current = this.requireRevision(id, revision);
    textValue(token, 256);
    // Update backups must not keep a replaced bot token readable.
    destroyBackupKeys(this.root);
    return this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO channel_credentials VALUES (?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token",
        )
        .run(id, token);
      this.db.prepare("DELETE FROM channel_pairing WHERE id=?").run(id);
      return this.write({ ...current, diagnostic: null }, revision);
    });
  }
  disconnect(id, revision) {
    const current = this.requireRevision(id, revision);
    destroyBackupKeys(this.root);
    return this.transaction(() => {
      this.db.prepare("DELETE FROM channel_credentials WHERE id=?").run(id);
      this.db.prepare("DELETE FROM channel_pairing WHERE id=?").run(id);
      return this.write({ ...current, enabled: false, diagnostic: null }, revision);
    });
  }
  pairing(id, revision, appUrl, language) {
    const current = this.requireRevision(id, revision);
    if (!this.secret(id)) throw assistantProblem("invalid");
    const address = appUrl === undefined ? current.appUrl || null : appOrigin(appUrl);
    const lang =
      language === undefined ? current.language || "de" : channelLanguage(language);
    const code = randomBytes(24).toString("base64url"),
      expiresAt = Date.now() + 600000;
    this.transaction(() => {
      this.write(
        { ...current, appUrl: address, language: lang, enabled: false, diagnostic: null },
        revision,
      );
      this.db
        .prepare(
          "INSERT INTO channel_pairing VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,expires=excluded.expires",
        )
        .run(id, hash(code), expiresAt);
    });
    return {
      code,
      expiresAt,
      url: `https://t.me/${current.username}?start=${code}`,
      channel: this.get(id),
    };
  }
  acceptPair(id, message) {
    if (
      message?.chat?.type !== "private" ||
      message.from?.is_bot !== false ||
      !Number.isSafeInteger(message.chat.id) ||
      message.chat.id <= 0 ||
      message.from.id !== message.chat.id
    )
      return false;
    const code = /^\/(?:start|pair) ([a-zA-Z0-9_-]{32})$/.exec(message.text || "")?.[1];
    const pairing = this.db.prepare("SELECT * FROM channel_pairing WHERE id=?").get(id);
    if (
      !code ||
      !pairing ||
      pairing.expires < Date.now() ||
      hash(code) !== pairing.digest
    )
      return false;
    const current = this.record(id);
    if (current.enabled) return false;
    const hasInbox = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='channel_inbox'")
      .get();
    if (
      hasInbox &&
      this.db
        .prepare(
          "SELECT 1 FROM channel_inbox WHERE channel_id=? AND json_extract(body,'$.state') NOT IN ('delivered','failed','cancelled','reviewed') LIMIT 1",
        )
        .get(id)
    )
      return false;
    const hasOutbox = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='channel_outbox'")
      .get();
    if (
      hasOutbox &&
      this.db
        .prepare(
          "SELECT 1 FROM channel_outbox WHERE channel_id=? AND state NOT IN ('delivered','reviewed') LIMIT 1",
        )
        .get(id)
    )
      return false;
    this.transaction(() => {
      this.write(
        {
          ...current,
          chatId: String(message.chat.id),
          userId: String(message.from.id),
          enabled: true,
          diagnostic: null,
        },
        current.revision,
      );
      this.db.prepare("DELETE FROM channel_pairing WHERE id=?").run(id);
    });
    return true;
  }
  offset(id) {
    return (
      this.db.prepare("SELECT offset FROM channel_offsets WHERE id=?").get(id)?.offset ||
      0
    );
  }
  // Not monotonic: Telegram may restart update ids after a week without
  // updates, and the next offset must follow the batch it actually returned.
  advance(id, offset) {
    this.db.prepare("UPDATE channel_offsets SET offset=? WHERE id=?").run(offset, id);
  }
  diagnostic(id, diagnostic, pollAfter = 0) {
    const record = this.record(id);
    this.db
      .prepare("UPDATE channels SET body=? WHERE id=?")
      .run(JSON.stringify({ ...record, diagnostic, pollAfter }), id);
  }
  /**
   * Records that a stranger chat is told the bot is private. Returns false while
   * that chat was already told within the last day. Chats are stored hashed.
   */
  claimStrangerNotice(id, chatId, now) {
    const chat = hash(`${id}:${chatId}`);
    return this.transaction(() => {
      this.db
        .prepare("DELETE FROM channel_strangers WHERE notified<=?")
        .run(now - strangerQuietMs);
      return !!this.db
        .prepare("INSERT OR IGNORE INTO channel_strangers VALUES(?,?,?)")
        .run(id, chat, now).changes;
    });
  }
  // Diagnostic counters for messages ignored without reaching the model; they
  // do not change the revision the settings page edits against.
  countIgnored(id, kind) {
    const record = this.record(id);
    const ignoredMessages = { private: 0, group: 0, ...record.ignoredMessages };
    ignoredMessages[kind]++;
    this.db
      .prepare("UPDATE channels SET body=? WHERE id=?")
      .run(JSON.stringify({ ...record, ignoredMessages }), id);
  }
  halt(id, diagnostic) {
    const current = this.record(id);
    this.transaction(() => {
      this.db.prepare("DELETE FROM channel_pairing WHERE id=?").run(id);
      this.write({ ...current, enabled: false, diagnostic }, current.revision);
    });
  }
  close() {
    this.db.close();
  }
}
