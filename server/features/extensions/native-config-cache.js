import fs from "node:fs";

/** Total text a cache keeps: one configuration at the 64 MiB read limit fits. */
export const CONFIG_CACHE_BUDGET = 96 * 1024 * 1024;
const racyMs = 2000;

const signature = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
function real(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * Parsed native CLI configurations by real path, so an unchanged file is parsed once
 * however often it is read (a large ~/.claude.json takes seconds to parse). An entry
 * holds while the file's device, inode, size and modification time are unchanged.
 * A file modified within `racyMs` of being cached may have changed again inside the
 * file system's timestamp granularity: its text is compared before the entry is used.
 *
 * The cache keeps at most `budget` characters of text (the cost proxy for text and
 * data together), dropping the least recently used entries first; a file larger than
 * the budget is never cached. Text and frozen data are held strongly, the tree weakly.
 */
export class ConfigCache {
  constructor({ budget = CONFIG_CACHE_BUDGET } = {}) {
    this.budget = budget;
    this.entries = new Map();
    this.bytes = 0;
  }

  /**
   * The cached `{ text, data, tree }` of `file` for `tool` while `stat` matches, or
   * null. `readText` reads the file's text for a racy entry. A hit is most recent.
   */
  cached(file, tool, stat, readText) {
    const key = real(file);
    const entry = key && this.entries.get(key);
    if (!entry || entry.tool !== tool || entry.signature !== signature(stat)) return null;
    if (stat.mtimeMs >= entry.at - racyMs && readText() !== entry.text) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { text: entry.text, data: entry.data, tree: entry.tree?.deref() ?? null };
  }

  /** Caches the parse of `text`, which `file` held while `stat` was taken. */
  remember(file, tool, stat, { text, data, tree }) {
    const key = real(file);
    if (!key) return;
    this.drop(key);
    if (text.length > this.budget) return;
    this.entries.set(key, {
      tool,
      signature: signature(stat),
      text,
      data,
      tree: tree ? new WeakRef(tree) : null,
      at: Date.now(),
    });
    this.bytes += text.length;
    while (this.bytes > this.budget) this.drop(this.entries.keys().next().value);
  }

  /** Drops what is cached for `file`: it is being written or did not match. */
  forget(file) {
    const key = real(file);
    if (key) this.drop(key);
  }

  drop(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.text.length;
  }
}

/** The process's cache of native configuration reads. */
export const configCache = new ConfigCache();
