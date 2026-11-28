import test from "node:test";
import assert from "node:assert/strict";
import { agentDevicesFixture } from "../helpers/agent-devices-fixture.js";

// The devices' gate on the run behind a call (agent-device-origin.js), through the
// real team bridge: the cases where the run is not simply the session's one turn.
const names = (result) => result.devices.map((device) => device.name);

// A routine a lead set up on its permanent member, as the scheduler knows its run.
function leadRoutine(f, member) {
  let agent = f.agentOf(member);
  f.store.updateAssistant(
    agent.id,
    { capabilities: { ...agent.capabilities, memory: true, reminders: true } },
    agent.revision,
  );
  agent = f.agentOf(member);
  const key = `agent:${agent.runtimeAgentId}:cron:job-1:run:r1`;
  f.assistants.routines = {
    results: { forConversation: () => [] },
    writable: () => false,
    runOrigin: (a, k) =>
      a.id === agent.id && k === key
        ? {
            binding: {
              id: "b1",
              assistantId: a.id,
              definition: {},
              createdBy: "lead",
              leadId: f.lead().id,
              leadMemberId: member.id,
            },
            conversation: f.chatOf(member),
          }
        : null,
  };
  return key;
}

test("a lead's routine on its member gets a device only while the lead could use devices itself", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.agentOf(f.permanent), pixel);
  const key = leadRoutine(f, f.permanent);
  const run = (input) => f.invoke(f.agentOf(f.permanent), key, input);
  assert.deepEqual(names(await run({ action: "list" })), ["Pixel"]);
  // The lead serves other people through its own Telegram bot: as for its tasks,
  // nothing it set up reaches a device.
  f.services.assistantTelegramSenders = { connected: (id) => id === f.lead().id };
  assert.equal(await f.code(run({ action: "list" })), "DEVICE_RUN_FORBIDDEN");
  assert.equal(
    await f.code(run({ action: "shell", device: "Pixel", command: "id" })),
    "DEVICE_RUN_FORBIDDEN",
  );
  assert.deepEqual(f.adb, []);
  f.services.assistantTelegramSenders = null;
  assert.deepEqual(names(await run({ action: "list" })), ["Pixel"]);
  // An archived lead, and a lead that is gone, hand nothing on either.
  f.archive(f.lead().id);
  assert.equal(await f.code(run({ action: "list" })), "DEVICE_RUN_FORBIDDEN");
});
