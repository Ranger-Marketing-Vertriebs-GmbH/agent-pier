import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The helper entry point inside one application tree.
const entry = path.join("server", "github-credentials.js");
const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Where git starts a session's credential helper.
 *
 * A session keeps the GIT_CONFIG_* values of its start for its whole life, so a
 * path into one release directory breaks once an update activates another release
 * and cleanup removes the old one. An installed release therefore starts the helper
 * through the install root's `current` link, which every activation moves to the
 * release it activates and which cleanup never removes; the helper and its Node
 * runtime then always come from the active release. A source checkout keeps its own
 * paths, because no update replaces them.
 *
 * `reads` lists what a sandboxed session must be able to read to run the helper:
 * the link and every release it may point at after later updates.
 */
export function githubHelperLocation({
  installRoot = process.env.AGENTPIER_INSTALL_ROOT,
  applicationRoot = sourceRoot,
  execPath = process.execPath,
} = {}) {
  const pinned = {
    node: execPath,
    script: path.join(applicationRoot, entry),
    stable: false,
    reads: [execPath, path.join(applicationRoot, entry)],
  };
  if (!installRoot) return pinned;
  try {
    const root = fs.realpathSync(installRoot);
    const releases = path.join(root, "releases");
    const current = path.join(root, "current");
    const application = fs.realpathSync(applicationRoot);
    if (path.dirname(application) !== releases) return pinned;
    if (!fs.lstatSync(current).isSymbolicLink()) return pinned;
    if (path.dirname(fs.realpathSync(current)) !== releases) return pinned;
    const node = path.join(current, "bin", "node");
    const script = path.join(current, entry);
    fs.accessSync(node, fs.constants.X_OK);
    fs.accessSync(script, fs.constants.R_OK);
    return { node, script, stable: true, reads: [current, releases] };
  } catch {
    return pinned;
  }
}
