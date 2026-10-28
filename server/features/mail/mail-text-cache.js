import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { privateDirectory } from "../../lib/storage.js";

// Extracted attachment text for the attachment-text search, one 0600 JSON file per
// attachment under `<root>/<accountId>/<key>.json`, kept under the data folder and
// never in a backup (mail/ only travels as the sealed account list). The files stay
// within a byte budget: when a write goes over it, the least recently used files are
// removed. A failed read or write never fails the search; it only misses the cache.

const accountName = /^[A-Za-z0-9_-]{1,64}$/;
const keyName = /^[0-9a-f]{64}$/;
const failureCode = /^MAIL_[A-Z_]{1,40}$/;

// The entry as stored and as returned: text, or the code of a failed extraction.
function entryOf(value) {
  if (value && typeof value.failed === "string" && failureCode.test(value.failed))
    return { failed: value.failed };
  if (value && typeof value.text === "string" && typeof value.truncated === "boolean")
    return { text: value.text, truncated: value.truncated };
  return null;
}

export class MailTextCache {
  constructor({ root, budgetBytes = 268_435_456 }) {
    this.root = path.resolve(root);
    this.budgetBytes = budgetBytes;
    // Bytes of all entries; counted on the first write, then kept up to date.
    this.total = null;
  }

  /** The cache key of one attachment: SHA-256 hex of its joined fields. */
  key({ accountId, folder, uidValidity, uid, part }) {
    return createHash("sha256")
      .update([accountId, folder, uidValidity, uid, part].map(String).join("\0"))
      .digest("hex");
  }

  file(accountId, key) {
    if (!accountName.test(String(accountId)) || !keyName.test(String(key))) return null;
    return path.join(this.root, accountId, `${key}.json`);
  }

  /** The entry, or null when there is none or it cannot be read. Marks it as used. */
  get(accountId, key) {
    const file = this.file(accountId, key);
    if (!file) return null;
    try {
      const entry = entryOf(JSON.parse(fs.readFileSync(file, "utf8")));
      if (entry) {
        const now = new Date();
        fs.utimesSync(file, now, now);
      }
      return entry;
    } catch {
      return null;
    }
  }

  /**
   * Stores `{ text, truncated }` or `{ failed: code }` atomically (temporary file,
   * then rename), then evicts the oldest entries over the budget. Returns whether the
   * entry was stored; never throws.
   */
  set(accountId, key, value) {
    const file = this.file(accountId, key);
    const entry = entryOf(value);
    if (!file || !entry) return false;
    const data = Buffer.from(JSON.stringify(entry), "utf8");
    if (data.length > this.budgetBytes) return false;
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      this.total ??= this.scan().reduce((sum, item) => sum + item.size, 0);
      privateDirectory(path.dirname(file));
      let previous = 0;
      try {
        previous = fs.statSync(file).size;
      } catch {}
      fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, file);
      this.total += data.length - previous;
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      this.total = null;
      return false;
    }
    if (this.total > this.budgetBytes) this.evict();
    return true;
  }

  // Every entry with its size and last use; temporary files a crash left are removed
  // (all writes of this process are synchronous, so none is in progress).
  scan() {
    const items = [];
    for (const account of this.list(this.root)) {
      const directory = path.join(this.root, account);
      for (const name of this.list(directory)) {
        const file = path.join(directory, name);
        try {
          if (name.endsWith(".tmp")) fs.rmSync(file, { force: true });
          else if (name.endsWith(".json")) {
            const stat = fs.statSync(file);
            items.push({ file, size: stat.size, used: stat.mtimeMs });
          }
        } catch {}
      }
    }
    return items;
  }

  list(directory) {
    try {
      return fs.readdirSync(directory);
    } catch {
      return [];
    }
  }

  // Removes the least recently used entries until the rest fit the budget.
  evict() {
    const items = this.scan().sort((a, b) => a.used - b.used);
    let total = items.reduce((sum, item) => sum + item.size, 0);
    for (const item of items) {
      if (total <= this.budgetBytes) break;
      try {
        fs.rmSync(item.file, { force: true });
        total -= item.size;
      } catch {}
    }
    this.total = total;
  }

  /** Removes the account's cached text (the account was removed). */
  removeAccount(accountId) {
    if (!accountName.test(String(accountId))) return;
    try {
      fs.rmSync(path.join(this.root, accountId), { recursive: true, force: true });
    } catch {}
    this.total = null;
  }

  /** Removes the cached text of every account not in `accountIds` (startup). */
  removeOrphans(accountIds) {
    const keep = new Set(accountIds);
    for (const name of this.list(this.root))
      if (!keep.has(name))
        try {
          fs.rmSync(path.join(this.root, name), { recursive: true, force: true });
        } catch {}
    this.total = null;
  }
}
