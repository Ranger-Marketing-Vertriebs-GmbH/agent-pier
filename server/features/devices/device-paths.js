import path from "node:path";
import { privateDirectory } from "../../lib/storage.js";
import { cleanEnvironment } from "../accounts/account-store.js";
import { androidManifest, androidPlatform } from "./android-manifest.js";

/*
 * Where Android devices live below the data directory, and the environment every
 * emulator and adb process of AgentPier runs with. Nothing here is shared with an
 * Android setup of the user: not `~/.android`, not an SDK elsewhere, not adb's
 * default server port 5037.
 *
 *   devices/sdk/emulator, sdk/platform-tools, sdk/system-images/<image id>/<abi>
 *   devices/avd/<device id>.ini and <device id>.avd/
 *   devices/home           HOME of the processes (adb keys, emulator state)
 *   devices/downloads      archives while they are fetched (`.partial` to resume)
 *   devices/run, run/tmp   run records of live processes, and their TMPDIR
 *   devices/logs           the emulator output of each device's last start
 *   devices/settings.json, devices/devices.json
 */
/** The receipt inside an installed SDK component: `{ version, sha256 }`. */
export const receiptFile = "agentpier-receipt.json";

/** The paths below `<dataDir>/devices`; `host` is `{ platform, arch }`. */
export function devicePaths(dataDir, manifest = androidManifest, host = {}) {
  const key = androidPlatform(host.platform, host.arch);
  const root = path.join(dataDir, "devices");
  const sdk = path.join(root, "sdk");
  const emulator = path.join(sdk, "emulator");
  const platformTools = path.join(sdk, "platform-tools");
  const images = path.join(sdk, "system-images");
  const run = path.join(root, "run");
  return {
    root,
    sdk,
    emulator,
    emulatorBin: path.join(emulator, "emulator"),
    platformTools,
    adbBin: path.join(platformTools, "adb"),
    images,
    /** The folder of image `id` for `abi`: the pinned image of this host by default. */
    image: (
      id = manifest.image.id,
      abi = manifest.image.archives[key]?.abi ?? "unknown",
    ) => path.join(images, id, abi),
    avd: path.join(root, "avd"),
    home: path.join(root, "home"),
    downloads: path.join(root, "downloads"),
    run,
    tmp: path.join(run, "tmp"),
    logs: path.join(root, "logs"),
    settingsFile: path.join(root, "settings.json"),
    devicesFile: path.join(root, "devices.json"),
  };
}

/** Creates the folders of `paths`, each for the owner only. Returns `paths`. */
export function ensureDeviceFolders(paths) {
  for (const name of ["root", "sdk", "avd", "home", "downloads", "run", "tmp", "logs"])
    privateDirectory(paths[name]);
  return paths;
}

/**
 * The environment of an emulator or adb process: `base` without any inherited
 * `ANDROID_*` or `ADB_*` variable, with the private home, SDK, AVD folder and
 * temporary folder, AgentPier's own adb server port and adb's mDNS discovery off
 * (it would open UDP port 5353 on every interface).
 */
export function deviceEnvironment(paths, { adbPort, base = cleanEnvironment() } = {}) {
  if (!Number.isInteger(adbPort) || adbPort < 1024 || adbPort > 65535 || adbPort === 5037)
    throw TypeError("An adb server port of AgentPier's own is required.");
  const env = {};
  for (const [name, value] of Object.entries(base))
    if (!/^(?:ANDROID_|ADB_)/.test(name)) env[name] = value;
  const userHome = path.join(paths.home, ".android");
  return {
    ...env,
    HOME: paths.home,
    TMPDIR: paths.tmp,
    ANDROID_SDK_ROOT: paths.sdk,
    ANDROID_HOME: paths.sdk,
    ANDROID_AVD_HOME: paths.avd,
    ANDROID_USER_HOME: userHome,
    ANDROID_EMULATOR_HOME: userHome,
    ANDROID_ADB_SERVER_PORT: String(adbPort),
    ADB_MDNS: "0",
  };
}
