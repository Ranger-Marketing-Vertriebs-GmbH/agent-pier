import fs from "node:fs";
import path from "node:path";

import { safePath } from "./mcp-config.js";

/** A read-only copy keeps the execute bit only: 0o500 for programs, 0o400 otherwise. */
export const readOnlyMode = (mode) => (mode & 0o111 ? 0o500 : 0o400);

/**
 * Writes a skill's `[relative, buffer, mode]` files below `target`, refusing any path
 * that leaves it or passes through a link. Folders are private (0o700).
 */
export function writeSkillFiles(target, files, { readOnly = false } = {}) {
  for (const [relative, buffer, mode = 0o600] of files) {
    const file = path.join(target, relative);
    safePath(file, target);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, buffer, {
      mode: readOnly ? readOnlyMode(mode) : mode,
      flag: "wx",
    });
  }
}
