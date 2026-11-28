// Android devices on `services`: the SDK installation, the emulator source and the
// device service, the sessions' grants and the device actions, their live topics,
// audit rows, routes, start and shutdown.
import { AndroidSdk } from "../features/devices/android-sdk.js";
import { DeviceActions } from "../features/devices/device-actions.js";
import { DeviceService } from "../features/devices/device-service.js";
import { EmulatorSource } from "../features/devices/emulator-source.js";
import {
  deviceInstallationChanged,
  devicesChanged,
} from "../features/devices/live-topics.js";
import { SessionDeviceGrants } from "../features/devices/session-device-grants.js";
import { devicesRoutes } from "../http/routes/devices.js";
import { sessionDevicesRoutes } from "../http/routes/session-devices.js";

/** The audit resource id of the SDK components, a `tool`. */
export const ANDROID_TOOL = "android-devices";
// How long a shutdown waits for a running SDK job after the devices stopped; a
// removal it interrupts is completed at the next start (AndroidSdk#recover).
const sdkCloseMs = 1500;

const failed = (what) => (error) =>
  console.error(`AgentPier could not ${what}: ${error?.code || "unknown error"}`);

// An audit row never fails what it records; the log names the error code only.
function append(audit, event) {
  try {
    audit?.append(event);
  } catch (error) {
    failed("audit an Android device change")(error);
  }
}

const sources = { owner: "user", session: "mcp", agent: "agent" };
// What DeviceService reports (`audit` option) as an audit row; never the device name.
function auditDevice(audit, { action, device, caller }) {
  const row = {
    "device.created": { action: "device.created", resourceType: "device" },
    "device.reset": { action: "device.reset", resourceType: "device" },
    "device.deleted": { action: "device.deleted", resourceType: "device" },
  }[action];
  if (!row) return;
  append(audit, {
    ...row,
    resourceId: device.id,
    ...(caller?.kind === "session" && caller.id ? { sessionId: caller.id } : {}),
    source: sources[caller?.kind] ?? "system",
    outcome: "success",
    details: { caller: caller?.kind },
  });
}

// A finished SDK job as an audit row: installed (or failed with its code), cancelled
// by the owner, or removed. A job a shutdown interrupted goes on at the next start
// and is recorded then.
function auditInstallation(audit, sdk, operation) {
  if (operation.shutdown) return;
  const { failure, terms } = sdk.settings();
  const cancelled = operation.kind === "install" && operation.controller.signal.aborted;
  const row =
    operation.kind === "remove"
      ? { action: "tool.deleted", resourceType: "tool" }
      : cancelled
        ? { action: "tool.cancelled", resourceType: "tool" }
        : { action: "tool.installed", resourceType: "tool" };
  const broken = !cancelled && !!failure;
  append(audit, {
    ...row,
    resourceId: ANDROID_TOOL,
    // An update to a later pin and the installer option's request run by themselves.
    source:
      operation.kind === "install" && (operation.updating || terms?.by === "installer")
        ? "system"
        : "user",
    outcome: broken ? "failure" : "success",
    details: broken ? { code: failure.code } : {},
  });
}

/**
 * The SDK and the device service on `services`; both signal their live topics on
 * every change and write their audit rows. `config.androidDevices` replaces what
 * tests replace: `manifest`, `host`, `problem`, `fetchImpl`, `run`, and further
 * options of EmulatorSource (`source`) and DeviceService (`service`). Nothing is
 * read from the network or started here.
 *
 * Also returned: `grants`, the devices the owner assigned to coding sessions
 * (session-device-grants.js), which answer the service's permission checks, fill the
 * assignments of its view and say whether a session that created a device still
 * exists; and `actions`, what a session or agent does with a device
 * (device-actions.js).
 */
export function createDevices(services) {
  const { config } = services;
  const { source = {}, service = {}, ...shared } = config.androidDevices ?? {};
  const { manifest, host } = shared;
  let devices = null;
  // The job whose end is still to be recorded.
  let job = null;
  const sdk = new AndroidSdk({
    dataDir: config.dataDir,
    ...shared,
    changed: () => {
      if (job && job !== sdk.operation) auditInstallation(services.audit, sdk, job);
      job = sdk.operation;
      deviceInstallationChanged(services.live);
      // Whether devices can run is part of the device view.
      devicesChanged(services.live);
    },
    inUse: () => !!devices?.inUse(),
    imagesInUse: () => devices?.imagesInUse() ?? [],
  });
  const emulator = new EmulatorSource({
    dataDir: config.dataDir,
    ...(manifest && { manifest }),
    ...(host && { host }),
    sdk,
    ...source,
  });
  const grants = new SessionDeviceGrants({ dataDir: config.dataDir });
  devices = new DeviceService({
    dataDir: config.dataDir,
    sdk,
    sources: { emulator },
    changed: () => devicesChanged(services.live),
    audit: (entry) => auditDevice(services.audit, entry),
    // An agent that created a device is looked up with the agent tools.
    creatorExists: (creator) => creator.kind !== "session" || grants.exists(creator.id),
    ...service,
  });
  devices.registerGrants("session", (id) => grants.grantsOf(id));
  devices.registerAssignments("session", (id) => grants.assignmentsOf(id));
  devices.onRemoved((id) => grants.dropDevice(id));
  // Who a device is assigned to is part of the device view.
  grants.onChange = () => devices.signal();
  const actions = new DeviceActions({ devices, dataDir: config.dataDir });
  return { devices, sdk, grants, actions };
}

/**
 * At server start, each step on its own and none thrown: what the last process left
 * of an SDK job is settled, leftover device processes are stopped, and then a
 * pending installation or an update to a newer pin continues. On a host without the
 * SDK this reads two files and starts no process.
 */
export async function startDevices({ devices, androidSdk: sdk }) {
  try {
    sdk.recover();
  } catch (error) {
    failed("settle the Android SDK installation")(error);
  }
  await devices.start().catch(failed("start the Android devices"));
  try {
    sdk.resume();
  } catch (error) {
    failed("continue the Android SDK installation")(error);
  }
}

/**
 * Sets `services.devices`, `services.androidSdk`, `services.sessionDeviceGrants`
 * and `services.deviceActions`, mounts the routes and, once the server listens, runs
 * startDevices.
 */
export function connectDevices(services, { mount, whenListening }) {
  const { devices, sdk, grants, actions } = createDevices(services);
  services.devices = devices;
  services.androidSdk = sdk;
  services.sessionDeviceGrants = grants;
  services.deviceActions = actions;
  mount(devicesRoutes(services));
  mount(sessionDevicesRoutes(services));
  whenListening.push(() => startDevices(services));
}

/**
 * For a shutdown: every device stops (at most 3 s, DeviceService#shutdown; what is
 * left then, the next start reclaims) and a running SDK job ends or is left to the
 * next start. Never throws.
 */
export async function shutdownDevices(services) {
  await services.devices?.shutdown().catch(failed("stop the Android devices"));
  let timer;
  const bound = new Promise((resolve) => {
    timer = setTimeout(resolve, sdkCloseMs);
  });
  await Promise.race([
    Promise.resolve(services.androidSdk?.close()).catch(
      failed("stop the Android SDK installation"),
    ),
    bound,
  ]);
  clearTimeout(timer);
}
