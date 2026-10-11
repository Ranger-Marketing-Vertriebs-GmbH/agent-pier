import path from "node:path";
import { privateDatabase } from "../../lib/private-database.js";
import { assistantProblem } from "./assistant-validation.js";

const providers = ["duckduckgo", "perplexity", "brave"];
const keyPattern = /^[\x21-\x7e]{1,1024}$/;

/** The owner's choice of web search provider for agents; keys never leave this class. */
export class WebSearchSettings {
  constructor({ dataDir, connections }) {
    this.connections = connections;
    this.db = privateDatabase(path.join(dataDir, "assistants"), "web-search.sqlite");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, provider TEXT NOT NULL, connection_id TEXT); CREATE TABLE IF NOT EXISTS credentials(id INTEGER PRIMARY KEY CHECK(id=1), brave_key TEXT NOT NULL); INSERT OR IGNORE INTO settings VALUES (1,0,'duckduckgo',NULL);",
    );
  }
  braveKey() {
    return this.db.prepare("SELECT brave_key FROM credentials WHERE id=1").get()
      ?.brave_key;
  }
  perplexityKey(connectionId) {
    if (!connectionId) return undefined;
    try {
      const record = this.connections?.list().find((c) => c.id === connectionId);
      if (record?.providerId !== "openrouter") return undefined;
      return this.connections.secret(connectionId)?.apiKey || undefined;
    } catch {
      return undefined;
    }
  }
  keyFor(provider, connectionId) {
    if (provider === "brave") return this.braveKey();
    if (provider === "perplexity") return this.perplexityKey(connectionId);
    return undefined;
  }
  row() {
    return this.db.prepare("SELECT * FROM settings WHERE id=1").get();
  }
  get() {
    const row = this.row();
    const ready =
      row.provider === "duckduckgo" || !!this.keyFor(row.provider, row.connection_id);
    return {
      revision: row.revision,
      provider: row.provider,
      ...(row.connection_id ? { connectionId: row.connection_id } : {}),
      hasBraveKey: !!this.braveKey(),
      ready,
    };
  }
  /** The compiler's view; the only place a key leaves the store. */
  resolve() {
    const row = this.row();
    const key = this.keyFor(row.provider, row.connection_id);
    if (row.provider !== "duckduckgo" && !key)
      return { provider: row.provider, requiresPlugin: true, unavailable: true };
    return { provider: row.provider, ...(key ? { key } : {}), requiresPlugin: true };
  }
  save(input) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (k) => !["revision", "provider", "connectionId", "braveKey"].includes(k),
      )
    )
      throw assistantProblem("invalid");
    const { provider, connectionId, braveKey } = input;
    if (
      !providers.includes(provider) ||
      !Number.isInteger(input.revision) ||
      (connectionId !== undefined &&
        (typeof connectionId !== "string" ||
          !connectionId ||
          connectionId.length > 128)) ||
      (braveKey !== undefined &&
        braveKey !== null &&
        (typeof braveKey !== "string" || !keyPattern.test(braveKey)))
    )
      throw assistantProblem("invalid");
    if (input.revision !== this.row().revision) throw assistantProblem("conflict", 409);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (typeof braveKey === "string")
        this.db
          .prepare(
            "INSERT INTO credentials VALUES(1,?) ON CONFLICT(id) DO UPDATE SET brave_key=excluded.brave_key",
          )
          .run(braveKey);
      if (braveKey === null) this.db.prepare("DELETE FROM credentials WHERE id=1").run();
      const changed = this.db
        .prepare(
          "UPDATE settings SET revision=revision+1,provider=?,connection_id=? WHERE id=1 AND revision=?",
        )
        .run(
          provider,
          provider === "perplexity" ? (connectionId ?? null) : null,
          input.revision,
        );
      if (!changed.changes) throw assistantProblem("conflict", 409);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get();
  }
  close() {
    this.db.close();
  }
}
