import { serverMessages } from "../../lib/i18n/de.js";
import path from "node:path";

// The managed Craft Anything tool: the pinned release 0.5.0 of
// github.com/storytold/craft-anything, one archive per platform. Every value below was
// checked on 2026-11-08: the SHA-256 comes from the release's SHA256SUMS.txt and was
// re-computed on the downloaded asset; `size` is the asset's byte size; `top` is the
// archive's single top folder and `binary` the CLI's path below it. `installedSize` is
// the unpacked size (du, KiB x 1024). The Linux tarballs also hold the ~100 MB GUI
// binary bin/craft-anything, which AgentPier does not need: `remove` lists what is
// deleted after unpacking (and is not part of `installedSize`). The macOS zip is one
// universal build for arm64 and x64 with the binary at the archive's top.
// Updating means raising the version and replacing every url, sha256, size and
// installedSize from the same sources, and checking the rebuilds' 0.5.0 assumptions
// again (freshQuestions in craft/rebuild-view.js: a resumed build re-asks under new ids).
const release = "https://github.com/storytold/craft-anything/releases/download/v0.5.0";
const macos = Object.freeze({
  url: `${release}/craft-anything-cli-0.5.0-macos-universal.zip`,
  sha256: "88ce25c2d727e8536678a4c9877e1a8020165198869135f08e7fac13761835fc",
  size: 26956827,
  kind: "zip",
  top: "craft-anything-cli-0.5.0-macos-universal",
  binary: "craft-anything-cli",
  installedSize: 65560576,
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
  checked: "2026-11-08",
  version: "0.5.0",
  platforms: Object.freeze({
    "darwin-arm64": macos,
    "darwin-x64": macos,
    "linux-x64": linux(
      "craft-anything-0.5.0-linux-x86_64.tar.gz",
      "d18c54ef05e5c7ef50f8c4959fee8983c0a4a1f141edc488d11f7029973c885b",
      68980627,
      "craft-anything-0.5.0-linux-x86_64",
      34758656,
    ),
    "linux-arm64": linux(
      "craft-anything-0.5.0-linux-aarch64.tar.gz",
      "5fbbf8de469e9ec07355c5a5686412ac4775ed341a4f2a09d7ff61ff53c15805",
      65813141,
      "craft-anything-0.5.0-linux-aarch64",
      28803072,
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
