import { serverMessages } from "../../lib/i18n/de.js";
import path from "node:path";

// The managed Craft Anything tool: the pinned release 0.6.0 of
// github.com/storytold/craft-anything, one archive per platform. Every value below was
// checked on 2026-11-10: the SHA-256 comes from the release's SHA256SUMS.txt and was
// re-computed on the downloaded asset; `size` is the asset's byte size; `top` is the
// archive's single top folder and `binary` the CLI's path below it. `installedSize` is
// the unpacked size (du, KiB x 1024). The Linux tarballs also hold the ~100 MB GUI
// binary bin/craft-anything, which AgentPier does not need: `remove` lists what is
// deleted after unpacking (and is not part of `installedSize`). The macOS zip is one
// universal build for arm64 and x64 with the binary at the archive's top.
// Updating means raising the version and replacing every url, sha256, size and
// installedSize from the same sources, and checking the rebuilds' assumptions against the
// new binary again (comments in craft/ name the version they were verified with; e.g.
// freshQuestions in craft/rebuild-view.js: a resumed build re-asks under new ids).
const release = "https://github.com/storytold/craft-anything/releases/download/v0.6.0";
const macos = Object.freeze({
  url: `${release}/craft-anything-cli-0.6.0-macos-universal.zip`,
  sha256: "29661218b0c293308b4ffbe1623628f2d22ad4074dabeb414dbc8c7f25dcb2a5",
  size: 27350163,
  kind: "zip",
  top: "craft-anything-cli-0.6.0-macos-universal",
  binary: "craft-anything-cli",
  installedSize: 66498560,
});
const linux = (file, sha256, size, top, installedSize) =>
  Object.freeze({
    url: `${release}/${file}`,
    sha256,
    size,
    kind: "tar.gz",
    top,
    binary: "bin/craft-anything-cli",
    installedSize,
    remove: Object.freeze(["bin/craft-anything"]),
  });

export const craftManifest = Object.freeze({
  checked: "2026-11-10",
  version: "0.6.0",
  platforms: Object.freeze({
    "darwin-arm64": macos,
    "darwin-x64": macos,
    "linux-x64": linux(
      "craft-anything-0.6.0-linux-x86_64.tar.gz",
      "cbc65972a8eb4c89ed74b99bcf14aa5ea0f7aa9da709def38da79ccacc5e07a0",
      69441863,
      "craft-anything-0.6.0-linux-x86_64",
      35172352,
    ),
    "linux-arm64": linux(
      "craft-anything-0.6.0-linux-aarch64.tar.gz",
      "e22f2df940882421d95395a685647168aa828618058dd2f8ed4b21c2dffbee01",
      66241076,
      "craft-anything-0.6.0-linux-aarch64",
      29143040,
    ),
  }),
});

/** The pinned archive for this host: `{ available, reason, entry }`. */
export function craftPlatform({ platform, arch }, manifest = craftManifest) {
  const entry = Object.hasOwn(manifest.platforms, `${platform}-${arch}`)
    ? manifest.platforms[`${platform}-${arch}`]
    : null;
  if (!entry)
    return {
      available: false,
      reason: serverMessages.craft.platformUnavailable,
      entry: null,
    };
  return { available: true, reason: null, entry };
}

/** The CLI inside an installed component (`managedReaComponent`). */
export const craftBinary = (component) => path.join(component.home, "craft-anything-cli");

/**
 * The CLI below `root` (<dataDir>/clis) through the activation link: the MCP row's
 * command. The archive's top folder stays in the path, so it changes with the version.
 */
export const craftBinaryPath = (root, entry) =>
  path.join(root, "craft-anything", entry.top, entry.binary);
