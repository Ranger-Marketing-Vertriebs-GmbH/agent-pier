import fs from "node:fs";
import { fileURLToPath } from "node:url";
/** Node may canonicalize import.meta.url while argv retains a checkout or release symlink. */
export function isMainModule(moduleUrl, entry = process.argv[1]) {
  if (typeof entry !== "string" || !entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
