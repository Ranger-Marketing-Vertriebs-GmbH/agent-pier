import path from "node:path";

// Kept apart from craft-config.js (which needs smol-toml) so the installer scripts can
// use it before the dependencies are installed.

/** Craft Anything's own folder below the data directory. */
export function craftHome(dataDir) {
  return path.join(dataDir, "craft-anything");
}
