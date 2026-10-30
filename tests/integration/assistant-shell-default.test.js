import test from "node:test";
import assert from "node:assert/strict";
import { shellService } from "../helpers/assistant-shell-service.js";

// AGENTPIER-276: a new agent of the owner's starts with shell "With approval": every
// command still asks him, so it needs no confirmation. Full access still does, and
// an agent of users starts without shell.
const agent = (extra = {}) => ({
  name: "Fresh",
  instructions: "",
  model: { connectionId: "c", modelId: "m" },
  capabilities: { memory: true, reminders: false },
  ...extra,
});

test("a new agent of the owner's starts with shell With approval", async (t) => {
  const f = shellService(t);
  const created = await f.service.create(agent());
  assert.equal(created.shell, "approval");
  const off = await f.service.create(agent({ name: "Quiet", shell: "off" }));
  assert.equal(off.shell, "off");
  await assert.rejects(f.service.create(agent({ name: "Ops", shell: "full" })), {
    status: 409,
  });
  const full = await f.service.create(
    agent({ name: "Ops", shell: "full", confirmShell: true, confirmFull: true }),
  );
  assert.equal(full.shell, "full");
});
