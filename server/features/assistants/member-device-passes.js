import { refusal } from "../devices/device-registry.js";
import { deviceAgent, deviceOrigin, deviceRun } from "./agent-device-origin.js";
import { callerOf, requestKind, requestTerminal } from "./lead-request-store.js";

/*
 * Android devices a lead passes on to a member with one task
 * (agentpier_team_delegate `access.devices`): the member uses them while it works
 * on that task, beside the devices the owner assigned to it. Decided by the owner
 * (AGENTPIER-508); the rules:
 *
 * - A lead passes on only what it has itself: a device the owner assigned to it or
 *   one it created, named by id or name. Never `manage`: a member neither resets
 *   nor deletes a passed device, and never creates one in a task.
 * - Only from a run in which the lead could use devices itself
 *   (agent-device-origin.js): a lead working on someone else's content passes
 *   nothing on.
 * - The pass lives on the task's own record (`devices`: device ids) and so ends
 *   with the task. It is only an upper bound: it counts while the task is open, the
 *   lead still has the device and lead and member are still the owner's own agents,
 *   read live at every call.
 * - Any member of the lead takes a pass, a permanent and a temporary one; a member
 *   of an agent of restricted users never exists.
 *
 * The device service asks `passedDevices` for a member's permission, and the device
 * list names the member beside the device while the pass counts (`passAssignments`).
 * Which of its devices a member's run may use is the run's own question
 * (agent-devices.js).
 */
const MAX_PASSED = 20;
const invalid = () => refusal("DEVICE_PASS_INVALID", 409);

const requests = (s) => s.assistants?.teams?.requests?.store ?? null;

// Whether `lead` has device `deviceId` itself: assigned by the owner, or created.
function held(s, leadId, deviceId) {
  try {
    if (s.agentDeviceGrants.grantsOf(leadId).some((g) => g.deviceId === deviceId))
      return true;
    const { creator } = s.devices.store.get(deviceId);
    return creator.kind === "agent" && creator.id === leadId;
  } catch {
    return false;
  }
}

// The lead of task `request` while it may hand devices on, else null.
function passingLead(s, request) {
  try {
    const lead = s.assistants.store.getAssistant(request.parentAssistantId);
    return !lead.teamMemberId && deviceAgent(s, lead) ? lead : null;
  } catch {
    return null;
  }
}

/** The device ids task `request` passes on that count right now. */
export function taskDevices(s, request) {
  if (
    !request ||
    request.kind !== requestKind ||
    requestTerminal.has(request.phase) ||
    request.fromMemberId ||
    !Array.isArray(request.devices) ||
    !deviceOrigin(request.origin)
  )
    return [];
  const lead = passingLead(s, request);
  if (!lead) return [];
  return request.devices.filter((id) => typeof id === "string" && held(s, lead.id, id));
}

// The open tasks of member agent `memberId` that pass devices on.
function openTasks(s, memberId) {
  try {
    return (
      requests(s)?.open(
        (r) => r.memberAssistantId === memberId && Array.isArray(r.devices),
      ) ?? []
    );
  } catch {
    return [];
  }
}

/**
 * `[{ deviceId, manage: false }]` of every device an open task passes on to member
 * agent `memberId`, for the device service's permission check.
 */
export function passedDevices(s, memberId) {
  let member = null;
  try {
    member = s.assistants?.store.getAssistant(memberId);
  } catch {
    return [];
  }
  if (!member?.teamMemberId || !deviceAgent(s, member)) return [];
  return openTasks(s, memberId).flatMap((request) =>
    taskDevices(s, request).map((deviceId) => ({ deviceId, manage: false })),
  );
}

/**
 * The members device `deviceId` is passed on to right now, for the device list:
 * `[{ kind: "agent", id, name, manage: false, passedBy: { id, name } }]`.
 */
export function passAssignments(s, deviceId) {
  let open = [];
  try {
    open = requests(s)?.open((r) => Array.isArray(r.devices)) ?? [];
  } catch {
    return [];
  }
  const found = new Map();
  for (const request of open) {
    if (!taskDevices(s, request).includes(deviceId)) continue;
    try {
      const member = s.assistants.store.getAssistant(request.memberAssistantId);
      if (!deviceAgent(s, member)) continue;
      found.set(member.id, {
        kind: "agent",
        id: member.id,
        name: member.name,
        manage: false,
        passedBy: { id: request.parentAssistantId, name: request.leadName ?? "" },
      });
    } catch {
      // A member that is gone is assigned nothing.
    }
  }
  return [...found.values()];
}

/**
 * The devices a lead names in `access.devices` of a task, checked before the task
 * exists: an array of 1 to 20 ids or names, each a device the calling lead has
 * itself, in a run that may use devices. Returns the device ids. Throws
 * DEVICE_PASS_INVALID, or the refusal of the lead's own run.
 */
export function checkedPass(w, inv, lead, named) {
  const s = w.s;
  if (!s.devices || !s.agentDeviceGrants) throw refusal("DEVICE_UNAVAILABLE");
  if (
    !Array.isArray(named) ||
    !named.length ||
    named.length > MAX_PASSED ||
    named.some((n) => typeof n !== "string" || !n || n.length > 100)
  )
    throw invalid();
  const run = deviceRun(w, inv);
  // A member hands nothing on, and neither does a task's own run.
  if (run.agent.id !== lead.id || run.kind === "task" || lead.teamMemberId)
    throw invalid();
  const mine = s.devices
    .devicesFor({ kind: "agent", id: lead.id })
    .filter((device) => held(s, lead.id, device.id));
  const ids = named.map((reference) => {
    const device =
      mine.find((d) => d.id === reference) ?? mine.find((d) => d.name === reference);
    if (!device) throw invalid();
    return device.id;
  });
  return [...new Set(ids)];
}

/**
 * A delegated task's input split for LeadRequests#delegate (`requests`): `task`
 * without its `access`, `share` for what the lead shares of its own access with
 * that task (lead-share-input.js taskShare; null without any) and `devices`, the
 * checked ids of the devices it passes on (null without `access.devices`). An
 * `access` that is no object is left to the shares' own check.
 */
export function taskAccess(requests, inv, input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !("access" in input))
    return { task: input, share: null, devices: null };
  const { access, ...task } = input;
  const plain = !!access && typeof access === "object" && !Array.isArray(access);
  if (!plain || !("devices" in access))
    return { task, share: requests.taskShare(inv, task.memberId, access), devices: null };
  inv.assertCurrent();
  const { devices: named, ...rest } = access;
  const { lead } = requests.store.caller(callerOf(inv));
  // The member must be the lead's own and reachable, as for any task.
  requests.store.ownMember(lead.id, task.memberId);
  const devices = checkedPass(requests.assistants.workflows, inv, lead, named);
  const share = Object.keys(rest).length
    ? requests.taskShare(inv, task.memberId, rest)
    : null;
  return { task, share, devices };
}

/** Writes the pass onto task `request` before its member's turn starts; audited. */
export function applyPass(w, request, deviceIds) {
  const teams = w.a.teams.store;
  const current = teams.find(request.id) ?? request;
  const same =
    Array.isArray(current.devices) &&
    current.devices.length === deviceIds.length &&
    deviceIds.every((id) => current.devices.includes(id));
  if (same) return current;
  const next = teams.write(current, { devices: deviceIds });
  try {
    w.s.audit?.append({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: request.memberAssistantId,
      source: "system",
      outcome: "success",
      details: {
        kind: "lead-share",
        change: "grant",
        by: "lead",
        leadAssistantId: request.parentAssistantId,
        memberId: request.memberId,
        requestId: request.id,
        devices: deviceIds.length,
      },
    });
  } catch (error) {
    console.error("Device pass audit failed:", error?.name ?? "Error");
  }
  try {
    w.s.devices?.signal();
  } catch {
    // The device list follows with its next change.
  }
  return next;
}
