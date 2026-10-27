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
const remove = (file) => fs.rmSync(file, { recursive: true, force: true });
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

/** Sets the catalog modes: folders 0o700, files 0o400, `executables` 0o500. */
function applyModes(dir, executables, relative = "") {
  const folder = path.join(dir, relative);
  fs.chmodSync(folder, 0o700);
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) applyModes(dir, executables, name);
    else if (entry.isFile())
      fs.chmodSync(path.join(dir, name), executables.has(name) ? 0o500 : 0o400);
  }
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
 * the modes from `executables`.
 */
export class SkillCatalogStore {
  constructor({ root }) {
    this.root = root;
    this.file = path.join(root, "catalog.json");
    this.liveRoot = path.join(root, "skills");
    this.stagingRoot = path.join(root, "staging");
    this.storeRoot = path.join(root, "store");
  }
  path(...parts) {
    const target = path.join(this.root, ...parts);
    safePath(target, this.root);
    return target;
  }
  livePath(name) {
    return this.path("skills", name);
  }
  storePath(name, digest) {
    return this.path("store", name, ...(digest ? [digest] : []));
  }
  stagingPath(name = randomUUID()) {
    privateDirectory(this.stagingRoot);
    return this.path("staging", name);
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
  /** Whether `dir` holds exactly the content with `digest` (modes aside). */
  intact(dir, digest) {
    try {
      return (
        fs.statSync(dir).isDirectory() && skillDigest(dir, { modes: false }) === digest
      );
    } catch {
      return false;
    }
  }
  /**
   * Copies `storeDir` into staging and swaps it in as the live copy. Returns a rollback
   * and the old copy (in staging), which the caller removes once its record is written.
   */
  swapLive(name, storeDir, executables) {
    privateDirectory(this.liveRoot);
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
  repairStore(name, storeDir, live, executables) {
    const fresh = this.stagingPath();
    try {
      copySkill(live, fresh, executables);
      remove(storeDir);
      privateDirectory(this.storePath(name));
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
        privateDirectory(this.storePath(name));
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
    return record;
  }
  /**
   * Checks each live copy against its record: a changed or missing copy is restored from
   * the store; when the store copy changed too, the live copy goes and the record is
   * marked `damaged`. Modes are re-applied to every intact copy.
   */
  verify(names) {
    const wanted = names ? new Set(names) : null;
    const restored = [];
    const damaged = [];
    let records = this.list();
    for (const record of records) {
      if (record.damaged || (wanted && !wanted.has(record.name))) continue;
      const executables = new Set(record.executables || []);
      const live = this.livePath(record.name);
      const storeDir = this.storePath(record.name, record.digest);
      try {
        if (this.intact(live, record.digest)) {
          applyModes(live, executables);
          if (this.intact(storeDir, record.digest)) applyModes(storeDir, executables);
          else this.repairStore(record.name, storeDir, live, executables);
          continue;
        }
        if (this.intact(storeDir, record.digest)) {
          applyModes(storeDir, executables);
          const { old } = this.swapLive(record.name, storeDir, executables);
          quietly(() => remove(old));
          restored.push(record.name);
          continue;
        }
      } catch {
        /* A copy that cannot be read or restored counts as damaged. */
      }
      remove(live);
      damaged.push(record.name);
    }
    if (damaged.length) {
      const marked = new Set(damaged);
      records = records.map((record) =>
        marked.has(record.name) ? { ...record, damaged: true } : record,
      );
      writePrivate(this.file, records);
    }
    return { restored, damaged };
  }
  /** The given names that are catalog skills and bundled, `needsSettings` or damaged. */
  dropped(names, bundled = new Set()) {
    const records = new Map(this.list().map((record) => [record.name, record]));
    return [...new Set(names)]
      .filter((name) => {
        const record = records.get(name);
        return record && (bundled.has(name) || record.needsSettings || record.damaged);
      })
      .sort();
  }
  /** Removes staging leftovers, unreferenced store versions and live folders without a record. */
  sweep() {
    const records = new Map(this.list().map((record) => [record.name, record]));
    const entries = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
    for (const entry of entries(this.stagingRoot)) remove(this.path("staging", entry));
    for (const name of entries(this.storeRoot)) {
      const record = records.get(name);
      if (!record) {
        remove(this.storePath(name));
        continue;
      }
      for (const digest of entries(this.storePath(name)))
        if (digest !== record.digest) remove(this.storePath(name, digest));
    }
    for (const name of entries(this.liveRoot)) {
      const record = records.get(name);
      if (!record || record.damaged) remove(this.livePath(name));
    }
  }
}
