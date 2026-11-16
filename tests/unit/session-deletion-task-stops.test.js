import test from "node:test";
import assert from "node:assert/strict";
import { deleteSession } from "../../server/application/session-deletion.js";

test("deleting a session forgets its task stops and notes", async () => {
  const calls = [];
  const noop = { discard: async () => {}, remove: () => {}, forgetSession: () => {} };
  const services = {
    sessions: { remove: async () => {} },
    chatDelivery: noop,
    chatAttachments: noop,
    requests: noop,
    memoryIntegration: noop,
    activity: noop,
    chat: noop,
    bindings: noop,
    github: noop,
    models: noop,
    taskControl: { forget: (id) => calls.push(id) },
  };
  await deleteSession(services, { id: "s9" });
  assert.deepEqual(calls, ["s9"]);
});
