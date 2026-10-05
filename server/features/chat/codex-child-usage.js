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
const MAX_DEPTH = 4;
const BUSY_TIMEOUT = 200;
const RECORD = Buffer.from('"token_usage_record"');
// Grandchildren roll up into the direct child that spawned them. The walk goes one
// level deeper than counted so truncated descendants are known; a cycle back to the
// root or along the current path stops, and read() keeps each thread's shallowest row.
const TREE = `WITH RECURSIVE tree(child, top, depth, path) AS (
    SELECT child_thread_id, child_thread_id, 1, char(31) || child_thread_id || char(31)
      FROM thread_spawn_edges WHERE parent_thread_id=?1 AND child_thread_id<>?1
    UNION
    SELECT e.child_thread_id, tree.top, tree.depth + 1,
        tree.path || e.child_thread_id || char(31)
      FROM thread_spawn_edges e JOIN tree ON e.parent_thread_id = tree.child
      WHERE tree.depth <= ${MAX_DEPTH} AND e.child_thread_id<>?1
        AND instr(tree.path, char(31) || e.child_thread_id || char(31)) = 0
  )
  SELECT tree.child AS id, tree.top AS top, tree.depth AS depth, t.rollout_path AS rollout
  FROM tree LEFT JOIN threads t ON t.id = tree.child
  ORDER BY tree.depth LIMIT ${MAX_CHILDREN + 1}`;

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
export async function lastTokenUsage(file, threadId = null, options = {}) {
  return (await scanTokenUsage(file, threadId, options)).totals;
}

/**
 * `complete` is false when the scan gave up (tail or line cap) before the file start,
 * so a missing record is unknown rather than absent.
 */
async function scanTokenUsage(file, threadId, { maxBytes = MAX_TAIL } = {}) {
  const incomplete = { totals: null, complete: false };
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
          if (found) return { totals: found, complete: true };
        }
        cut = index;
      }
      rest = buffer.subarray(0, cut);
      if (rest.length > MAX_LINE) return incomplete;
    }
    if (position > 0) return incomplete;
    return { totals: trailing ? null : usageLine(rest, threadId), complete: true };
  } finally {
    await handle.close();
  }
}

/** Child threads from Codex's own state database; usage from their rollouts' tails. */
export class CodexChildUsage {
  constructor({ maxFiles = 512, maxBytes = MAX_TAIL } = {}) {
    this.files = new Map();
    this.maxFiles = maxFiles;
    this.maxBytes = maxBytes;
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
      db = openDatabase(location, { busyTimeout: BUSY_TIMEOUT });
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
    // A row beyond the limit means at least one more child could not be read.
    let unavailable = rows.length > MAX_CHILDREN ? 1 : 0,
      observedAt = null;
    const seen = new Set([threadId]);
    for (const row of rows.slice(0, MAX_CHILDREN)) {
      const id = nativeId(row.id),
        top = nativeId(row.top);
      // Rows come shallowest first; a revisit is a cycle or a duplicate path.
      if (!id || !top || seen.has(id)) continue;
      seen.add(id);
      if (row.depth > MAX_DEPTH) {
        unavailable++;
        continue;
      }
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
  /**
   * Totals of one child; undefined when its rollout is missing, no regular file, outside
   * the profile or could not be scanned far enough to know its usage.
   */
  async child(rollout, id, realRoot) {
    if (typeof rollout !== "string" || !rollout || !realRoot) return undefined;
    let real, stat;
    try {
      real = await fs.realpath(rollout);
      if (!real.startsWith(realRoot + path.sep)) return undefined;
      stat = await fs.stat(real);
      if (!stat.isFile()) return undefined;
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
    const scan = await scanTokenUsage(real, id, { maxBytes: this.maxBytes }).catch(
      () => null,
    );
    const totals = scan?.complete || scan?.totals ? scan.totals : undefined;
    this.files.delete(real);
    this.files.set(real, { size: stat.size, mtimeMs: stat.mtimeMs, totals });
    while (this.files.size > this.maxFiles)
      this.files.delete(this.files.keys().next().value);
    return totals;
  }
}
