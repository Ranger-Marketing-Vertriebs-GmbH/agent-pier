import test from "node:test";
import assert from "node:assert/strict";
import {
  capabilityPatch,
  capabilityServer,
} from "../../web/features/assistants/settings/agent-settings-fields.js";
import {
  followsLead,
  shoppingBlocker,
} from "../../web/features/assistants/settings/shopping-switch.js";

const own = (extra = {}) => ({
  id: "a1",
  revision: 3,
  capabilities: { memory: true, browser: true },
  ...extra,
});

test("the shopping switch is on by default and off only when stored off", () => {
  assert.equal(capabilityServer(own()).shopping, true);
  assert.equal(capabilityServer(own({ shopping: true })).shopping, true);
  assert.equal(capabilityServer(own({ shopping: false })).shopping, false);
});

test("the shopping switch is sent on its own, only when it changed", () => {
  const assistant = own();
  const base = capabilityServer(assistant);
  assert.deepEqual(capabilityPatch({ values: base, base, assistant }), {});
  assert.deepEqual(
    capabilityPatch({ values: { ...base, shopping: false }, base, assistant }),
    { shopping: false },
  );
  // A task member has no switch of its own: nothing is ever sent for it.
  const task = own({
    teamMemberId: "m1",
    lifetime: "temporary",
    capabilities: {},
    inherited: { capabilities: { browser: true }, shopping: true },
  });
  const taskBase = capabilityServer(task);
  assert.deepEqual(
    capabilityPatch({
      values: { ...taskBase, shopping: false },
      base: taskBase,
      assistant: task,
    }),
    {},
  );
});

test("why an agent cannot shop follows the draft and the server's rules", () => {
  const values = (assistant) => capabilityServer(assistant);
  const blocker = (assistant, change = {}) =>
    shoppingBlocker(assistant, { ...values(assistant), ...change });
  assert.equal(blocker(own()), null);
  assert.equal(blocker(own(), { browser: false }), "browser");
  assert.equal(blocker(own(), { memory: false }), "memory");
  assert.equal(blocker(own(), { browser: false, memory: false }), "browser");
  assert.equal(
    blocker(own({ userAccess: { mode: "shared", members: [] } })),
    "userAgent",
  );
  assert.equal(blocker(own({ archivedAt: "2026-10-01T00:00:00Z" })), "archived");
  // A permanent member also holds what its lead shares with it.
  const permanent = own({
    teamMemberId: "m1",
    lifetime: "permanent",
    capabilities: { memory: true },
    leadCapabilities: { browser: true },
  });
  assert.equal(blocker(permanent), null);
  // A task member: the lead's browser grant, its own memory, the lead's switch.
  const task = (inherited) =>
    own({
      teamMemberId: "m2",
      lifetime: "temporary",
      capabilities: {},
      inherited: { capabilities: { browser: true }, shopping: true, ...inherited },
    });
  assert.equal(blocker(task()), null);
  assert.equal(blocker(task({ capabilities: {} })), "browser");
  assert.equal(blocker(task({ shopping: false })), "lead");
});

test("a task member's switch follows its lead and is never its own", () => {
  const task = (shopping) =>
    own({
      teamMemberId: "m2",
      lifetime: "temporary",
      capabilities: {},
      inherited: { capabilities: { browser: true }, shopping },
    });
  assert.equal(followsLead(task(true)), true);
  assert.equal(followsLead(own()), false);
  assert.equal(followsLead(own({ teamMemberId: "m1", lifetime: "permanent" })), false);
});
