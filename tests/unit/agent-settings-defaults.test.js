import test from "node:test";
import assert from "node:assert/strict";
import {
  capabilityDefaults,
  capabilityKeys,
  capabilityPatch,
  capabilityServer,
  createCapabilityDefaults,
  createServer,
} from "../../web/features/assistants/settings/agent-settings-fields.js";
import { dreamingStep } from "../../web/features/settings/settings-steps.js";

test("new agents start with Remember information on", () => {
  assert.equal(createServer().memory, true);
  assert.equal(createCapabilityDefaults.memory, true);
  // Saved agents keep the all-off base: an unset capability stays off.
  assert.deepEqual(
    capabilityDefaults,
    Object.fromEntries(capabilityKeys.map((key) => [key, false])),
  );
  const assistant = { id: "a", capabilities: { reminders: false } };
  const base = capabilityServer(assistant);
  const patch = capabilityPatch({
    values: { ...base, webSearch: true },
    base,
    assistant,
  });
  assert.equal(patch.capabilities.webSearch, true);
  assert.notEqual(patch.capabilities.memory, true);
});

test("the dreaming step saves its keys and asks to confirm memory", async () => {
  const calls = [];
  const step = dreamingStep({
    label: "Dreaming",
    save: async (input) => (calls.push(input), { revision: 5 }),
  });
  assert.deepEqual(step.keys, ["dreamingEnabled", "dreamingHour", "dreamingTimeZone"]);
  assert.equal(step.label, "Dreaming");
  await step.run({
    values: { dreamingEnabled: true, dreamingHour: 4, dreamingTimeZone: "Europe/Berlin" },
    revision: 2,
    confirmations: { confirmMemory: true },
  });
  assert.deepEqual(calls, [
    {
      enabled: true,
      hour: 4,
      timeZone: "Europe/Berlin",
      revision: 2,
      confirmMemory: true,
    },
  ]);
  const agents = [{ id: "f", name: "Fern" }];
  assert.deepEqual(
    step.confirmation({
      code: "ASSISTANT_DREAMING_MEMORY_CONFIRMATION_REQUIRED",
      agents,
    }),
    { kind: "dreamingMemory", flags: { confirmMemory: true }, data: { agents } },
  );
  assert.equal(
    step.confirmation({ code: "ASSISTANT_DREAMING_AGENTS_BUSY", agents }),
    null,
  );
});
