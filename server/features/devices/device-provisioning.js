import fs from "node:fs";
import {
  androidManifest,
  androidPlatform,
  downloadBytes,
  licencesFor,
} from "./android-manifest.js";
import { installedSdk } from "./android-sdk-install.js";
import { hostProblem } from "./device-availability.js";
import { devicePaths } from "./device-paths.js";
import { readDeviceSettings, writeDeviceSettings } from "./device-settings.js";

/*
 * The installer's part of Android devices (`--with-android-devices`, setup.sh and
 * release-install.mjs), in the style of tools/craft-provisioning.js: it leaves a
 * request in `<data>/devices/settings.json` and downloads nothing. The server
 * installs the pinned components at its next start (AndroidSdk#resume), resumably
 * and with its progress in Settings › General › Android devices.
 *
 * The option counts as accepting Google's terms, so the step prints them with what
 * will be downloaded. It never throws and never fails an installation.
 */
const messages = {
  DEVICES_PLATFORM_UNSUPPORTED: ({ platform, arch }) =>
    `Android devices need macOS on Apple silicon or Linux x64; this host is ${platform}-${arch}. Nothing was changed.`,
  DEVICES_KVM_MISSING: () =>
    "Android devices need hardware virtualization, but /dev/kvm does not exist. Enable virtualization in the firmware (in a virtual machine: nested virtualization), then run the installer with --with-android-devices again. Nothing was changed.",
  DEVICES_KVM_DENIED: () =>
    'Android devices need /dev/kvm, which this user may not open. Add the user to the kvm group (sudo usermod -aG kvm "$USER"), sign in again, then run the installer with --with-android-devices again. Nothing was changed.',
};
const gigabytes = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;

function installed(dataDir, manifest, host) {
  const key = androidPlatform(host.platform, host.arch);
  if (!key) return { usable: false, current: false };
  const found = installedSdk(devicePaths(dataDir, manifest, host), manifest, key);
  return {
    usable: !!(found.emulator && found.platformTools && found.images.length),
    current: found.current,
  };
}

/**
 * Whether this installation has or awaits Android devices: an SDK is installed or
 * requested. The installer then also provides the emulator's system libraries on
 * Linux (install-dependencies.mjs). Never throws; unknown reads as no.
 */
export function androidDevicesWanted({
  dataDir,
  platform = process.platform,
  arch = process.arch,
  manifest = androidManifest,
}) {
  try {
    if (!androidPlatform(platform, arch)) return false;
    return (
      readDeviceSettings(dataDir).requested ||
      installed(dataDir, manifest, { platform, arch }).usable
    );
  } catch {
    return false;
  }
}

/**
 * Resolves null when Android devices were neither asked for nor are there, else
 * `{ status, message? }`:
 *
 * - `installed`: the pinned components are in place (or, without `enable`, an
 *   earlier pin the server updates by itself);
 * - `requested`: the request and the accepted terms are stored (`terms.by` is
 *   "installer"; terms the owner accepted earlier stay) and the server installs at
 *   its next start; with `enable`, `print` first hears what is downloaded, from
 *   where, and under which licences;
 * - `unavailable`: this host cannot run devices; `message` says why. Nothing is
 *   written;
 * - `failed`: the request could not be stored; `message` says why.
 *
 * `print` writes to stderr by default, because the installers answer with JSON on
 * stdout. `problem` and `now` are replaced in tests.
 */
export async function provisionAndroidDevices({
  dataDir,
  enable = false,
  platform = process.platform,
  arch = process.arch,
  manifest = androidManifest,
  problem = hostProblem,
  now = Date.now,
  print = console.error,
}) {
  try {
    const host = { platform, arch };
    const key = androidPlatform(platform, arch);
    if (!enable) {
      if (!key) return null;
      if (installed(dataDir, manifest, host).usable) return { status: "installed" };
      return readDeviceSettings(dataDir).requested ? { status: "requested" } : null;
    }
    const reason = problem({ ...host, manifest });
    if (reason)
      return {
        status: "unavailable",
        message: (messages[reason] ?? messages.DEVICES_PLATFORM_UNSUPPORTED)(host),
      };
    if (installed(dataDir, manifest, host).current) return { status: "installed" };
    // A link in place of <data>/devices is refused, so nothing lands elsewhere.
    const { root } = devicePaths(dataDir, manifest, host);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(root).isDirectory())
      throw Error("The Android devices folder in the data directory is not a folder.");
    const settings = readDeviceSettings(dataDir);
    const versions = {
      emulator: manifest.emulator.version,
      platformTools: manifest.platformTools.version,
      image: manifest.image.id,
    };
    print(
      [
        "Android devices: AgentPier downloads these components from " +
          `${manifest.hosts.join(", ")} at its next start ` +
          `(${gigabytes(downloadBytes(manifest, key))}; Settings › General › Android devices shows the progress):`,
        `  Android Emulator ${versions.emulator}, platform tools ${versions.platformTools}, ` +
          `system image ${versions.image}`,
        "Google provides them under these terms:",
        ...licencesFor(manifest, key).map(
          (licence) => `  ${licence.name}: ${licence.url}`,
        ),
        "By passing --with-android-devices you accept these terms. AgentPier redistributes " +
          "none of these files; remove them again in Settings › General › Android devices.",
      ].join("\n"),
    );
    if (settings.requested && settings.terms && !settings.failure)
      return { status: "requested" };
    writeDeviceSettings(dataDir, {
      requested: true,
      failure: null,
      terms: settings.terms ?? { acceptedAt: now(), by: "installer", versions },
    });
    return { status: "requested" };
  } catch (error) {
    return { status: "failed", message: error.message };
  }
}
