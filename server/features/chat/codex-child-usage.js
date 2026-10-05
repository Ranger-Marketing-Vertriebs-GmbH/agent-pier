import fs from "node:fs/promises";
import path from "node:path";
import { nativeId } from "./observability-values.js";
import { codexTotals, sumUsage, usageFromTotals } from "./token-usage.js";
import {
  hasColumns,
  locateDatabase,
  openDatabase,
  unchangedDatabase,
} from "./readonly-sqlite.js";

const BLOCK = 64 * 1024;
const MAX_TAIL = 8 * 1024 * 1024;
const MAX_LINE = 4 * 1024 * 1024;
const MAX_CHILDREN = 512;
const RECORD = Buffer.from('"token_usage_record"');
// Grandchildren roll up into the direct child that spawned them.
const TREE = `WITH RECURSIVE tree(child, top, depth) AS (
    SELECT child_thread_id, child_thread_id, 1 FROM thread_spawn_edges WHERE parent_thread_id=?
    UNION
    SELECT e.child_thread_id, tree.top, tree.depth + 1 FROM thread_spawn_edges e
      JOIN tree ON e.parent_thread_id = tree.child WHERE tree.depth < 4
  )
  SELECT tree.child AS id, tree.top AS top, t.rollout_path AS rollout
  FROM tree LEFT JOIN threads t ON t.id = tree.child LIMIT ${MAX_CHILDREN}`;

function usageLine(line, threadId) {
  if (!line.includes(RECORD)) return null;
  try {
    const record = JSON.parse(line.toString("utf8"));
    const payload = record?.payload;
    if (record?.type !== "token_usage_record" || !payload?.thread_token_usage)
      return null;
    if (payload.thread_id && threadId && payload.thread_id !== threadId) return null;
    return codexTotals(payload.thread_token_usage, "codex-thread", record.timestamp);
  } catch {
    return null;
  }
}

/** The last complete token_usage_record of a rollout, read backwards from its end. */
export async function lastTokenUsage(
  file,
  threadId = null,
  { maxBytes = MAX_TAIL } = {},
) {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    let position = size,
      rest = Buffer.alloc(0),
      trailing = true,
      scanned = 0;
    const previous = (buffer, cut) => (cut > 0 ? buffer.lastIndexOf(10, cut - 1) : -1);
    while (position > 0 && scanned < maxBytes) {
      const start = Math.max(0, position - BLOCK);
      const chunk = Buffer.alloc(position - start);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
      scanned += bytesRead;
      position = start;
      const buffer = Buffer.concat([chunk.subarray(0, bytesRead), rest]);
      let cut = buffer.length;
      for (let index = previous(buffer, cut); index >= 0; index = previous(buffer, cut)) {
        // Bytes after the last newline are an unfinished append.
        if (trailing) trailing = false;
        else {
          const found = usageLine(buffer.subarray(index + 1, cut), threadId);
          if (found) return found;
        }
        cut = index;
      }
      rest = buffer.subarray(0, cut);
      if (rest.length > MAX_LINE) return null;
    }
    return position === 0 && !trailing ? usageLine(rest, threadId) : null;
  } finally {
    await handle.close();
  }
}

/** Child threads from Codex's own state database; usage from their rollouts' tails. */
export class CodexChildUsage {
  constructor({ maxFiles = 512 } = {}) {
    this.files = new Map();
    this.maxFiles = maxFiles;
    this.reads = 0;
  }
  async read(history, session, threadId) {
    const env = history.environment(session);
    const root = env.CODEX_HOME || path.join(env.HOME || history.home, ".codex");
    const file = path.join(root, "state_5.sqlite");
    let location, rows, db;
    try {
      location = await locateDatabase(root, file);
      if (!location) return null;
      db = openDatabase(location);
      if (
        !hasColumns(db, "thread_spawn_edges", ["parent_thread_id", "child_thread_id"]) ||
        !hasColumns(db, "threads", ["id", "rollout_path"])
      )
        return null;
      rows = db.prepare(TREE).all(threadId);
    } catch {
      return null;
    } finally {
      db?.close();
    }
    if (!rows.length || !(await unchangedDatabase(root, file, location))) return null;
    const realRoot = await fs.realpath(root).catch(() => null);
    const agents = {};
    let unavailable = 0,
      observedAt = null;
    for (const row of rows) {
      const id = nativeId(row.id),
        top = nativeId(row.top);
      if (!id || !top) continue;
      const totals = await this.child(row.rollout, id, realRoot);
      if (totals === undefined) {
        unavailable++;
        continue;
      }
      const usage = usageFromTotals(totals);
      if (!usage) continue;
      if (totals.observedAt && (!observedAt || totals.observedAt > observedAt))
        observedAt = totals.observedAt;
      agents[top] = Object.hasOwn(agents, top) ? sumUsage([agents[top], usage]) : usage;
    }
    return { agents, toolUses: {}, workflow: null, unavailable, observedAt };
  }
  /** Totals of one child; undefined when its rollout is missing or outside the profile. */
  async child(rollout, id, realRoot) {
    if (typeof rollout !== "string" || !rollout || !realRoot) return undefined;
    let real, stat;
    try {
      real = await fs.realpath(rollout);
      if (!real.startsWith(realRoot + path.sep)) return undefined;
      stat = await fs.stat(real);
    } catch {
      return undefined;
    }
    const cached = this.files.get(real);
    if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      this.files.delete(real);
      this.files.set(real, cached);
      return cached.totals;
    }
    this.reads++;
    const totals = await lastTokenUsage(real, id).catch(() => null);
    this.files.delete(real);
    this.files.set(real, { size: stat.size, mtimeMs: stat.mtimeMs, totals });
    while (this.files.size > this.maxFiles)
      this.files.delete(this.files.keys().next().value);
    return totals;
  }
}
