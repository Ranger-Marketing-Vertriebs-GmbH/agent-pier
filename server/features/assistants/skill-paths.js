import fs from "node:fs";
import path from "node:path";

// Where the Gateway reports a skill's file (skills.status `filePath`), checked against
// the folder AgentPier expects it in. No dependencies beyond Node: built-in-skills.js
// reaches the start compile, which also runs from a checkout without node_modules.

const inside = (file, root) => {
  if (typeof file !== "string" || !root) return false;
  const relative = path.relative(root, file);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};
const realRoot = (root) => {
  try {
    return fs.realpathSync(root);
  } catch {
    return null;
  }
};

/**
 * Whether a path the Gateway reports lies strictly below `root`/`sub`, with `root`
 * as given or as its real path (e.g. /var against /private/var on macOS). Only
 * `root` is resolved: a link inside it is never followed.
 */
export function insideRoot(file, root, sub = "") {
  if (!root) return false;
  const real = realRoot(root);
  return (
    inside(file, path.join(root, sub)) || (!!real && inside(file, path.join(real, sub)))
  );
}
