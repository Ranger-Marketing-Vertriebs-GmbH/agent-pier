// The live topics of Android devices, owner only. `devices` carries the value
// GET /api/devices answers (availability, limits, counts and every device with its
// state); DeviceService signals it on every change. `devices.installation` carries
// GET /api/devices/installation (the state of the SDK components and the progress of
// a download); AndroidSdk signals it per component, phase and percent. Nothing is
// sampled. Every change of the devices also reaches `session.devices:<session id>`
// (session-device-access.js), the devices one session may use, and
// `agent.devices:<agent id>` (agent-device-access.js), the devices one agent may use.

const owner = (principal) => principal?.role === "owner";

/** The `devices` topic definition for LiveHub#define. */
export function devicesTopic(services) {
  return {
    name: "devices",
    mode: "state",
    authorize: owner,
    scopeKey: () => "owner",
    read: () => services.devices.view(),
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
