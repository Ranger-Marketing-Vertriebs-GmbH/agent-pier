import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { nativeId } from "./observability-values.js";
import { createClaudeUsage, sumUsage, usageFromTotals } from "./token-usage.js";

const BLOCK = 64 * 1024;
const MAX_LINE = 4 * 1024 * 1024;
const MAX_META = 64 * 1024;
const MAX_FILES = 1024;
const MAX_DEPTH = 8;
const NOTIFY_INTERVAL = 1500;
const AGENT_FILE = /^agent-([A-Za-z0-9][A-Za-z0-9_-]{0,119})\.jsonl$/;
const WORKFLOW_DIR = /^wf_[A-Za-z0-9_-]{1,120}$/;
const USAGE = Buffer.from('"usage"');
const missing = (error) => ["ENOENT", "ENOTDIR"].includes(error?.code);

/** Real directory below the profile root, or null when absent or outside it. */
async function inside(directory, root) {
  try {
    const [real, realRoot] = await Promise.all([
      fs.realpath(directory),
      fs.realpath(root),
    ]);
    return real.startsWith(realRoot + path.sep) ? real : null;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

const regularFile = async (file) => {
  const stat = await fs.lstat(file).catch(() => null);
  return stat?.isFile() ? stat : null;
};
/** A cached file state still describes the file when inode, size and mtime match. */
const current = (state, stat) =>
  state?.ino === stat.ino && state.size === stat.size && state.mtimeMs === stat.mtimeMs;

/**
 * Continues a subagent file from its last complete line. Files are live-appended,
 * so an unfinished last line is read again on the next refresh.
 */
export async function readAgentUsage(file, previous = null) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    let state = previous;
    if (!state || state.ino !== stat.ino || stat.size < state.offset)
      state = {
        ino: stat.ino,
        offset: 0,
        size: -1,
        mtimeMs: -1,
        usage: createClaudeUsage(),
      };
    if (state.size === stat.size && state.mtimeMs === stat.mtimeMs) return state;
    let position = state.offset,
      pending = Buffer.alloc(0),
      skipping = false;
    while (position < stat.size) {
      const buffer = Buffer.alloc(Math.min(BLOCK, stat.size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let end;
      while ((end = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        if (!skipping && line.includes(USAGE)) {
          try {
            const record = JSON.parse(line.toString("utf8"));
            if (record?.type === "assistant" && record.message?.usage)
              state.usage.add(record.message, record.timestamp);
          } catch {
            /* A malformed line is no usage evidence. */
          }
        }
        skipping = false;
        state.offset = position - pending.length;
      }
      if (pending.length > MAX_LINE) {
        pending = Buffer.alloc(0);
        skipping = true;
      }
      await yieldTurn();
    }
    state.size = stat.size;
    state.mtimeMs = stat.mtimeMs;
    return state;
  } finally {
    await handle.close();
  }
}

/**
 * `{ meta }` with `{ toolUseId, parentAgentId }` once it is final: parsed, or `{}`
 * for a meta that is no regular file or too large. `{ failed }` names the size and
 * mtime of an empty or unparseable (half-written) meta, which is read again only
 * after it changes. Null while it is missing or a read failed transiently.
 */
async function readMeta(file, failed) {
  let handle;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size >= MAX_META) return { meta: {} };
    if (failed?.size === stat.size && failed.mtimeMs === stat.mtimeMs) return { failed };
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const buffer = Buffer.alloc(MAX_META);
    const { bytesRead } = await handle.read(buffer, 0, MAX_META, 0);
    if (bytesRead >= MAX_META) return { meta: {} };
    try {
      const meta = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      return {
        meta: {
          toolUseId: nativeId(meta?.toolUseId),
          parentAgentId: nativeId(meta?.parentAgentId),
        },
      };
    } catch {
      return { failed: { size: stat.size, mtimeMs: stat.mtimeMs } };
    }
  } catch (error) {
    // A symlink swapped in after lstat is no meta to follow.
    return error?.code === "ELOOP" ? { meta: {} } : null;
  } finally {
    await handle?.close();
  }
}

/** Bounded per-session cache of `<session>/subagents` usage, refreshed in the background. */
export class ClaudeSubagentUsage {
  constructor({
    root,
    onUpdated,
    maxSessions = 16,
    maxFiles = MAX_FILES,
    interval = NOTIFY_INTERVAL,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.root = root;
    this.onUpdated = onUpdated;
    this.maxSessions = maxSessions;
    this.maxFiles = maxFiles;
    this.interval = interval;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.entries = new Map();
  }
  peek(session, id, transcript) {
    if (this.closed) return null;
    const key = JSON.stringify([session.accountId, session.cwd, id, transcript]);
    let entry = this.entries.get(session.id);
    if (!entry || entry.key !== key) {
      if (entry) this.forget(entry);
      entry = {
        key,
        session: { ...session },
        id,
        transcript,
        files: new Map(),
        metas: new Map(),
        metaFailures: new Map(),
        names: [],
        overflow: 0,
        directoryMtime: null,
        result: null,
        digest: null,
        reads: 0,
        pending: null,
        dirty: false,
        notifiedAt: -Infinity,
        timer: null,
      };
    }
    this.entries.delete(session.id);
    this.entries.set(session.id, entry);
    while (this.entries.size > this.maxSessions) {
      const [oldest, evicted] = this.entries.entries().next().value;
      this.forget(evicted);
      this.entries.delete(oldest);
    }
    // A peek during a refresh asks for one follow-up refresh, so changes written
    // during the running one are seen.
    if (entry.pending) entry.dirty = true;
    else
      entry.pending = (async () => {
        do {
          entry.dirty = false;
          await yieldTurn();
          await this.refresh(entry);
        } while (entry.dirty && !this.closed && this.entries.get(session.id) === entry);
      })()
        .catch(() => {})
        .finally(() => {
          entry.pending = null;
        });
    return entry.result;
  }
  async refresh(entry) {
    const root = await this.root(entry.session);
    if (this.closed || this.entries.get(entry.session.id) !== entry) return;
    const directory = await inside(
      path.join(path.dirname(entry.transcript), entry.id, "subagents"),
      root,
    );
    if (!directory) return this.publish(entry, null);
    const stat = await fs.stat(directory);
    if (stat.mtimeMs !== entry.directoryMtime) {
      const names = (await fs.readdir(directory))
        .filter((name) => AGENT_FILE.test(name))
        .sort();
      entry.names = names.slice(0, this.maxFiles);
      entry.overflow = names.length - entry.names.length;
      entry.directoryMtime = stat.mtimeMs;
    }
    const top = (agentId) => {
      let id = agentId;
      for (
        let depth = 0;
        depth < MAX_DEPTH && entry.metas.get(id)?.parentAgentId;
        depth++
      )
        id = entry.metas.get(id).parentAgentId;
      return id;
    };
    // Every known file is stat-checked on each refresh and read again only when
    // its size or mtime changed, whatever the observer reports about its agent.
    for (const name of entry.names) {
      const agentId = AGENT_FILE.exec(name)[1];
      if (!entry.metas.has(agentId)) {
        const read = await readMeta(
          path.join(directory, `agent-${agentId}.meta.json`),
          entry.metaFailures.get(agentId),
        );
        if (read?.meta) {
          entry.metas.set(agentId, read.meta);
          entry.metaFailures.delete(agentId);
        } else if (read?.failed) entry.metaFailures.set(agentId, read.failed);
      }
      await this.update(entry, path.join(directory, name));
    }
    const workflows = await this.workflowFiles(directory);
    for (const file of workflows.files) await this.update(entry, file);
    const result = this.summarize(entry, directory, workflows.files, top);
    this.publish(entry, {
      ...result,
      unavailable: entry.overflow + workflows.overflow,
    });
  }
  /** Reads a file again only when it changed; an unreadable file keeps its last state. */
  async update(entry, file) {
    const stat = await regularFile(file);
    if (!stat) return;
    const known = entry.files.get(file);
    if (known && current(known, stat)) return;
    entry.reads++;
    entry.files.set(
      file,
      await readAgentUsage(file, known).catch((error) =>
        missing(error) ? null : (known ?? null),
      ),
    );
  }
  async workflowFiles(directory) {
    const workflows = path.join(directory, "workflows");
    const none = { files: [], overflow: 0 };
    const stat = await fs.lstat(workflows).catch(() => null);
    if (!stat?.isDirectory() || !(await inside(workflows, directory))) return none;
    const names = await fs.readdir(workflows).catch((error) => {
      if (missing(error)) return [];
      throw error;
    });
    const files = [];
    let overflow = 0;
    for (const name of names.filter((value) => WORKFLOW_DIR.test(value)).sort()) {
      const folder = path.join(workflows, name);
      if (!(await fs.lstat(folder).catch(() => null))?.isDirectory()) continue;
      for (const file of (await fs.readdir(folder).catch(() => []))
        .filter((value) => AGENT_FILE.test(value))
        .sort()) {
        if (files.length >= this.maxFiles) {
          overflow++;
          continue;
        }
        files.push(path.join(folder, file));
      }
    }
    return { files, overflow };
  }
  summarize(entry, directory, workflowFiles, top) {
    const agents = {},
      toolUses = {},
      current = new Set(workflowFiles),
      present = new Set();
    let observedAt = null;
    const note = (totals) => {
      if (totals?.observedAt && (!observedAt || totals.observedAt > observedAt))
        observedAt = totals.observedAt;
    };
    for (const name of entry.names) {
      const agentId = AGENT_FILE.exec(name)[1];
      const file = path.join(directory, name);
      current.add(file);
      present.add(agentId);
      const meta = entry.metas.get(agentId);
      if (meta?.toolUseId && !meta.parentAgentId) toolUses[meta.toolUseId] = agentId;
      const totals = entry.files.get(file)?.usage.totals();
      note(totals);
      const usage = usageFromTotals(totals);
      if (!usage) continue;
      const owner = top(agentId);
      agents[owner] = Object.hasOwn(agents, owner)
        ? sumUsage([agents[owner], usage])
        : usage;
    }
    const workflow = workflowFiles
      .map((file) => {
        const totals = entry.files.get(file)?.usage.totals();
        note(totals);
        return usageFromTotals(totals);
      })
      .filter(Boolean);
    for (const file of entry.files.keys())
      if (!current.has(file)) entry.files.delete(file);
    for (const agentId of entry.metas.keys())
      if (!present.has(agentId)) entry.metas.delete(agentId);
    for (const agentId of entry.metaFailures.keys())
      if (!present.has(agentId)) entry.metaFailures.delete(agentId);
    return {
      agents,
      toolUses,
      workflow: workflow.length
        ? { count: workflow.length, usage: sumUsage(workflow) }
        : null,
      observedAt,
    };
  }
  publish(entry, result) {
    const digest = JSON.stringify(result && { ...result, observedAt: null });
    if (digest === entry.digest) return;
    const quiet = entry.digest === null && !result;
    entry.digest = digest;
    entry.result = result;
    if (!quiet) this.notify(entry);
  }
  /**
   * Each notification makes clients re-read the chat, which peeks again; pacing
   * them keeps a writing subagent from turning that into a busy loop. The last
   * change within an interval is announced when the interval ends.
   */
  notify(entry) {
    if (entry.timer) return;
    const wait = entry.notifiedAt + this.interval - this.now();
    const send = () => {
      entry.timer = null;
      if (this.closed || this.entries.get(entry.session.id) !== entry) return;
      entry.notifiedAt = this.now();
      void Promise.resolve(
        this.onUpdated?.({ session: entry.session, id: entry.id }),
      ).catch(() => {});
    };
    if (wait <= 0) return send();
    entry.timer = this.setTimer(send, wait);
    entry.timer?.unref?.();
  }
  forget(entry) {
    if (entry.timer) this.clearTimer(entry.timer);
    entry.timer = null;
  }
  close() {
    this.closed = true;
    for (const entry of this.entries.values()) this.forget(entry);
    this.entries.clear();
  }
}
