// Whole member reports and answers (up to the history limit) live in rows of their
// own beside the record that names them, so team and request records, read on every
// scheduler pass, list and Telegram scan, stay small. A `text` row belongs to its
// owner record (`parent_id`) and is read only for that owner.
export const excerptPoints = 2000;
const rowId = (owner, name) => `text:${owner}:${name}`;

/** The first `max` code points of a text, never half a surrogate pair. */
export const excerpt = (text, max = excerptPoints) =>
  Array.from(text || "")
    .slice(0, max)
    .join("");

/** A text's short form for a record: its excerpt, and `truncated` when it is longer. */
export function shortForm(text) {
  const short = excerpt(text);
  return short.length < (text || "").length ? { text: short, truncated: true } : { text };
}

export function saveText(db, owner, name, text) {
  const id = rowId(owner, name);
  db.prepare(
    `INSERT INTO assistant_team_records(id,kind,parent_id,operation_key,phase,revision,body)
     VALUES(?,'text',?,NULL,NULL,1,?)
     ON CONFLICT(id) DO UPDATE SET body=excluded.body, revision=revision+1`,
  ).run(id, owner, JSON.stringify({ id, kind: "text", text }));
}

/** The whole text, or null when none was stored (records written before). */
export function readText(db, owner, name) {
  const row = db
    .prepare("SELECT body FROM assistant_team_records WHERE id=? AND kind='text'")
    .get(rowId(owner, name));
  return row ? JSON.parse(row.body).text : null;
}

export function dropTexts(db, owner) {
  return db
    .prepare("DELETE FROM assistant_team_records WHERE kind='text' AND parent_id=?")
    .run(owner).changes;
}

export function dropText(db, owner, name) {
  db.prepare("DELETE FROM assistant_team_records WHERE id=? AND kind='text'").run(
    rowId(owner, name),
  );
}
