// fs.watch handles of folders for the live topics that follow files (the editor's
// file.meta, the AgentBus queue): one handle per folder, shared by every listener
// of a name in it, closed with the last one, and capped. A folder is keyed by its
// path and its `dev:ino`, so a folder deleted and created again gets a new handle.
// A handle that fails, or whose folder was replaced (checked on every `rename` it
// reports), is closed and its listeners are called, so they watch again.
import fs from "node:fs";
import fsp from "node:fs/promises";

// Names as a case-insensitive file system may report them.
export const foldName = (name) => String(name).normalize("NFC").toLowerCase();
// The key of a listener for every name in its folder (no file name holds a NUL).
const ANY = "\0any";

export class DirectoryWatchers {
  constructor({ watch = fs.watch, maxDirectories = 256 } = {}) {
    this.watch = watch;
    this.maxDirectories = maxDirectories;
    this.folders = new Map();
  }
  get size() {
    return this.folders.size;
  }
  /**
   * Calls `listener(filename)` when an entry of `directory` named `names` (a name,
   * a list of names, or null for any) changes, and `listener()` once when the handle
   * fails. Returns the release function, or null when the cap is reached or the
   * folder cannot be watched. `identity` is the folder's `dev:ino`; the release
   * function's `alive()` turns false once the handle failed: the caller must add again.
   */
  add(directory, names, listener, identity = null) {
    const id = identity ? `${directory}\0${identity}` : directory;
    let folder = this.folders.get(id);
    if (!folder) {
      if (this.folders.size >= this.maxDirectories) return null;
      let handle;
      try {
        handle = this.watch(directory, { persistent: false });
      } catch {
        return null;
      }
      folder = { id, directory, identity, handle, names: new Map() };
      const current = folder;
      handle.on("change", (type, filename) => this.changed(current, type, filename));
      handle.on("error", () => this.failed(current));
      this.folders.set(id, folder);
    }
    const keys =
      names === null ? [ANY] : [...new Set([names].flat().map((name) => foldName(name)))];
    const record = { listener };
    for (const key of keys) {
      if (!folder.names.has(key)) folder.names.set(key, new Set());
      folder.names.get(key).add(record);
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        const listeners = folder.names.get(key);
        listeners?.delete(record);
        if (listeners && !listeners.size) folder.names.delete(key);
      }
      if (!folder.names.size) this.drop(folder);
    };
    release.alive = () => !released && !record.dead;
    return release;
  }
  records(folder) {
    return new Set([...folder.names.values()].flatMap((set) => [...set]));
  }
  changed(folder, type, filename) {
    // A folder removed or replaced may leave its handle silent (inotify follows the
    // old inode): any rename it reports checks that the folder is still the same.
    if (type === "rename" && folder.identity) this.verify(folder);
    const named = filename !== null && filename !== undefined;
    const records = named
      ? new Set([
          ...(folder.names.get(foldName(filename)) || []),
          ...(folder.names.get(ANY) || []),
        ])
      : this.records(folder);
    for (const { listener } of records) {
      try {
        listener(named ? String(filename) : undefined);
      } catch {
        // One listener must not stop the others.
      }
    }
  }
  async verify(folder) {
    let same = false;
    try {
      const stat = await fsp.stat(folder.directory, { bigint: true });
      same = `${stat.dev}:${stat.ino}` === folder.identity;
    } catch {
      same = false;
    }
    if (!same && this.folders.get(folder.id) === folder) this.failed(folder);
  }
  failed(folder) {
    const records = this.records(folder);
    for (const record of records) record.dead = true;
    folder.names.clear();
    this.drop(folder);
    for (const { listener } of records) {
      try {
        listener();
      } catch {
        // As above.
      }
    }
  }
  drop(folder) {
    if (this.folders.get(folder.id) === folder) this.folders.delete(folder.id);
    try {
      folder.handle.close();
    } catch {
      // Already closed.
    }
  }
  close() {
    for (const folder of [...this.folders.values()]) this.drop(folder);
  }
}
