import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * A digest of what a skill folder holds: each relative path with its kind, permission
 * bits and SHA-256. An edited, added, removed or linked entry changes it, so AgentPier
 * only replaces or removes a copy that is still exactly what it wrote. `modes: false`
 * leaves the permission bits out, for copies a backup restore may reset to 0600.
 */
export function skillDigest(dir, { modes = true } = {}) {
  const hash = createHash("sha256");
  const walk = (folder, relative) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort(byName)) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${name}\0`);
        walk(file, name);
      } else if (entry.isFile()) {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const stat = fs.fstatSync(fd);
          const content = createHash("sha256").update(fs.readFileSync(fd)).digest("hex");
          const bits = modes ? `${(stat.mode & 0o777).toString(8)}\0` : "";
          hash.update(`f\0${name}\0${bits}${content}\0`);
        } finally {
          fs.closeSync(fd);
        }
      } else hash.update(`x\0${name}\0`);
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}
