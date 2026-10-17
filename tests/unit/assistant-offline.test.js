import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentHistoryCache,
  connectionLost,
  featureAfterFailure,
} from "../../web/features/assistants/agent-offline.js";

const history = (id, texts) => ({
  messages: texts.map((text, index) => ({ id: `${id}-${index}`, role: "user", text })),
  requests: [],
  stale: false,
});

test("only missing responses and an unreachable service count as a lost connection", () => {
  assert.equal(connectionLost(new TypeError("Failed to fetch")), true);
  for (const status of [502, 503, 504])
    assert.equal(connectionLost(Object.assign(new Error("x"), { status })), true);
  for (const status of [400, 401, 403, 404, 409, 500])
    assert.equal(connectionLost(Object.assign(new Error("x"), { status })), false);
});

test("a failed switch read keeps a known on and reports the failure", () => {
  assert.deepEqual(featureAfterFailure({ enabled: true, error: null }, "FAILED"), {
    enabled: true,
    error: "FAILED",
    loading: false,
  });
  assert.equal(featureAfterFailure({ enabled: false }, "FAILED").enabled, false);
});

test("the chat cache returns the last read and forgets the least recently used chats", () => {
  const cache = new AgentHistoryCache({ maxEntries: 2, maxChars: 1000 });
  cache.set("a", history("a", ["one"]));
  cache.set("b", history("b", ["two"]));
  assert.equal(cache.get("a").messages[0].text, "one");
  cache.set("c", history("c", ["three"]));
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a").messages[0].text, "one");
  assert.equal(cache.get("c").messages[0].text, "three");
  cache.clear();
  assert.equal(cache.get("a"), undefined);
});

test("the chat cache stays within its text budget and keeps the newest messages", () => {
  const cache = new AgentHistoryCache({ maxEntries: 5, maxChars: 10 });
  cache.set("a", history("a", ["12345"]));
  cache.set("b", history("b", ["1234", "5678"]));
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b").messages.length, 2);
  cache.set("c", history("c", ["older text", "newest"]));
  assert.equal(cache.get("b"), undefined);
  assert.deepEqual(
    cache.get("c").messages.map((m) => m.text),
    ["newest"],
  );
  assert.equal(cache.size, 6);
});

test("the chat cache ignores a read without messages and replaces an older read", () => {
  const cache = new AgentHistoryCache();
  cache.set("a", null);
  assert.equal(cache.get("a"), undefined);
  cache.set("a", history("a", ["first"]));
  cache.set("a", history("a", ["second"]));
  assert.deepEqual(
    cache.get("a").messages.map((m) => m.text),
    ["second"],
  );
});
