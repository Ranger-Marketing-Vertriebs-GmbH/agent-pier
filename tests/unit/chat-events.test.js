import test from "node:test";
import assert from "node:assert/strict";
import { ChatEvents } from "../../server/features/chat/chat-events.js";

test("chat events sequence per session and replay recent hints", () => {
  const events = new ChatEvents({ maxEvents: 2 });
  const first = events.publish("one", "changed");
  events.publish("one", "binding", { providerSessionId: "new" });
  events.publish("one", "changed");
  assert.equal(first.sequence, 1);
  assert.deepEqual(
    events.since("one", 1).map((event) => event.sequence),
    [2, 3],
  );
  assert.equal(events.since("one", 0), null);
  assert.deepEqual(events.since("other", 0), []);
});

test("chat event subscribers can unsubscribe", () => {
  const events = new ChatEvents();
  const received = [];
  const unsubscribe = events.subscribe("one", (event) => received.push(event.type));
  events.publish("one", "changed");
  unsubscribe();
  events.publish("one", "ended");
  assert.deepEqual(received, ["changed"]);
});
