import path from "node:path";
import { privateDatabase } from "../../lib/private-database.js";
import { assistantProblem } from "../assistants/assistant-validation.js";
export class SpeechConnections {
  constructor({ dataDir }) {
    this.db = privateDatabase(path.join(dataDir, "speech"), "connections.sqlite");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, model TEXT NOT NULL, language TEXT NOT NULL); CREATE TABLE IF NOT EXISTS credentials(id INTEGER PRIMARY KEY CHECK(id=1), api_key TEXT NOT NULL); INSERT OR IGNORE INTO settings(id,revision,model,language) VALUES (1,0,'nova-3','auto'); CREATE TABLE IF NOT EXISTS key_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL); INSERT OR IGNORE INTO key_state VALUES (1,0);",
    );
    // Whether a finished dictation sends its message right away (dictation-service.js).
    // A table of its own keeps `settings` in the shape older builds still insert into.
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS dictation(id INTEGER PRIMARY KEY CHECK(id=1), send INTEGER NOT NULL); INSERT OR IGNORE INTO dictation VALUES (1,0);",
    );
    this.leases = 0;
  }
  get() {
    const { revision, model, language } = this.db
      .prepare("SELECT * FROM settings WHERE id=1")
      .get();
    const { send } = this.db.prepare("SELECT send FROM dictation WHERE id=1").get();
    return {
      id: "deepgram",
      provider: "deepgram",
      revision,
      model,
      language,
      dictationSend: send === 1,
      hasSecret: !!this.db.prepare("SELECT 1 FROM credentials WHERE id=1").get(),
    };
  }
  save(input) {
    if (this.leases) throw assistantProblem("active", 409);
    const current = this.get();
    if (
      !input ||
      Object.keys(input).some(
        (k) =>
          ![
            "apiKey",
            "removeApiKey",
            "model",
            "language",
            "dictationSend",
            "revision",
          ].includes(k),
      )
    )
      throw assistantProblem("invalid");
    if (input.revision !== current.revision) throw assistantProblem("conflict", 409);
    const { apiKey, removeApiKey } = input,
      model = input.model ?? current.model,
      language = input.language ?? current.language,
      dictationSend = input.dictationSend ?? current.dictationSend;
    if (
      !/^[a-zA-Z0-9._-]{1,64}$/.test(model) ||
      !/^(auto|[a-z]{2}(?:-[A-Z]{2})?)$/.test(language) ||
      (apiKey !== undefined &&
        (typeof apiKey !== "string" ||
          !apiKey.length ||
          apiKey.length > 1024 ||
          /[^\x21-\x7e]/.test(apiKey))) ||
      (removeApiKey !== undefined && typeof removeApiKey !== "boolean") ||
      typeof dictationSend !== "boolean" ||
      (removeApiKey && apiKey)
    )
      throw assistantProblem("invalid");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (apiKey)
        this.db
          .prepare(
            "INSERT INTO credentials VALUES(1,?) ON CONFLICT(id) DO UPDATE SET api_key=excluded.api_key",
          )
          .run(apiKey);
      if (removeApiKey) this.db.prepare("DELETE FROM credentials WHERE id=1").run();
      // Counts key changes, so a changed key is told without reading the key.
      if (apiKey || removeApiKey)
        this.db.prepare("UPDATE key_state SET revision=revision+1 WHERE id=1").run();
      const changed = this.db
        .prepare(
          "UPDATE settings SET revision=revision+1,model=?,language=? WHERE id=1 AND revision=?",
        )
        .run(model, language, input.revision);
      this.db
        .prepare("UPDATE dictation SET send=? WHERE id=1")
        .run(dictationSend ? 1 : 0);
      if (!changed.changes) throw assistantProblem("conflict", 409);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get();
  }
  keyRevision() {
    return this.db.prepare("SELECT revision FROM key_state WHERE id=1").get().revision;
  }
  acquire() {
    const row = this.db.prepare("SELECT api_key FROM credentials WHERE id=1").get();
    if (!row) throw assistantProblem("invalid");
    this.leases++;
    let released = false;
    return {
      ...this.get(),
      apiKey: row.api_key,
      keyRevision: this.keyRevision(),
      release: () => {
        if (!released) {
          released = true;
          this.leases--;
        }
      },
    };
  }
  close() {
    this.db.close();
  }
}
