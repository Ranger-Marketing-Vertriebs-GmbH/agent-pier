import { EventEmitter } from "node:events";
export class AssistantEvents extends EventEmitter {
  #watchers = new Set();
  #fanout = (event) => {
    for (const watcher of [...this.#watchers]) watcher(event);
  };
  publish(event) {
    this.emit("update", event);
  }
  /** A service's own lasting listener: one emitter listener each. */
  subscribe(listener) {
    this.on("update", listener);
    return () => this.off("update", listener);
  }
  /**
   * A listener whose number grows with use (an open chat or browser view, a waiting
   * ask, a live topic instance). All of them share one emitter listener, so a dozen
   * open chats stay below Node's leak warning while lasting subscribers keep it.
   */
  watch(listener) {
    const entry = (event) => listener(event);
    if (!this.#watchers.size) this.on("update", this.#fanout);
    this.#watchers.add(entry);
    return () => {
      if (!this.#watchers.delete(entry) || this.#watchers.size) return;
      this.off("update", this.#fanout);
    };
  }
  close() {
    this.emit("close");
    this.#watchers.clear();
    this.removeAllListeners();
  }
}
