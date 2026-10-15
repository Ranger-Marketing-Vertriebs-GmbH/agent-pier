import { runtimeManifest } from "../assistants/runtime-manifest.js";
import { packageProblem } from "./package-errors.js";

// uv release assets (.sha256) and python-build-standalone SHA256SUMS, verified
// 2026-10-14. uv 0.12.21 (2026-09-29) instead of the two-day-old 0.13 line.
const triples = Object.freeze({
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
});
const uvVersion = "0.12.21";
const pythonVersion = "3.14.7";
const pythonBuild = "20260929";
const pythonAsset = (target) =>
  `cpython-${pythonVersion}+${pythonBuild}-${triples[target]}-install_only_stripped.tar.gz`;

export const toolchainManifest = Object.freeze({
  node: Object.freeze({
    version: runtimeManifest.nodeVersion,
    npmVersion: runtimeManifest.npmVersion,
    // A frozen copy: the runtime manifest's object stays its own.
    checksums: Object.freeze({ ...runtimeManifest.nodeChecksums }),
    url: (target) =>
      `https://nodejs.org/dist/v${runtimeManifest.nodeVersion}/node-v${runtimeManifest.nodeVersion}-${target}.tar.gz`,
  }),
  uv: Object.freeze({
    version: uvVersion,
    triples,
    checksums: Object.freeze({
      "darwin-arm64": "b88bda573e566ef9bced66b155fe0408626fbbc053aee1c30ba686f0728c9447",
      "darwin-x64": "2b336763b396ec6afa20c5a8b083538ca7402445b868311979d740a4344c17d8",
      "linux-arm64": "030b69227b40af8c1981b7301793dc66e71ed3c796ea8688209dd268bd91ec51",
      "linux-x64": "23f02075b652bb1df64178cfae41b5caf160822e720e2663568f3f5d63bc52c0",
    }),
    url: (target) =>
      `https://github.com/astral-sh/uv/releases/download/${uvVersion}/uv-${triples[target]}.tar.gz`,
  }),
  python: Object.freeze({
    version: pythonVersion,
    build: pythonBuild,
    checksums: Object.freeze({
      "darwin-arm64": "44b4716f4e63bc85e1c07ea2aca730d13a0ec3557d06526d84a13b1d111cf4f9",
      "darwin-x64": "419c8d110a393add7e20480f785a9cc2213978cdb10f8198ee7bb38b02cdb0fe",
      "linux-arm64": "9b8bd45d06fc3fcdc56f2713a62535fe1c019816461ae87c170dd56184dd3f4d",
      "linux-x64": "da5357f47b1d9c8d4c439004d463d893ef688a44c27438a62b47073d26d1377e",
    }),
    asset: pythonAsset,
    url: (target) =>
      `https://github.com/astral-sh/python-build-standalone/releases/download/${pythonBuild}/${encodeURIComponent(pythonAsset(target))}`,
  }),
});

/** The glibc version of this process, or null on musl and non-Linux hosts. */
export function hostGlibc() {
  try {
    return process.report.getReport().header.glibcVersionRuntime ?? null;
  } catch {
    return null;
  }
}

/** `<platform>-<arch>` when every toolchain is pinned for it; never for musl. */
export function toolchainTarget({
  platform = process.platform,
  arch = process.arch,
  glibc = platform === "linux" ? hostGlibc() : null,
} = {}) {
  const target = `${platform}-${arch}`;
  if (!triples[target] || (platform === "linux" && !glibc))
    throw packageProblem("MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE", 503);
  return target;
}
