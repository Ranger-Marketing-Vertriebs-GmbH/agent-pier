import { openCodeRevert } from "./opencode-revert.js";
import { markOpenCodeInput } from "./opencode-input-state.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeOpenCode } from "./history-parsers.js";
import { openCodeTotals, usageFromTotals } from "./token-usage.js";
import { nativeId } from "./observability-values.js";
import { observeOpenCode } from "./opencode-observability.js";
import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import {
  DatabaseLocationError,
  locateDatabase,
  hasColumns,
  openDatabase,
} from "./readonly-sqlite.js";

const PAGE_MESSAGES = 50;
const SCAN_PARTS = 200;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const mismatch = () => problem(serverMessages.chat.sessionHistoryMismatch, 409);
const unavailable = () => problem(serverMessages.chat.openCodeHistoryUnavailable, 409);
const tooLarge = () => problem(serverMessages.chat.historyTooLarge, 413);

async function databaseFile(history, session) {
  const env = history.environment(session);
  const root =
    env.XDG_DATA_HOME || path.join(env.HOME || history.home, ".local", "share");
  if (env.OPENCODE_DB === ":memory:") return null;
  const file = path.resolve(root, "opencode", env.OPENCODE_DB || "opencode.db");
  try {
    return await locateDatabase(root, file);
  } catch (error) {
    if (error instanceof DatabaseLocationError)
      throw error.reason === "partial-wal" ? unavailable() : mismatch();
    throw error;
  }
}

function supported(db) {
  const required = {
    session: ["id", "directory", "time_created", "revert"],
    message: ["id", "session_id", "time_created", "data"],
    part: ["id", "message_id", "session_id", "data"],
    todo: ["session_id", "content", "status", "priority", "position"],
  };
  return Object.entries(required).every(([table, columns]) => {
    const names = new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name),
    );
    return columns.every((column) => names.has(column));
  });
}

// Matches OpenCode MessageV2.page ordering and hydration, but parts also have a
// keyset: a single large native message never needs to be exported or cached whole.
// Source: anomalyco/opencode packages/opencode/src/session/message-v2.ts.
export async function readOpenCodePage(history, session, id, state = null) {
  const location = await databaseFile(history, session);
  if (!location) {
    if (state?.opencode) throw mismatch();
    return null; // Pre-SQLite storage stays on the explicit legacy adapter.
  }
  let db;
  try {
    db = openDatabase(location);
    if (!supported(db)) {
      if (state?.opencode) throw mismatch();
      return null;
    }
    const info = db
      .prepare("SELECT id,directory,time_created,revert FROM session WHERE id=?")
      .get(id);
    if (!info)
      throw problem(serverMessages.chat.sessionHistoryPending, state ? 409 : 404);
    if (info.directory !== session.cwd)
      throw problem(serverMessages.chat.historyProjectMismatch, 409);
    const scope = hash([
      location.file,
      location.identity,
      session.id,
      session.accountId,
      session.cwd,
      id,
      info.time_created,
      info.revert,
    ]);
    const cursor = state?.opencode;
    if (state && (!cursor || cursor.scope !== scope)) throw mismatch();
    if (cursor) validateBoundary(db, id, cursor.before);
    const revert = openCodeRevert(info.revert);
    let cutoff;
    if (revert) {
      const target = db
        .prepare("SELECT time_created FROM message WHERE session_id=? AND id=?")
        .get(id, revert.messageID);
      if (!target) throw mismatch();
      cutoff = {
        id: revert.messageID,
        time: target.time_created,
        part: revert.partID || null,
      };
      validateBoundary(db, id, cutoff);
    }
    const result = page(db, id, scope, cursor?.before || cutoff);
    if (!state) Object.assign(result.observability, sessionUsage(db, id));
    if (location.immutable) {
      const after = await databaseFile(history, session);
      if (
        !after?.immutable ||
        after.identity !== location.identity ||
        after.version !== location.version
      )
        throw mismatch();
    }
    return result;
  } catch (error) {
    if (error.status) throw error;
    throw unavailable();
  } finally {
    db?.close();
  }
}

function validateBoundary(db, id, before) {
  if (!before || typeof before.id !== "string" || !Number.isSafeInteger(before.time))
    throw mismatch();
  const message = db
    .prepare("SELECT time_created FROM message WHERE session_id=? AND id=?")
    .get(id, before.id);
  if (!message || message.time_created !== before.time) throw mismatch();
  if (
    before.part !== null &&
    (typeof before.part !== "string" ||
      !db
        .prepare("SELECT id FROM part WHERE session_id=? AND message_id=? AND id=?")
        .get(id, before.id, before.part))
  )
    throw mismatch();
}

const TOTAL_COLUMNS = [
  "cost",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
];
const MAX_CHILDREN = 512;

/** OpenCode maintains these columns per session, so they cover the whole history. */
function readSessionUsage(db, id) {
  if (!hasColumns(db, "session", TOTAL_COLUMNS))
    return { totals: null, subagentUsage: null };
  const updated = hasColumns(db, "session", ["time_updated"]) ? ",time_updated" : "";
  const columns = `id,${TOTAL_COLUMNS.join(",")}${updated}`;
  const row = db.prepare(`SELECT ${columns} FROM session WHERE id=?`).get(id);
  const totals = row ? openCodeTotals(row, row.time_updated ?? null) : null;
  if (!hasColumns(db, "session", ["parent_id"])) return { totals, subagentUsage: null };
  const agents = {};
  let count = 0;
  let unavailable = 0;
  for (const child of db
    .prepare(
      `SELECT ${columns} FROM session WHERE parent_id=? ORDER BY time_created,id LIMIT ?`,
    )
    .iterate(id, MAX_CHILDREN + 1)) {
    if (count >= MAX_CHILDREN) {
      unavailable++;
      break;
    }
    count++;
    const usage = usageFromTotals(openCodeTotals(child, child.time_updated ?? null));
    if (nativeId(child.id) && usage) agents[child.id] = usage;
    else unavailable++;
  }
  return {
    totals,
    subagentUsage: count
      ? { agents, toolUses: {}, workflow: null, unavailable, observedAt: null }
      : null,
  };
}

function sessionUsage(db, id) {
  try {
    return readSessionUsage(db, id);
  } catch {
    return { totals: null, subagentUsage: null };
  }
}

function page(db, id, scope, before) {
  const messageColumns =
    "id,time_created,length(CAST(data AS BLOB)) AS bytes,CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data";
  const latest = db.prepare(
    `SELECT ${messageColumns} FROM message WHERE session_id=? ORDER BY time_created DESC,id DESC LIMIT 1`,
  );
  const older = db.prepare(
    `SELECT ${messageColumns} FROM message WHERE session_id=? AND (time_created,id)<(?,?) ORDER BY time_created DESC,id DESC LIMIT 1`,
  );
  const exact = db.prepare(
    `SELECT ${messageColumns} FROM message WHERE session_id=? AND id=?`,
  );
  const partColumns =
    "id,length(CAST(data AS BLOB)) AS bytes,CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data";
  const latestParts = db.prepare(
    `SELECT ${partColumns} FROM part WHERE session_id=? AND message_id=? ORDER BY id DESC LIMIT ?`,
  );
  const olderParts = db.prepare(
    `SELECT ${partColumns} FROM part WHERE session_id=? AND message_id=? AND id<? ORDER BY id DESC LIMIT ?`,
  );
  let row = before?.part
    ? exact.get(MAX_PAGE_BYTES, id, before.id)
    : before
      ? older.get(MAX_PAGE_BYTES, id, before.time, before.id)
      : latest.get(MAX_PAGE_BYTES, id);
  if (
    !row &&
    !before &&
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='session_message'",
      )
      .get() &&
    db.prepare("SELECT id FROM session_message WHERE session_id=? LIMIT 1").get(id)
  )
    throw unavailable(); // V2-only rows cannot be represented by the V1 export adapter.
  let partBefore = before?.part || null;
  let scanned = 0;
  let bytes = 0;
  let boundary = null;
  const messages = [];
  const envelope = [];
  const parse = (record) => {
    bytes += record.bytes;
    if (!record.data || bytes > MAX_PAGE_BYTES) throw tooLarge();
    try {
      return JSON.parse(record.data);
    } catch {
      throw unavailable();
    }
  };
  for (let visited = 0; row && visited < PAGE_MESSAGES; visited++) {
    const info = { ...parse(row), id: row.id, sessionID: id };
    const visibleParts = [];
    envelope.push({ info, parts: visibleParts });
    boundary = { id: row.id, time: row.time_created, part: null };
    const iterator = partBefore
      ? olderParts.iterate(MAX_PAGE_BYTES, id, row.id, partBefore, SCAN_PARTS - scanned)
      : latestParts.iterate(MAX_PAGE_BYTES, id, row.id, SCAN_PARTS - scanned);
    for (const item of iterator) {
      const part = { ...parse(item), id: item.id, messageID: row.id, sessionID: id };
      visibleParts.unshift(part);
      messages.push(
        ...normalizeOpenCode({ messages: [{ info, parts: [part] }] }).messages,
      );
      boundary.part = item.id;
      scanned++;
      if (messages.length >= PAGE_MESSAGES || scanned >= SCAN_PARTS) break;
    }
    const moreParts =
      boundary.part &&
      db
        .prepare(
          "SELECT id FROM part WHERE session_id=? AND message_id=? AND id<? LIMIT 1",
        )
        .get(id, row.id, boundary.part);
    if (!moreParts) boundary.part = null;
    if (messages.length >= PAGE_MESSAGES || scanned >= SCAN_PARTS) break;
    row = older.get(MAX_PAGE_BYTES, id, row.time_created, row.id);
    partBefore = null;
  }
  const hasOlder =
    boundary &&
    (boundary.part ||
      db
        .prepare(
          "SELECT id FROM message WHERE session_id=? AND (time_created,id)<(?,?) LIMIT 1",
        )
        .get(id, boundary.time, boundary.id));
  const todos = [];
  for (const todo of db
    .prepare(
      "SELECT length(CAST(content AS BLOB)) AS bytes, CASE WHEN length(CAST(content AS BLOB))<=? THEN content END AS content,status,priority FROM todo WHERE session_id=? ORDER BY position LIMIT 1001",
    )
    .iterate(MAX_PAGE_BYTES, id)) {
    bytes += todo.bytes;
    if (todo.content === null || bytes > MAX_PAGE_BYTES || todos.length >= 1000)
      throw tooLarge();
    todos.push(todo);
  }
  const exported = { info: { id }, messages: envelope.reverse(), todos };
  return {
    messages: markOpenCodeInput(messages.reverse(), envelope),
    tasks: normalizeOpenCode(exported).tasks,
    observability: observeOpenCode(exported),
    next: hasOlder ? { opencode: { scope, before: boundary } } : null,
  };
}
