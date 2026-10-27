import fsp from "node:fs/promises";
import path from "node:path";
import { entryStat, folderNames, measureTree, removeEntry } from "./safe-tree.js";
import { cleanupProblem } from "./cleanup-problem.js";

/*
 * Transcripts of ended CLI sessions in AgentPier's CLI profiles
 * (profiles/<id>/<tool> and profiles/<id>/providers/<provider>/<tool>):
 * - Claude Code: projects/<encoded cwd>/<session id>.jsonl, with the session's
 *   folder of subagent transcripts and tool results beside it (<session id>/);
 * - Codex: sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl and
 *   archived_sessions/rollout-*.jsonl. Codex also indexes its threads in SQLite
 *   databases (state_*.sqlite, thread_history_*.sqlite) whose schema changes with
 *   Codex releases; AgentPier never writes them, so they stay as they are.
 * OpenCode keeps its sessions in its own database and is not offered.
 * A transcript goes only when it was last changed before the cutoff and no stored
 * AgentPier session, chat binding, native-session receipt or AgentBus record names
 * its id: stopped sessions that are still listed keep theirs, so they can be resumed.
 */
export const CUTOFF_DAYS = [30, 90, 180];
// The age the cleanup list preselects and the storage summary measures.
export const DEFAULT_CUTOFF_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
const TOOLS = ["claude", "codex"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const claudeName =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const codexName =
  /^rollout-.*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
// What AgentPier keeps about its sessions; every id named there stays protected.
const SOURCES = ["sessions", "chat", "native-sessions", "agentbus"];
const MAX_SOURCE_FILES = 100_000;
const REFRESH_MS = 2000;
const MAX_SOURCE_BYTES = 4 * 1024 ** 3;

// Adds every id in a file, read in chunks; an id split between two chunks still counts.
async function scanIds(file, ids, budget) {
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let tail = "";
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      if ((budget.bytes -= bytesRead) < 0) throw Error("Too much to read.");
      const text = tail + buffer.toString("latin1", 0, bytesRead);
      for (const match of text.matchAll(UUID)) ids.add(match[0].toLowerCase());
      tail = text.slice(-35);
    }
  } finally {
    await handle.close();
  }
}

const isFolder = (stat) => !!stat && stat.isDirectory() && !stat.isSymbolicLink();

/**
 * Every session id AgentPier's own records name: the files below SOURCES and the
 * texts `records()` returns (the pipeline runs, whose steps resume CLI sessions). A
 * record that cannot be read fails the whole cleanup (nothing is deleted), so an id
 * is never missed.
 */
export async function protectedIds(dataDir, records = () => []) {
  const ids = new Set();
  const budget = { bytes: MAX_SOURCE_BYTES };
  let files = 0;
  const visit = async (folder, depth) => {
    let entries;
    try {
      entries = await fsp.readdir(folder, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw cleanupProblem("sessionsUnreadable", 503);
    }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth >= 8) throw cleanupProblem("sessionsUnreadable", 503);
        await visit(file, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.(?:json|jsonl)$/.test(entry.name)) continue;
      if (++files > MAX_SOURCE_FILES) throw cleanupProblem("sessionsUnreadable", 503);
      try {
        await scanIds(file, ids, budget);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw cleanupProblem("sessionsUnreadable", 503);
      }
    }
  };
  for (const source of SOURCES) await visit(path.join(dataDir, source), 0);
  try {
    for (const text of await records())
      for (const match of String(text).matchAll(UUID)) ids.add(match[0].toLowerCase());
  } catch {
    throw cleanupProblem("sessionsUnreadable", 503);
  }
  return ids;
}

/** The CLI homes of a managed profile: its own and those of its provider choices. */
export async function profileHomes(dataDir, account) {
  if (!TOOLS.includes(account?.tool)) return [];
  const root = path.join(dataDir, "profiles", account.id);
  const homes = [];
  if (isFolder(await entryStat(path.dirname(root), account.id))) {
    if (isFolder(await entryStat(root, account.tool)))
      homes.push(path.join(root, account.tool));
    const providers = path.join(root, "providers");
    if (isFolder(await entryStat(root, "providers")))
      for (const name of await folderNames(providers))
        if (
          isFolder(await entryStat(providers, name)) &&
          isFolder(await entryStat(path.join(providers, name), account.tool))
        )
          homes.push(path.join(providers, name, account.tool));
  }
  return homes;
}

// Transcript files (and Claude's session folders) below one CLI home.
async function transcriptsIn(home, tool) {
  const found = [];
  const walk = async (folder, depth, pattern, companion) => {
    for (const name of await folderNames(folder)) {
      const stat = await entryStat(folder, name);
      if (isFolder(stat)) {
        if (depth > 0) await walk(path.join(folder, name), depth - 1, pattern, companion);
        continue;
      }
      const match = stat?.isFile() && pattern.exec(name);
      if (match)
        found.push({ folder, name, id: match[1].toLowerCase(), stat, companion });
    }
  };
  if (tool === "claude") {
    const projects = path.join(home, "projects");
    for (const name of await folderNames(projects))
      if (isFolder(await entryStat(projects, name)))
        await walk(path.join(projects, name), 0, claudeName, true);
  } else {
    await walk(path.join(home, "sessions"), 4, codexName, false);
    await walk(path.join(home, "archived_sessions"), 4, codexName, false);
  }
  for (const item of found) {
    const size = await measureTree(path.join(item.folder, item.name));
    item.bytes = size.bytes;
    item.newestMs = item.stat.mtimeMs;
    if (item.companion) {
      const folder = path.join(item.folder, item.id);
      const companion = isFolder(await entryStat(item.folder, item.id))
        ? await measureTree(folder)
        : null;
      item.companionName = companion ? item.id : null;
      if (companion) {
        item.bytes += companion.bytes;
        item.newestMs = Math.max(item.newestMs, companion.newestMs);
        // A folder too large to measure counts as changed now: it stays.
        if (companion.partial) item.newestMs = Infinity;
      }
    }
  }
  return found;
}

/** Old transcripts of one profile by cutoff, and how many are kept as still listed. */
export async function profileTranscripts(dataDir, account, ids, now = Date.now()) {
  const items = [];
  for (const home of await profileHomes(dataDir, account))
    items.push(...(await transcriptsIn(home, account.tool)));
  const cutoffs = CUTOFF_DAYS.map((days) => {
    const before = now - days * DAY;
    const old = items.filter((item) => item.newestMs < before);
    const removable = old.filter((item) => !ids.has(item.id));
    return {
      days,
      count: removable.length,
      bytes: removable.reduce((sum, item) => sum + item.bytes, 0),
      kept: old.length - removable.length,
    };
  });
  return { items, cutoffs };
}

/**
 * Deletes the transcripts of one profile older than `days`, checking each file again
 * just before it goes: still a regular file, still older than the cutoff, its id
 * still unnamed by AgentPier. Returns counts and bytes, never a path or content.
 */
export async function deleteTranscripts(
  dataDir,
  account,
  days,
  { now = Date.now(), records } = {},
) {
  if (!CUTOFF_DAYS.includes(days)) throw cleanupProblem("invalidAge");
  if (!TOOLS.includes(account?.tool)) throw cleanupProblem("profileUnsupported", 409);
  const before = now - days * DAY;
  const { items } = await profileTranscripts(dataDir, account, new Set(), now);
  // Read after the scan and again every few seconds: a session AgentPier records
  // while a long deletion runs is protected from then on.
  const ids = await protectedIds(dataDir, records);
  let checkedAt = Date.now();
  let removed = 0,
    bytes = 0,
    skipped = 0;
  for (const item of items) {
    if (item.newestMs >= before) continue;
    if (Date.now() - checkedAt > REFRESH_MS) {
      for (const id of await protectedIds(dataDir, records)) ids.add(id);
      checkedAt = Date.now();
    }
    if (ids.has(item.id)) continue;
    try {
      const gone = await removeEntry(
        item.folder,
        item.name,
        (stat) => stat.isFile() && stat.mtimeMs < before && stat.ino === item.stat.ino,
      );
      if (!gone) {
        skipped++;
        continue;
      }
      // The session's own folder goes with it; its subagent transcripts belong to it.
      if (item.companionName) await removeEntry(item.folder, item.companionName);
      removed++;
      bytes += item.bytes;
    } catch {
      skipped++;
    }
  }
  return { removed, bytes, skipped };
}
