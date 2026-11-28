import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage, withLanguage } from "../../web/lib/i18n/index.js";
import {
  agentAccessBlocked,
  agentAccessBody,
  agentAccessDraft,
  allowedCount,
  allowedHeading,
  devicesStep,
  keptAssignment,
  orderedDraft,
  passedDevices,
} from "../../web/features/devices/agent-device-access.js";
import {
  deviceGrantEntries,
  noAccess,
} from "../../web/features/devices/session-device-access.js";
import { followServer } from "../../web/lib/settings/draft-state.js";
import { runSaveChain } from "../../web/lib/settings/save-chain.js";

// The rules of an agent's Android devices as the owner chooses them in the agent's
// Access tab (GET/PUT /api/assistants/:id/devices).
setLanguage("en");

const owner = { kind: "owner", id: "owner", name: "", gone: false };
const row = (patch = {}) => ({
  id: "d-0000000000a1",
  name: "Pixel",
  state: "stopped",
  creator: owner,
  assigned: false,
  manage: false,
  own: false,
  passed: false,
  ...patch,
});
const access = (devices = [], patch = {}) => ({
  availability: { available: true, reason: null },
  eligible: true,
  create: false,
  devices,
  ...patch,
});
const pixel = row({ assigned: true });
const tablet = row({
  id: "d-0000000000b2",
  name: "Tablet",
  assigned: true,
  manage: true,
});
const own = row({
  id: "d-0000000000c3",
  name: "Scratch",
  own: true,
  manage: true,
  creator: { kind: "agent", id: "home", name: "Home", gone: false },
});
const lent = row({ id: "d-0000000000d4", name: "Lent", passed: true });

test("the draft holds the owner's grants in one order, whatever the server's", () => {
  assert.deepEqual(agentAccessDraft(null), noAccess());
  const draft = agentAccessDraft(access([tablet, own, lent, pixel], { create: true }));
  assert.deepEqual(draft, {
    devices: [
      { deviceId: pixel.id, manage: false },
      { deviceId: tablet.id, manage: true },
    ],
    create: true,
  });
  // The same grants in another order are the same draft, so the tab reports no change.
  assert.deepEqual(
    orderedDraft({ devices: [...draft.devices].reverse(), create: true }),
    draft,
  );
  // A device of the agent's own that the owner also assigned keeps its grant.
  assert.deepEqual(agentAccessDraft(access([{ ...own, assigned: true }])).devices, [
    { deviceId: own.id, manage: true },
  ]);
});

test("a save sends the draft without devices that are gone", () => {
  const draft = {
    devices: [
      { deviceId: tablet.id, manage: true },
      { deviceId: "d-gone", manage: false },
      { deviceId: pixel.id, manage: false },
    ],
    create: false,
  };
  assert.deepEqual(agentAccessBody(draft, access([pixel, tablet])), {
    devices: [
      { deviceId: pixel.id, manage: false },
      { deviceId: tablet.id, manage: true },
    ],
    create: false,
  });
  // Without a known access the draft goes as it is, in order.
  assert.equal(agentAccessBody(draft, null).devices.length, 3);
});

test("an agent that cannot be given devices reads why", () => {
  assert.equal(agentAccessBlocked(access([pixel])), "");
  assert.match(
    agentAccessBlocked(access([pixel], { eligible: false })),
    /^Devices can be given to your own agents only, not to an archived agent/,
  );
  assert.match(
    agentAccessBlocked(
      access([], {
        availability: { available: false, reason: "DEVICES_NOT_INSTALLED" },
        eligible: false,
      }),
    ),
    /not installed/,
  );
  withLanguage("de", () =>
    assert.match(
      agentAccessBlocked(access([], { eligible: false })),
      /^Geräte bekommen nur deine eigenen Agenten/,
    ),
  );
  // What the owner assigned earlier is kept and said so.
  assert.equal(keptAssignment(access([pixel], { eligible: false })), true);
  assert.equal(keptAssignment(access([lent, own], { eligible: false })), false);
  assert.equal(keptAssignment(access([], { create: true })), true);
});

test("passed devices are listed apart; own and granted ones count as allowed", () => {
  const all = access([pixel, tablet, own, lent]);
  assert.deepEqual(
    passedDevices(all).map((device) => device.name),
    ["Lent"],
  );
  const draft = agentAccessDraft(all);
  assert.equal(allowedCount(draft, all.devices), 3);
  assert.equal(allowedHeading(draft, all.devices), "Allowed for this agent · 3");
  assert.equal(allowedCount(noAccess(), all.devices), 1);
  withLanguage("de", () =>
    assert.equal(allowedHeading(draft, all.devices), "Für diesen Agenten erlaubt · 3"),
  );
  // The agent's own device is fixed in the picker and worded for an agent.
  const entries = deviceGrantEntries(all.devices, "created by this agent");
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.locked, entry.notes]),
    [
      ["Pixel", false, []],
      ["Tablet", false, []],
      ["Scratch", true, ["created by this agent"]],
      ["Lent", false, []],
    ],
  );
});

test("a push while the owner edits keeps the edit and reports the conflict", () => {
  const base = {
    devices: agentAccessDraft(access([pixel, row({ ...tablet, assigned: false })])),
  };
  const edited = {
    devices: orderedDraft({
      devices: [...base.devices.devices, { deviceId: tablet.id, manage: false }],
      create: true,
    }),
  };
  // A device changed its state: the grants are the same, nothing moves.
  const same = followServer(
    { values: edited, base },
    { devices: agentAccessDraft(access([{ ...pixel, state: "running" }])) },
  );
  assert.deepEqual(same.values, edited);
  assert.deepEqual(same.conflicts, []);
  // The grants changed elsewhere: the edit stays and the tab names the conflict.
  const moved = followServer(
    { values: edited, base },
    { devices: agentAccessDraft(access([pixel], { create: true })) },
  );
  assert.deepEqual(moved.values, edited);
  assert.deepEqual(moved.conflicts, ["devices"]);
  // Without an edit the draft follows the push.
  const followed = followServer(
    { values: base, base },
    { devices: agentAccessDraft(access([pixel, tablet])) },
  );
  assert.equal(followed.values.devices.devices.length, 2);
});

test("the save step runs only for changed devices and hands on a refusal", async () => {
  const sent = [];
  const step = devicesStep({
    save: async (draft) => {
      sent.push(draft);
      return {};
    },
  });
  assert.equal(step.label, "Android devices");
  const base = { devices: noAccess(), other: 1 };
  const untouched = await runSaveChain({
    steps: [step],
    values: { ...base, other: 2 },
    base,
  });
  assert.equal(untouched.status, "saved");
  assert.equal(sent.length, 0);
  const values = { ...base, devices: { devices: [], create: true } };
  const saved = await runSaveChain({ steps: [step], values, base });
  assert.deepEqual(saved.savedKeys, ["devices"]);
  assert.deepEqual(sent, [{ devices: [], create: true }]);
  const refused = await runSaveChain({
    steps: [
      devicesStep({
        save: async () => {
          throw Object.assign(new Error("not for this agent"), {
            status: 409,
            code: "DEVICE_AGENT_INELIGIBLE",
          });
        },
      }),
    ],
    values,
    base,
  });
  // A 409 without a revision conflict is an error, not "changed elsewhere".
  assert.equal(refused.status, "error");
  assert.equal(refused.error.message, "not for this agent");
});
