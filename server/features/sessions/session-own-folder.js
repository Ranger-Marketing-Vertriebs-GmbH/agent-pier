import fs from "node:fs";
import path from "node:path";

/**
 * `native-sessions/` and `requests/` are shared by all sessions. A launch keeps its
 * files there in a folder of its own, `<root>/<id>/`, under the names they had before
 * (`<id>.launch.json`, `<id>.claude`, …), so a sandboxed session is granted that
 * folder and nothing of the other sessions beside it. Launches from before kept
 * the same names directly in `<root>`; they are read there until the session is
 * reloaded.
 */
const launchName = (id) => `${id}.launch.json`;

/** The folder a new launch of `id` writes to. */
export const ownFolder = (root, id) => path.join(root, id);

/** The folder that holds the files of `id`'s current launch: its own, else `root`. */
export function sessionFolder(root, id) {
  const own = ownFolder(root, id);
  return fs.existsSync(path.join(own, launchName(id))) ? own : root;
}

/** The launch file of `id`'s current launch in either place. */
export const launchFile = (root, id) =>
  path.join(sessionFolder(root, id), launchName(id));

/**
 * Whether `file` is a launch file of the shared folder named `rootName`, in a
 * session's own folder or directly in the shared one.
 */
export function isLaunchFile(file, rootName) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return false;
  const name = path.basename(file);
  if (!name.endsWith(".launch.json")) return false;
  const folder = path.dirname(file);
  if (path.basename(folder) === rootName) return true;
  return (
    path.basename(folder) === name.slice(0, -".launch.json".length) &&
    path.basename(path.dirname(folder)) === rootName
  );
}
