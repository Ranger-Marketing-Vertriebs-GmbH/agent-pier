import { serverMessages } from "../../lib/i18n/de.js";
import { transaction } from "./memory-database.js";
import { failure, pageValue, textValue } from "./memory-validation.js";
import { entry, entryColumns, pageSize } from "./memory-rows.js";

/**
 * Full-text search over the current revision of every entry. The FTS5 table is
 * derived data: one row per entry, keyed by entry ID (the project comes from the
 * entries table, so project moves need no index change). Writes keep it current in
 * their transaction; each start rebuilds it when it is missing or stale; backups leave
 * it out. Without FTS5 (some Node 22 builds) search falls back to LIKE.
 */
const index = "memory_search";
const excerptLength = 256;
// unicode61 keeps letters, numbers and private-use characters; the rest separates.
const tokenCharacter = /[\p{L}\p{N}\p{Co}]/u;
const sorts = ["relevance", "newest"];
const joined = "entries e JOIN revisions r ON r.entry_id=e.id AND r.revision=e.revision";
const current = `SELECT e.id,e.revision,r.title,r.content FROM ${joined}`;

/** Whether this SQLite build provides FTS5. */
export function fullTextAvailable(db) {
  try {
    db.exec(
      "CREATE VIRTUAL TABLE temp.memory_fts_probe USING fts5(x); DROP TABLE temp.memory_fts_probe",
    );
    return true;
  } catch {
    return false;
  }
}

const indexExists = (db) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(index));

/** Whether the index rows differ from the current entry revisions. */
function indexStale(db) {
  try {
    const rows = db.prepare(`SELECT entry_id,revision FROM ${index}`).all();
    const indexed = new Map(rows.map((row) => [row.entry_id, Number(row.revision)]));
    const entries = db.prepare("SELECT id,revision FROM entries").all();
    return (
      indexed.size !== rows.length ||
      rows.length !== entries.length ||
      entries.some((row) => indexed.get(row.id) !== row.revision)
    );
  } catch {
    return true;
  }
}

/**
 * Removes the derived index, for a backup copy or a start without FTS5. Without the
 * module the virtual table cannot be dropped, so its shadow tables are emptied; the
 * next start with FTS5 finds it stale and rebuilds it.
 */
export function discardSearchIndex(db) {
  if (!indexExists(db)) return;
  try {
    db.exec(`DROP TABLE ${index}`);
  } catch {
    for (const suffix of ["content", "docsize", "data", "idx"])
      try {
        db.exec(`DELETE FROM ${index}_${suffix}`);
      } catch {
        // Best effort: a stale index is rebuilt before it is used again.
      }
  }
}

/** Whether an index table left in place still holds rows (or cannot be read). */
export function searchIndexHoldsText(db) {
  if (!indexExists(db)) return false;
  try {
    return Boolean(
      db
        .prepare(
          `SELECT EXISTS(SELECT 1 FROM ${index}_content) OR EXISTS(SELECT 1 FROM ${index}_data) AS held`,
        )
        .get().held,
    );
  } catch {
    return true;
  }
}

/**
 * Builds or verifies the index at start; returns whether search uses it. A failed
 * rebuild discards the old index, so no stale copy of later forgotten text remains.
 */
export function prepareSearchIndex(db, enabled) {
  if (!enabled) {
    discardSearchIndex(db);
    return false;
  }
  if (indexExists(db) && !indexStale(db)) return true;
  try {
    transaction(db, () => {
      db.exec(`DROP TABLE IF EXISTS ${index}`);
      db.exec(
        `CREATE VIRTUAL TABLE ${index} USING fts5(entry_id UNINDEXED, revision UNINDEXED, title, content, tokenize='unicode61 remove_diacritics 2')`,
      );
      db.exec(`INSERT INTO ${index}(entry_id,revision,title,content) ${current}`);
    });
    return true;
  } catch (error) {
    console.error(
      `AgentPier could not build the memory search index; search uses LIKE: ${error?.code || error?.name || "unknown error"}`,
    );
    discardSearchIndex(db);
    return false;
  }
}

/** Re-indexes an entry's current revision; runs inside the caller's transaction. */
export function indexEntry(memory, id) {
  if (!memory.fullText) return;
  memory.db.prepare(`DELETE FROM ${index} WHERE entry_id=?`).run(id);
  memory.db
    .prepare(
      `INSERT INTO ${index}(entry_id,revision,title,content) ${current} WHERE e.id=?`,
    )
    .run(id);
}

/**
 * Removes a forgotten entry from the index inside the forget transaction. Merging all
 * segments drops its terms, also those older revisions left behind, so the following
 * VACUUM leaves none of its text in the shadow tables. Without a usable index any
 * leftover one is stale and discarded whole; purgeForgotten checks that it is gone.
 */
export function forgetIndexed(memory, id) {
  if (!memory.fullText) return discardSearchIndex(memory.db);
  memory.db.prepare(`DELETE FROM ${index} WHERE entry_id=?`).run(id);
  memory.db.exec(`INSERT INTO ${index}(${index}) VALUES('optimize')`);
}

/** Lower-cases ASCII only, like SQLite's lower(). */
const asciiLower = (text) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/**
 * References in the query: file paths, ticket keys, URLs and code symbols, i.e. words
 * with inner punctuation or camel case. Entries containing one exactly, between token
 * boundaries, rank first.
 */
function references(words) {
  const found = new Set();
  for (const word of words) {
    const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (
      /[\p{L}\p{N}][^\p{L}\p{N}]+[\p{L}\p{N}]/u.test(bare) ||
      /\p{Ll}\p{Lu}/u.test(bare)
    )
      found.add(asciiLower(bare));
  }
  return [...found];
}

// A GLOB for the reference between non-alphanumeric ASCII boundaries: ABC-12 does
// not match inside ABC-123. The text is padded with spaces to match at its edges.
const bounded = (ref) =>
  `*[^a-z0-9]${ref.replace(/[*?[]/g, (special) => `[${special}]`)}[^a-z0-9]*`;
const verbatim = (column) => `(' '||lower(${column})||' ') GLOB ?`;

// Each word becomes a quoted prefix phrase, so FTS syntax in it stays plain text.
const phrase = (word) => `"${word.replaceAll('"', '""')}"*`;
const pattern = (word) =>
  `%${word.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
const like = (column) => `${column} LIKE ? ESCAPE '\\'`;

/** The content around the first word found, for the LIKE fallback. */
function excerptAround(content, words) {
  const lower = asciiLower(content);
  const hits = words
    .map((word) => lower.indexOf(asciiLower(word)))
    .filter((at) => at >= 0);
  let start = hits.length ? Math.min(...hits) - 32 : 0;
  if (start <= 0) return content;
  // Never start inside a surrogate pair.
  if (/[\uDC00-\uDFFF]/.test(content[start])) start -= 1;
  return `…${content.slice(start)}`;
}

/**
 * One page of a project's entries. With a search term every word must match, title
 * or content, and results are ranked by relevance unless `sort` is "newest";
 * without one the newest revisions come first.
 */
export function searchEntries(
  memory,
  projectId,
  { query = "", page = 1, archived = false, sort } = {},
) {
  pageValue(page);
  textValue(query, serverMessages.memory.invalidQuery, 300, { empty: true });
  if (typeof archived !== "boolean")
    throw failure(serverMessages.memory.invalidArchiveFilter);
  if (sort !== undefined && !sorts.includes(sort))
    throw failure(serverMessages.memory.invalidSort);
  const words = query.split(/\s+/u).filter(Boolean);
  const terms = words.filter((word) => tokenCharacter.test(word));
  const ranked = words.length > 0 && sort !== "newest";
  const refs = ranked ? references(words) : [];
  // Number of references found verbatim (ASCII case folded), ranked first.
  const exact = refs.length
    ? `(${refs.map(() => `(${verbatim("r.title")} OR ${verbatim("r.content")})`).join("+")}) DESC, `
    : "";
  const exactArgs = refs.flatMap((ref) => [bounded(ref), bounded(ref)]);
  const scope = "e.project_id=? AND r.archived=?",
    scopeArgs = [projectId, Number(archived)];
  let from, where, whereArgs, score, scoreArgs, excerpt;
  // A query of punctuation only has no FTS terms; it is matched literally.
  if (memory.fullText && terms.length) {
    from = `${index} JOIN ${joined} AND e.id=${index}.entry_id`;
    where = `${index} MATCH ? AND ${scope}`;
    whereArgs = [terms.map(phrase).join(" "), ...scopeArgs];
    score = `bm25(${index},0,0,10,1)`;
    scoreArgs = [];
    excerpt = `snippet(${index},3,'','','…',24)`;
  } else {
    // Like FTS, punctuation-only words count only when the query has nothing else.
    const patterns = (terms.length ? terms : words).map(pattern);
    from = joined;
    where = [
      scope,
      ...patterns.map(() => `(${like("r.title")} OR ${like("r.content")})`),
    ].join(" AND ");
    whereArgs = [...scopeArgs, ...patterns.flatMap((value) => [value, value])];
    // Without bm25, entries matching more words in the title rank first.
    score = `-(${patterns.map(() => `(${like("r.title")})`).join("+")})`;
    scoreArgs = patterns;
    excerpt = "NULL";
  }
  const order = ranked
    ? `${exact}${score}, r.created_at DESC, e.id`
    : "r.created_at DESC, e.id";
  const total = memory.db
    .prepare(`SELECT COUNT(*) AS total FROM ${from} WHERE ${where}`)
    .get(...whereArgs).total;
  const items = memory.db
    .prepare(
      `SELECT ${entryColumns}, ${excerpt} AS excerpt FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .all(
      ...whereArgs,
      ...(ranked ? [...exactArgs, ...scoreArgs] : []),
      pageSize,
      (page - 1) * pageSize,
    )
    .map((row) =>
      words.length
        ? { ...entry(row), excerpt: row.excerpt ?? excerptAround(row.content, words) }
        : entry(row),
    );
  return { projectId, items, page, pageSize, total };
}

/** Search results with a bounded excerpt instead of the full content (MCP, agents). */
export function withExcerpts(result) {
  return {
    ...result,
    items: result.items.map(({ content, excerpt, ...item }) => ({
      ...item,
      excerpt: Array.from(excerpt ?? content)
        .slice(0, excerptLength)
        .join(""),
    })),
  };
}
