import { isUserAgent } from "../users/user-access.js";
import { SESSION_PARAM } from "../requests/live-topics.js";
import { refusal } from "./device-registry.js";
import { deviceEligible } from "./session-device-grants.js";

/*
 * A coding session's access to Android devices as the owner reads and sets it:
 * the value of `GET` and `PUT /api/sessions/:id/devices` and of the live topic
 * `session.devices:<session id>` (owner only), and the check of a launch's
 * `deviceAccess`. The grants themselves are session-device-grants.js; what a
 * session may then do with a device is the device service's rule.
 *
 * The value:
 *
 *   {
 *     availability: { available, reason },   as in the device view
 *     eligible,     this session can be given devices: a running coding session of
 *                   the owner's, not a sign-in, pipeline or imported session and
 *                   not one a restricted user's agent started
 *     tools,        "ready" | "missing": whether the session has the AgentPier
 *                   tools that carry the device tools
 *     create,       the session may create devices
 *     devices: [{ id, name, state, creator, assigned, manage, own }]
 *                   every device: `assigned` and `manage` are the owner's grant,
 *                   `own` says that the session created it (it may then use, reset
 *                   and delete it without a grant)
 *   }
 */

/** Whether the agent `assistantId` serves restricted users; unknown counts as one. */
function userAgent(services, assistantId) {
  const store = services.assistants?.store;
  if (!store) return true;
  try {
    return isUserAgent(store.getAssistant(assistantId));
  } catch {
    return true;
  }
}

/** Whether `session` can be given devices (deviceEligible, with the agents known). */
export const sessionDeviceEligible = (services, session) =>
  deviceEligible(session, { userAgent: (id) => userAgent(services, id) });

/** What `GET /api/sessions/:id/devices` answers for `session`. */
export function sessionDeviceAccess(services, session) {
  const { devices, sessionDeviceGrants: grants } = services;
  const view = devices.view();
  const access = grants.get(session);
  const granted = new Map(access.devices.map((entry) => [entry.deviceId, entry.manage]));
  return {
    availability: view.availability,
    eligible: sessionDeviceEligible(services, session),
    tools: services.sessionMcp?.grantFor(session.id) ? "ready" : "missing",
    create: access.create,
    devices: view.devices.map(({ id, name, state, creator }) => {
      const own = creator.kind === "session" && creator.id === session.id;
      return {
        id,
        name,
        state,
        creator,
        assigned: granted.has(id),
        manage: own || granted.get(id) === true,
        own,
      };
    }),
  };
}

/**
 * The access a `PUT` or a launch names, checked: DEVICE_ASSIGNMENT_INVALID (400)
 * for another shape or a device that does not exist.
 */
export function checkedDeviceAccess(services, input) {
  const access = services.sessionDeviceGrants.validate(input);
  const known = new Set(services.devices.view().devices.map((device) => device.id));
  if (access.devices.some((entry) => !known.has(entry.deviceId)))
    throw refusal("DEVICE_ASSIGNMENT_INVALID", 400);
  return access;
}

/** Whether `access` grants anything at all. */
export const grantsAnything = (access) =>
  !!access && (access.create || access.devices.length > 0);

/**
 * Stores `access` for `session` and returns the new value. Throws
 * DEVICE_SESSION_INELIGIBLE (409) when this session cannot be given devices; an
 * access that grants nothing may always be stored, so it can always be taken away.
 */
export function setSessionDeviceAccess(services, session, input) {
  const access = checkedDeviceAccess(services, input);
  if (grantsAnything(access) && !sessionDeviceEligible(services, session))
    throw refusal("DEVICE_SESSION_INELIGIBLE");
  services.sessionDeviceGrants.set(session, access);
  return sessionDeviceAccess(services, session);
}

/** The topic definition of `session.devices` for LiveHub#define. */
export function sessionDevicesTopic(services) {
  return {
    name: "session.devices",
    mode: "state",
    param: SESSION_PARAM,
    authorize: (principal) => principal?.role === "owner",
    scopeKey: () => "owner",
    read: async (_principal, id) =>
      sessionDeviceAccess(services, await services.sessions.get(id)),
  };
}
