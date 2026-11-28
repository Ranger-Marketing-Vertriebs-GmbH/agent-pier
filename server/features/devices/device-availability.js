import fs from "node:fs";
import { androidManifest, androidPlatform } from "./android-manifest.js";

/*
 * Why this host cannot run Android devices at all, apart from "not installed"
 * (android-sdk.js): there is an emulator build only for macOS arm64 and Linux x64,
 * and on Linux the emulator needs KVM, usable by the user AgentPier runs as. The
 * web app has a text for each code.
 */
export const AVAILABILITY_CODES = Object.freeze([
  "DEVICES_PLATFORM_UNSUPPORTED",
  "DEVICES_KVM_MISSING",
  "DEVICES_KVM_DENIED",
]);
const kvm = "/dev/kvm";

/**
 * One of AVAILABILITY_CODES, or null when the host can run the pinned emulator.
 * `access` and `exists` are the file system calls; tests replace them.
 */
export function hostProblem({
  platform = process.platform,
  arch = process.arch,
  manifest = androidManifest,
  access = fs.accessSync,
  exists = fs.existsSync,
} = {}) {
  const key = androidPlatform(platform, arch);
  const pinned =
    key &&
    ["emulator", "platformTools", "image"].every(
      (name) => manifest[name]?.archives?.[key],
    );
  if (!pinned) return "DEVICES_PLATFORM_UNSUPPORTED";
  if (platform !== "linux") return null;
  if (!exists(kvm)) return "DEVICES_KVM_MISSING";
  try {
    access(kvm, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    return "DEVICES_KVM_DENIED";
  }
  return null;
}
