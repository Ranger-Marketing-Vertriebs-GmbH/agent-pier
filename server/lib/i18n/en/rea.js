/** English messages of the managed REA tool, with the same keys as the German catalog. */
export const rea = Object.freeze({
  downloadFailed: "A REA component could not be downloaded.",
  checksumMismatch: "A downloaded REA component does not match its pinned checksum.",
  forbiddenRedirect: "The REA download was redirected to a disallowed target.",
  redirectLimit: "The REA download was redirected too many times.",
  platformUnavailable: "REA is only available for macOS and Linux on arm64 or x64.",
  ghidraMacosTooOld: "Ghidra for REA needs macOS 15 (Sequoia) or newer.",
  ghidraIntelMac:
    "Ghidra for REA is not available on Intel Macs yet; REA Core and frida can be installed.",
  ghidraLinuxArm64:
    "Ghidra for REA is not available on Linux arm64 yet; REA Core and frida can be installed.",
  fridaUnavailable: "frida for REA is not available on this platform.",
});
