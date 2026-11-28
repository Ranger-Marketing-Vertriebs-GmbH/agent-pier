// The live topics of Android devices, owner only. `devices` carries the value
// GET /api/devices answers (availability, limits, counts and every device with its
// state); DeviceService signals it on every change. `devices.installation` carries
// GET /api/devices/installation (the state of the SDK components and the progress of
// a download); AndroidSdk signals it per component, phase and percent. Nothing is
// sampled. Every change of the devices also reaches `session.devices:<session id>`
// (session-device-access.js), the devices one session may use, and
// `agent.devices:<agent id>` (agent-device-access.js), the devices one agent may use.
//
// `devices` and `agent.devices` also depend on what the agents' own stores hold,
// which the device service never hears of: whether an agent can be given devices at
// all (archived or restored, an agent of restricted users or the owner's own, with
// or without its own Telegram bot for other people) and which task of a lead passes
// a device on (member-device-passes.js: the pass ends when its task ends or is
// asked to stop). Every one of those writes ends with the agents' `change` event
// (AssistantService#changed), so both topics read again on it while a tab watches
// (`followAgentChanges`); a change of one chat only (a message) names its chat and
// is skipped.
import { sharedSource } from "../live/shared-source.js";

const owner = (principal) => principal?.role === "owner";

/**
 * Calls `listener` on every agent-level `change` event of the current agent
 * services, and once each time agents are switched on or off, after binding to the
 * services that are current then. Returns the stop function.
 */
export function followAgentChanges(services, listener) {
  let unbind = null;
  const bind = () => {
    unbind?.();
    unbind =
      services.assistants?.events?.watch?.((event) => {
        if (event?.type === "change" && !event.conversationId) listener();
      }) || null;
  };
  bind();
  const feature = services.assistantFeature?.events;
  const rebind = () => {
    bind();
    listener();
  };
  feature?.on("started", rebind);
  feature?.on("stopped", rebind);
  return () => {
    unbind?.();
    unbind = null;
    feature?.off("started", rebind);
    feature?.off("stopped", rebind);
  };
}

// One listener on the agents' events per `services` for every topic instance.
const sources = new WeakMap();
/** `watch` of a topic that reads again when the agents changed (LiveHub#define). */
export function agentChangeWatch(services) {
  if (!sources.has(services))
    sources.set(
      services,
      sharedSource((fanout) => followAgentChanges(services, fanout)),
    );
  return ({ invalidate }) => sources.get(services)(() => invalidate());
}

/** The `devices` topic definition for LiveHub#define. */
export function devicesTopic(services) {
  return {
    name: "devices",
    mode: "state",
    authorize: owner,
    scopeKey: () => "owner",
    read: () => services.devices.view(),
    // Which agents a device is assigned or passed on to (see above).
    watch: agentChangeWatch(services),
  };
}

/** The `devices.installation` topic definition for LiveHub#define. */
export function deviceInstallationTopic(services) {
  return {
    name: "devices.installation",
    mode: "state",
    authorize: owner,
    scopeKey: () => "owner",
    read: () => services.androidSdk.status(),
  };
}

export function devicesChanged(hub) {
  hub?.invalidate("devices");
  hub?.invalidate("session.devices");
  hub?.invalidate("agent.devices");
}
export const deviceInstallationChanged = (hub) => hub?.invalidate("devices.installation");
