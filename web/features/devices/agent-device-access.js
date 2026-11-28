import { devicesCopy as copy } from "../../lib/i18n/messages/devices.js";
import { codeText } from "./device-view.js";
import { accessDraft, noAccess, prunedDraft } from "./session-device-access.js";

// The Android devices of one agent as the owner chooses them in the agent's Access
// tab (GET/PUT /api/assistants/:id/devices, live topic `agent.devices:<id>`). The
// draft is a session's (`{ devices: [{ deviceId, manage }], create }`,
// session-device-access.js), kept in one order so the tab's draft compares it with
// the server's value field by field. Pure: tests/unit/agent-device-access.test.js.

const byId = (a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);

/** `draft` with its devices in the one order drafts are compared in. */
export const orderedDraft = (draft) => ({
  devices: [...draft.devices].sort(byId),
  create: draft.create === true,
});

/** The draft of what the server reports for an agent, or one that grants nothing. */
export const agentAccessDraft = (access) =>
  access ? orderedDraft(accessDraft(access)) : noAccess();

/** What a save sends: the draft without devices that are gone meanwhile. */
export const agentAccessBody = (draft, access) =>
  orderedDraft(access ? prunedDraft(draft, access.devices) : draft);

/**
 * Why the group offers no choice for `access`, or "": the host cannot run devices
 * (its reason in words), or this agent cannot be given any.
 */
export function agentAccessBlocked(access) {
  if (!access.availability.available)
    return codeText(access.availability.reason || "DEVICE_UNAVAILABLE");
  return access.eligible ? "" : codeText("DEVICE_AGENT_INELIGIBLE");
}

/** Whether the owner assigned anything that is kept while the agent is ineligible. */
export const keptAssignment = (access) =>
  access.create === true || access.devices.some((device) => device.assigned);

/** The devices a lead passes on to this agent with a task that is open now. */
export const passedDevices = (access) =>
  access.devices.filter((device) => device.passed === true);

/** How many devices the agent may use by the draft: its own and the granted ones. */
export function allowedCount(draft, devices) {
  const granted = new Set(draft.devices.map((entry) => entry.deviceId));
  return devices.filter((device) => device.own || granted.has(device.id)).length;
}

/** The heading of the allowed list. */
export const allowedHeading = (draft, devices) =>
  copy.agent.allowed(allowedCount(draft, devices));

/**
 * The save-chain step of an agent's devices (`devices` of the tab draft,
 * docs/settings-pattern.md): `save(draft)` is useAgentDevices' and stores them.
 */
export const devicesStep = ({ save }) => ({
  id: "devices",
  label: copy.title,
  keys: ["devices"],
  run: ({ values }) => save(values.devices),
});
