import { EventEmitter } from "node:events";
export class AssistantEvents extends EventEmitter {
  constructor() {
    super();
    // Every live topic instance that follows the agents adds one listener while
    // someone subscribes and removes it when the last one leaves; each user has her
    // own instances (live-me-topics.js), so their number grows with users and tabs.
    this.setMaxListeners(0);
  }
  publish(event) {
    this.emit("update", event);
  }
  subscribe(listener) {
    this.on("update", listener);
    return () => this.off("update", listener);
  }
  close() {
    this.emit("close");
    this.removeAllListeners();
  }
}
