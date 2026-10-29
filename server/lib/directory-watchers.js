// fs.watch handles of folders for the live topics that follow files (the editor's
// file.meta, the AgentBus queue): one handle per folder, shared by every listener
// of a name in it, closed with the last one, and capped. A folder is keyed by its
// path and its `dev:ino`, so a folder deleted and created again gets a new handle.
// A handle that fails, closes by itself, reports a rename of its own folder, or whose
// folder was replaced (checked on every `rename` or nameless event it reports), is
// closed and its listeners are called, so they watch again.
//
// Linux inotify does not follow a path: deleting the watched folder sends
// IN_DELETE_SELF and IN_IGNORED, which Node reports as a `rename` naming the folder
// itself (or not at all), and the watch is dead even if a folder of that name comes
// back. The re-created folder often gets the same inode number, so `dev:ino` alone
// cannot tell it apart; the check compares the birth time too where the file system
// records one.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

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
   * Calls `listener(filename, type)` when an entry of `directory` named `names` (a name,
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
      folder = { id, directory, identity, handle, names: new Map(), dropped: false };
      // The folder's birth time as the handle starts (null where none is recorded).
      folder.birth = identity ? birthOf(directory) : Promise.resolve(null);
      const current = folder;
      handle.on("change", (type, filename) => this.changed(current, type, filename));
      handle.on("error", () => this.failed(current));
      // A handle that closes without being dropped (a dead inotify watch) is gone.
      handle.on?.("close", () => {
        if (!current.dropped) this.failed(current);
      });
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
    const named = filename !== null && filename !== undefined;
    // inotify reports the watched folder's own deletion as a rename of itself.
    if (
      type === "rename" &&
      named &&
      foldName(filename) === foldName(path.basename(folder.directory))
    ) {
      if (this.folders.get(folder.id) === folder) this.failed(folder);
      return;
    }
    // A folder removed or replaced may leave its handle silent: any rename or
    // nameless event checks that the folder is still the same.
    if ((type === "rename" || !named) && folder.identity) this.verify(folder);
    const records = named
      ? new Set([
          ...(folder.names.get(foldName(filename)) || []),
          ...(folder.names.get(ANY) || []),
        ])
      : this.records(folder);
    for (const { listener } of records) {
      try {
        listener(named ? String(filename) : undefined, type);
      } catch {
        // One listener must not stop the others.
      }
    }
  }
  async verify(folder) {
    let same = false;
    try {
      const stat = await fsp.lstat(folder.directory, { bigint: true });
      const birth = await folder.birth;
      same =
        stat.isDirectory() &&
        `${stat.dev}:${stat.ino}` === folder.identity &&
        (!birth || !stat.birthtimeNs || stat.birthtimeNs === birth);
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
    folder.dropped = true;
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

async function birthOf(directory) {
  try {
    const stat = await fsp.lstat(directory, { bigint: true });
    return stat.birthtimeNs || null;
  } catch {
    return null;
  }
}
