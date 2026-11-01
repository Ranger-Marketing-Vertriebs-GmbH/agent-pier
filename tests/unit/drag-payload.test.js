import test from "node:test";
import assert from "node:assert/strict";
import {
  PANE_MIME,
  hasPayload,
  readPayload,
  writePayload,
} from "../../web/features/views/drag-payload.js";

// A DataTransfer as far as the payload module uses it.
function fakeTransfer() {
  const data = new Map();
  return {
    types: [],
    setData(type, value) {
      if (!data.has(type)) this.types.push(type);
      data.set(type, value);
    },
    getData(type) {
      return data.get(type) ?? "";
    },
  };
}
const fakeWith = (type, value) => {
  const transfer = fakeTransfer();
  transfer.setData(type, value);
  return transfer;
};

test("the pane MIME type is private to AgentPier", () => {
  assert.equal(PANE_MIME, "application/x-agentpier-pane");
});

test("a written payload reads back under the pane MIME type only", () => {
  const dt = fakeTransfer();
  writePayload(dt, { item: { kind: "session", id: "s1" } });
  assert.deepEqual(dt.types, ["application/x-agentpier-pane"]);
  assert.deepEqual(readPayload(dt), { item: { kind: "session", id: "s1" } });
});

test("agent and pane payloads read back", () => {
  const agent = fakeTransfer();
  writePayload(agent, { agent: { assistantId: "a1" } });
  assert.deepEqual(readPayload(agent), { agent: { assistantId: "a1" } });
  const pane = fakeTransfer();
  writePayload(pane, { pane: { viewId: "v_1", key: "session:s1" } });
  assert.deepEqual(readPayload(pane), { pane: { viewId: "v_1", key: "session:s1" } });
  const chat = fakeTransfer();
  writePayload(chat, { item: { kind: "chat", assistantId: "a1", conversationId: "c1" } });
  assert.deepEqual(readPayload(chat), {
    item: { kind: "chat", assistantId: "a1", conversationId: "c1" },
  });
});

test("malformed or foreign payloads read as null", () => {
  assert.equal(readPayload(fakeWith("application/x-agentpier-pane", "{")), null);
  assert.equal(readPayload(fakeWith("application/x-agentpier-pane", "")), null);
  assert.equal(readPayload(fakeWith("application/x-agentpier-pane", "[]")), null);
  assert.equal(
    readPayload(fakeWith("application/x-agentpier-pane", '{"item":{"kind":"file"}}')),
    null,
  );
  assert.equal(
    readPayload(fakeWith("application/x-agentpier-pane", '{"item":{"kind":"session"}}')),
    null,
  );
  assert.equal(
    readPayload(fakeWith("text/plain", '{"agent":{"assistantId":"a"}}')),
    null,
  );
});

test("only drags carrying the pane MIME type are payload drags", () => {
  assert.equal(hasPayload(["Files"]), false);
  assert.equal(hasPayload(["application/x-agentpier-files"]), false);
  assert.equal(hasPayload([]), false);
  assert.equal(hasPayload(["text/plain", "application/x-agentpier-pane"]), true);
});
