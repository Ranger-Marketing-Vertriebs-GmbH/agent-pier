export class AgentBusNotices {
  constructor() {
    this.pending = new Map();
    this.waiters = new Map();
    this.closed = false;
  }
  key(ctx) {
    return `${ctx.launch.id}:${ctx.record.generation}`;
  }
  push(ctx, nativeSessionId, text) {
    if (this.closed) return false;
    const key = this.key(ctx),
      notices = this.pending.get(key) || new Map();
    notices.set(nativeSessionId, { nativeSessionId, text });
    while (notices.size > 32) notices.delete(notices.keys().next().value);
    this.pending.set(key, notices);
    const waiter = this.waiters.get(key);
    if (waiter) waiter();
    return Boolean(waiter);
  }
  wait(ctx, signal) {
    const key = this.key(ctx);
    if (this.closed || signal.aborted) return Promise.resolve([]);
    if (this.waiters.has(key))
      throw Error("AgentBus notification connection already active.");
    return new Promise((resolve) => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        this.waiters.delete(key);
        const notices = [...(this.pending.get(key)?.values() || [])];
        this.pending.delete(key);
        resolve(notices);
      };
      this.waiters.set(key, finish);
      signal.addEventListener("abort", finish, { once: true });
      timer = setTimeout(finish, 20000);
      timer.unref();
      if (this.pending.has(key)) finish();
    });
  }
  revoke(id) {
    for (const key of new Set([...this.pending.keys(), ...this.waiters.keys()]))
      if (key.startsWith(`${id}:`)) {
        this.pending.delete(key);
        this.waiters.get(key)?.();
      }
  }
  close() {
    this.closed = true;
    this.pending.clear();
    for (const finish of [...this.waiters.values()]) finish();
  }
}
