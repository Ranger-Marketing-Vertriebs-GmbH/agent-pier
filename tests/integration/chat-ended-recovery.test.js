import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
const { default: WebSocket } = await import("ws");
const { applicationFixture } = await import(
  new URL("../../tests/helpers/application.js", import.meta.url)
);

const sessionId = "chat-stream-fixture";
const timeout = 10000;

async function until(predicate, message) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

async function fixture(t) {
  const f = await applicationFixture(t);
  f.application.accounts.environment = () => ({ HOME: f.home });
  f.application.sessions.get = async (id) => {
    assert.equal(id, sessionId);
    return { id, accountId: "fixture", tool: "codex", status: "stopped" };
  };
  f.application.sessions.screen = async () => "stopped fixture\n";
  let snapshot = {
    providerSessionId: "provider-fixture",
    messages: [
      { id: "first", role: "assistant", text: "Initial answer" },
      { id: "last", role: "user", text: "Unchanged tail" },
    ],
    tasks: [{ id: "task", status: "pending" }],
  };
  f.application.chat.read = async () => structuredClone(snapshot);
  f.application.chatImages.decorate = async (_id, value) => value;
  f.application.chatImages.read = async () => structuredClone(snapshot);
  return Object.assign(f, {
    update(next) {
      snapshot = next;
      f.application.chatEvents.publish(sessionId, "source-changed");
    },
    snapshot: () => structuredClone(snapshot),
  });
}

const { createChatStream } = await import(
  new URL("../../web/features/chat/chat-stream-transport.js", import.meta.url)
);
test(
  "stopped session recovers from stale snapshot without reload",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    f.update({ ...f.snapshot(), observability: { stale: true } });
    const snapshots = [],
      connections = [];
    const dispose = createChatStream({
      url: f.url.replace("http:", "ws:") + "/api/sessions/" + sessionId + "/chat-stream",
      read: async () => f.snapshot(),
      onSnapshot: (v) => snapshots.push(v),
      onConnection: (v) => connections.push(v),
      onError: () => {},
      createSocket: (address) =>
        new WebSocket(address, {
          origin: f.url,
          headers: { cookie: f.cookie },
        }),
      visibility: {
        hidden: false,
        addEventListener() {},
        removeEventListener() {},
      },
    });
    t.after(dispose);
    await until(() => snapshots.length, "initial stale snapshot arrives");

    const fresh = f.snapshot();
    fresh.messages[0].text = "Recovered final answer";
    fresh.observability = { stale: false };
    f.update(fresh);
    await until(
      () => snapshots.at(-1)?.messages[0].text === "Recovered final answer",
      "final snapshot arrives",
    );

    assert.equal(snapshots.at(-1).messages[0].text, "Recovered final answer");
  },
);
