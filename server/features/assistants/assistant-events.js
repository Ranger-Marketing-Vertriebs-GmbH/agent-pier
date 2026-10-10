import { EventEmitter } from "node:events";
export class AssistantEvents extends EventEmitter {
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
