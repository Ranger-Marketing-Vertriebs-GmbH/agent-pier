import path from "node:path";
import { privateDatabase } from "../../lib/private-database.js";
import { assistantProblem } from "../assistants/assistant-validation.js";
export class SpeechConnections {
  constructor({ dataDir }) {
    this.db = privateDatabase(path.join(dataDir, "speech"), "connections.sqlite");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, model TEXT NOT NULL, language TEXT NOT NULL); CREATE TABLE IF NOT EXISTS credentials(id INTEGER PRIMARY KEY CHECK(id=1), api_key TEXT NOT NULL); INSERT OR IGNORE INTO settings VALUES (1,0,'nova-3','auto');",
    );
    this.leases = 0;
  }
  get() {
    const { revision, model, language } = this.db
      .prepare("SELECT * FROM settings WHERE id=1")
      .get();
    return {
      id: "deepgram",
      provider: "deepgram",
      revision,
      model,
      language,
      hasSecret: !!this.db.prepare("SELECT 1 FROM credentials WHERE id=1").get(),
    };
  }
  save(input) {
    if (this.leases) throw assistantProblem("active", 409);
    const current = this.get();
    if (
      !input ||
      Object.keys(input).some(
        (k) => !["apiKey", "removeApiKey", "model", "language", "revision"].includes(k),
      )
    )
      throw assistantProblem("invalid");
    if (input.revision !== current.revision) throw assistantProblem("conflict", 409);
    const { apiKey, removeApiKey } = input,
      model = input.model ?? current.model,
      language = input.language ?? current.language;
    if (
      !/^[a-zA-Z0-9._-]{1,64}$/.test(model) ||
      !/^(auto|[a-z]{2}(?:-[A-Z]{2})?)$/.test(language) ||
      (apiKey !== undefined &&
        (typeof apiKey !== "string" ||
          !apiKey.length ||
          apiKey.length > 1024 ||
          /[^\x21-\x7e]/.test(apiKey))) ||
      (removeApiKey !== undefined && typeof removeApiKey !== "boolean") ||
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
      const changed = this.db
        .prepare(
          "UPDATE settings SET revision=revision+1,model=?,language=? WHERE id=1 AND revision=?",
        )
        .run(model, language, input.revision);
      if (!changed.changes) throw assistantProblem("conflict", 409);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get();
  }
  acquire() {
    const row = this.db.prepare("SELECT api_key FROM credentials WHERE id=1").get();
    if (!row) throw assistantProblem("invalid");
    this.leases++;
    let released = false;
    return {
      ...this.get(),
      apiKey: row.api_key,
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
