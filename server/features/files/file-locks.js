import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

const covers = (a, b) => a === b || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
const overlaps = (a, b) => a.some((x) => b.some((y) => covers(x, y) || covers(y, x)));

/** Paths must already be canonical. Fairness applies to overlapping waiters only. */
export class PathLocks {
  constructor() {
    this.context = new AsyncLocalStorage();
    this.active = new Set();
    this.queue = [];
  }
  hasLease() {
    return this.context.getStore()?.active === true;
  }
  detached(action) {
    return this.context.exit(action);
  }
  async withPaths(paths, action, signal) {
    if (
      !Array.isArray(paths) ||
      paths.some(
        (p) =>
          typeof p !== "string" ||
          !path.isAbsolute(p) ||
          path.normalize(p) !== p ||
          p.includes("\0"),
      )
    )
      throw new TypeError("Path locks require canonical absolute paths.");
    signal?.throwIfAborted();
    paths = [...new Set(paths)].sort();
    const held = this.context.getStore();
    if (held?.active) {
      if (!paths.every((p) => held.paths.some((parent) => covers(parent, p))))
        throw new Error("Cannot enlarge an active path lease.");
      return action();
    }
    const lease = await new Promise((resolve, reject) => {
      const waiter = { paths, resolve, reject, signal };
      waiter.abort = () => {
        this.queue = this.queue.filter((item) => item !== waiter);
        reject(signal.reason);
        this.drain();
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
      this.drain();
    });
    try {
      signal?.throwIfAborted();
      return await this.context.run(lease, action);
    } finally {
      lease.active = false;
      this.active.delete(lease);
      this.drain();
    }
  }
  drain() {
    const blocked = [];
    for (const waiter of [...this.queue]) {
      if (
        [...this.active, ...blocked].some((item) => overlaps(item.paths, waiter.paths))
      ) {
        blocked.push(waiter);
        continue;
      }
      this.queue.splice(this.queue.indexOf(waiter), 1);
      waiter.signal?.removeEventListener("abort", waiter.abort);
      const lease = { paths: waiter.paths, active: true };
      this.active.add(lease);
      waiter.resolve(lease);
    }
  }
}
