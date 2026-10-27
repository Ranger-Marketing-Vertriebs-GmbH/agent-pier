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
  downloading: (name, percent) => `Downloading ${name} for REA … ${percent}%`,
  unpacking: (name) => `Unpacking ${name} for REA …`,
  checking: (name) => `Checking ${name} for REA …`,
  layoutInvalid: (name) => `The downloaded ${name} does not have the expected layout.`,
  ghidraVersionMismatch: (version) => `The unpacked Ghidra is not version ${version}.`,
  ghidraDecompilerMissing:
    "The unpacked Ghidra has no native decompiler for this platform.",
  ghidraMissingLibraries: (libraries) =>
    `Ghidra's decompiler is missing system libraries: ${libraries}.`,
  jdkNotStarting: "The Java runtime for REA does not start.",
  jdkVersionMismatch: (version) =>
    `The Java runtime for REA does not report version ${version}.`,
  diskFull: "There is not enough free disk space for this REA component.",
  fridaFailed: "frida for REA could not be installed or does not load.",
  invalidPath: "Enter an absolute path without control characters for this REA setting.",
  invalidJebUrl:
    "The JEB MCP URL must be an http or https URL without credentials or fragment.",
  idaConfigRequired:
    "The IDA analysis provider needs the path to an IDA MCP configuration.",
  invalidProvider: "REA's analysis provider must be Ghidra or IDA.",
});
