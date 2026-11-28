import { deviceAgent } from "../assistants/agent-device-origin.js";
import { deviceWorkspace } from "../assistants/agent-devices.js";
import { passedDevices } from "../assistants/member-device-passes.js";
import { refusal } from "./device-registry.js";
import { agentChangeWatch } from "./live-topics.js";

/*
 * An agent's access to Android devices as the owner reads and sets it: the value of
 * `GET` and `PUT /api/assistants/:id/devices` and of the live topic
 * `agent.devices:<agent id>` (owner only). The grants themselves are
 * agent-device-grants.js; which of its runs may then use a device is the agents'
 * own gate (assistants/agent-device-origin.js).
 *
 * The value:
 *
 *   {
 *     availability: { available, reason },   as in the device view
 *     eligible,     this agent can be given devices: an agent of the owner's that
 *                   is not archived, serves no restricted users and has no bot for
 *                   other people
 *     create,       the agent may create devices (in a turn the owner started)
 *     devices: [{ id, name, state, creator, assigned, manage, own, passed }]
 *                   every device: `assigned` and `manage` are the owner's grant,
 *                   `own` says that the agent created it (it may then use, reset
 *                   and delete it without a grant), `passed` that its lead passes
 *                   it on with a task that is open right now
 *   }
 */
const AGENT_PARAM = /[A-Za-z0-9][A-Za-z0-9_-]{0,99}/;
const notFound = () => Object.assign(new Error("Not found"), { status: 404 });

/** The agent `id` as stored (also an archived one). Throws 404 without one. */
export function deviceAgentRecord(services, id) {
  const store = services.assistants?.store;
  if (!store || typeof id !== "string") throw notFound();
  return store.getAssistant(id);
}

/** What `GET /api/assistants/:id/devices` answers for `agent`. */
export function agentDeviceAccess(services, agent) {
  const { devices, agentDeviceGrants: grants } = services;
  const view = devices.view();
  const access = grants.get(agent.id);
  const granted = new Map(access.devices.map((entry) => [entry.deviceId, entry.manage]));
  const passed = new Set(passedDevices(services, agent.id).map((g) => g.deviceId));
  return {
    availability: view.availability,
    eligible: deviceAgent(services, agent),
    create: access.create,
    devices: view.devices.map(({ id, name, state, creator }) => {
      const own = creator.kind === "agent" && creator.id === agent.id;
      return {
        id,
        name,
        state,
        creator,
        assigned: granted.has(id),
        manage: own || granted.get(id) === true,
        own,
        passed: passed.has(id),
      };
    }),
  };
}

/**
 * Stores `input` (`{ devices: [{ deviceId, manage }], create }`) for `agent` and
 * returns the new value. Throws DEVICE_ASSIGNMENT_INVALID (400) for another shape or
 * a device that does not exist, and DEVICE_AGENT_INELIGIBLE (409) when this agent
 * cannot be given devices; an access that grants nothing may always be stored, so it
 * can always be taken away. Audited as `assistant.updated` with `kind:
 * "device-grants"`, without naming a device.
 */
export function setAgentDeviceAccess(services, agent, input) {
  const { devices, agentDeviceGrants: grants, assistants } = services;
  const access = grants.validate(input ?? null);
  const known = new Set(devices.view().devices.map((device) => device.id));
  if (access.devices.some((entry) => !known.has(entry.deviceId)))
    throw refusal("DEVICE_ASSIGNMENT_INVALID", 400);
  const anything = access.create || access.devices.length > 0;
  if (anything && !deviceAgent(services, agent)) throw refusal("DEVICE_AGENT_INELIGIBLE");
  grants.set(agent.id, access, {
    workspace: anything ? deviceWorkspace(assistants, agent) : null,
  });
  try {
    services.audit?.append({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: agent.id,
      source: "user",
      outcome: "success",
      details: { kind: "device-grants" },
    });
  } catch (error) {
    console.error(
      `AgentPier could not audit an agent's device access: ${error?.code || "unknown error"}`,
    );
  }
  return agentDeviceAccess(services, agent);
}

/** The topic definition of `agent.devices` for LiveHub#define. */
export function agentDevicesTopic(services) {
  return {
    name: "agent.devices",
    mode: "state",
    param: AGENT_PARAM,
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    read: (_principal, id) =>
      agentDeviceAccess(services, deviceAgentRecord(services, id)),
    // `eligible` and `passed` follow the agents' own changes (live-topics.js).
    watch: agentChangeWatch(services),
  };
}
