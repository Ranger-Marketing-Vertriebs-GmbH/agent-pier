import fs from "node:fs";

/**
 * Parsed native CLI configurations by real path, so an unchanged file is parsed once
 * however often it is read (a large ~/.claude.json takes seconds to parse). An entry
 * holds while the file's device, inode, size and modification time are unchanged.
 * A file modified within `racyMs` of being cached may have changed again inside the
 * file system's timestamp granularity: its text is compared before the entry is used.
 * The tree is held weakly; the parsed data is frozen, since every reader shares it.
 */
const limit = 8;
const racyMs = 2000;
const entries = new Map();

const signature = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
function real(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * The cached `{ text, data, tree }` of `file` for `tool` while `stat` matches, or null.
 * `readText` reads the file's text for a racy entry.
 */
export function cachedConfig(file, tool, stat, readText) {
  const key = real(file);
  const entry = key && entries.get(key);
  if (!entry || entry.tool !== tool || entry.signature !== signature(stat)) return null;
  if (stat.mtimeMs >= entry.at - racyMs && readText() !== entry.text) return null;
  entries.delete(key);
  entries.set(key, entry);
  return { text: entry.text, data: entry.data, tree: entry.tree?.deref() ?? null };
}

/** Caches the parse of `text`, which `file` held while `stat` was taken. */
export function rememberConfig(file, tool, stat, { text, data, tree }) {
  const key = real(file);
  if (!key) return;
  entries.delete(key);
  entries.set(key, {
    tool,
    signature: signature(stat),
    text,
    data,
    tree: tree ? new WeakRef(tree) : null,
    at: Date.now(),
  });
  while (entries.size > limit) entries.delete(entries.keys().next().value);
}

/** Drops what is cached for `file`: it is being written or did not match. */
export function forgetConfig(file) {
  const key = real(file);
  if (key) entries.delete(key);
}
