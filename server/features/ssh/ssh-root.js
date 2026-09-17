import fs from "node:fs";
import path from "node:path";

// Resolve existing ancestors too, so clients agree before first-time initialization.
function physicalPath(directory) {
  try {
    return fs.realpathSync(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(physicalPath(parent), path.basename(directory));
  }
}

export function sshPhysicalRoot(dataDir) {
  return physicalPath(path.join(path.resolve(dataDir), "ssh"));
}
