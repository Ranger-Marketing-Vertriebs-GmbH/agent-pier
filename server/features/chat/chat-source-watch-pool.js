import fs from "node:fs";

/** One OS watch per target, shared only within an application's chat streams. */
export class ChatSourceWatchPool {
  constructor({
    watch = fs.watch,
    stat = (file) => fs.promises.stat(file),
    now = Date.now,
  } = {}) {
    Object.assign(this, { watch, stat, now });
    this.entries = new Map();
  }
  subscribe({ file, directory = false, recursive = false }, listener) {
    const key = JSON.stringify([file, directory, recursive]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { file, directory, recursive, listeners: new Set(), closed: false };
      this.entries.set(key, entry);
    }
    entry.listeners.add(listener);
    let active = true;
    const stop = () => {
      if (!active) return;
      active = false;
      entry.listeners.delete(listener);
      if (entry.listeners.size) return;
      entry.closed = true;
      this.retire(entry);
      this.entries.delete(key);
    };
    stop.refresh = () => (active ? this.refresh(entry) : Promise.resolve());
    return stop;
  }
  retire(entry) {
    const watcher = entry.watcher;
    entry.watcher = null;
    watcher?.close();
  }
  report(entry, filename = null) {
    if (!entry.closed) for (const listener of entry.listeners) listener(filename);
  }
  failed(entry) {
    this.retire(entry);
    entry.retryAt = this.now() + Math.min(30000, 1000 * 2 ** (entry.failures || 0));
    entry.failures = Math.min(5, (entry.failures || 0) + 1);
  }
  refresh(entry) {
    if (entry.closed) return Promise.resolve();
    // Several chats can reconcile the same shared directory at once.
    entry.pending ??= this.reconcile(entry).finally(() => (entry.pending = null));
    return entry.pending;
  }
  async reconcile(entry) {
    let info;
    try {
      info = await this.stat(entry.file);
    } catch {
      // Missing files (including a WAL) are retried by the viewer's stat probe.
    }
    if (entry.closed) return;
    const identity =
      info && (entry.directory ? info.isDirectory() : info.isFile())
        ? `${info.dev}:${info.ino}`
        : null;
    const initialized = entry.identity !== undefined;
    const replaced = identity !== entry.identity;
    if (replaced) {
      this.retire(entry);
      entry.identity = identity;
      if (initialized) this.report(entry);
    }
    if (!identity || entry.watcher || this.now() < (entry.retryAt || 0)) return;
    try {
      const watcher = this.watch(
        entry.file,
        { recursive: entry.recursive },
        (event, filename) => {
          if (entry.closed || entry.watcher !== watcher) return;
          entry.failures = 0;
          // File watches follow an inode, not a replacement at the same path.
          // Directory rename events also describe ordinary child creation.
          if (!entry.directory && event === "rename") this.retire(entry);
          this.report(entry, filename == null ? null : String(filename));
        },
      );
      entry.watcher = watcher;
      watcher.on("error", () => {
        if (entry.closed || entry.watcher !== watcher) return;
        this.failed(entry);
        this.report(entry);
      });
      watcher.unref();
      // Recover changes missed during rearming. Initial registration must not
      // invalidate a completed background read; the settle/probe covers its race.
      if (initialized && !replaced) this.report(entry);
    } catch {
      // A transient failure must not prevent the chat read or become a retry loop.
      this.failed(entry);
    }
  }
}
