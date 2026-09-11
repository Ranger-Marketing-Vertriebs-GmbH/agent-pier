/** FIFO within a session; creation/replacement remain exclusive across sessions. */
export class SessionOperations {
  constructor(ready) {
    this.ready = ready;
    this.barrier = Promise.resolve();
    this.sessions = new Map();
  }
  run(operation, id) {
    const previous =
      id === undefined
        ? [this.barrier, ...this.sessions.values()]
        : [this.barrier, this.sessions.get(id)];
    const result = Promise.all(previous)
      .then(() => this.ready())
      .then(operation);
    const tail = result.catch(() => {});
    if (id === undefined) {
      this.barrier = tail;
      this.sessions.clear();
    } else {
      this.sessions.set(id, tail);
      tail.then(() => {
        if (this.sessions.get(id) === tail) this.sessions.delete(id);
      });
    }
    return result;
  }
  drain() {
    return Promise.all([this.barrier, ...this.sessions.values()]);
  }
}
