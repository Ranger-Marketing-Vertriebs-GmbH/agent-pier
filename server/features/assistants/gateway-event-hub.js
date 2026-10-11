// Gateway events by name, session-scoped ones included (a live exec approval names
// its session). Chat frames stay with the conversation path in the assistant
// service. Events sent while disconnected are lost, so every ready runs each
// registered resync once.
export class GatewayEventHub {
  constructor() {
    this.handlers = new Map();
    this.resyncs = [];
  }
  on(name, handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push(handler);
  }
  onReady(resync) {
    this.resyncs.push(resync);
  }
  bind(client) {
    this.unsubscribe?.();
    this.unsubscribe = client?.subscribe((frame) => {
      if (frame.event === "chat") return;
      for (const handler of this.handlers.get(frame.event) || []) {
        try {
          handler(frame.payload);
        } catch {
          /* One failing handler must not stop the others. */
        }
      }
    });
  }
  ready() {
    for (const resync of this.resyncs)
      Promise.resolve()
        .then(resync)
        .catch(() => {});
  }
}
