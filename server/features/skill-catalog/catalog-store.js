import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { privateDirectory, problem, readJSON, writePrivate } from "../../lib/storage.js";
import { safePath } from "../extensions/mcp-config.js";
import { skillDigest } from "../extensions/skill-digest.js";
import { readOnlyMode, writeSkillFiles } from "../extensions/skill-files.js";
import { skillName } from "../extensions/skill-packages.js";
import { contentHash } from "../extensions/skill-scan.js";

/** lstat-based: a link or file in place of a folder still counts as present. */
const present = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
/** Makes every folder below `file` writable (never following links) so rmSync can empty it. */
function makeRemovable(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
    if (!stat.isDirectory()) return;
    fs.chmodSync(file, 0o700);
    for (const name of fs.readdirSync(file)) makeRemovable(path.join(file, name));
  } catch {
    /* rmSync reports what still cannot be removed. */
  }
}
/** Removes a file, folder or link; a link goes, its target stays. */
const remove = (file) => {
  makeRemovable(file);
  fs.rmSync(file, { recursive: true, force: true });
};
/** Removes whatever is at `file` unless it is a real folder. */
const clearNonDirectory = (file) => {
  if (present(file) && !fs.lstatSync(file).isDirectory()) remove(file);
};
const quietly = (fn) => {
  try {
    fn();
  } catch {
    /* Best-effort cleanup; sweep() removes what is left over. */
  }
};

/** Relative paths of the files below `dir` that carry an execute bit, sorted. */
function executablesOf(dir, relative = "") {
  const found = [];
  for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...executablesOf(dir, name));
    else if (fs.lstatSync(path.join(dir, name)).mode & 0o111) found.push(name);
  }
  return found.sort();
}

/** chmod only when the bits differ, so an intact copy keeps its change time. */
function setMode(file, wanted) {
  if ((fs.lstatSync(file).mode & 0o777) !== wanted) fs.chmodSync(file, wanted);
}

/** Sets the catalog modes: folders 0o700, files 0o400, `executables` 0o500. */
function applyModes(dir, executables, relative = "") {
  const folder = path.join(dir, relative);
  setMode(folder, 0o700);
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) applyModes(dir, executables, name);
    else if (entry.isFile())
      setMode(path.join(dir, name), executables.has(name) ? 0o500 : 0o400);
  }
}

/**
 * What lstat says about every entry below `dir` (name, kind, inode, size, mode,
 * modification and change time in ns), and the newest of those times. Any write,
 * chmod, rename or replacement changes it: the change time cannot be set back.
 */
function statSignature(dir) {
  const parts = [];
  let newest = 0n;
  const walk = (relative) => {
    const folder = path.join(dir, relative);
    for (const name of fs.readdirSync(folder).sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(path.join(dir, rel), { bigint: true });
      if (stat.ctimeNs > newest) newest = stat.ctimeNs;
      if (stat.mtimeNs > newest) newest = stat.mtimeNs;
      parts.push(
        `${rel}\0${stat.mode}\0${stat.ino}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}`,
      );
      if (stat.isDirectory()) walk(rel);
    }
  };
  const top = fs.lstatSync(dir, { bigint: true });
  if (!top.isDirectory()) return null;
  newest = top.ctimeNs > top.mtimeNs ? top.ctimeNs : top.mtimeNs;
  parts.push(`.\0${top.mode}\0${top.ino}\0${top.mtimeNs}\0${top.ctimeNs}`);
  walk("");
  return { signature: parts.join("\n"), newest };
}

/** Copies a stored version file by file (never following links) with catalog modes. */
function copySkill(from, to, executables, relative = "") {
  fs.mkdirSync(path.join(to, relative), { mode: 0o700 });
  for (const entry of fs.readdirSync(path.join(from, relative), {
    withFileTypes: true,
  })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) copySkill(from, to, executables, name);
    else if (entry.isFile()) {
      const fd = fs.openSync(
        path.join(from, name),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      let data;
      try {
        data = fs.readFileSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.writeFileSync(path.join(to, name), data, {
        mode: readOnlyMode(executables.has(name) ? 0o100 : 0),
        flag: "wx",
      });
    } else throw problem(serverMessages.extensions.linkedPathsReadOnly, 409);
  }
}

/**
 * The agent skill catalog below `root`: `catalog.json` holds the records,
 * `store/<name>/<digest>/` the current version of each skill, `skills/<name>/` the live
 * copy OpenClaw scans, and `staging/` everything in flight. Staging and the old copy of
 * a swap stay outside `skills/`, so OpenClaw never sees two `SKILL.md` with one name.
 * Digests ignore permission bits (a backup restores files as 0600); `verify` re-applies
 * the modes from `executables`. A cached verify (before each turn) re-hashes a copy
 * only when its stat signature changed since it last matched; a copy changed less than
 * `settleMs` before it was hashed is never cached, since a coarse file system clock
 * could give a later change the same times.
 */
export class SkillCatalogStore {
  constructor({ root, settleMs = 2000 }) {
    this.settleMs = settleMs;
    // Folder -> { digest, signature } of the last matching hash.
    this.verified = new Map();
    this.root = root;
    this.file = path.join(root, "catalog.json");
    this.liveRoot = path.join(root, "skills");
    this.stagingRoot = path.join(root, "staging");
    this.storeRoot = path.join(root, "store");
    // Names whose last verify hit an I/O error; dropped until a verify passes.
    this.failed = new Set();
  }
  /** One of the fixed sub-roots as a real private folder (a planted link is removed). */
  subRoot(dir) {
    clearNonDirectory(dir);
    return privateDirectory(dir);
  }
  /**
   * A single-segment entry below `parent`. A link planted there is removed (the link
   * only), so it reads as a missing copy instead of failing every later call.
   */
  entry(parent, name) {
    const target = path.join(parent, name);
    if (!name || name === "." || name === ".." || path.dirname(target) !== parent)
      throw problem(serverMessages.extensions.targetOutsideProfile, 409);
    if (present(target) && fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
    safePath(target, this.root);
    return target;
  }
  livePath(name) {
    return this.entry(this.subRoot(this.liveRoot), name);
  }
  storePath(name, digest) {
    const folder = this.entry(this.subRoot(this.storeRoot), name);
    if (!digest) return folder;
    clearNonDirectory(folder);
    return this.entry(folder, digest);
  }
  stagingPath() {
    return this.entry(this.subRoot(this.stagingRoot), randomUUID());
  }
  list() {
    return readJSON(this.file, []);
  }
  byId(id) {
    return this.list().find((record) => record.id === id);
  }
  byName(name) {
    return this.list().find((record) => record.name === name);
  }
  names() {
    return new Set(this.list().map((record) => record.name));
  }
  digestOf(dir) {
    return skillDigest(dir, { modes: false });
  }
  /**
   * Whether `dir` holds exactly the content with `digest` (modes aside). `cached`
   * trusts an unchanged stat signature of an earlier match instead of hashing again.
   */
  intact(dir, digest, { cached = false } = {}) {
    try {
      if (!fs.statSync(dir).isDirectory()) return false;
      const stats = cached ? statSignature(dir) : null;
      const known = this.verified.get(dir);
      if (stats && known?.digest === digest && known.signature === stats.signature)
        return true;
      this.verified.delete(dir);
      const ok = this.digestOf(dir) === digest;
      const settled = BigInt(Date.now() - this.settleMs) * 1_000_000n;
      if (ok && stats && stats.newest < settled)
        this.verified.set(dir, { digest, signature: stats.signature });
      return ok;
    } catch {
      this.verified.delete(dir);
      return false;
    }
  }
  /**
   * Copies `storeDir` into staging and swaps it in as the live copy. Returns a rollback
   * and the old copy (in staging), which the caller removes once its record is written.
   */
  swapLive(name, storeDir, executables) {
    const live = this.livePath(name);
    const fresh = this.stagingPath();
    const old = `${fresh}-old`;
    let swapped = false;
    const rollback = () => {
      if (swapped) remove(live);
      if (!present(live) && present(old)) fs.renameSync(old, live);
      remove(fresh);
    };
    try {
      copySkill(storeDir, fresh, executables);
      if (present(live)) fs.renameSync(live, old);
      fs.renameSync(fresh, live);
      swapped = true;
    } catch (error) {
      rollback();
      throw error;
    }
    return { old, rollback };
  }
  /** Rewrites a changed or missing store copy from an intact live copy. */
  repairStore(name, storeDir, live, record) {
    const fresh = this.stagingPath();
    try {
      copySkill(live, fresh, new Set(record.executables || []));
      if (!this.intact(fresh, record.digest))
        throw problem(serverMessages.extensions.skillSaveFailed);
      remove(storeDir);
      this.subRoot(this.storePath(name));
      fs.renameSync(fresh, storeDir);
    } finally {
      remove(fresh);
    }
  }
  /** Stores a new skill, or the next version of the catalog skill with the same name. */
  write(pack, meta) {
    if (!skillName(pack?.name))
      throw problem(serverMessages.extensions.invalidSkillIdentity);
    const { name } = pack;
    const records = this.list();
    const previous = records.find((record) => record.name === name);
    const stage = this.stagingPath();
    let created;
    let digest;
    let swap;
    let next;
    try {
      writeSkillFiles(stage, pack.files, { readOnly: true });
      digest = skillDigest(stage, { modes: false });
      const executables = executablesOf(stage);
      const storeDir = this.storePath(name, digest);
      if (!this.intact(storeDir, digest)) {
        remove(storeDir);
        this.subRoot(this.storePath(name));
        fs.renameSync(stage, storeDir);
        created = storeDir;
      }
      swap = this.swapLive(name, storeDir, new Set(executables));
      const now = new Date().toISOString();
      next = {
        id: previous?.id || randomUUID(),
        name,
        description: pack.description,
        version: (previous?.version || 0) + 1,
        digest,
        contentHash: contentHash(pack.files),
        executables,
        importKind: meta.importKind,
        ...(meta.source?.url ? { source: { url: meta.source.url } } : {}),
        ...(meta.origin ? { origin: meta.origin } : {}),
        scan: {
          verdict: meta.scan?.verdict,
          rules: meta.scan?.rules || [],
          overridden: Boolean(meta.scan?.overridden),
        },
        needsSettings: Boolean(meta.needsSettings),
        installedAt: previous?.installedAt || now,
        updatedAt: now,
      };
      writePrivate(
        this.file,
        previous
          ? records.map((record) => (record.id === previous.id ? next : record))
          : [...records, next],
      );
    } catch (error) {
      quietly(() => swap?.rollback());
      quietly(() => remove(stage));
      // A new store version goes; one the current record still names stays.
      if (created && digest !== previous?.digest) quietly(() => remove(created));
      throw error.status ? error : problem(serverMessages.extensions.skillSaveFailed);
    }
    quietly(() => remove(swap.old));
    quietly(() => remove(stage));
    if (previous && previous.digest !== digest)
      quietly(() => remove(this.storePath(name, previous.digest)));
    // A fresh, intact copy: the next verify decides again.
    this.failed.delete(name);
    return next;
  }
  /** Drops the record first; a crash before the files go leaves them to sweep(). */
  remove(id) {
    const records = this.list();
    const record = records.find((item) => item.id === id);
    if (!record) throw problem(serverMessages.extensions.skillNotInstalledHere, 404);
    writePrivate(
      this.file,
      records.filter((item) => item.id !== id),
    );
    remove(this.livePath(record.name));
    remove(this.storePath(record.name));
    this.failed.delete(record.name);
    return record;
  }
  /**
   * Checks each live copy against its record: a changed or missing copy is restored from
   * the store; when the store copy does not match either, the live copy goes and the
   * record is marked `damaged`. Modes are re-applied to every intact copy.
   *
   * Only the two digest checks decide `damaged`. An I/O error while re-applying modes,
   * repairing or restoring marks nothing damaged: the name is `failed` (kept in
   * `this.failed` and `dropped` until a later verify passes), a live copy that was not
   * intact is removed best-effort so OpenClaw cannot load it, and every other record is
   * still checked. The marks are saved; nothing is thrown for one record's failure.
   * `cached` (the check before each turn) skips hashing copies whose stat signature
   * is unchanged since they last matched; a Gateway start always hashes.
   */
  verify(names, { cached = false } = {}) {
    const wanted = names ? new Set(names) : null;
    const restored = [];
    const damaged = [];
    const failed = [];
    const records = this.list();
    for (const record of records) {
      if (record.damaged || (wanted && !wanted.has(record.name))) continue;
      const state = {};
      try {
        this.verifyOne(record, { restored, damaged, cached }, state);
        this.failed.delete(record.name);
      } catch {
        failed.push(record.name);
        this.failed.add(record.name);
        if (state.liveIntact !== true) quietly(() => remove(this.livePath(record.name)));
      }
    }
    if (damaged.length) {
      const marked = new Set(damaged);
      writePrivate(
        this.file,
        records.map((record) =>
          marked.has(record.name) ? { ...record, damaged: true } : record,
        ),
      );
    }
    return { restored, damaged, failed };
  }
  verifyOne(record, { restored, damaged, cached }, state = {}) {
    const executables = new Set(record.executables || []);
    const live = this.livePath(record.name);
    const storeDir = this.storePath(record.name, record.digest);
    const liveIntact = (state.liveIntact = this.intact(live, record.digest, { cached }));
    const storeIntact = this.intact(storeDir, record.digest, { cached });
    if (liveIntact) {
      applyModes(live, executables);
      if (storeIntact) applyModes(storeDir, executables);
      else this.repairStore(record.name, storeDir, live, record);
    } else if (storeIntact) {
      applyModes(storeDir, executables);
      const { old } = this.swapLive(record.name, storeDir, executables);
      quietly(() => remove(old));
      restored.push(record.name);
    } else {
      damaged.push(record.name);
      remove(live);
    }
  }
  /**
   * The given names that are catalog skills and bundled, `needsSettings`, damaged or
   * failed in the last verify.
   */
  dropped(names, bundled = new Set()) {
    const records = new Map(this.list().map((record) => [record.name, record]));
    return [...new Set(names)]
      .filter((name) => {
        const record = records.get(name);
        return (
          record &&
          (bundled.has(name) ||
            record.needsSettings ||
            record.damaged ||
            this.failed.has(name))
        );
      })
      .sort();
  }
  /** Removes every live copy (best effort): OpenClaw then loads no catalog skill. */
  clearLive() {
    for (const name of fs.readdirSync(this.subRoot(this.liveRoot)))
      quietly(() => remove(path.join(this.liveRoot, name)));
  }
  /** Removes staging leftovers, unreferenced store versions and live folders without a record. */
  sweep() {
    const records = new Map(this.list().map((record) => [record.name, record]));
    // Names come from readdir below the fixed sub-roots, which subRoot() keeps real
    // folders; remove() takes a link itself, never its target.
    const entries = (dir) => fs.readdirSync(this.subRoot(dir));
    for (const entry of entries(this.stagingRoot))
      remove(path.join(this.stagingRoot, entry));
    for (const name of entries(this.storeRoot)) {
      const folder = path.join(this.storeRoot, name);
      const record = records.get(name);
      if (!record || !fs.lstatSync(folder).isDirectory()) {
        remove(folder);
        continue;
      }
      for (const digest of fs.readdirSync(folder))
        if (digest !== record.digest) remove(path.join(folder, digest));
    }
    for (const name of entries(this.liveRoot)) {
      const record = records.get(name);
      if (!record || record.damaged) remove(path.join(this.liveRoot, name));
    }
  }
}
