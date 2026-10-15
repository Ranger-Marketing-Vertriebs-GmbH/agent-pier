/** English counterpart of de/mcp-packages.js with identical keys. */
export const mcpPackages = Object.freeze({
  invalid: "Enter an npm or PyPI package with a valid name and an exact version.",
  notFound: "This package does not exist in the selected registry.",
  versionNotFound: "This version of the package does not exist.",
  registryUnavailable: "The registry is currently unreachable. Please try again later.",
  needsScripts:
    "The package needs install scripts or a build from source. Allow this explicitly to install it.",
  integrityMismatch: "A package checksum does not match the registry.",
  foreignSource: "A dependency does not come from the public registry and is rejected.",
  versionYanked:
    "The maintainers withdrew (yanked) this version. Choose another version.",
  noProgram: "The package contains no runnable program.",
  programRequired: "The package contains several programs. Please choose one.",
  toolchainUnavailable:
    "The toolchain for this package cannot be provided on this machine (macOS and Linux with glibc only, arm64 or x64).",
  downloadFailed: "The download failed. Please try again later.",
  installFailed: "The installation failed. See the log for details.",
  previewExpired: "The preview has expired. Please check the installation again.",
  busy: "An installation is already running for this server.",
  confirmationRequired: "Please confirm the installation of the package.",
  previewBusy: "Several packages are being checked right now. Please try again shortly.",
  toolchainBusy: "A toolchain is already being installed. Please try again shortly.",
  invalidConstraints:
    "Dependency constraints take one PyPI package name with version limits per line (for example fastmcp<4), at most 10.",
});
