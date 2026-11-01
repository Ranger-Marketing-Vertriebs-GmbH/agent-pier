// Runtime events by the runtime's own frame name (`event`, passed through by the
// runtime port's events.subscribe, runtimes/agent-runtime.js), session-scoped ones
// included: approval events name their session under `request.sessionKey`, not at
// the payload top level. Handlers get the runtime's own payload. Only `chat` belongs
// to the session path in the assistant service. Events sent while disconnected are
// lost, so every ready runs each registered resync once.
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
  /** Listens to `events`, the runtime port's events sub-port, instead of the last one. */
  bind(events) {
    this.unsubscribe?.();
    this.unsubscribe = events?.subscribe((event) => {
      if (event.event === "chat") return;
      for (const handler of this.handlers.get(event.event) || []) {
        try {
          handler(event.payload);
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
