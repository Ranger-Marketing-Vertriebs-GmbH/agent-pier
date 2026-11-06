import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "../helpers/ticket-service-fixture.js";

const input = { source: "github", key: "acme/app#7", kind: "session", session: {} };

test("a hook block in the send result fails the start with its reason", async (t) => {
  const { service, store, stopped } = await setup(t, {
    deliver: (n) =>
      n === 1
        ? { status: "rejected", reason: "CHAT_HOOK_BLOCKED" }
        : { status: "accepted" },
  });
  await assert.rejects(service.start("p1", input), {
    status: 502,
    code: "CHAT_HOOK_BLOCKED",
  });
  assert.deepEqual(stopped, ["s1"]);
  assert.equal(store.starts("p1").length, 0);
  // The retry's accepted receipt starts the ticket.
  await service.start("p1", input);
  assert.equal(store.starts("p1").length, 1);
});

test("an accepted receipt starts the ticket", async (t) => {
  const { service, store, stopped } = await setup(t, {
    deliver: () => ({ status: "accepted" }),
  });
  await service.start("p1", input);
  assert.deepEqual(stopped, []);
  assert.equal(store.starts("p1").length, 1);
});
