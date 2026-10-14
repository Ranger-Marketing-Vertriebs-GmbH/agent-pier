import path from "node:path";
import { toolchainRoot } from "./toolchains.js";

/**
 * A toolchain folder by name under this data dir's root, else null. pruneToolchains
 * stops pruning for any entry outside its root (a real path such as /private/var for
 * /var, or a toolchain of another data dir), so entries are kept by folder name.
 * Records store only this shape, never the root or a parent of it.
 */
export const toolchainEntry = (dataDir, dir) =>
  typeof dir === "string" && /^(node|python)-/.test(path.basename(dir))
    ? path.join(toolchainRoot(dataDir), path.basename(dir))
    : null;
