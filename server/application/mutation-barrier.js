import { AsyncLocalStorage } from "node:async_hooks";

/** Fair shared mutation leases and exclusive short application snapshots. */
export class MutationBarrier {
  constructor() {
    this.context = new AsyncLocalStorage();
    this.queue = [];
    this.active = 0;
    this.exclusive = false;
  }
  acquire(exclusive) {
    return new Promise((resolve) => {
      this.queue.push({ exclusive, resolve });
      this.drain();
    });
  }
  drain() {
    if (this.exclusive) return;
    while (this.queue.length) {
      const next = this.queue[0];
      if (next.exclusive && this.active) return;
      this.queue.shift();
      this.active++;
      this.exclusive = next.exclusive;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        if (next.exclusive) this.exclusive = false;
        this.drain();
      });
      if (next.exclusive) return;
    }
  }
  async run(fn) {
    if (this.hasLease()) return fn();
    const release = await this.acquire(false);
    const lease = { active: true };
    try {
      return await this.context.run(lease, fn);
    } finally {
      lease.active = false;
      release();
    }
  }
  async snapshot(fn) {
    if (this.hasLease()) throw Error("Cannot upgrade an active mutation to a snapshot.");
    const release = await this.acquire(true);
    const lease = { active: true };
    try {
      return await this.context.run(lease, fn);
    } finally {
      lease.active = false;
      release();
    }
  }
  hasLease() {
    return this.context.getStore()?.active === true;
  }
}

/** Hold the lease for the actual handler promise, including after client disconnect. */
export function guardMutations(router, barrier) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const handler of layer.route.stack) {
      const original = handler.handle;
      if (original.length > 3) continue;
      handler.handle = function (req, res, next) {
        if (["GET", "HEAD", "OPTIONS"].includes(req.method))
          return original(req, res, next);
        return barrier.run(() => original(req, res, next));
      };
    }
  }
  return router;
}
