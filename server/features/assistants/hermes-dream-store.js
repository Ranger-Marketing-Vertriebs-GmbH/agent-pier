/*
 * What Hermes's nightly dream (hermes-dreams.js) keeps per agent, in dreaming.sqlite
 * beside the owner's switch (DreamingSettings#db): the cursor (the newest chat message
 * the last applied night read), the night it last dreamed, and its diary of
 * structured entries. The browser renders the entries in the reader's language; only
 * the model's summary keeps its own.
 */

// The diary keeps its newest entries within this many bytes of entry text; what an
// older entry took is counted in `pruned_bytes`, so the size stays the whole diary's.
export const diaryLimit = 262144;

const bytes = (text) => Buffer.byteLength(text);

export class HermesDreamStore {
  constructor(db) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS hermes_dream_agents(assistant_id TEXT PRIMARY KEY, applied_until INTEGER, night TEXT);" +
        "CREATE TABLE IF NOT EXISTS hermes_dream_diary(id INTEGER PRIMARY KEY, assistant_id TEXT, at TEXT, body TEXT);" +
        "CREATE INDEX IF NOT EXISTS hermes_dream_diary_agent ON hermes_dream_diary(assistant_id, id);" +
        "CREATE TABLE IF NOT EXISTS hermes_dream_meta(assistant_id TEXT PRIMARY KEY, pruned_bytes INTEGER);",
    );
  }
  row(id) {
    return this.db
      .prepare(
        "SELECT applied_until, night FROM hermes_dream_agents WHERE assistant_id=?",
      )
      .get(id);
  }
  /** The `at` of the newest message the last applied night read, or null. */
  cursor(id) {
    return this.row(id)?.applied_until ?? null;
  }
  /** The local date of the last night the agent dreamed (or began to), or null. */
  night(id) {
    return this.row(id)?.night ?? null;
  }
  markNight(id, night) {
    this.db
      .prepare(
        "INSERT INTO hermes_dream_agents(assistant_id, night) VALUES (?,?) ON CONFLICT(assistant_id) DO UPDATE SET night=excluded.night",
      )
      .run(id, night);
  }
  applied(id, until) {
    this.db
      .prepare(
        "INSERT INTO hermes_dream_agents(assistant_id, applied_until) VALUES (?,?) ON CONFLICT(assistant_id) DO UPDATE SET applied_until=excluded.applied_until",
      )
      .run(id, until);
  }
  /** Appends a diary entry, then drops the oldest beyond diaryLimit (never the newest). */
  append(id, entry) {
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO hermes_dream_diary(assistant_id, at, body) VALUES (?,?,?)")
        .run(id, entry.at, JSON.stringify(entry));
      let kept = 0;
      let pruned = 0;
      const rows = this.db
        .prepare(
          "SELECT id, body FROM hermes_dream_diary WHERE assistant_id=? ORDER BY id DESC",
        )
        .all(id);
      for (const [i, row] of rows.entries()) {
        const size = bytes(row.body);
        if (i === 0 || kept + size <= diaryLimit) {
          kept += size;
          continue;
        }
        this.db.prepare("DELETE FROM hermes_dream_diary WHERE id=?").run(row.id);
        pruned += size;
      }
      if (pruned)
        this.db
          .prepare(
            "INSERT INTO hermes_dream_meta VALUES (?,?) ON CONFLICT(assistant_id) DO UPDATE SET pruned_bytes=pruned_bytes+excluded.pruned_bytes",
          )
          .run(id, pruned);
    });
  }
  /**
   * The agent's diary: `{ entries (newest first), size (bytes of every entry ever
   * kept, cut ones included), truncated, modifiedAt (the newest entry's at) }`.
   */
  diary(id) {
    const rows = this.db
      .prepare(
        "SELECT body FROM hermes_dream_diary WHERE assistant_id=? ORDER BY id DESC",
      )
      .all(id);
    const pruned =
      this.db
        .prepare("SELECT pruned_bytes FROM hermes_dream_meta WHERE assistant_id=?")
        .get(id)?.pruned_bytes ?? 0;
    const entries = rows.map((row) => JSON.parse(row.body));
    return {
      entries,
      size: rows.reduce((sum, row) => sum + bytes(row.body), pruned),
      truncated: pruned > 0,
      modifiedAt: entries[0]?.at ?? null,
    };
  }
  /** Forgets every agent not in `knownIds` (deleted agents, ended members). */
  prune(knownIds) {
    const known = new Set(knownIds);
    this.transaction(() => {
      for (const table of [
        "hermes_dream_agents",
        "hermes_dream_diary",
        "hermes_dream_meta",
      ])
        for (const { assistant_id: id } of this.db
          .prepare(`SELECT DISTINCT assistant_id FROM ${table}`)
          .all())
          if (!known.has(id))
            this.db.prepare(`DELETE FROM ${table} WHERE assistant_id=?`).run(id);
    });
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
