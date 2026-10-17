import test from "node:test";
import assert from "node:assert/strict";
import { writeGuardWiring } from "../../server/features/assistants/write-guard-wait.js";
import { WriteGuardReapply } from "../../server/features/assistants/write-guard-reapply.js";
import {
  TeamBridge,
  runtimeStatus,
} from "../../server/features/assistants/team-bridge.js";

const browserOnly = { id: "b", capabilities: { browser: true } };
const member = {
  id: "m",
  teamMemberId: "m",
  lifetime: "task",
  parentAssistantId: "b",
  inherited: { capabilities: { browser: true }, skills: [], shell: "off", ssh: false },
};

test("owner turns of browser agents wait for the tool guard like memory agents", () => {
  const wiring = writeGuardWiring({
    bridge: { guardPending: (needed) => needed, readyAt: 0 },
    nativeReady: () => true,
  });
  assert.equal(wiring.writeGuardPending(browserOnly), true);
  assert.equal(wiring.writeGuardPending(member), true);
  assert.equal(wiring.writeGuardPending({ id: "p", capabilities: {} }), false);
  // The runtime status reports the pending guard for browser agents, too.
  const status = runtimeStatus(
    { status: () => ({ availability: "ready" }) },
    { store: { listAssistants: () => [browserOnly] } },
    { guardPending: (needed) => needed },
  );
  assert.equal(status.diagnostic, "WRITE_GUARD_PENDING");
});

test("a reconnect that loses the guard re-applies browser agents once it is back", async () => {
  const listeners = [];
  const runtime = {
    status: () => ({ availability: "ready", version: "2026.10.3" }),
    on: (_name, fn) => listeners.push(fn),
  };
  let live = true;
  const applies = [];
  const assistants = {
    runtime,
    maintenance: false,
    store: { listAssistants: () => [browserOnly] },
    admit: (fn) => fn(),
    config: { apply: async (id) => applies.push(id) },
  };
  const reapply = new WriteGuardReapply({
    assistants,
    live: () => live,
    generation: () => 1,
  });
  const bridge = new TeamBridge({ assistants, generation: () => 1 });
  bridge.onGuardLost = () => reapply.guardLost();
  await reapply.request();
  assert.deepEqual(applies, ["b"]);
  // Same generation, guard lost on a reconnect and reported again.
  live = false;
  for (const listener of listeners) listener({ availability: "reconnecting" });
  for (const listener of listeners) listener({ availability: "ready" });
  live = true;
  await reapply.request();
  assert.deepEqual(applies, ["b", "b"]);
});
