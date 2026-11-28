// Values as the server reports them for Android devices (the "API reference" of the
// routes in server/http/routes/devices.js): the installation status of
// GET /api/devices/installation and the view of GET /api/devices, for the unit tests
// of device-view.js and the browser spec.

export const pinned = {
  emulator: "37.3.10",
  platformTools: "37.0.3",
  image: {
    id: "android-36-google_apis-r7",
    api: 36,
    tag: "google_apis",
    abi: "arm64-v8a",
  },
  downloadBytes: 2309918652,
  diskBytes: 5939857260,
};
export const licences = [
  {
    id: "android-sdk-license",
    name: "Android Software Development Kit License Agreement",
    url: "https://developer.android.com/studio/terms",
  },
  {
    id: "android-sdk-arm-dbt-license",
    name: "Android SDK licence with additional terms of Arm Limited",
    url: "https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-5.xml",
  },
];

/** An installation status; `patch` replaces fields. Absent on a host that can run it. */
export const installation = (patch = {}) => ({
  available: true,
  reason: null,
  state: "absent",
  updating: false,
  progress: null,
  failure: null,
  requested: false,
  terms: { accepted: false, acceptedAt: null, by: null },
  pinned,
  installed: null,
  sources: ["dl.google.com"],
  licences,
  ...patch,
});

/** The status once everything pinned is installed. */
export const installed = (patch = {}) =>
  installation({
    state: "installed",
    terms: { accepted: true, acceptedAt: 1795000000000, by: "owner" },
    installed: {
      emulator: pinned.emulator,
      platformTools: pinned.platformTools,
      images: [pinned.image.id],
    },
    ...patch,
  });

/** One device of the view; `patch` replaces fields. */
export const device = (patch = {}) => ({
  id: "d-0000000000a1",
  name: "Pixel test",
  source: "emulator",
  state: "stopped",
  operation: null,
  failure: null,
  live: false,
  creator: { kind: "owner", id: "owner", name: "", gone: false },
  assignments: [],
  image: { id: pinned.image.id, current: true },
  diskBytes: 4080218931,
  held: false,
  viewers: 0,
  createdAt: 1795000000000,
  lastUsedAt: null,
  ...patch,
});

/** The view of `devices` on a host where they can run; `patch` replaces fields. */
export const view = (devices = [], patch = {}) => ({
  availability: { available: true, reason: null },
  settings: { maxDevices: 5, maxRunning: 2 },
  counts: {
    total: devices.length,
    running: devices.filter((entry) =>
      ["starting", "running", "stopping"].includes(entry.state),
    ).length,
  },
  devices,
  ...patch,
});

/** The view while the components are not installed. */
export const notInstalledView = (patch = {}) =>
  view([], {
    availability: { available: false, reason: "DEVICES_NOT_INSTALLED" },
    ...patch,
  });
