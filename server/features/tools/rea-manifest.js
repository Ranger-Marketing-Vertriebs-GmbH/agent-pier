import fs from "node:fs";
import { serverMessages } from "../../lib/i18n/de.js";

// The managed REA tool (AGENTPIER-104): REA Core from npm plus pinned Ghidra, JDK and
// frida downloads per platform. Every value below was checked on 2026-10-27:
// - rea-agents: `integrity` is the registry's dist.integrity for the version, equal
//   to the sha512 of the downloaded tarball; `rea-package-lock.json` beside this file
//   is written by `node scripts/refresh-rea-lock.mjs` (never by hand, never with
//   install scripts) and checked against that integrity.
// - Ghidra darwin-arm64: Homebrew's 12.1.4 bottles on ghcr.io. The SHA-256 is the
//   blob digest from the bottle manifest index (ghcr.io/v2/homebrew/core/ghidra/
//   manifests/12.1.4); the tahoe bottle was downloaded and hashed, the sequoia blob's
//   size and digest were confirmed by the registry. Newer macOS uses the tahoe bottle.
// - Ghidra linux-x64: the official release zip of the Ghidra_12.1.4_build release on
//   github.com/NationalSecurityAgency/ghidra (SHA-256 from the release notes and the
//   asset digest), downloaded and hashed.
// - Temurin: Adoptium's published `.sha256.txt` next to each archive, downloaded and
//   hashed.
// - frida: the N-API prebuilds of the 17.23.2 release on github.com/frida/frida
//   (asset digests), each downloaded and hashed; one file, build/frida_binding.node.
// `installedSize` is the unpacked size (du, KiB × 1024). Updating a component means
// raising its version and replacing every url, sha256, size and installedSize from
// the same sources, then re-running the lock refresh for Core.
export const reaManifest = {
  checked: "2026-10-27",
  core: {
    name: "rea-agents",
    version: "6.8.0",
    integrity:
      "sha512-9QDeRnGqEDzABZyr04eLnBXBv/c6I9/TWu/6M0MD4pEfkySI/BIgwTODIbAReX3C1x6hjw9+Jlx4A2yUSPZ9ww==",
    program: { name: "rea", path: "scripts/rea.mjs" },
    args: ["mcp"],
    downloadSize: 86032384,
    installedSize: 171048960,
  },
  ghidra: {
    version: "12.1.4",
    platforms: {
      "darwin-arm64": {
        kind: "tar.gz",
        top: "ghidra",
        installDir: "ghidra/12.1.4/libexec",
        decompiler: "Ghidra/Features/Decompiler/os/mac_arm_64/decompile",
        installedSize: 804155392,
        variants: [
          {
            name: "arm64_sequoia",
            minDarwin: 24,
            url: "https://ghcr.io/v2/homebrew/core/ghidra/blobs/sha256:fdaf330d5d9e3a2ad7c58c4cf69c6a145ec8a964c119617d6476f911434d6ca2",
            sha256: "fdaf330d5d9e3a2ad7c58c4cf69c6a145ec8a964c119617d6476f911434d6ca2",
            size: 464278484,
            auth: "ghcr-anonymous",
          },
          {
            name: "arm64_tahoe",
            minDarwin: 25,
            url: "https://ghcr.io/v2/homebrew/core/ghidra/blobs/sha256:d2a6222389d18d32d48e55079407c1d877d90f86d692911b0399a6ff5e440a9a",
            sha256: "d2a6222389d18d32d48e55079407c1d877d90f86d692911b0399a6ff5e440a9a",
            size: 464260893,
            auth: "ghcr-anonymous",
          },
        ],
      },
      "linux-x64": {
        kind: "zip",
        top: "ghidra_12.1.4_PUBLIC",
        installDir: "ghidra_12.1.4_PUBLIC",
        decompiler: "Ghidra/Features/Decompiler/os/linux_x86_64/decompile",
        url: "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip",
        sha256: "ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db",
        size: 569649598,
        installedSize: 918020096,
      },
    },
  },
  jdk: {
    version: "21.0.13+9",
    platforms: {
      "darwin-arm64": {
        top: "jdk-21.0.13+9",
        home: "jdk-21.0.13+9/Contents/Home",
        url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.13_9.tar.gz",
        sha256: "bf036b35b071bfb2f54f2c0af8ee8d88afa95ee6eb3dce02c0f94cfc2524d04a",
        size: 199754598,
        installedSize: 351399936,
      },
      "linux-x64": {
        top: "jdk-21.0.13+9",
        home: "jdk-21.0.13+9",
        url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_x64_linux_hotspot_21.0.13_9.tar.gz",
        sha256: "d7f5d5cf865a2902b70ff549b97586a7d3f234e016f041ab447ea740c7d66d1c",
        size: 207858352,
        installedSize: 362299392,
      },
    },
  },
  // `installedSize` here is darwin-arm64's; a platform with its own value overrides it.
  frida: {
    version: "17.23.2",
    napi: 8,
    installedSize: 98189312,
    platforms: {
      "darwin-arm64": {
        url: "https://github.com/frida/frida/releases/download/17.23.2/frida-v17.23.2-napi-v8-darwin-arm64.tar.gz",
        sha256: "850fba220a2d9b6aae282ac6dde37f48847e73597b7a06d648737ff9addc3340",
        size: 38219481,
      },
      "darwin-x64": {
        url: "https://github.com/frida/frida/releases/download/17.23.2/frida-v17.23.2-napi-v8-darwin-x64.tar.gz",
        sha256: "f8953b09720cbdccd271c1d6caa4fff085474a9f24def3fe46160526aacdb40b",
        size: 29267518,
        installedSize: 79966208,
      },
      "linux-x64": {
        url: "https://github.com/frida/frida/releases/download/17.23.2/frida-v17.23.2-napi-v8-linux-x64.tar.gz",
        sha256: "9fa8f668ce91eb03713e8564de4f8fbde232233ee91d729c16773fde11dbae95",
        size: 39443166,
        installedSize: 112779264,
      },
      "linux-arm64": {
        url: "https://github.com/frida/frida/releases/download/17.23.2/frida-v17.23.2-napi-v8-linux-arm64.tar.gz",
        sha256: "11083f016a429e87506cd68166bd1445da8febd506a24edf3f6c4a9a7a3ea9fe",
        size: 27142488,
        installedSize: 87097344,
      },
    },
  },
};

const supported = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]);
const ghidraGaps = {
  "darwin-x64": "ghidraIntelMac",
  "linux-arm64": "ghidraLinuxArm64",
};

/** The bottle for this macOS major (Darwin kernel major), or null when none fits. */
function variantFor(variants, darwinMajor) {
  if (!Number.isFinite(darwinMajor)) return null;
  return variants
    .filter((variant) => variant.minDarwin <= darwinMajor)
    .reduce(
      (best, variant) => (best && best.minDarwin > variant.minDarwin ? best : variant),
      null,
    );
}

function ghidraFor(key, darwinMajor, manifest) {
  const platform = manifest.ghidra.platforms[key];
  const jdk = manifest.jdk.platforms[key];
  if (!platform || !jdk)
    return {
      ghidra: null,
      reason: serverMessages.rea[ghidraGaps[key] ?? "platformUnavailable"],
    };
  if (!platform.variants) {
    const { variants: _none, ...entry } = platform;
    return { ghidra: { entry, jdk }, reason: null };
  }
  const variant = variantFor(platform.variants, darwinMajor);
  if (!variant) return { ghidra: null, reason: serverMessages.rea.ghidraMacosTooOld };
  const { variants: _all, ...fields } = platform;
  const { minDarwin: _min, ...chosen } = variant;
  return { ghidra: { entry: { ...fields, ...chosen }, jdk }, reason: null };
}

/**
 * What REA offers on this host: Core everywhere supported, Ghidra and frida where a
 * pinned download exists, otherwise null with the reason. `darwinMajor` is the
 * Darwin kernel major (`os.release()`), which picks the Homebrew bottle.
 */
export function reaPlatform({ platform, arch, darwinMajor }, manifest = reaManifest) {
  const key = `${platform}-${arch}`;
  if (!supported.has(key))
    return {
      key: null,
      available: false,
      reason: serverMessages.rea.platformUnavailable,
      core: false,
      ghidra: null,
      ghidraReason: null,
      frida: null,
      fridaReason: null,
    };
  const { ghidra, reason: ghidraReason } = ghidraFor(key, darwinMajor, manifest);
  const prebuild = manifest.frida.platforms[key];
  const frida = prebuild
    ? {
        version: manifest.frida.version,
        napi: manifest.frida.napi,
        installedSize: manifest.frida.installedSize,
        ...prebuild,
      }
    : null;
  return {
    key,
    available: true,
    reason: null,
    core: true,
    ghidra,
    ghidraReason,
    frida,
    fridaReason: frida ? null : serverMessages.rea.fridaUnavailable,
  };
}

const lockFile = new URL("./rea-package-lock.json", import.meta.url);

/** REA Core as an npm package reference with its committed lockfile, read as is. */
export function reaCore(manifest = reaManifest) {
  const { name, version, integrity, program, args } = manifest.core;
  return {
    ref: { registry: "npm", name, version },
    lockText: fs.readFileSync(lockFile, "utf8"),
    integrity,
    program: { ...program },
    args: [...args],
  };
}
