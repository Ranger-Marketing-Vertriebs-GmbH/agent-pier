import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { privateDirectory } from "../../lib/storage.js";

// Extracted attachment text for the attachment-text search, one 0600 JSON file per
// attachment under `<root>/<accountId>/<key>.json`, kept under the data folder and
// never in a backup (mail/ only travels as the sealed account list). The files stay
// within a byte budget: when a write goes over it, the least recently used files are
// removed down to 90 % of it, so a full cache is not scanned again on every write. A
// failed read or write never fails the search; it only misses the cache.

const accountName = /^[A-Za-z0-9_-]{1,64}$/;
const keyName = /^[0-9a-f]{64}$/;
const failureCode = /^MAIL_[A-Z_]{1,40}$/;
const lowWater = 0.9;

// The entry as stored and as returned: text, or the code of a failed extraction.
function entryOf(value) {
  if (value && typeof value.failed === "string" && failureCode.test(value.failed))
    return { failed: value.failed };
  if (value && typeof value.text === "string" && typeof value.truncated === "boolean")
    return { text: value.text, truncated: value.truncated };
  return null;
}

export class MailTextCache {
  constructor({ root, budgetBytes = 268_435_456, identity = () => null }) {
    this.root = path.resolve(root);
    this.budgetBytes = budgetBytes;
    // The mailbox an account reaches now (server and login), part of every key.
    this.identity = identity;
    // Bytes of all entries; counted on the first write, then kept up to date.
    this.total = null;
    // Accounts removed in this process: a search still running writes nothing more.
    this.removed = new Set();
    // Per account, raised whenever its text is dropped (another mailbox, removal): a
    // write carrying an older generation comes from a search that began before.
    this.generations = new Map();
  }

  /**
   * The cache key of one attachment: SHA-256 hex of its joined fields with the
   * account's mailbox identity and generation, so text of another mailbox, or text
   * dropped while its files could not be deleted, is never found again, not even
   * after a restart.
   */
  key({ accountId, folder, uidValidity, uid, part }) {
    const scope = [this.identity(accountId), this.generation(accountId)];
    return createHash("sha256")
      .update(
        JSON.stringify([accountId, folder, uidValidity, uid, part, ...scope].map(String)),
      )
      .digest("hex");
  }

  file(accountId, key) {
    if (!accountName.test(String(accountId)) || !keyName.test(String(key))) return null;
    return path.join(this.root, accountId, `${key}.json`);
  }

  /** The account's current generation; a search takes it when it starts. */
  generation(accountId) {
    return this.generations.get(accountId) ?? 0;
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
   * then rename), then evicts the oldest entries over the budget. A `generation`
   * older than the account's drops the write. Returns whether the entry was stored;
   * never throws.
   */
  set(accountId, key, value, generation = this.generation(accountId)) {
    const file = this.file(accountId, key);
    const entry = entryOf(value);
    if (!file || !entry || this.removed.has(accountId)) return false;
    if (generation !== this.generation(accountId)) return false;
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

  // Removes the least recently used entries until the rest fit 90 % of the budget.
  evict() {
    const items = this.scan().sort((a, b) => a.used - b.used);
    let total = items.reduce((sum, item) => sum + item.size, 0);
    for (const item of items) {
      if (total <= this.budgetBytes * lowWater) break;
      try {
        fs.rmSync(item.file, { force: true });
        total -= item.size;
      } catch {}
    }
    this.total = total;
  }

  /** Removes the account's cached text; nothing is written for it any more. */
  removeAccount(accountId) {
    if (!accountName.test(String(accountId))) return;
    this.removed.add(accountId);
    this.clearAccount(accountId);
  }

  /** Removes the account's cached text (its connection now reaches another mailbox). */
  clearAccount(accountId) {
    if (!accountName.test(String(accountId))) return;
    this.generations.set(accountId, this.generation(accountId) + 1);
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
