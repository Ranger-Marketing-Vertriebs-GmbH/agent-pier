// Android devices (AGENTPIER-508): the pinned Android Emulator, platform tools (adb)
// and one system image per supported host. AgentPier downloads these archives from
// Google on the owner's request and redistributes nothing.
//
// Google's repository index (https://dl.google.com/android/repository/repository2-3.xml
// for the emulator and the platform tools, .../sys-img/google_apis/sys-img2-3.xml for
// the image, which lists revision 7 as sys-img2-4.xml and sys-img2-5.xml do) names
// each archive with its size and SHA-1 only. The SHA-256, top-level folder, file
// count and expanded size below were computed on 2026-11-28 by
// `node scripts/refresh-android-manifest.mjs`, which first requires the index's size
// and SHA-1 of every archive. All six were served by dl.google.com without a
// redirect. Changing the pin means changing the versions here and in that script and
// pasting its output.
const repository = "https://dl.google.com/android/repository/";

export const androidManifest = {
  baseUrl: repository,
  // Every download, a redirect's target included, must be on one of these hosts.
  hosts: ["dl.google.com"],
  emulator: {
    version: "37.3.10",
    build: "16970787",
    archives: {
      "darwin-arm64": {
        url: `${repository}emulator-darwin_aarch64-16970787.zip`,
        sha256: "9824ef77c4319fe123e6446d9a8b88e49c51eea458ef85986f7fc309499ee3ac",
        size: 420629851,
        top: "emulator",
        files: 354,
        expandedBytes: 1324524957,
      },
      "linux-x64": {
        url: `${repository}emulator-linux_x64-16970787.zip`,
        sha256: "a4405349d8a9c52136ab7861e5331dc40e85574bd91cb8889a298a2ff4c52e26",
        size: 350068887,
        top: "emulator",
        files: 398,
        expandedBytes: 892942977,
      },
    },
  },
  platformTools: {
    version: "37.0.3",
    archives: {
      "darwin-arm64": {
        url: `${repository}platform-tools_r37.0.3-darwin.zip`,
        sha256: "df21339b9371fef9b19264404338dc686f59a88a1dce634b963da344909001d6",
        size: 16597626,
        top: "platform-tools",
        files: 12,
        expandedBytes: 40235542,
      },
      "linux-x64": {
        url: `${repository}platform-tools_r37.0.3-linux.zip`,
        sha256: "214548146cadb2ca3508143d8a1d4be4c59de5bb837253e3ede89ed74cf450d1",
        size: 9571024,
        top: "platform-tools",
        files: 12,
        expandedBytes: 22869813,
      },
    },
  },
  // `google_apis` without the Play Store. `id` names the image's folder below
  // `<sdk>/system-images/` and is what a device record stores.
  image: {
    id: "android-36-google_apis-r7",
    api: 36,
    tag: "google_apis",
    revision: 7,
    archives: {
      "darwin-arm64": {
        url: `${repository}sys-img/google_apis/arm64-v8a-36_r07.zip`,
        sha256: "fb47d861d6f87230ee0fe70f610d579935ca77f41a0eefbf391595d3dc4b5ee2",
        size: 1872691175,
        top: "arm64-v8a",
        files: 28,
        expandedBytes: 4575096761,
        abi: "arm64-v8a",
      },
      "linux-x64": {
        url: `${repository}sys-img/google_apis/x86_64-36_r07.zip`,
        sha256: "b1bb0769d0bed7698e61f203d7dc9bf6e7c37cd01a39d0d8788a11186bc78160",
        size: 1895447397,
        top: "x86_64",
        files: 28,
        expandedBytes: 4585389445,
        abi: "x86_64",
      },
    },
  },
  // The one device shape: a phone with a moderate screen (720x1600 at 320 dpi renders
  // sharply and keeps screenshots small). The emulator raises 2048 MB to 2560 MB.
  shape: {
    width: 720,
    height: 1600,
    density: 320,
    cores: 4,
    memoryMb: 2048,
    dataPartition: "6G",
  },
  // The licences the pinned packages reference in the index (`uses-license`). The
  // index carries their full text; `platforms` names where a licence applies when it
  // is not every platform (only the arm64 image references the second one).
  licences: [
    {
      id: "android-sdk-license",
      name: "Android Software Development Kit License Agreement",
      url: "https://developer.android.com/studio/terms",
    },
    {
      id: "android-sdk-arm-dbt-license",
      name: "Android Software Development Kit License Agreement (Arm system image)",
      url: `${repository}sys-img/google_apis/sys-img2-3.xml`,
      platforms: ["darwin-arm64"],
    },
  ],
};

/** The manifest platform key for this host, or null when no emulator build exists. */
export function androidPlatform(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  return ["darwin-arm64", "linux-x64"].includes(key) ? key : null;
}

const total = (manifest, key, field) =>
  ["emulator", "platformTools", "image"].reduce(
    (sum, name) => sum + (manifest[name]?.archives?.[key]?.[field] || 0),
    0,
  );

/**
 * The licences of the components installed on platform `key`, as `{ id, name, url }`:
 * one whose `platforms` does not name the host does not apply there (the Arm terms
 * belong to the arm64 system image only).
 */
export function licencesFor(manifest, key) {
  return (manifest.licences ?? [])
    .filter((licence) => !licence.platforms || licence.platforms.includes(key))
    .map(({ id, name, url }) => ({ id, name, url }));
}

/** The bytes a complete installation downloads on platform `key`. */
export function downloadBytes(manifest, key) {
  return total(manifest, key, "size");
}

/** The bytes the three unpacked components take on disk on platform `key`. */
export function diskBytes(manifest, key) {
  return total(manifest, key, "expandedBytes");
}
