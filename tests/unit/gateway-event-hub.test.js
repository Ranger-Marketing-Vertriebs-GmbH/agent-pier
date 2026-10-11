import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";

function fakeClient(methods = ["config.get"]) {
  const emitter = new EventEmitter();
  return {
    features: { methods: new Set(methods), events: new Set(["chat"]) },
    supports(method) {
      return this.features.methods.has(method);
    },
    subscribe(listener) {
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
    emit: (frame) => emitter.emit("event", frame),
  };
}

test("events are dispatched by name, session-scoped ones included, chat excluded", () => {
  const hub = new GatewayEventHub();
  const seen = [];
  hub.on("exec.approval.requested", (payload) => seen.push(payload.id));
  hub.on("chat", (payload) => seen.push(`chat:${payload.sessionKey}`));
  const client = fakeClient();
  hub.bind(client);
  client.emit({ event: "exec.approval.requested", payload: { id: "e1" } });
  // A live exec approval names its session; it must still reach the hub.
  client.emit({
    event: "exec.approval.requested",
    payload: { id: "e2", request: { sessionKey: "s" }, sessionKey: "s" },
  });
  // Chat frames belong to the conversation path in the assistant service.
  client.emit({ event: "chat", payload: { sessionKey: "s" } });
  assert.deepEqual(seen, ["e1", "e2"]);
});

test("every ready runs each resync exactly once and rebinding drops the old client", async () => {
  const hub = new GatewayEventHub();
  let resyncs = 0,
    events = 0;
  hub.onReady(() => resyncs++);
  hub.on("x", () => events++);
  const first = fakeClient();
  hub.bind(first);
  hub.ready();
  await new Promise(setImmediate);
  const second = fakeClient();
  hub.bind(second);
  hub.ready();
  await new Promise(setImmediate);
  first.emit({ event: "x", payload: {} });
  second.emit({ event: "x", payload: {} });
  assert.equal(resyncs, 2);
  assert.equal(events, 1);
});

test("a handler that throws does not stop the others", () => {
  const hub = new GatewayEventHub();
  const seen = [];
  hub.on("x", () => {
    throw new Error("boom");
  });
  hub.on("x", () => seen.push(1));
  const client = fakeClient();
  hub.bind(client);
  client.emit({ event: "x", payload: {} });
  assert.deepEqual(seen, [1]);
});
